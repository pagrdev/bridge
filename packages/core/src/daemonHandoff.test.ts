import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BridgeFrame, GatewayFrame, Provider, SessionSummary } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { updateConfig } from './config.js';
import { createDaemon, type Daemon } from './daemon.js';
import { HANDOFF_DIR } from './handoff/format.js';
import { verifyRaw } from './identity.js';
import { IpcClient } from './ipc.js';
import { MemorySecretStore } from './keychain.js';
import { FakeServerSigner, ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

/**
 * The daemon's local front door for `pagr handoff` — `handoff.capture` and `handoff.start`.
 *
 * What is under test here is the wiring, not the switch: that a command minted on this Mac runs
 * through the same dispatcher a signed one does, that its refusals come back as IPC errors the
 * CLI can map to exit codes, and — the invariant that made the local path worth thinking about —
 * that the ack it produces is NOT sent to a gateway that never issued the command.
 *
 * The switch itself (write, commit, stop, seal) is covered against fakes in `switch.test.ts` and
 * `dispatcherHandoff.test.ts`. Nothing here touches a real repository or a real agent.
 */

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('daemon · handoff over IPC', () => {
  const t = useTempHome('pagr-handoff-ipc-');
  let daemon: Daemon | null = null;
  let codex: FakeAdapter;
  let client: IpcClient;
  let projectId: string;
  let repo: string;

  beforeEach(async () => {
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    codex = new FakeAdapter('codex');
    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
      env: {},
    });
    projectId = daemon.registry.add(repo).projectId;
    // Unpaired: `start` binds the IPC socket and never opens a gateway connection, which is
    // exactly the offline Mac `pagr handoff` is meant to work on.
    await daemon.start();
    client = new IpcClient(daemon.paths.socketPath);
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
  });

  it('refuses a capture for a session this Mac has never seen', async () => {
    await expect(
      client.call('handoff.capture', { sessionId: ids.ses(), to: 'codex' }),
    ).rejects.toMatchObject({ code: 'unknown_session' });
  });

  it('refuses a capture whose `to` is not an agent, before anything runs', async () => {
    await expect(
      client.call('handoff.capture', { sessionId: ids.ses(), to: 'cursor' }),
    ).rejects.toBeTruthy();
  });

  it('starts the receiving agent on the handoff, with the standard instruction', async () => {
    const handoffId = `hnd_${'a'.repeat(32)}`;
    const summary = await client.call<SessionSummary>('handoff.start', {
      handoffId,
      provider: 'codex',
      projectId,
    });
    expect(summary.sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    const started = codex.calls.find((c) => c.method === 'startSession');
    expect(started?.args).toMatchObject({
      instruction: `Read ${HANDOFF_DIR}/${handoffId}.md and continue the task it describes.`,
      readOnly: false,
    });
    // The session is now this Mac's, under the id the daemon minted rather than one the cloud
    // pre-allocated: a local handoff has no cloud row to join to.
    expect(daemon?.sessions.get(summary.sessionId)?.projectId).toBe(projectId);
  });

  it('refuses to start in a directory that is not a registered project', async () => {
    await expect(
      client.call('handoff.start', {
        handoffId: `hnd_${'a'.repeat(32)}`,
        provider: 'codex',
        projectId: `prj_${'f'.repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: 'unknown_project' });
  });

  it('refuses a handoff id that is not one', async () => {
    await expect(
      client.call('handoff.start', { handoffId: 'hnd_nope', provider: 'codex', projectId }),
    ).rejects.toBeTruthy();
  });

  it('reports the adapter’s own failure as the IPC error, not as success', async () => {
    codex.failNext = new Error('codex is not signed in on this Mac');
    await expect(
      client.call('handoff.start', {
        handoffId: `hnd_${'a'.repeat(32)}`,
        provider: 'codex',
        projectId,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('not signed in') });
  });
});

describe('daemon · a local command’s ack never reaches the gateway', () => {
  const t = useTempHome('pagr-handoff-ack-');
  const deviceId = ids.dev();
  let wss: WebSocketServer;
  let sockets: WebSocket[];
  let received: BridgeFrame[];
  let daemon: Daemon;
  let projectId: string;

  beforeEach(async () => {
    received = [];
    sockets = [];
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const store = new MemorySecretStore();
    const signer = new FakeServerSigner();
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
          const res: GatewayFrame = { kind: 'auth.result', ok, serverKeys: signer.trustedKeys };
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
    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', new FakeAdapter('codex')]]),
      secretStore: store,
      heartbeatMs: 60_000,
      backoff: { baseMs: 20, maxMs: 50 },
      env: { PAGR_ENV: 'local' },
    });
    projectId = daemon.registry.add(repo).projectId;
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    });
  });

  it('sends session.updated but no command.ack for a handoff started from the terminal', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const client = new IpcClient(daemon.paths.socketPath);
    const summary = await client.call<SessionSummary>('handoff.start', {
      handoffId: `hnd_${'a'.repeat(32)}`,
      provider: 'codex',
      projectId,
    });
    await until(() =>
      received.some(
        (f) =>
          f.kind === 'event' &&
          f.event.type === 'session.updated' &&
          (f.event.payload as SessionSummary).sessionId === summary.sessionId,
      ),
    );
    // The start really happened and the phone was told about it — and the ack for a command the
    // cloud never signed was withheld, so `command.ack` stays "exactly once per RECEIVED command".
    const acks = received.filter((f) => f.kind === 'event' && f.event.type === 'command.ack');
    expect(acks).toEqual([]);
  });
});
