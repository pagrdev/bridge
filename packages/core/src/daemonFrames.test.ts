import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BridgeFrame, EventPayload, Provider } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { updateConfig } from './config.js';
import { createDaemon, type Daemon } from './daemon.js';
import { decodeFrameBody, type FrameBody } from './frames.js';
import { verifyRaw } from './identity.js';
import { MemorySecretStore } from './keychain.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FramePayload = EventPayload<'session.frame'>;

/**
 * The daemon end of MOB-032: a frame is on disk before it is on the wire, and a socket that dies
 * in between costs a re-send rather than a gap.
 */
describe('daemon frames', () => {
  const t = useTempHome('pagr-daemon-frames-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();
  const sessionId = ids.ses();

  let wss: WebSocketServer;
  let received: BridgeFrame[];
  let sockets: WebSocket[];
  let daemon: Daemon;
  let home: string;
  let projectId: string;
  let protocolVersion: 1 | 2;
  let connects: number;

  const frames = (): FramePayload[] =>
    received
      .filter((f) => f.kind === 'event' && f.event.type === 'session.frame')
      .map((f) => (f.kind === 'event' ? (f.event.payload as FramePayload) : ({} as FramePayload)));

  const journalPath = () => join(home, 'journal', `${sessionId}.log`);
  const journalLines = (): Array<{ seq: number; body: FrameBody }> =>
    existsSync(journalPath())
      ? readFileSync(journalPath(), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  const emit = (text: string) =>
    daemon.dispatcher.emitFrame(
      sessionId,
      { kind: 'assistant', text },
      { projectId, provider: 'claude', meta: { source: 'stdio' } },
    );

  /**
   * Take the link down deterministically. Terminating the socket and waiting for the daemon's own
   * backoff races the reconnect; stopping the transport is the same state with a known edge.
   */
  const disconnect = async () => {
    await daemon.transport?.stop();
    for (const s of sockets) s.terminate();
    sockets.length = 0;
  };
  const reconnect = async () => {
    const n = connects;
    daemon.transport?.start();
    await until(() => connects > n && daemon.transport?.state === 'connected');
  };
  const cycleConnection = async () => {
    await disconnect();
    await reconnect();
  };

  beforeEach(async () => {
    protocolVersion = 2;
    received = [];
    sockets = [];
    connects = 0;
    home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const store = new MemorySecretStore();
    const pre = await createDaemon({ home, adapters: new Map(), secretStore: store });

    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', r));
    wss.on('connection', (sock) => {
      connects++;
      sockets.push(sock);
      sock.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as BridgeFrame;
        received.push(f);
        if (f.kind === 'auth.request')
          sock.send(JSON.stringify({ kind: 'auth.challenge', nonce: 'x'.repeat(40) }));
        if (f.kind === 'auth.response') {
          const ok = verifyRaw(
            pre.identity.publicKeyRaw,
            `${deviceId}.${'x'.repeat(40)}`,
            f.signature,
          );
          sock.send(JSON.stringify({ kind: 'auth.result', ok, serverKeys: {}, protocolVersion }));
        }
      });
      sock.on('close', () => {
        const i = sockets.indexOf(sock);
        if (i >= 0) sockets.splice(i, 1);
      });
    });

    updateConfig(join(home, 'config.json'), {
      deviceId,
      userId: ids.usr(),
      gatewayUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      serverKeys: {},
    });
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    projectId = new ProjectRegistry({ home: t.home, pagrHome: home }).add(repo).projectId;

    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['claude', new FakeAdapter('claude')]]),
      secretStore: store,
      heartbeatMs: 60_000,
      backoff: { baseMs: 10, maxMs: 30 },
      env: { PAGR_ENV: 'local' },
    });
    await daemon.start();
    await until(() => daemon.transport?.state === 'connected');
  });

  afterEach(async () => {
    await daemon.stop();
    await new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    });
  });

  /** First-pin: an empty pinned set accepts the gateway's without a signature. */
  const pinPhone = async () => {
    for (const s of sockets)
      s.send(
        JSON.stringify({
          kind: 'keys.updated',
          recipientKeys: {
            v: 1,
            userId: ids.usr(),
            keys: [{ kid: phone.kid, x25519: phone.publicKeyB64u, name: 'iPhone' }],
            features: { imessage: false },
            issuedAt: '2026-09-17T00:00:00.000Z',
          },
        }),
      );
    await until(() => daemon.recipientKeyIds().length === 1);
  };

  it('journals a frame before sending it, and re-sends it when the socket died in between', async () => {
    await pinPhone();
    await disconnect();

    // The gateway is gone; the frame still gets a seq and a line on disk.
    expect(emit('written while the link was down')).toMatchObject({ seq: 1 });
    expect(journalLines()).toHaveLength(1);
    expect(frames()).toEqual([]);

    await reconnect();
    await until(() => frames().length === 1);
    const payload = frames()[0] as FramePayload;
    expect(payload).toMatchObject({ sessionId, seq: 1, kind: 'assistant' });
    expect(
      decodeFrameBody(
        openFrame(payload.sealed, sealAadFor(payload.sealed.aad), phone.privateKeyRaw),
      ),
    ).toEqual({
      kind: 'assistant',
      text: 'written while the link was down',
    });
  });

  it('re-sends an unacked frame on the next connection, and stops once it is acked', async () => {
    await pinPhone();
    emit('one');
    await until(() => frames().length === 1);

    // No ack: the gateway never confirmed it, so the next connection owes it again.
    await cycleConnection();
    await until(() => frames().length === 2);
    expect(frames().map((f) => f.seq)).toEqual([1, 1]);

    // Now ack it, and the next connection sends nothing.
    for (const s of sockets) s.send(JSON.stringify({ kind: 'ack', cursors: { [sessionId]: 1 } }));
    await until(() => daemon.dispatcher.pendingFrames().length === 0);
    await cycleConnection();
    await wait(100);
    expect(frames()).toHaveLength(2);
  });

  it('journals but never sends on a v1 gateway, and sends the backlog once v2 is up', async () => {
    protocolVersion = 1;
    await cycleConnection();
    await pinPhone();

    expect(emit('held back by an old gateway')).toMatchObject({
      seq: 1,
      emitted: false,
      heldBack: 'protocol_v1',
    });
    await wait(50);
    expect(frames()).toEqual([]);
    expect(journalLines()).toHaveLength(1);
    expect(daemon.transport?.negotiatedVersion).toBe(1);

    // The cursor never claimed it was sent, so there is nothing to resume either — and with
    // nothing ever sent, the outbox has not been written at all.
    expect(daemon.dispatcher.pendingFrames()).toEqual([]);
    expect(existsSync(join(home, 'journal', 'outbox.json'))).toBe(false);
  });

  it('sends the device.hello before any frame on a fresh connection', async () => {
    await pinPhone();
    emit('after the hello, please');
    await until(() => frames().length === 1);
    await disconnect();
    received.length = 0;
    await reconnect();
    await until(() => frames().length === 1);

    const types = received
      .filter((f) => f.kind === 'event')
      .map((f) => (f.kind === 'event' ? f.event.type : ''));
    expect(types.indexOf('device.hello')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('device.hello')).toBeLessThan(types.indexOf('session.frame'));
  });
});
