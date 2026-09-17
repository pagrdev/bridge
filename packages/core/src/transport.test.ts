import type { AddressInfo } from 'node:net';
import {
  type BridgeFrame,
  canonicalize,
  type DeviceEvent,
  type GatewayFrame,
  SERVER_KEY_SET_CONTEXT,
} from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { makeEvent } from './events.js';
import {
  generateKeyPairPem,
  loadOrCreateIdentity,
  rawPublicKeyFromPem,
  signWithPem,
  verifyRaw,
} from './identity.js';
import { MemorySecretStore } from './keychain.js';
import { type Logger, silentLogger } from './logging.js';
import { generateRecipientKeyPair, importRecipientKeys, openFrame, sealFrame } from './seal.js';
import { ids } from './testFixtures.js';
import {
  CLOSE_REPLACED,
  classifyAuthFailure,
  evaluateKeySet,
  evaluateRecipientKeys,
  evaluateServerKeys,
  GatewayClient,
  type KeySetSignature,
  MAX_FRAME_BYTES,
  RECIPIENT_KEY_SET_CONTEXT,
  signedByOneOf,
} from './transport.js';

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
  /** `auth.result.error` to answer with when `authOk` is false. */
  authError: string;
  /** Key set handed out on a successful auth; null sends none. */
  serverKeys: Record<string, string> | null;
  /** Detached signature over the key set, as a real rotation would carry. */
  keySignature: { keyId: string; signature: string } | null;
  /** v2 `auth.result.recipientKeys`: the signed set of phones. Null sends none (a v1 gateway). */
  recipientKeys: unknown | null;
  recipientKeysSignature: { keyId: string; signature: string } | null;
  /** v2 `auth.result.features`. */
  features: { imessage: boolean } | null;
  /** Send a frame the v1 `GatewayFrame` union does not know about (e.g. `keys.updated`). */
  sendRaw(f: unknown): void;
  /** Gateway hub behaviour: a newer connection evicts the older one with 4000. */
  replaceOlder: boolean;
  /** Accept the socket and then say nothing at all (a black-hole proxy). */
  silent: boolean;
  /** Stop reading from every accepted socket: it stays open but answers nothing. */
  deafen(): void;
  authAttempts: number;
  /** Protocol version to ANSWER with in `auth.result`; null sends none, which means v1. */
  protocolVersion: 1 | 2 | null;
  /** A gateway that has not been upgraded yet: it refuses any offer above v1. */
  refuseVersion2: boolean;
  /** Every `auth.response.protocolVersion` this gateway was offered, in order. */
  offers: number[];
}

async function startFakeGateway(publicKeyRaw: string, deviceId: string): Promise<FakeGateway> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', r));
  let deaf = false;
  const gw: FakeGateway = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    frames: [],
    sockets: [],
    authOk: true,
    authError: 'bad_signature',
    serverKeys: { k1: 'AAAA' },
    keySignature: null,
    recipientKeys: null,
    recipientKeysSignature: null,
    features: null,
    sendRaw: (f) => {
      for (const s of gw.sockets) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(f));
    },
    replaceOlder: false,
    silent: false,
    authAttempts: 0,
    protocolVersion: null,
    refuseVersion2: false,
    offers: [],
    deafen: () => {
      deaf = true;
      for (const s of gw.sockets) s.pause();
    },
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
    if (deaf) sock.pause();
    const nonce = 'n'.repeat(40);
    sock.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as BridgeFrame;
      gw.frames.push(f);
      if (gw.silent) return;
      if (f.kind === 'auth.request') sock.send(JSON.stringify({ kind: 'auth.challenge', nonce }));
      if (f.kind === 'auth.response') {
        gw.authAttempts++;
        const offered = f.protocolVersion ?? 1;
        gw.offers.push(offered);
        const valid =
          verifyRaw(publicKeyRaw, `${deviceId}.${nonce}`, f.signature) && f.deviceId === deviceId;
        const versionOk = !(gw.refuseVersion2 && offered > 1);
        const ok = valid && gw.authOk && versionOk;
        // Deliberately not typed as `GatewayFrame`: several tests hand this gateway a malformed
        // or forward-compatible key set on purpose, and the point is that the BRIDGE refuses it.
        const res: Record<string, unknown> = {
          kind: 'auth.result',
          ok,
          ...(ok
            ? {
                ...(gw.serverKeys ? { serverKeys: gw.serverKeys } : {}),
                ...(gw.keySignature ? { serverKeysSignature: gw.keySignature } : {}),
                ...(gw.recipientKeys ? { recipientKeys: gw.recipientKeys } : {}),
                ...(gw.recipientKeysSignature
                  ? { recipientKeysSignature: gw.recipientKeysSignature }
                  : {}),
                ...(gw.features ? { features: gw.features } : {}),
                ...(gw.protocolVersion ? { protocolVersion: gw.protocolVersion } : {}),
              }
            : { error: versionOk ? gw.authError : 'protocol_version' }),
          ...(gw.minBridgeVersion ? { minBridgeVersion: gw.minBridgeVersion } : {}),
        };
        sock.send(JSON.stringify(res));
        // The gateway keeps exactly one live socket per device (hub.ts `CLOSE_REPLACED`).
        if (ok && gw.replaceOlder)
          for (const other of [...gw.sockets])
            if (other !== sock && other.readyState === WebSocket.OPEN)
              other.close(CLOSE_REPLACED, 'replaced by a newer connection');
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
      env: { PAGR_ENV: 'local' },
      ...over,
    });

  it('requires wss:// unless PAGR_ENV=local or PAGR_ALLOW_INSECURE_WS=1 (finding 9a)', () => {
    expect(() => make({ env: {} })).toThrow(/wss:\/\//);
    expect(() => make({ env: { PAGR_ENV: 'production' } })).toThrow(/wss:\/\//);
    expect(() => make({ env: { PAGR_ALLOW_INSECURE_WS: '1' } })).not.toThrow();
    expect(() => make({ env: { PAGR_ENV: 'local' } })).not.toThrow();
    expect(() => make({ url: 'wss://gateway.example.com/bridge', env: {} })).not.toThrow();
    expect(() => make({ url: 'https://gateway.example.com', env: {} })).toThrow(/wss:\/\//);
    expect(() => make({ url: 'not a url', env: {} })).toThrow(/gateway url/i);
  });

  it('rejects a server key set that does not overlap the pinned set (finding 9b)', async () => {
    const complaints: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (m) => {
        complaints.push(m);
      },
      error: (m) => {
        complaints.push(m);
      },
      child: () => logger,
    };
    client = make({ serverKeys: { k9: 'ZZZZ' }, logger });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual({ k9: 'ZZZZ' });
    expect(keys).toEqual([]);
    expect(complaints.some((w) => /server key/i.test(w))).toBe(true);
  });

  it('accepts a rotated server key set when at least one pinned key overlaps (finding 9b)', async () => {
    client = make({ serverKeys: { k1: 'AAAA', k0: 'OLD' } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual({ k1: 'AAAA' });
    expect(keys).toEqual([{ k1: 'AAAA' }]);
    // same key id but a different public key is NOT an overlap
    await client.stop();
    keys.length = 0;
    client = make({ serverKeys: { k1: 'BBBB' } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual({ k1: 'BBBB' });
    expect(keys).toEqual([]);
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

  it('stops for good on a genuine auth refusal and keeps retrying a rate limit (BR-5, BR-23)', async () => {
    // Revoked: the gateway is refusing this identity, and a re-pair is the only way back.
    gw.authOk = false;
    gw.authError = 'revoked';
    client = make();
    const failures: Array<[string, boolean]> = [];
    client.on('auth_failed', (code, f) => failures.push([code, f.fatal]));
    client.start();
    await until(() => client.state === 'unauthorized');
    expect(failures).toEqual([['revoked', true]]);
    expect(client.lastFailure?.reason).toMatch(/revoked/i);
    const attemptsAfterRefusal = gw.authAttempts;
    await wait(200); // several base backoffs (20ms) would have passed
    expect(gw.authAttempts).toBe(attemptsAfterRefusal);
    expect(client.state).toBe('unauthorized');
    await client.stop();

    // Rate limited: every bridge behind one office NAT trips this together, so it must not look
    // like a revocation — back off and come back.
    failures.length = 0;
    gw.authError = 'rate_limited';
    gw.authAttempts = 0;
    client = make({ backoff: { baseMs: 10, maxMs: 40, rateLimitedMs: 30 } });
    client.on('auth_failed', (code, f) => failures.push([code, f.fatal]));
    client.start();
    await until(() => gw.authAttempts >= 2, 3000);
    expect(client.state).not.toBe('unauthorized');
    expect(failures.every(([code, fatal]) => code === 'rate_limited' && !fatal)).toBe(true);
    gw.authOk = true; // the limiter refills
    await until(() => client.state === 'connected', 3000);
  });

  it('classifies auth refusals: identity is fatal, everything else retries (BR-23)', () => {
    expect(classifyAuthFailure('revoked').fatal).toBe(true);
    expect(classifyAuthFailure('bad_signature').fatal).toBe(true);
    expect(classifyAuthFailure('device_mismatch').fatal).toBe(true);
    expect(classifyAuthFailure('protocol_version').fatal).toBe(true);
    expect(classifyAuthFailure('rate_limited').fatal).toBe(false);
    expect(classifyAuthFailure('rate_limited').reason).toMatch(/not a revocation/);
    expect(classifyAuthFailure('nonce_expired').fatal).toBe(false);
    // An error code this bridge has never heard of must not brick the device.
    expect(classifyAuthFailure('something_new').fatal).toBe(false);
    expect(classifyAuthFailure(undefined).code).toBe('unknown');
  });

  it('backs off hard when another connection takes this identity, instead of flapping (BR-6)', async () => {
    gw.replaceOlder = true;
    const first = make({ backoff: { baseMs: 10, maxMs: 20, replacedMs: 400 } });
    const second = make({ backoff: { baseMs: 10, maxMs: 20, replacedMs: 400 } });
    client = first; // afterEach stops this one
    let replacedAfterMs = 0;
    first.on('replaced', (ms) => {
      replacedAfterMs = ms;
    });
    first.start();
    await until(() => first.state === 'connected');
    try {
      second.start();
      await until(() => second.state === 'connected');
      await until(() => first.state === 'displaced', 2000);
      expect(replacedAfterMs).toBeGreaterThanOrEqual(400);
      // The old behaviour raced straight back in at the base backoff and the two evicted each
      // other about once a second, forever. The loser must stay out and the winner stay up.
      await wait(250);
      expect(first.state).toBe('displaced');
      expect(second.state).toBe('connected');
    } finally {
      await second.stop();
    }
  });

  it('tears down a half-open socket the peer has stopped answering (BR-15)', async () => {
    client = make({ heartbeatMs: 40, livenessTimeoutMs: 120 });
    const reasons: string[] = [];
    client.on('disconnected', (r) => reasons.push(r));
    client.start();
    await until(() => client.state === 'connected');
    // The laptop slept / a NAT forgot the flow: the socket still reads as open on this side.
    gw.deafen();
    await until(() => reasons.some((r) => /no response/.test(r)), 3000);
    expect(client.state).not.toBe('connected');
  });

  it('does not hang in the auth phase against a black-hole proxy (BR-22)', async () => {
    gw.silent = true;
    client = make({ authTimeoutMs: 80, backoff: { baseMs: 10, maxMs: 20 } });
    client.start();
    await until(() => gw.frames.filter((f) => f.kind === 'auth.request').length >= 2, 3000);
    expect(client.state).not.toBe('connected');
  });

  it('refuses to put an oversized frame on the wire (BR-3)', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (m) => {
        errors.push(m);
      },
      child: () => logger,
    };
    client = make({ logger });
    client.start();
    await until(() => client.state === 'connected');
    const huge = makeEvent(deviceId, 'session.event', {
      sessionId: ids.ses(),
      projectId: ids.proj(),
      provider: 'codex',
      kind: 'progress',
      summary: 'x'.repeat(MAX_FRAME_BYTES + 1000),
      at: new Date().toISOString(),
    });
    expect(client.sendEvent(huge)).toBe(false);
    expect(errors.some((e) => /oversized frame/.test(e))).toBe(true);
    // The connection survives: a 1009 close here is what produced the endless reconnect loop.
    await wait(30);
    expect(client.state).toBe('connected');
  });

  it('backoff grows exponentially with jitter and is capped', () => {
    client = make({ random: () => 0.5, backoff: { baseMs: 1000, maxMs: 60_000 } });
    expect(client.nextDelayMs(0)).toBe(1000);
    expect(client.nextDelayMs(1)).toBe(2000);
    expect(client.nextDelayMs(10)).toBe(60_000);
    const c2 = make({ random: () => 0, backoff: { baseMs: 1000, maxMs: 60_000 } });
    expect(c2.nextDelayMs(0)).toBe(500);
  });

  // ---- protocol negotiation (v2) ----

  it('offers the newest version it speaks and uses what the gateway answers', async () => {
    gw.protocolVersion = 2;
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(gw.offers).toEqual([2]);
    expect(client.negotiatedVersion).toBe(2);
  });

  it('falls back to v1 when the gateway answers nothing, or answers 1', async () => {
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.negotiatedVersion).toBe(1);
    await client.stop();

    gw.protocolVersion = 1;
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.negotiatedVersion).toBe(1);
  });

  it('never emits a v2-only event on a link that negotiated v1', async () => {
    const frame = () =>
      makeEvent(deviceId, 'session.frame', {
        sessionId: ids.ses(),
        projectId: ids.proj(),
        provider: 'claude',
        seq: 1,
        kind: 'assistant',
        at: new Date().toISOString(),
        sealed: {
          v: 1,
          epk: 'A'.repeat(43),
          recipients: [{ kid: '0011:2233:4455:6677', nonce: 'B'.repeat(16), wrap: 'C'.repeat(64) }],
          nonce: 'D'.repeat(16),
          ct: 'E'.repeat(64),
          aad: { sessionId: ids.ses(), seq: 1, kind: 'assistant' },
        },
        meta: { bytes: 12, source: 'stdio' },
      });

    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.sendEvent(frame())).toBe(false);
    // A v1 event on the same link still goes out, so this is a gate and not a stall.
    expect(client.sendEvent(makeEvent(deviceId, 'device.heartbeat', { activeSessions: 1 }))).toBe(
      true,
    );
    await until(() =>
      gw.frames.some((f) => f.kind === 'event' && f.event.type === 'device.heartbeat'),
    );
    expect(gw.frames.some((f) => f.kind === 'event' && f.event.type === 'session.frame')).toBe(
      false,
    );
    await client.stop();

    gw.frames.length = 0;
    gw.protocolVersion = 2;
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.sendEvent(frame())).toBe(true);
    await until(() =>
      gw.frames.some((f) => f.kind === 'event' && f.event.type === 'session.frame'),
    );
  });

  it('drops buffered v2-only events at flush time when the gateway turns out to speak v1', async () => {
    client = make();
    // Queued while offline: the version is only known after the handshake.
    expect(
      client.sendEvent(
        makeEvent(deviceId, 'question.answered', {
          questionId: ids.qst(),
          answeredElsewhere: false,
        }),
      ),
    ).toBe(true);
    expect(client.sendEvent(makeEvent(deviceId, 'device.heartbeat', { activeSessions: 0 }))).toBe(
      true,
    );
    client.start();
    await until(() => client.state === 'connected');
    await until(() =>
      gw.frames.some((f) => f.kind === 'event' && f.event.type === 'device.heartbeat'),
    );
    expect(gw.frames.some((f) => f.kind === 'event' && f.event.type === 'question.answered')).toBe(
      false,
    );
    expect(client.bufferedCount).toBe(0);
  });

  it('offers v1 once more when the gateway refuses v2, and only gives up if that fails too', async () => {
    gw.refuseVersion2 = true;
    const failures: string[] = [];
    client = make();
    client.on('auth_failed', (code) => failures.push(code));
    client.start();
    // The first offer (2) is refused; the retry offers 1 and connects.
    await until(() => client.state === 'connected', 4000);
    expect(gw.offers).toEqual([2, 1]);
    expect(client.negotiatedVersion).toBe(1);
    // The refusal was reported once, and the bridge is connected rather than unauthorized.
    expect(failures).toEqual(['protocol_version']);
    expect(client.lastFailure).toBeNull();
    expect(client.offeredProtocolVersion).toBe(1);
  });

  it('treats a refusal of the v1 offer as fatal, as it always has', async () => {
    gw.authOk = false;
    gw.authError = 'protocol_version';
    client = make();
    client.start();
    // Offer 2 refused → not fatal, retry at 1; refused again → unauthorized.
    await until(() => client.state === 'unauthorized', 4000);
    expect(gw.offers).toEqual([2, 1]);
    expect(client.lastFailure?.fatal).toBe(true);
    expect(client.lastFailure?.code).toBe('protocol_version');
  });
});

describe('server key rotation (SEC-7)', () => {
  const deviceId = ids.dev();
  let gw: FakeGateway;
  let client: GatewayClient;
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>> & { deviceId: string };
  let persisted: Array<Record<string, string>>;

  /** Stand-in for the cloud's signing key: what a bridge pins at pairing. */
  const signer = () => {
    const kp = generateKeyPairPem();
    return { pem: kp.privateKeyPem, raw: rawPublicKeyFromPem(kp.publicKeyPem) };
  };
  const signKeySet = (pem: string, set: Record<string, string>): string =>
    signWithPem(pem, `${SERVER_KEY_SET_CONTEXT}${canonicalize(set)}`);

  beforeEach(async () => {
    identity = (await loadOrCreateIdentity(new MemorySecretStore(), {
      deviceId,
    })) as typeof identity;
    gw = await startFakeGateway(identity.publicKeyRaw, deviceId);
    persisted = [];
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
      onCommand: () => {},
      onServerKeys: (k) => persisted.push(k),
      heartbeatMs: 1000,
      backoff: { baseMs: 20, maxMs: 100 },
      env: { PAGR_ENV: 'local' },
      ...over,
    });

  it('accepts a rotation signed by a key it already trusts, and persists it', async () => {
    const current = signer();
    const next = signer();
    const rotated = { k1: current.raw, k2: next.raw };
    gw.serverKeys = rotated;
    gw.keySignature = { keyId: 'k1', signature: signKeySet(current.pem, rotated) };
    client = make({ serverKeys: { k1: current.raw } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual(rotated);
    expect(persisted).toEqual([rotated]);
  });

  it('refuses an added key that nothing already trusted vouched for, and persists nothing', async () => {
    const current = signer();
    const attacker = signer();
    // The old rule accepted ANY set that overlapped the pinned one by a single key, so anyone who
    // got hold of one server key could append their own and the bridge stored it forever.
    gw.serverKeys = { k1: current.raw, evil: attacker.raw };
    gw.keySignature = null;
    client = make({ serverKeys: { k1: current.raw } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual({ k1: current.raw });
    expect(persisted).toEqual([]);
  });

  it('refuses an added key signed by the attacker rather than by a pinned key', async () => {
    const current = signer();
    const attacker = signer();
    const poisoned = { k1: current.raw, evil: attacker.raw };
    gw.serverKeys = poisoned;
    gw.keySignature = { keyId: 'evil', signature: signKeySet(attacker.pem, poisoned) };
    client = make({ serverKeys: { k1: current.raw } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.serverKeys).toEqual({ k1: current.raw });
    expect(persisted).toEqual([]);
  });

  it('decides key sets by what they grant, not by overlap', () => {
    const a = signer();
    const b = signer();
    const pinned = { k1: a.raw, k2: b.raw };
    // Retiring the outgoing half of a rotation needs no signature: it only narrows trust.
    expect(evaluateServerKeys(pinned, { k1: a.raw })).toEqual({ accept: true, reason: 'narrowed' });
    expect(evaluateServerKeys(pinned, pinned)).toEqual({ accept: true, reason: 'unchanged' });
    // Nothing is pinned yet: the pairing response is the trust root.
    expect(evaluateServerKeys({}, { k1: a.raw })).toEqual({ accept: true, reason: 'first-pin' });
    // Re-pointing a pinned id at a different key is a widening, not a narrowing.
    expect(evaluateServerKeys({ k1: a.raw }, { k1: b.raw })).toEqual({
      accept: false,
      reason: 'unsigned-change',
    });
    const added = { k1: a.raw, k3: b.raw };
    expect(evaluateServerKeys({ k1: a.raw }, added)).toEqual({
      accept: false,
      reason: 'unsigned-change',
    });
    expect(evaluateServerKeys({ k1: a.raw }, added, { keyId: 'k9', signature: 'x' })).toEqual({
      accept: false,
      reason: 'unknown-signer',
    });
    expect(
      evaluateServerKeys({ k1: a.raw }, added, {
        keyId: 'k1',
        signature: signKeySet(b.pem, added),
      }),
    ).toEqual({ accept: false, reason: 'bad-signature' });
    expect(
      evaluateServerKeys({ k1: a.raw }, added, {
        keyId: 'k1',
        signature: signKeySet(a.pem, added),
      }),
    ).toEqual({ accept: true, reason: 'signed' });
  });
});

describe('recipient key set (MOB-031)', () => {
  const signer = () => {
    const kp = generateKeyPairPem();
    return { pem: kp.privateKeyPem, raw: rawPublicKeyFromPem(kp.publicKeyPem) };
  };
  const phones = [
    generateRecipientKeyPair(),
    generateRecipientKeyPair(),
    generateRecipientKeyPair(),
  ];
  const userId = ids.usr();
  /** The set exactly as the cloud issues and signs it. */
  const setOf = (
    keys: Array<{ kid: string; publicKeyB64u: string }>,
    over: Record<string, unknown> = {},
  ) => ({
    v: 1,
    userId,
    keys: keys.map((k, i) => ({
      kid: k.kid,
      x25519: k.publicKeyB64u,
      name: `iPhone ${i + 1}`,
      registeredAt: '2026-09-17T00:00:00.000Z',
    })),
    features: { imessage: true },
    issuedAt: '2026-09-17T00:00:00.000Z',
    ...over,
  });
  const sign = (pem: string, set: unknown): KeySetSignature => ({
    keyId: 'k1',
    signature: signWithPem(pem, `${RECIPIENT_KEY_SET_CONTEXT}${canonicalize(set)}`),
  });
  const flat = (keys: Array<{ kid: string; publicKeyB64u: string }>) =>
    Object.fromEntries(keys.map((k) => [k.kid, k.publicKeyB64u]));

  it('pins the first set unsigned, re-accepts it unchanged, and narrows unsigned', () => {
    const cloud = signer();
    const one = setOf([phones[0] as (typeof phones)[0]]);
    const first = evaluateRecipientKeys({}, one, undefined, { k1: cloud.raw });
    expect(first).toMatchObject({ accept: true, reason: 'first-pin' });
    if (!first.accept) throw new Error('unreachable');
    expect(first.keys).toEqual(flat([phones[0] as (typeof phones)[0]]));
    expect(first.features).toEqual({ imessage: true });
    expect(first.userId).toBe(userId);

    const pinned = flat([phones[0] as (typeof phones)[0], phones[1] as (typeof phones)[1]]);
    expect(
      evaluateRecipientKeys(
        pinned,
        setOf([phones[0] as (typeof phones)[0], phones[1] as (typeof phones)[1]]),
        undefined,
        {
          k1: cloud.raw,
        },
      ),
    ).toMatchObject({ accept: true, reason: 'unchanged' });
    // The user revoked a phone in the dashboard: dropping a key grants nothing new.
    expect(
      evaluateRecipientKeys(pinned, setOf([phones[0] as (typeof phones)[0]]), undefined, {
        k1: cloud.raw,
      }),
    ).toMatchObject({ accept: true, reason: 'narrowed' });
  });

  it('refuses an added phone that no pinned server key vouched for', () => {
    const cloud = signer();
    const attacker = signer();
    const pinned = flat([phones[0] as (typeof phones)[0]]);
    const widened = setOf([phones[0] as (typeof phones)[0], phones[1] as (typeof phones)[1]]);
    // A compromised gateway adding a key of its own is the whole threat: it would be able to
    // read every frame from that moment on, so this MUST be the signed path.
    expect(evaluateRecipientKeys(pinned, widened, undefined, { k1: cloud.raw })).toEqual({
      accept: false,
      reason: 'unsigned-change',
    });
    expect(
      evaluateRecipientKeys(pinned, widened, sign(attacker.pem, widened), { k1: cloud.raw }),
    ).toEqual({ accept: false, reason: 'bad-signature' });
    expect(
      evaluateRecipientKeys(pinned, widened, { keyId: 'k9', signature: 'x' }, { k1: cloud.raw }),
    ).toEqual({ accept: false, reason: 'unknown-signer' });
    // A signature over a DIFFERENT set does not carry over to this one.
    const other = setOf([phones[0] as (typeof phones)[0], phones[2] as (typeof phones)[2]]);
    expect(
      evaluateRecipientKeys(pinned, widened, sign(cloud.pem, other), { k1: cloud.raw }),
    ).toEqual({ accept: false, reason: 'bad-signature' });
  });

  it('accepts an addition and a re-point when a pinned server key signs them', () => {
    const cloud = signer();
    const pinned = flat([phones[0] as (typeof phones)[0]]);
    const widened = setOf([phones[0] as (typeof phones)[0], phones[1] as (typeof phones)[1]]);
    expect(
      evaluateRecipientKeys(pinned, widened, sign(cloud.pem, widened), { k1: cloud.raw }),
    ).toMatchObject({ accept: true, reason: 'signed' });
    // Re-pointing an existing kid is a widening too — but a kid IS its key's fingerprint, so the
    // re-point has to keep the pair consistent or `importRecipientKeys` refuses it first.
    const repointed = {
      ...setOf([phones[1] as (typeof phones)[1]]),
      keys: [
        {
          kid: (phones[1] as (typeof phones)[1]).kid,
          x25519: (phones[1] as (typeof phones)[1]).publicKeyB64u,
          name: 'iPhone 1',
          registeredAt: '2026-09-17T00:00:00.000Z',
        },
      ],
    };
    expect(
      evaluateRecipientKeys(pinned, repointed, sign(cloud.pem, repointed), { k1: cloud.raw }),
    ).toMatchObject({ accept: true, reason: 'signed' });
  });

  it('refuses a set that is malformed, or whose key does not fingerprint to its kid', () => {
    const cloud = signer();
    expect(
      evaluateRecipientKeys({}, { v: 2, userId, keys: [] }, undefined, { k1: cloud.raw }),
    ).toMatchObject({
      accept: false,
      reason: 'invalid-set',
    });
    expect(evaluateRecipientKeys({}, 'nope', undefined, { k1: cloud.raw })).toMatchObject({
      accept: false,
      reason: 'invalid-set',
    });
    // Someone else's key filed under a kid the user has verified out of band.
    const swapped = {
      ...setOf([phones[0] as (typeof phones)[0]]),
      keys: [
        {
          kid: (phones[0] as (typeof phones)[0]).kid,
          x25519: (phones[1] as (typeof phones)[1]).publicKeyB64u,
        },
      ],
    };
    expect(
      evaluateRecipientKeys({}, swapped, sign(cloud.pem, swapped), { k1: cloud.raw }),
    ).toMatchObject({ accept: false, reason: 'bad-keys' });
  });

  it('verifies over the set exactly as received, not over a re-serialised parse', () => {
    const cloud = signer();
    // A newer gateway adds a field this bridge has never heard of. The signature still covers it,
    // so stripping unknown keys before verifying would break every rotation on the next release.
    const forwardCompatible = setOf(
      [phones[0] as (typeof phones)[0], phones[1] as (typeof phones)[1]],
      {
        revocationHint: 'kid-2 retired',
      },
    );
    expect(
      evaluateRecipientKeys(
        flat([phones[0] as (typeof phones)[0]]),
        forwardCompatible,
        sign(cloud.pem, forwardCompatible),
        {
          k1: cloud.raw,
        },
      ),
    ).toMatchObject({ accept: true, reason: 'signed' });
  });

  it('is the same rule as the server key set, over a different document', () => {
    const a = signer();
    const b = signer();
    const verify = signedByOneOf({ k1: a.raw });
    expect(evaluateKeySet({}, { k1: a.raw }, undefined, verify, 'ctx:')).toEqual({
      accept: true,
      reason: 'first-pin',
    });
    expect(
      evaluateKeySet({ k1: a.raw }, { k1: a.raw, k2: b.raw }, undefined, verify, 'ctx:'),
    ).toEqual({
      accept: false,
      reason: 'unsigned-change',
    });
    const widened = { k1: a.raw, k2: b.raw };
    expect(
      evaluateKeySet(
        { k1: a.raw },
        widened,
        { keyId: 'k1', signature: signWithPem(a.pem, `ctx:${canonicalize(widened)}`) },
        verify,
        'ctx:',
      ),
    ).toEqual({ accept: true, reason: 'signed' });
    // `evaluateServerKeys` is that call with the pinned keys as the signers.
    expect(evaluateServerKeys({ k1: a.raw }, widened)).toEqual({
      accept: false,
      reason: 'unsigned-change',
    });
  });
});

describe('recipient keys over the wire', () => {
  const deviceId = ids.dev();
  let gw: FakeGateway;
  let client: GatewayClient;
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>> & { deviceId: string };
  let persisted: Array<Record<string, string>>;
  const cloud = (() => {
    const kp = generateKeyPairPem();
    return { pem: kp.privateKeyPem, raw: rawPublicKeyFromPem(kp.publicKeyPem) };
  })();
  const phoneA = generateRecipientKeyPair();
  const phoneB = generateRecipientKeyPair();
  const setOf = (keys: Array<{ kid: string; publicKeyB64u: string }>) => ({
    v: 1,
    userId: ids.usr(),
    keys: keys.map((k) => ({ kid: k.kid, x25519: k.publicKeyB64u })),
    features: { imessage: true },
    issuedAt: '2026-09-17T00:00:00.000Z',
  });
  const sign = (set: unknown): KeySetSignature => ({
    keyId: 'k1',
    signature: signWithPem(cloud.pem, `${RECIPIENT_KEY_SET_CONTEXT}${canonicalize(set)}`),
  });

  beforeEach(async () => {
    identity = (await loadOrCreateIdentity(new MemorySecretStore(), {
      deviceId,
    })) as typeof identity;
    gw = await startFakeGateway(identity.publicKeyRaw, deviceId);
    gw.serverKeys = { k1: cloud.raw };
    persisted = [];
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
      onCommand: () => {},
      onRecipientKeys: (k) => persisted.push(k),
      heartbeatMs: 1000,
      backoff: { baseMs: 20, maxMs: 100 },
      env: { PAGR_ENV: 'local' },
      ...over,
    });

  it('starts with nothing pinned and seals to nobody', async () => {
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.recipientKeys).toEqual({});
    expect(client.recipientKeyIds()).toEqual([]);
    expect(client.sealsToNobody).toBe(true);
    expect(persisted).toEqual([]);
  });

  it('pins the set from auth.result and reports it for hello v2', async () => {
    gw.recipientKeys = setOf([phoneA, phoneB]);
    gw.features = { imessage: true };
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.recipientKeys).toEqual({
      [phoneA.kid]: phoneA.publicKeyB64u,
      [phoneB.kid]: phoneB.publicKeyB64u,
    });
    expect(client.recipientKeyIds()).toEqual([phoneA.kid, phoneB.kid].sort());
    expect(client.sealsToNobody).toBe(false);
    expect(client.features).toEqual({ imessage: true });
    expect(persisted).toEqual([client.recipientKeys]);
  });

  it('ignores a v1 gateway that sends no recipient fields at all', async () => {
    gw.recipientKeys = null;
    client = make({ recipientKeys: { [phoneA.kid]: phoneA.publicKeyB64u } });
    client.start();
    await until(() => client.state === 'connected');
    expect(client.recipientKeys).toEqual({ [phoneA.kid]: phoneA.publicKeyB64u });
    expect(persisted).toEqual([]);
  });

  it('accepts a signed addition pushed as keys.updated, and persists it once', async () => {
    gw.recipientKeys = setOf([phoneA]);
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    expect(client.recipientKeyIds()).toEqual([phoneA.kid]);
    persisted.length = 0;

    const widened = setOf([phoneA, phoneB]);
    gw.sendRaw({
      kind: 'keys.updated',
      recipientKeys: widened,
      recipientKeysSignature: sign(widened),
    });
    await until(() => client.recipientKeyIds().length === 2);
    expect(client.recipientKeyIds()).toEqual([phoneA.kid, phoneB.kid].sort());
    expect(persisted).toHaveLength(1);
    // Re-sending the same set changes nothing and writes nothing.
    gw.sendRaw({
      kind: 'keys.updated',
      recipientKeys: widened,
      recipientKeysSignature: sign(widened),
    });
    await wait(50);
    expect(persisted).toHaveLength(1);
  });

  it('refuses an unsigned addition pushed as keys.updated and keeps the connection', async () => {
    const complaints: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (m) => {
        complaints.push(m);
      },
      child: () => logger,
    };
    gw.recipientKeys = setOf([phoneA]);
    client = make({ logger });
    client.start();
    await until(() => client.state === 'connected');
    gw.sendRaw({ kind: 'keys.updated', recipientKeys: setOf([phoneA, phoneB]) });
    await until(() => complaints.some((c) => /recipient key set/i.test(c)));
    expect(client.recipientKeyIds()).toEqual([phoneA.kid]);
    expect(persisted).toHaveLength(1); // only the first pin
    expect(client.state).toBe('connected');
  });

  it('accepts an unsigned revocation pushed as keys.updated', async () => {
    gw.recipientKeys = setOf([phoneA, phoneB]);
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    gw.sendRaw({ kind: 'keys.updated', recipientKeys: setOf([phoneA]) });
    await until(() => client.recipientKeyIds().length === 1);
    expect(client.recipientKeyIds()).toEqual([phoneA.kid]);
  });

  it('ignores a malformed keys.updated without dropping the socket', async () => {
    gw.recipientKeys = setOf([phoneA]);
    client = make();
    client.start();
    await until(() => client.state === 'connected');
    gw.sendRaw({ kind: 'keys.updated' });
    gw.sendRaw({ kind: 'keys.updated', recipientKeys: { v: 9 } });
    await wait(50);
    expect(client.recipientKeyIds()).toEqual([phoneA.kid]);
    expect(client.state).toBe('connected');
  });

  it('never puts a frame body on the wire in the clear', async () => {
    gw.recipientKeys = setOf([phoneA]);
    // `session.frame` is a v2-only event, so the link has to have agreed on v2 before one may be
    // emitted at all (MOB-030). That gate is what this test then sends a real sealed frame past.
    gw.protocolVersion = 2;
    client = make();
    client.start();
    await until(() => client.state === 'connected');

    const secret = 'ssh deploy@prod "psql -c \\"drop table users\\""';
    const aad = { sessionId: ids.ses(), seq: 3, kind: 'terminal' as const };
    const sealed = sealFrame(
      new TextEncoder().encode(JSON.stringify({ command: secret, exitCode: 0 })),
      aad,
      importRecipientKeys(client.recipientKeys),
    );
    const frame = makeEvent(deviceId, 'session.frame', {
      sessionId: aad.sessionId,
      projectId: ids.proj(),
      provider: 'claude',
      seq: aad.seq,
      kind: aad.kind,
      at: new Date().toISOString(),
      sealed,
      meta: { bytes: 64, truncated: false, source: 'stdio' },
    });
    expect(client.sendEvent(frame)).toBe(true);
    await until(() =>
      gw.frames.some((f) => f.kind === 'event' && f.event.type === 'session.frame'),
    );

    // Every byte this Mac has sent since it connected, frame by frame.
    expect(gw.frames.length).toBeGreaterThan(1);
    for (const f of gw.frames) {
      const wire = JSON.stringify(f);
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain('drop table');
      expect(wire).not.toContain('deploy@prod');
    }
    // …and the ciphertext really is on the wire, so the assertion above is not vacuous.
    expect(gw.frames.map((f) => JSON.stringify(f)).join('\n')).toContain(sealed.ct);
    // …and the phone, holding the private key, reads it back.
    expect(JSON.parse(new TextDecoder().decode(openFrame(sealed, aad, phoneA.privateKey)))).toEqual(
      { command: secret, exitCode: 0 },
    );
  });
});
