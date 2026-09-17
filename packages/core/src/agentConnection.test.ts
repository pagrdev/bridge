import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BridgeFrame, GatewayFrame, Provider } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { updateConfig } from './config.js';
import { createDaemon, type Daemon } from './daemon.js';
import { verifyRaw } from './identity.js';
import { MemorySecretStore } from './keychain.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * `agent.connection` is emitted on CHANGE, and only on change.
 *
 * The phone's "this Mac can take a turn" affordance is driven by this event, so a bridge that
 * re-announced an unchanged status every minute would be a push notification a minute for
 * nothing — and a bridge that only announced it on connect would leave the affordance up for a
 * terminal that was closed twenty minutes ago.
 */
describe('agent.connection', () => {
  const t = useTempHome('pagr-agent-conn-');
  const deviceId = ids.dev();
  let wss: WebSocketServer;
  let received: BridgeFrame[];
  let sockets: WebSocket[];
  let daemon: Daemon;
  let claude: FakeAdapter;
  let codex: FakeAdapter;
  let home: string;

  const connections = () =>
    received
      .filter((f) => f.kind === 'event' && f.event.type === 'agent.connection')
      .map((f) => (f.kind === 'event' ? f.event.payload : null));

  beforeEach(async () => {
    received = [];
    sockets = [];
    home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const store = new MemorySecretStore();
    const pre = await createDaemon({ home, adapters: new Map(), secretStore: store });
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', r));
    wss.on('connection', (sock) => {
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
          const res: GatewayFrame = { kind: 'auth.result', ok, protocolVersion: 2 };
          sock.send(JSON.stringify(res));
        }
      });
    });
    updateConfig(join(home, 'config.json'), {
      deviceId,
      userId: ids.usr(),
      gatewayUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      serverKeys: {},
    });
    claude = new FakeAdapter('claude');
    codex = new FakeAdapter('codex');
    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['claude', claude],
        ['codex', codex],
      ]),
      secretStore: store,
      heartbeatMs: 60_000,
      backoff: { baseMs: 20, maxMs: 50 },
      env: { PAGR_ENV: 'local' },
      // The real cadence is a minute; the behaviour under test is the diff, not the interval.
      agentConnectionPollMs: 15,
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

  it('announces both agents once, then says nothing while nothing changes', async () => {
    await until(() => connections().length >= 2);
    const first = connections().length;
    expect(first).toBe(2);
    expect(
      connections()
        .map((p) => (p as { provider: string }).provider)
        .sort(),
    ).toEqual(['claude', 'codex']);
    // Several more ticks go by with the same answer from both probes.
    await new Promise((r) => setTimeout(r, 120));
    expect(connections().length).toBe(first);
    // …and the probes really did run, so the silence is a diff, not a dead timer.
    expect(claude.calls.filter((c) => c.method === 'probe').length).toBeGreaterThan(2);
  });

  it('emits exactly once for one change, and only for the agent that changed', async () => {
    await until(() => connections().length >= 2);
    const before = connections().length;
    // A channel attaching or detaching is what moves this in real life; the fake's `canSteer`
    // moves the same field of the same probe answer.
    claude.canSteer = false;
    await until(() => connections().length > before);
    await new Promise((r) => setTimeout(r, 120));
    const after = connections().slice(before);
    expect(after).toHaveLength(1);
    expect((after[0] as { provider: string }).provider).toBe('claude');
    expect(
      (after[0] as { capabilities: { canSteerActiveTurn: boolean } }).capabilities
        .canSteerActiveTurn,
    ).toBe(false);
  });

  it('a probe that throws says nothing, and the next change still lands', async () => {
    await until(() => connections().length >= 2);
    const before = connections().length;
    codex.failNext = new Error('codex went away mid-probe');
    await new Promise((r) => setTimeout(r, 80));
    expect(connections().length).toBe(before);
    codex.canSteer = false;
    await until(() => connections().length > before);
    expect((connections().at(-1) as { provider: string }).provider).toBe('codex');
  });
});
