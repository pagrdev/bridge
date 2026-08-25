import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BridgeFrame, GatewayFrame, Provider } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { updateConfig } from './config.js';
import {
  createDaemon,
  type Daemon,
  installLaunchAgent,
  renderPlist,
  uninstallLaunchAgent,
} from './daemon.js';
import { verifyRaw } from './identity.js';
import { IpcClient } from './ipc.js';
import { MemorySecretStore } from './keychain.js';
import { FakeServerSigner, ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('daemon', () => {
  const t = useTempHome('pagr-daemon-');
  const deviceId = ids.dev();
  let signer: FakeServerSigner;
  let wss: WebSocketServer;
  let received: BridgeFrame[];
  let sockets: WebSocket[];
  let daemon: Daemon;
  let home: string;

  beforeEach(async () => {
    signer = new FakeServerSigner();
    received = [];
    sockets = [];
    home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const store = new MemorySecretStore();
    // pre-pair: identity is created by createDaemon; we need the public key for the fake gateway,
    // so create the daemon once unpaired to generate the key, then pair.
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
    const codex = new FakeAdapter('codex');
    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: store,
      heartbeatMs: 60_000,
      backoff: { baseMs: 20, maxMs: 50 },
      env: { PAGR_ENV: 'local' },
    });
    await daemon.start();
  });
  afterEach(async () => {
    await daemon.stop();
    await new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    });
  });

  const sendCommand = (envelope: unknown) => {
    for (const s of sockets) s.send(JSON.stringify({ kind: 'command', envelope }));
  };
  const acks = () =>
    received
      .filter((f) => f.kind === 'event' && f.event.type === 'command.ack')
      .map((f) => (f.kind === 'event' ? f.event : null));

  it('connects, sends device.hello, learns server keys, and runs a signed command end to end', async () => {
    await until(() => daemon.transport?.state === 'connected');
    await until(() => received.some((f) => f.kind === 'event' && f.event.type === 'device.hello'));
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).serverKeys).toEqual(
      signer.trustedKeys,
    );
    const status = await new IpcClient(daemon.paths.socketPath).call<{
      paired: boolean;
      transport: string;
    }>('status');
    expect(status).toMatchObject({ paired: true, transport: 'connected', deviceId });

    const probe = makeBody('device.probe', {}, { deviceId });
    sendCommand(signer.sign(probe));
    await until(() => acks().length === 1);
    expect(acks()[0]?.payload).toMatchObject({ commandId: probe.commandId, status: 'completed' });
    // exact resend (same idempotency key) → duplicate ack; reused nonce with a NEW key → replayed
    sendCommand(signer.sign(probe));
    await until(() => acks().length === 2);
    expect(acks()[1]?.payload).toMatchObject({ commandId: probe.commandId, status: 'duplicate' });
    sendCommand(signer.sign(makeBody('device.probe', {}, { deviceId, nonce: probe.nonce })));
    await until(() => acks().length === 3);
    expect(acks()[2]?.payload).toMatchObject({ status: 'rejected', errorCode: 'replayed' });
    // other device → rejected
    sendCommand(signer.sign(makeBody('device.probe', {}, { deviceId: ids.dev() })));
    await until(() => acks().length === 4);
    expect(acks()[3]?.payload).toMatchObject({ status: 'rejected', errorCode: 'wrong_device' });
    // idempotent retry with new nonce → duplicate
    sendCommand(
      signer.sign(makeBody('device.probe', {}, { deviceId, idempotencyKey: probe.idempotencyKey })),
    );
    await until(() => acks().length === 5);
    expect(acks()[4]?.payload).toMatchObject({ commandId: probe.commandId, status: 'duplicate' });
    expect(
      received
        .filter((f) => f.kind === 'event')
        .every((f) => f.kind === 'event' && f.event.deviceId === deviceId),
    ).toBe(true);
  });

  it('IPC: projects.add/list/remove, sessions.list, agent.event, approval.request round trip with cloud decision', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    await expect(c.call('projects.add', { path: join(t.home, 'nope') })).rejects.toMatchObject({
      code: 'not_found',
    });
    const proj = await c.call<{ projectId: string; path: string }>('projects.add', {
      path: repo,
      displayName: 'Repo',
    });
    expect(proj.projectId).toMatch(/^proj_/);
    expect((await c.call<unknown[]>('projects.list')).length).toBe(1);
    await until(() =>
      received.some((f) => f.kind === 'event' && f.event.type === 'project.registered'),
    );
    expect(await c.call('sessions.list')).toEqual([]);
    await c.call('agent.event', {
      provider: 'claude',
      sessionId: ids.ses(),
      projectId: proj.projectId,
      type: 'progress',
      summary: 'hi',
    });
    await until(() => received.some((f) => f.kind === 'event' && f.event.type === 'session.event'));

    const sessionId = ids.ses();
    const pending = c.call<{ approvalId: string; decision: string; resolution: string }>(
      'approval.request',
      {
        sessionId,
        projectId: proj.projectId,
        provider: 'claude',
        providerRequestId: 'hook-77',
        actionType: 'tool_use',
        preview: 'Bash(git push)',
        hints: { gitPush: true },
      },
      5000,
    );
    await until(() =>
      received.some((f) => f.kind === 'event' && f.event.type === 'approval.requested'),
    );
    const req = received.find((f) => f.kind === 'event' && f.event.type === 'approval.requested');
    const payload = (req && req.kind === 'event' ? req.event.payload : null) as unknown as {
      approvalId: string;
      previewHash: string;
      hints: { gitPush: boolean };
    };
    expect(payload.hints.gitPush).toBe(true);
    expect((await c.call<unknown[]>('approvals.list')).length).toBe(1);
    // cloud must know the session for respond_to_approval to pass the guard: record one
    daemon.sessions.upsert({
      sessionId,
      provider: 'claude',
      projectId: proj.projectId,
      providerSessionId: 'x',
      status: 'waiting_for_approval',
      startedAt: new Date().toISOString(),
    });
    sendCommand(
      signer.sign(
        makeBody(
          'agent.respond_to_approval',
          {
            approvalId: payload.approvalId,
            sessionId,
            providerRequestId: 'hook-77',
            previewHash: payload.previewHash,
            decision: 'deny',
          },
          { deviceId },
        ),
      ),
    );
    expect(await pending).toEqual({
      approvalId: payload.approvalId,
      decision: 'deny',
      resolution: 'denied',
    });
    await until(() => acks().length === 1);
    expect(acks()[0]?.payload).toMatchObject({ status: 'completed' });
    await c.call('projects.remove', { projectId: proj.projectId });
    expect(await c.call('projects.list')).toEqual([]);
  });

  it('IPC approval.request with sessionId=null + cwd maps to a project and a synthetic session (finding 12)', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const proj = await c.call<{ projectId: string }>('projects.add', { path: repo });
    // unregistered cwd → unknown_project, nothing emitted
    await expect(
      c.call('approval.request', {
        sessionId: null,
        cwd: join(t.home, 'elsewhere'),
        provider: 'claude',
        providerRequestId: 'hook-1',
        actionType: 'tool_use',
        preview: 'Bash(ls)',
      }),
    ).rejects.toMatchObject({ code: 'unknown_project' });
    // missing both sessionId/projectId and cwd → invalid
    await expect(
      c.call('approval.request', {
        sessionId: null,
        provider: 'claude',
        providerRequestId: 'hook-1',
        actionType: 'tool_use',
        preview: 'Bash(ls)',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const claudeSessionId = 'abc81286-92f3-4c72-b6a8-72e216749504';
    const pending = c.call<{ approvalId: string; decision: string; resolution: string }>(
      'approval.request',
      {
        sessionId: null,
        claudeSessionId,
        cwd: join(repo, 'src'),
        provider: 'claude',
        providerRequestId: 'hook-2',
        actionType: 'command_execution',
        preview: '$ git push',
        hints: { gitPush: true },
      },
      5000,
    );
    await until(() =>
      received.some((f) => f.kind === 'event' && f.event.type === 'approval.requested'),
    );
    const req = received.find((f) => f.kind === 'event' && f.event.type === 'approval.requested');
    const payload = (req && req.kind === 'event' ? req.event.payload : null) as unknown as {
      approvalId: string;
      sessionId: string;
      projectId: string;
      previewHash: string;
    };
    expect(payload.projectId).toBe(proj.projectId);
    expect(payload.sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    // a synthetic local session record exists so respond_to_approval passes the command guard,
    // and the cloud was told about it via session.updated before approval.requested
    const rec = daemon.sessions.get(payload.sessionId);
    expect(rec).toMatchObject({
      provider: 'claude',
      projectId: proj.projectId,
      providerSessionId: claudeSessionId,
      status: 'waiting_for_approval',
    });
    const idx = (type: string) =>
      received.findIndex((f) => f.kind === 'event' && f.event.type === type);
    expect(idx('session.updated')).toBeGreaterThanOrEqual(0);
    expect(idx('session.updated')).toBeLessThan(idx('approval.requested'));
    sendCommand(
      signer.sign(
        makeBody(
          'agent.respond_to_approval',
          {
            approvalId: payload.approvalId,
            sessionId: payload.sessionId,
            providerRequestId: 'hook-2',
            previewHash: payload.previewHash,
            decision: 'allow',
          },
          { deviceId },
        ),
      ),
    );
    expect(await pending).toEqual({
      approvalId: payload.approvalId,
      decision: 'allow',
      resolution: 'allowed',
    });
    await until(() => acks().length === 1);
    expect(acks()[0]?.payload).toMatchObject({ status: 'completed' });
    // the same interactive claude session maps to the same synthetic id next time
    const again = c.call<{ approvalId: string }>(
      'approval.request',
      {
        sessionId: null,
        claudeSessionId,
        cwd: repo,
        provider: 'claude',
        providerRequestId: 'hook-3',
        actionType: 'tool_use',
        preview: 'Read x',
      },
      5000,
    );
    await until(
      () =>
        received.filter((f) => f.kind === 'event' && f.event.type === 'approval.requested')
          .length === 2,
    );
    const second = received.filter(
      (f) => f.kind === 'event' && f.event.type === 'approval.requested',
    )[1];
    expect(
      (second && second.kind === 'event' ? second.event.payload : null) as unknown as {
        sessionId: string;
      },
    ).toMatchObject({ sessionId: payload.sessionId });
    expect(daemon.dispatcher.approvals.list()).toHaveLength(1);
    await daemon.dispatcher.approvals.cancelAll();
    await again;
  });

  it('starts with a very long PAGR_HOME by using the short runtime socket (item 14)', async () => {
    const home2 = join(t.home, 'l'.repeat(110), 'pagr');
    const d2 = await createDaemon({
      home: home2,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
    });
    await d2.start();
    try {
      expect(Buffer.byteLength(d2.paths.socketPath)).toBeLessThanOrEqual(100);
      expect(await new IpcClient(d2.paths.socketPath).call('status')).toMatchObject({
        socketPath: d2.paths.socketPath,
      });
      expect(readFileSync(join(home2, 'run', 'daemon.sock.path'), 'utf8').trim()).toBe(
        d2.paths.socketPath,
      );
    } finally {
      await d2.stop();
    }
  });

  it('runs unpaired: IPC works, no transport', async () => {
    const home2 = join(t.home, 'unpaired');
    const d2 = await createDaemon({
      home: home2,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
    });
    await d2.start();
    try {
      expect(d2.transport).toBeNull();
      expect(await new IpcClient(d2.paths.socketPath).call('status')).toMatchObject({
        paired: false,
        transport: 'unpaired',
      });
    } finally {
      await d2.stop();
    }
  });
});

describe('launch agent', () => {
  const t = useTempHome('pagr-la-');
  it('writes plist and calls launchctl bootstrap/bootout', () => {
    const calls: string[][] = [];
    const exec = (_f: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'bootout' && calls.length === 1) throw new Error('not loaded');
    };
    const dir = join(t.home, 'LaunchAgents');
    const plist = installLaunchAgent({
      programArguments: ['/usr/local/bin/node', '/x/pagr.js', 'daemon', 'run'],
      logsDir: join(t.home, 'logs'),
      launchAgentsDir: dir,
      uid: 501,
      exec,
      env: { PAGR_HOME: '/h/<x>' },
    });
    const xml = readFileSync(plist, 'utf8');
    expect(xml).toContain('<string>dev.pagr.bridge</string>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('/h/&lt;x&gt;');
    expect(xml).toContain('launchd.err.log');
    expect(calls).toEqual([
      ['bootout', 'gui/501/dev.pagr.bridge'],
      ['bootstrap', 'gui/501', plist],
    ]);
    expect(renderPlist({ programArguments: ['a'], logsDir: '/l' })).not.toContain(
      'EnvironmentVariables',
    );
    expect(uninstallLaunchAgent({ launchAgentsDir: dir, uid: 501, exec })).toBe(true);
    expect(calls.at(-1)).toEqual(['bootout', 'gui/501/dev.pagr.bridge']);
    expect(uninstallLaunchAgent({ launchAgentsDir: dir, uid: 501, exec })).toBe(false);
    vi.restoreAllMocks();
  });
});
