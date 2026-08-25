import type { AddressInfo } from 'node:net';
import {
  type BridgeFrame,
  canonicalize,
  type DeviceEvent,
  type GatewayFrame,
} from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { makeEvent } from './events.js';
import { loadOrCreateIdentity, verifyRaw } from './identity.js';
import { MemorySecretStore } from './keychain.js';
import { ids } from './testFixtures.js';
import { GatewayClient } from './transport.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting');
    await wait(10);
  }
};

interface FakeGateway {
  url: string;
  frames: BridgeFrame[];
  sockets: WebSocket[];
  close(): Promise<void>;
  send(f: GatewayFrame): void;
  authOk: boolean;
  minBridgeVersion?: string;
}

async function startFakeGateway(publicKeyRaw: string, deviceId: string): Promise<FakeGateway> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', r));
  const gw: FakeGateway = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    frames: [],
    sockets: [],
    authOk: true,
    send: (f) => {
      for (const s of gw.sockets) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(f));
    },
    close: () =>
      new Promise((r) => {
        for (const s of wss.clients) s.terminate();
        wss.close(() => r());
      }),
  };
  wss.on('connection', (sock) => {
    gw.sockets.push(sock);
    const nonce = 'n'.repeat(40);
    sock.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as BridgeFrame;
      gw.frames.push(f);
      if (f.kind === 'auth.request') sock.send(JSON.stringify({ kind: 'auth.challenge', nonce }));
      if (f.kind === 'auth.response') {
        const valid =
          verifyRaw(publicKeyRaw, `${deviceId}.${nonce}`, f.signature) && f.deviceId === deviceId;
        const res: GatewayFrame = {
          kind: 'auth.result',
          ok: valid && gw.authOk,
          ...(valid && gw.authOk ? { serverKeys: { k1: 'AAAA' } } : { error: 'bad signature' }),
          ...(gw.minBridgeVersion ? { minBridgeVersion: gw.minBridgeVersion } : {}),
        };
        sock.send(JSON.stringify(res));
      }
    });
    sock.on('close', () => gw.sockets.splice(gw.sockets.indexOf(sock), 1));
  });
  return gw;
}

describe('GatewayClient', () => {
  const deviceId = ids.dev();
  let gw: FakeGateway;
  let client: GatewayClient;
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>> & { deviceId: string };
  const commands: unknown[] = [];
  const keys: Record<string, string>[] = [];

  beforeEach(async () => {
    identity = (await loadOrCreateIdentity(new MemorySecretStore(), {
      deviceId,
    })) as typeof identity;
    gw = await startFakeGateway(identity.publicKeyRaw, deviceId);
    commands.length = 0;
    keys.length = 0;
  });
  afterEach(async () => {
    await client?.stop();
    await gw.close();
  });

  const make = (over: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) =>
    new GatewayClient({
      url: gw.url,
      identity,
      bridgeVersion: '0.1.0',
      onCommand: (e) => commands.push(e),
      onServerKeys: (k) => keys.push(k),
      heartbeatMs: 50,
      backoff: { baseMs: 20, maxMs: 100 },
      activeSessions: () => 2,
      ...over,
    });

  it('authenticates with a signed challenge, stores server keys, heartbeats and answers pings', async () => {
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(keys[0]).toEqual({ k1: 'AAAA' });
    expect(client.serverKeys).toEqual({ k1: 'AAAA' });
    gw.send({ kind: 'ping' });
    await until(() => gw.frames.some((f) => f.kind === 'pong'));
    await until(() =>
      gw.frames.some((f) => f.kind === 'event' && f.event.type === 'device.heartbeat'),
    );
    const hb = gw.frames.find((f) => f.kind === 'event' && f.event.type === 'device.heartbeat');
    expect(hb && hb.kind === 'event' && hb.event.payload).toEqual({ activeSessions: 2 });
  });

  it('delivers command frames and rejects malformed frames quietly', async () => {
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    const envelope = { body: { anything: 1 }, keyId: 'k1', signature: 'x' };
    // envelope must pass CommandEnvelope schema to be delivered — send a real-shaped one
    const body = {
      version: 1,
      commandId: ids.cmd(),
      userId: ids.usr(),
      deviceId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      nonce: 'x'.repeat(20),
      idempotencyKey: 'idem_1234',
      type: 'device.probe',
      payload: {},
    };
    gw.send({ kind: 'command', envelope: { body, keyId: 'k1', signature: 'sig' } } as GatewayFrame);
    for (const s of gw.sockets) s.send(JSON.stringify({ kind: 'command', envelope }));
    for (const s of gw.sockets) s.send('not json');
    await until(() => commands.length === 1);
    await wait(30);
    expect(commands).toHaveLength(1);
    expect(canonicalize((commands[0] as { body: unknown }).body)).toBe(canonicalize(body));
  });

  it('buffers events while disconnected (bounded) and flushes on reconnect', async () => {
    client = make({ bufferLimit: 3 });
    const ev = (i: number): DeviceEvent =>
      makeEvent(deviceId, 'device.heartbeat', { activeSessions: i }, { idGen: () => `evt_${i}` });
    expect(client.sendEvent(ev(1))).toBe(true);
    expect(client.sendEvent(ev(2))).toBe(true);
    expect(client.sendEvent(ev(3))).toBe(true);
    expect(client.sendEvent(ev(4))).toBe(false); // drops oldest
    expect(client.bufferedCount).toBe(3);
    client.start();
    await until(() => client.state === 'connected');
    await until(() => gw.frames.filter((f) => f.kind === 'event').length >= 3);
    const sent = gw.frames
      .filter((f) => f.kind === 'event')
      .map((f) => f.kind === 'event' && f.event.eventId);
    expect(sent.slice(0, 3)).toEqual(['evt_2', 'evt_3', 'evt_4']);
    expect(client.bufferedCount).toBe(0);
  });

  it('reconnects with backoff after the server drops the connection', async () => {
    client = make();
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));
    client.start();
    await until(() => client.state === 'connected');
    for (const s of gw.sockets) s.terminate();
    await until(() => events.length >= 3, 3000);
    expect(events).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('emits auth_failed and blocked; blocked stops reconnecting', async () => {
    gw.authOk = false;
    client = make();
    const failures: string[] = [];
    client.on('auth_failed', (e) => failures.push(e));
    client.start();
    await until(() => failures.length >= 1);
    await client.stop();
    gw.authOk = true;
    gw.minBridgeVersion = '9.0.0';
    client = make();
    let blocked = '';
    client.on('blocked', (v) => {
      blocked = v;
    });
    client.start();
    await until(() => blocked === '9.0.0');
    expect(client.state).toBe('blocked');
    await wait(150);
    expect(client.state).toBe('blocked');
  });

  it('backoff grows exponentially with jitter and is capped', () => {
    client = make({ random: () => 0.5, backoff: { baseMs: 1000, maxMs: 60_000 } });
    expect(client.nextDelayMs(0)).toBe(1000);
    expect(client.nextDelayMs(1)).toBe(2000);
    expect(client.nextDelayMs(10)).toBe(60_000);
    const c2 = make({ random: () => 0, backoff: { baseMs: 1000, maxMs: 60_000 } });
    expect(c2.nextDelayMs(0)).toBe(500);
  });
});
