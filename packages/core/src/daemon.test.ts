import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  classifyStartFailure,
  createDaemon,
  type Daemon,
  DaemonStartRefused,
  installLaunchAgent,
  renderPlist,
  startDaemon,
  uninstallLaunchAgent,
} from './daemon.js';
import { DaemonAlreadyRunningError } from './daemonLock.js';
import { InvalidDeviceKeyError, verifyRaw } from './identity.js';
import { IpcClient } from './ipc.js';
import type { KeepAwakeSpawn } from './keepAwake.js';
import { MemorySecretStore, SecretStoreError } from './keychain.js';
import { DAEMON_EXIT } from './launchAgent.js';
import { PagrHomeError } from './paths.js';
import { generateRecipientKeyPair } from './seal.js';
import { DEFAULT_SESSION_RETENTION_MS, UNREGISTERED_PROJECT } from './sessions.js';
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

  it('pins the phones it seals for into config.json and reports them for hello v2', async () => {
    await until(() => daemon.transport?.state === 'connected');
    expect(daemon.recipientKeys).toEqual({});
    expect(daemon.recipientKeyIds()).toEqual([]);

    const phone = generateRecipientKeyPair();
    const set = {
      v: 1,
      userId: ids.usr(),
      keys: [{ kid: phone.kid, x25519: phone.publicKeyB64u, name: 'iPhone' }],
      features: { imessage: false },
      issuedAt: '2026-09-17T00:00:00.000Z',
    };
    for (const s of sockets) s.send(JSON.stringify({ kind: 'keys.updated', recipientKeys: set }));
    await until(() => daemon.recipientKeyIds().length === 1);

    expect(daemon.recipientKeys).toEqual({ [phone.kid]: phone.publicKeyB64u });
    // It survives a restart: the phone is pinned on disk, not only in this process.
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      recipientKeys: Record<string, string>;
      recipientKeysUpdatedAt: string;
    };
    expect(cfg.recipientKeys).toEqual({ [phone.kid]: phone.publicKeyB64u });
    expect(Date.parse(cfg.recipientKeysUpdatedAt)).not.toBeNaN();
  });

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
    // exact resend → the cached terminal ack (not `replayed`); reused nonce with a NEW key → replayed
    sendCommand(signer.sign(probe));
    await until(() => acks().length === 2);
    expect(acks()[1]?.payload).toMatchObject({ commandId: probe.commandId, status: 'completed' });
    sendCommand(signer.sign(makeBody('device.probe', {}, { deviceId, nonce: probe.nonce })));
    await until(() => acks().length === 3);
    expect(acks()[2]?.payload).toMatchObject({ status: 'rejected', errorCode: 'replayed' });
    // other device → rejected
    sendCommand(signer.sign(makeBody('device.probe', {}, { deviceId: ids.dev() })));
    await until(() => acks().length === 4);
    expect(acks()[3]?.payload).toMatchObject({ status: 'rejected', errorCode: 'wrong_device' });
    // idempotent retry with new nonce → the original command's ack, not a second execution
    sendCommand(
      signer.sign(makeBody('device.probe', {}, { deviceId, idempotencyKey: probe.idempotencyKey })),
    );
    await until(() => acks().length === 5);
    expect(acks()[4]?.payload).toMatchObject({ commandId: probe.commandId, status: 'completed' });
    expect(
      received
        .filter((f) => f.kind === 'event')
        .every((f) => f.kind === 'event' && f.event.deviceId === deviceId),
    ).toBe(true);
  });

  it('IPC: an AskUserQuestion from the hook becomes a question, answered with updatedInput', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const repo = join(t.home, 'ask-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const proj = await c.call<{ projectId: string }>('projects.add', { path: repo });
    const questions = [
      {
        question: 'Do you prefer option A or option B?',
        header: 'Preference',
        multiSelect: false,
        options: [{ label: 'Option A' }, { label: 'Option B' }],
      },
    ];
    const sessionId = ids.ses();
    const pending = c.call<{
      approvalId: string;
      decision: string | null;
      resolution: string;
      updatedInput?: Record<string, unknown>;
    }>(
      'approval.request',
      {
        sessionId,
        projectId: proj.projectId,
        provider: 'claude',
        providerRequestId: 'hook-ask-1',
        actionType: 'tool_use',
        preview: 'AskUserQuestion',
        toolName: 'AskUserQuestion',
        questions,
      },
      5000,
    );
    // It became a question, not an approval card. (`question.asked` is v2-only and this fake
    // gateway negotiated v1, so the wire is the wrong place to look; the registry is not.)
    await until(() => daemon.dispatcher.questions.list().length === 1);
    expect(received.some((f) => f.kind === 'event' && f.event.type === 'approval.requested')).toBe(
      false,
    );
    expect(daemon.dispatcher.approvals.list()).toEqual([]);
    const record = daemon.dispatcher.questions.list()[0];
    if (!record) throw new Error('unreachable');
    expect(record).toMatchObject({
      sessionId,
      providerRequestId: 'hook-ask-1',
      answerable: true,
      multiSelect: [false],
      optionCount: [2],
      secret: [false],
    });
    daemon.sessions.upsert({
      sessionId,
      provider: 'claude',
      projectId: proj.projectId,
      providerSessionId: 'x',
      status: 'waiting_for_user',
      startedAt: new Date().toISOString(),
    });
    sendCommand(
      signer.sign(
        makeBody(
          'agent.answer_question',
          {
            questionId: record.questionId,
            sessionId,
            providerRequestId: 'hook-ask-1',
            answers: [{ questionIndex: 0, optionIndexes: [1] }],
          },
          { deviceId },
        ),
      ),
    );
    // The hook is handed the answer to print back to Claude, keyed by the question text.
    expect(await pending).toMatchObject({
      decision: 'allow',
      resolution: 'answered',
      updatedInput: {
        questions,
        answers: { 'Do you prefer option A or option B?': 'Option B' },
      },
    });
    await until(() => acks().length === 1);
    expect(acks()[0]?.payload).toMatchObject({ status: 'completed' });
    expect(daemon.dispatcher.questions.list()).toEqual([]);
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
    // BR-20: an event must name a session this daemon owns, and agree with the record about
    // provider and project. Anything else is a local process fabricating a phone notification.
    const eventSession = ids.ses();
    await expect(
      c.call('agent.event', {
        provider: 'claude',
        sessionId: eventSession,
        projectId: proj.projectId,
        type: 'progress',
        summary: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'unknown_session' });
    daemon.sessions.upsert({
      sessionId: eventSession,
      provider: 'claude',
      projectId: proj.projectId,
      providerSessionId: eventSession,
      status: 'working',
      startedAt: new Date().toISOString(),
    });
    await expect(
      c.call('agent.event', {
        provider: 'codex',
        sessionId: eventSession,
        projectId: proj.projectId,
        type: 'progress',
        summary: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      c.call('agent.event', {
        provider: 'claude',
        sessionId: eventSession,
        projectId: `proj_${'b'.repeat(32)}`,
        type: 'progress',
        summary: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await c.call('agent.event', {
      provider: 'claude',
      sessionId: eventSession,
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

  /**
   * Adoption. A permission hook fires inside somebody's own `claude`, in a directory the bridge
   * never started anything in. That session is real whether or not its directory happens to be a
   * registered project, and the point of the hook is that Pagr works for sessions it did not
   * start — so the daemon records it either way.
   */
  it('adopts a provider session it did not start, recording provider, cwd and first-seen', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const repo = join(t.home, 'adopt-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const proj = await c.call<{ projectId: string }>('projects.add', { path: repo });
    const claudeSessionId = '11111111-2222-3333-4444-555555555555';
    const pending = c.call<{ approvalId: string }>(
      'approval.request',
      {
        sessionId: null,
        claudeSessionId,
        cwd: repo,
        provider: 'claude',
        providerRequestId: 'adopt-1',
        actionType: 'tool_use',
        preview: 'Read x',
      },
      5000,
    );
    await until(() =>
      received.some((f) => f.kind === 'event' && f.event.type === 'approval.requested'),
    );
    const rec = daemon.sessions.list().find((r) => r.providerSessionId === claudeSessionId);
    expect(rec).toMatchObject({
      provider: 'claude',
      projectId: proj.projectId,
      providerSessionId: claudeSessionId,
      adopted: true,
      cwd: repo,
    });
    expect(Date.parse(rec?.adoptedAt ?? '')).not.toBeNaN();
    // Adopted sessions are counted separately in the status the user sees, because what Pagr can
    // do with one is not what it can do with a session it started.
    expect(daemon.status().adoptedSessions).toBe(1);
    void pending.catch(() => {});
  });

  it('adopts a session whose directory is in no registered project, and still answers no decision', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const elsewhere = join(t.home, 'not-a-project');
    mkdirSync(elsewhere, { recursive: true });
    const claudeSessionId = '99999999-8888-7777-6666-555555555555';
    // The hook treats an error as "no decision" and prints nothing, so the terminal prompt this
    // person is looking at behaves exactly as it would with no Pagr installed.
    await expect(
      c.call('approval.request', {
        sessionId: null,
        claudeSessionId,
        cwd: elsewhere,
        provider: 'claude',
        providerRequestId: 'adopt-2',
        actionType: 'tool_use',
        preview: 'Read x',
      }),
    ).rejects.toMatchObject({ code: 'unknown_project' });
    // …but the session is real, so it is recorded and reportable locally.
    const rec = daemon.sessions.list().find((r) => r.providerSessionId === claudeSessionId);
    expect(rec).toMatchObject({
      provider: 'claude',
      projectId: UNREGISTERED_PROJECT,
      adopted: true,
      cwd: elsewhere,
      status: 'idle',
    });
    expect(await c.call<unknown[]>('sessions.list')).toHaveLength(1);
    expect(daemon.status().adoptedSessions).toBe(1);
    // Nothing about it went to the cloud: a SessionSummary has to name a project.
    expect(
      received.filter((f) => f.kind === 'event' && f.event.type === 'session.updated'),
    ).toHaveLength(0);
  });

  it('tells the cloud about an adopted session in a registered project, in device.hello', async () => {
    await until(() => daemon.transport?.state === 'connected');
    const c = new IpcClient(daemon.paths.socketPath);
    const repo = join(t.home, 'hello-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const proj = await c.call<{ projectId: string }>('projects.add', { path: repo });
    const pending = c.call<unknown>(
      'approval.request',
      {
        sessionId: null,
        claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd: repo,
        provider: 'claude',
        providerRequestId: 'hello-1',
        actionType: 'tool_use',
        preview: 'Read x',
      },
      5000,
    );
    await until(() =>
      received.some((f) => f.kind === 'event' && f.event.type === 'approval.requested'),
    );
    const hello = await daemon.dispatcher.probe();
    const adopted = hello.sessions.find((x) => x.projectId === proj.projectId);
    expect(adopted).toBeTruthy();
    expect(adopted?.provider).toBe('claude');
    void pending.catch(() => {});
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
        preview: '$ git status',
        hints: {},
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

describe('daemon single instance', () => {
  const t = useTempHome('pagr-daemon-single-');
  const mk = (home: string) =>
    createDaemon({ home, adapters: new Map(), secretStore: new MemorySecretStore() });

  it('a second daemon on the same home fails with a clear error and never unlinks the live socket', async () => {
    const home = join(t.home, 'pagr');
    const first = await mk(home);
    await first.start();
    const lockFile = join(home, 'run', 'daemon.lock');
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
    const second = await mk(home);
    let err: unknown;
    try {
      await second.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((err as Error).message).toBe(
      `another pagr daemon is already running for ${home} (pid ${process.pid})`,
    );
    await second.stop(); // non-owner shutdown: lock + socket must survive
    expect(existsSync(lockFile)).toBe(true);
    expect(existsSync(first.paths.socketPath)).toBe(true);
    expect(
      await new IpcClient(first.paths.socketPath).call<{ pid: number }>('status'),
    ).toMatchObject({ pid: process.pid });
    await first.stop();
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(first.paths.socketPath)).toBe(false);
  });

  it('reclaims a stale lock left by a dead pid', async () => {
    const home = join(t.home, 'pagr');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'daemon.lock'), '2147483000\n');
    const d = await mk(home);
    await d.start();
    expect(readFileSync(join(home, 'run', 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid));
    await d.stop();
  });
});

describe('daemon startup reconciliation', () => {
  const t = useTempHome('pagr-daemon-recon-');

  const seed = (home: string, records: Array<Record<string, unknown>>) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'sessions.json'),
      JSON.stringify(Object.fromEntries(records.map((r) => [r.sessionId as string, r]))),
    );
  };

  /**
   * Seed timestamps are always relative to *now*.
   *
   * `daemon.start()` prunes terminal sessions older than `DEFAULT_SESSION_RETENTION_MS` before it
   * reconciles, so a hard-coded calendar date here quietly stops testing anything once it drifts
   * past the retention window — the `completed` row is deleted instead of kept, and the assertion
   * that it survives starts failing on a date nobody chose. Anything seeded for reconciliation
   * must therefore be younger than the retention window by construction.
   */
  const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

  const rec = (over: Record<string, unknown> = {}) => {
    const at = agoIso(1000);
    return {
      sessionId: ids.ses(),
      provider: 'codex',
      projectId: ids.proj(),
      providerSessionId: 'thr_1',
      status: 'working',
      startedAt: at,
      updatedAt: at,
      ...over,
    };
  };

  it('never leaves a session claiming to work after a restart', async () => {
    const home = join(t.home, 'pagr');
    const zombie = rec({ status: 'working' });
    const waiting = rec({ status: 'waiting_for_approval' });
    const done = rec({ status: 'completed' });
    seed(home, [zombie, waiting, done]);
    const codex = new FakeAdapter('codex');
    const d = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
    });
    await d.start();
    try {
      expect(d.sessions.get(zombie.sessionId as string)?.status).toBe('stopped');
      expect(d.sessions.get(waiting.sessionId as string)?.status).toBe('stopped');
      expect(d.sessions.get(done.sessionId as string)?.status).toBe('completed');
      expect(d.dispatcher.activeSessionCount()).toBe(0);
    } finally {
      await d.stop();
    }
  });

  it('prunes terminal sessions past the retention window at startup, keeps fresh ones', async () => {
    const home = join(t.home, 'pagr');
    const stale = rec({
      status: 'completed',
      updatedAt: agoIso(DEFAULT_SESSION_RETENTION_MS + 1000),
    });
    const fresh = rec({
      status: 'completed',
      updatedAt: agoIso(DEFAULT_SESSION_RETENTION_MS - 60_000),
    });
    seed(home, [stale, fresh]);
    const d = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', new FakeAdapter('codex')]]),
      secretStore: new MemorySecretStore(),
    });
    await d.start();
    try {
      expect(d.sessions.get(stale.sessionId as string)).toBeNull();
      expect(d.sessions.get(fresh.sessionId as string)?.status).toBe('completed');
    } finally {
      await d.stop();
    }
  });

  it('re-attaches a session the provider can still resume', async () => {
    const home = join(t.home, 'pagr');
    const live = rec({ status: 'working' });
    seed(home, [live]);
    const codex = new FakeAdapter('codex');
    codex.sessions.set(live.sessionId as string, {
      sessionId: live.sessionId as string,
      projectId: live.projectId as string,
      provider: 'codex',
      status: 'idle',
      activeTurn: false,
      startedAt: live.startedAt as string,
      updatedAt: live.updatedAt as string,
    });
    const d = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
    });
    await d.start();
    try {
      expect(d.sessions.get(live.sessionId as string)?.status).toBe('idle');
    } finally {
      await d.stop();
    }
  });

  it('bounds sessions.json on startup', async () => {
    const home = join(t.home, 'pagr');
    const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    seed(
      home,
      Array.from({ length: 6 }, () => rec({ status: 'completed', updatedAt: old })),
    );
    const d = await createDaemon({
      home,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
    });
    await d.start();
    try {
      expect(d.sessions.size).toBe(0); // all far past the retention window
    } finally {
      await d.stop();
    }
  });

  it('answers channel.status honestly: registered by default, nothing attached', async () => {
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const d = await createDaemon({
      home,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
      env: {},
    });
    await d.start();
    try {
      const via = await new IpcClient(d.paths.socketPath).call<{
        enabled: boolean;
        canSteerLive: boolean;
      }>('channel.status');
      expect(via).toEqual({
        enabled: true,
        attachedProjects: [],
        canSteerLive: false,
        boundSessions: 0,
      });
      expect(d.channelStatus().enabled).toBe(true);
    } finally {
      await d.stop();
    }
  });
});

describe('startDaemon exit contract (BR-11)', () => {
  const t = useTempHome('pagr-start-');
  let seq = 0;
  let home: string;
  let exits: number[];
  let stderr: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  const pair = (over: Record<string, unknown> = {}) =>
    updateConfig(join(home, 'config.json'), {
      deviceId: ids.dev(),
      userId: ids.usr(),
      // Nothing listens there; the transport retries in the background and never throws.
      gatewayUrl: 'ws://127.0.0.1:1',
      serverKeys: {},
      ...over,
    });

  const start = (over: Partial<Parameters<typeof startDaemon>[0]> = {}) =>
    startDaemon({
      home,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
      env: { PAGR_ENV: 'local' },
      startRetry: { baseMs: 1, maxMs: 1 },
      sleep: async () => {},
      exit: (code: number) => {
        exits.push(code);
      },
      ...over,
    });

  beforeEach(() => {
    home = join(t.home, `h${seq++}`);
    mkdirSync(home, { recursive: true });
    exits = [];
    stderr = [];
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => writeSpy.mockRestore());

  it('classifies what a restart can and cannot fix', () => {
    // launchd will not restart a non-zero exit, so only these may take one.
    expect(
      classifyStartFailure(new SecretStoreError('locked', 'keychain is locked')).unrecoverable,
    ).toBe(true);
    expect(classifyStartFailure(new SecretStoreError('denied', 'user denied')).unrecoverable).toBe(
      true,
    );
    expect(
      classifyStartFailure(new SecretStoreError('unavailable', 'no store')).unrecoverable,
    ).toBe(true);
    expect(classifyStartFailure(new InvalidDeviceKeyError('bad key')).unrecoverable).toBe(true);
    expect(
      classifyStartFailure(new PagrHomeError('permission', '/x', 'denied')).unrecoverable,
    ).toBe(true);
    // These can come right on their own, and killing the daemon for them is worse than waiting.
    expect(classifyStartFailure(new SecretStoreError('io', 'transient')).unrecoverable).toBe(false);
    expect(classifyStartFailure(new PagrHomeError('no_space', '/x', 'full')).unrecoverable).toBe(
      false,
    );
    expect(classifyStartFailure(new Error('getaddrinfo ENOTFOUND gateway')).unrecoverable).toBe(
      false,
    );
  });

  it(`exits ${DAEMON_EXIT.unrecoverable} when this Mac is not paired`, async () => {
    await expect(start()).rejects.toBeInstanceOf(DaemonStartRefused);
    expect(exits).toEqual([DAEMON_EXIT.unrecoverable]);
    expect(stderr.join('')).toContain('not paired');
  });

  it(`exits ${DAEMON_EXIT.unrecoverable} on an unusable config.json`, async () => {
    writeFileSync(join(home, 'config.json'), '{ this is not json');
    await expect(start()).rejects.toBeInstanceOf(DaemonStartRefused);
    expect(exits).toEqual([DAEMON_EXIT.unrecoverable]);
    expect(stderr.join('')).toMatch(/config\.json/);
  });

  it(`exits ${DAEMON_EXIT.unrecoverable} when the Keychain will not open`, async () => {
    pair();
    const locked = {
      kind: 'keyring' as const,
      get: () => Promise.reject(new SecretStoreError('locked', 'the login keychain is locked')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    await expect(start({ secretStore: locked })).rejects.toBeInstanceOf(DaemonStartRefused);
    expect(exits).toEqual([DAEMON_EXIT.unrecoverable]);
    // One line naming the fix — not ten thousand of them at ten-second intervals.
    expect(stderr.join('')).toMatch(/keychain is locked/i);
  });

  it('retries a transient failure in this process instead of handing launchd a corpse', async () => {
    pair();
    const inner = new MemorySecretStore();
    let attempts = 0;
    const flaky = {
      kind: 'keyring' as const,
      get: (k: string) => {
        attempts++;
        if (attempts <= 2) return Promise.reject(new SecretStoreError('io', 'temporary failure'));
        return inner.get(k);
      },
      set: (k: string, v: string) => inner.set(k, v),
      delete: (k: string) => inner.delete(k),
    };
    const d = await start({ secretStore: flaky });
    try {
      expect(attempts).toBeGreaterThan(2);
      expect(exits).toEqual([]); // never exited, so launchd never saw a failure
      expect(d.status().paired).toBe(true);
    } finally {
      await d.stop();
    }
  });
});

describe('a refused device does not keep hammering the gateway (BR-5)', () => {
  const t = useTempHome('pagr-revoked-');
  let wss: WebSocketServer;
  let authAttempts: number;

  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    authAttempts = 0;
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', r));
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as BridgeFrame;
        if (f.kind === 'auth.request')
          sock.send(JSON.stringify({ kind: 'auth.challenge', nonce: 'x'.repeat(40) }));
        if (f.kind === 'auth.response') {
          authAttempts++;
          const res: GatewayFrame = { kind: 'auth.result', ok: false, error: 'revoked' };
          sock.send(JSON.stringify(res));
        }
      });
    });
  });
  afterEach(async () => {
    writeSpy.mockRestore();
    await new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    });
  });

  it('stops reconnecting and ends the process with the unrecoverable status', async () => {
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const exits: number[] = [];
    updateConfig(join(home, 'config.json'), { deviceId: ids.dev(), userId: ids.usr() });
    const paired = await createDaemon({
      home,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
      gatewayUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      backoff: { baseMs: 10, maxMs: 20 },
      env: { PAGR_ENV: 'local' },
      exit: (code) => {
        exits.push(code);
      },
    });
    try {
      await paired.start();
      // The daemon takes itself down rather than retrying a refusal it cannot argue with.
      await until(() => exits.includes(DAEMON_EXIT.unrecoverable));
      expect(paired.transport?.lastFailure).toMatchObject({ code: 'revoked', fatal: true });
      const attemptsWhenRefused = authAttempts;
      await new Promise((r) => setTimeout(r, 200)); // ~10 base backoffs
      expect(authAttempts).toBe(attemptsWhenRefused);
    } finally {
      await paired.stop();
    }
  });
});

describe('daemon · keep-awake', () => {
  const t = useTempHome('pagr-awake-');
  const deviceId = ids.dev();
  let calls: Array<[string, string[]]>;
  let children: Array<{ kill: (s?: NodeJS.Signals | number) => boolean; killed: boolean }>;
  let daemon: Daemon | null;
  let codex: FakeAdapter;

  /** Records argv and hands back a controllable child: no real `caffeinate` is ever run. */
  const spawn: KeepAwakeSpawn = (command, args) => {
    calls.push([command, args]);
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      killed: false,
      kill(_signal?: NodeJS.Signals | number) {
        child.killed = true;
        return true;
      },
    });
    children.push(child);
    return child;
  };

  const build = async (): Promise<{ d: Daemon; projectId: string }> => {
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    codex = new FakeAdapter('codex');
    const d = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
      // Not the suite's environment: this is one of the few tests that wants keep-awake ON.
      env: {},
      spawn,
      keepAwakeHysteresisMs: 60_000,
    });
    daemon = d;
    return { d, projectId: d.registry.add(repo).projectId };
  };

  const start = (d: Daemon, projectId: string, sessionId: string, readOnly = false) =>
    d.dispatcher.handle(
      makeBody(
        'agent.start_session',
        { provider: 'codex', projectId, instruction: 'go', sessionId, attachments: [], readOnly },
        { deviceId },
      ),
    );

  beforeEach(() => {
    calls = [];
    children = [];
    daemon = null;
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    vi.useRealTimers();
  });

  it('holds the Mac awake while a session is live, and lets go once it completes', async () => {
    const { d, projectId } = await build();
    expect(d.keepAwake.status().active).toBe(false);

    const sessionId = ids.ses();
    await start(d, projectId, sessionId);
    expect(calls).toEqual([['/usr/bin/caffeinate', ['-i', '-w', String(process.pid)]]]);
    expect(d.keepAwake.status().reasons).toEqual({ sessions: 1 });

    d.sessions.setStatus(sessionId, 'completed');
    expect(d.keepAwake.status().reasons).toEqual({});
    // Still asserted: the hysteresis window is what stops back-to-back turns churning the child.
    expect(children[0]?.killed).toBe(false);
  });

  it('counts every live session, so one ending does not release the others', async () => {
    const { d, projectId } = await build();
    const a = ids.ses();
    const b = ids.ses();
    await start(d, projectId, a);
    // Read-only, because two writers in one tree is what `SessionGuard` exists to refuse.
    await start(d, projectId, b, true);
    expect(d.keepAwake.status().reasons).toEqual({ sessions: 2 });

    d.sessions.setStatus(a, 'completed');
    expect(d.keepAwake.status().reasons).toEqual({ sessions: 1 });
    expect(calls).toHaveLength(1);
  });

  it('holds while an approval is pending and releases when it is answered', async () => {
    const { d, projectId } = await build();
    const sessionId = ids.ses();
    await start(d, projectId, sessionId);
    d.sessions.setStatus(sessionId, 'completed');
    expect(d.keepAwake.status().reasons).toEqual({});

    const record = d.dispatcher.requestApproval({
      sessionId,
      projectId,
      provider: 'codex',
      providerRequestId: 'req-1',
      actionType: 'command_execution',
      preview: 'rm -rf build',
      onDecision: () => {},
    });
    expect(d.keepAwake.status().reasons).toEqual({ approvals: 1 });

    await d.dispatcher.approvals.resolveLocally(record.approvalId, 'canceled');
    expect(d.keepAwake.status().reasons).toEqual({});
  });

  it('reports keep-awake through the IPC status, as an optional field', async () => {
    const { d, projectId } = await build();
    await d.start();
    await start(d, projectId, ids.ses());
    const status = await new IpcClient(d.paths.socketPath).call<{
      keepAwake?: { active: boolean; disabled: boolean; reasons: Record<string, number> };
    }>('status');
    expect(status.keepAwake).toEqual({ active: true, disabled: false, reasons: { sessions: 1 } });
  });

  it('kills the assertion at shutdown rather than waiting out the hysteresis', async () => {
    const { d, projectId } = await build();
    await start(d, projectId, ids.ses());
    expect(children[0]?.killed).toBe(false);

    await d.stop();
    daemon = null;
    expect(children[0]?.killed).toBe(true);
  });

  it('PAGR_KEEP_AWAKE=0 means a live session spawns nothing at all', async () => {
    const home = join(t.home, 'optout');
    mkdirSync(home, { recursive: true });
    const repo = join(t.home, 'optout-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const d = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', new FakeAdapter('codex')]]),
      secretStore: new MemorySecretStore(),
      env: { PAGR_KEEP_AWAKE: '0' },
      spawn,
    });
    daemon = d;
    await start(d, d.registry.add(repo).projectId, ids.ses());

    expect(calls).toHaveLength(0);
    expect(d.status().keepAwake).toMatchObject({ active: false, disabled: true });
  });
});
