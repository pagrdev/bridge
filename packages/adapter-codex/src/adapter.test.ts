import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const SES = 'ses_00000000000000000000000000000001';
const SES2 = 'ses_00000000000000000000000000000002';
const PROJ = 'proj_0000000000000000000000000000000a';

function collector() {
  const events: AdapterEvent[] = [];
  const waiters: Array<{ pred: (e: AdapterEvent) => boolean; resolve: (e: AdapterEvent) => void }> =
    [];
  const emit = (e: AdapterEvent) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  };
  const waitFor = (pred: (e: AdapterEvent) => boolean, ms = 20_000): Promise<AdapterEvent> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e);
        },
      });
    });
  };
  return { events, emit, waitFor };
}

const sessionEvent = (type: string) => (e: AdapterEvent) =>
  e.kind === 'session_event' && e.type === type;

async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('CodexAdapter against fake app-server', () => {
  let home: string;
  let adapter: CodexAdapter;
  let project: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      approvalTimeoutMs: 400,
      restartDelayMs: 50,
      log: true,
    });
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const proj = () => ({ projectId: PROJ, path: project, displayName: 'demo' });

  it('probe reports installed + unauthenticated WITHOUT starting an app-server', async () => {
    const trace = path.join(home, 'trace.txt');
    const codexHome = path.join(home, 'codex-home');
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome,
      env: { FAKE_CODEX_TRACE: trace },
      log: false,
    });
    try {
      const s = await a.probe();
      expect(s).toMatchObject({
        provider: 'codex',
        mode: 'app-server',
        installed: true,
        providerVersion: '0.149.1',
        authStatus: 'unauthenticated',
      });
      expect(s.capabilities.canSteerActiveTurn).toBe(true);
      expect(s.capabilities.canReceiveLiveExternalMessages).toBe(false);
      // The whole point: probing is what the daemon does on every gateway connect. It must not
      // leave a `codex app-server` behind, and it must not have forked one to find that out.
      expect(a.appServerRunning).toBe(false);
      expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['--version']);
    } finally {
      await a.shutdown();
    }
  });

  it('probe reports authenticated when codex has credentials on disk', async () => {
    const codexHome = path.join(home, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"redacted"}');
    const a = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], codexHome, log: false });
    try {
      expect((await a.probe()).authStatus).toBe('authenticated');
      expect(a.appServerRunning).toBe(false);
    } finally {
      await a.shutdown();
    }
  });

  it('repeated probes reuse the cached version instead of re-forking codex', async () => {
    const trace = path.join(home, 'trace.txt');
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      env: { FAKE_CODEX_TRACE: trace },
      log: false,
    });
    try {
      for (let i = 0; i < 5; i++) await a.probe();
      expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['--version']);
    } finally {
      await a.shutdown();
    }
  });

  it('probe asks a RUNNING app-server for the real account status', async () => {
    const codexHome = path.join(home, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    // Credentials on disk say "authenticated"; the live app-server is the authority and says no.
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    const a = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], codexHome, log: false });
    try {
      await a.startSession({
        sessionId: SES,
        project: proj(),
        instruction: 'hello',
        localImagePaths: [],
        readOnly: true,
      });
      expect(a.appServerRunning).toBe(true);
      expect((await a.probe()).authStatus).toBe('unauthenticated');
    } finally {
      await a.shutdown();
    }
  });

  it('stops the idle app-server, and resumes the thread on the next instruction', async () => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      idleShutdownMs: 10,
      log: false,
    });
    const c = collector();
    a.subscribe(c.emit);
    try {
      await a.startSession({
        sessionId: SES,
        project: proj(),
        instruction: 'Run the tests',
        localImagePaths: [],
        readOnly: false,
      });
      await c.waitFor(sessionEvent('completed'));
      await waitUntil(() => !a.appServerRunning);
      expect(a.appServerRunning).toBe(false);
      // A follow-up must still work: a fresh app-server is started and the thread resumed.
      const res = await a.sendInstruction({
        sessionId: SES,
        instruction: 'and again',
        localImagePaths: [],
        mode: 'queue',
      });
      expect(res.delivered).toBe('new_turn');
      expect(a.appServerRunning).toBe(true);
    } finally {
      await a.shutdown();
    }
  });

  it('keeps the app-server while a turn is still running', async () => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      idleShutdownMs: 10,
      log: false,
    });
    const c = collector();
    a.subscribe(c.emit);
    try {
      await a.startSession({
        sessionId: SES,
        project: proj(),
        instruction: 'please wait here',
        localImagePaths: [],
        readOnly: false,
      });
      await c.waitFor(sessionEvent('started'));
      await new Promise((r) => setTimeout(r, 60));
      expect(a.appServerRunning).toBe(true);
    } finally {
      await a.shutdown();
    }
  });

  it('probe reports disabled when codex is missing', async () => {
    const a = new CodexAdapter({ home, codexCommand: ['/nonexistent/codex'], log: false });
    const s = await a.probe();
    expect(s).toMatchObject({ mode: 'disabled', installed: false });
    expect(s.detail).toContain('npm i -g @openai/codex');
    await a.shutdown();
  });

  it('runs a plain turn to completion and persists the session map', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    const summary = await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'Run the tests',
      localImagePaths: ['/tmp/shot.png'],
      readOnly: false,
    });
    // A fast provider can finish the whole turn before `startSession` resolves (its response and
    // its notifications share one stdout stream), so the only wrong answer here would be a status
    // that pretends nothing has started.
    expect(['working', 'completed']).toContain(summary.status);
    expect(summary.taskSummary).toBe('Run the tests');
    const done = await c.waitFor(sessionEvent('completed'));
    expect(done).toMatchObject({ summary: 'All 12 tests pass.' });
    expect(c.events.some((e) => e.kind === 'session_event' && e.type === 'agent_message')).toBe(
      true,
    );
    expect(c.events.some((e) => e.kind === 'session_event' && e.type === 'started')).toBe(true);
    const st = await adapter.getStatus(SES);
    expect(st?.status).toBe('completed');
    expect(st?.activeTurn).toBe(false);

    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'codex-sessions.json'), 'utf8'));
    expect(persisted[SES]).toMatchObject({
      projectId: PROJ,
      threadId: expect.stringMatching(/^thr_/),
    });
    expect(fs.existsSync(path.join(home, 'logs', 'codex.log'))).toBe(true);
    const log = fs.readFileSync(path.join(home, 'logs', 'codex.log'), 'utf8');
    expect(log).not.toContain('requiresOpenaiAuth');
  });

  it('relays a command approval and honours allow', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'please approve the migration',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req.approvalId).toMatch(/^apr_[0-9a-f]{32}$/);
    expect(req.actionType).toBe('command_execution');
    expect(req.preview).toContain('npm run db:migrate');
    expect(req.hints).toMatchObject({ productionHint: true });
    expect((await adapter.getStatus(SES))?.status).toBe('waiting_for_approval');

    await expect(
      adapter.respondToApproval({
        approvalId: req.approvalId,
        providerRequestId: 'wrong',
        decision: 'allow',
      }),
    ).rejects.toThrow(/providerRequestId/);

    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
    });
    const resolved = await c.waitFor((e) => e.kind === 'approval_resolved_locally');
    expect(resolved).toMatchObject({ resolution: 'allowed' });
    const done = await c.waitFor(sessionEvent('completed'));
    expect(done).toMatchObject({ summary: expect.stringContaining('Migration ran') });
  });

  it('declines on timeout and emits timed_out', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'approve this',
      localImagePaths: [],
      readOnly: true,
    });
    await c.waitFor((e) => e.kind === 'approval_requested');
    const resolved = await c.waitFor((e) => e.kind === 'approval_resolved_locally');
    expect(resolved).toMatchObject({ resolution: 'timed_out' });
    const done = await c.waitFor(sessionEvent('completed'));
    expect(done).toMatchObject({ summary: expect.stringContaining('decline') });
  });

  it('relays permissions requests and denies with an empty grant', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'needs permission',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req.actionType).toBe('permission');
    expect(req.hints).toMatchObject({ networkAccess: true });
    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'deny',
    });
    const done = await c.waitFor(sessionEvent('completed'));
    expect(done).toMatchObject({ summary: 'Network denied.' });
  });

  it('file-change previews are project-relative and containment uses realpath (item 15)', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'filechange please',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req.actionType).toBe('file_change');
    expect(req.preview).toBe('Write access requested under src');
    expect(req.preview).not.toContain(project);
    expect(req.hints.touchesOutsideProject).toBeFalsy();
    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
    });
    await c.waitFor(sessionEvent('completed'));
  });

  it('steers an active turn, queues when asked, stops via interrupt', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'wait for me',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('started'));
    const steered = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'also lint',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(steered).toEqual({ delivered: 'steered' });
    await c.waitFor((e) => e.kind === 'session_event' && e.summary.includes('Steer received'));

    const queued = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'later: run tests',
      mode: 'queue',
      localImagePaths: [],
    });
    expect(queued).toEqual({ delivered: 'queued' });
    await c.waitFor(sessionEvent('queued_followup'));

    await adapter.stopSession(SES);
    const stopped = await c.waitFor(sessionEvent('stopped'));
    expect(stopped.kind).toBe('session_event');
    expect((await adapter.getStatus(SES))?.status).toBe('stopped');
  });

  it('delivers a queued follow-up after completion and starts a new turn when idle', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'approve step one',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'then run tests',
      mode: 'queue',
      localImagePaths: [],
    });
    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'deny',
    });
    await c.waitFor(sessionEvent('followup_delivered'));
    const completions = () => c.events.filter(sessionEvent('completed')).length;
    await c.waitFor(() => completions() >= 2);
    expect((await adapter.getStatus(SES))?.status).toBe('completed');

    const r = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'one more',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(r).toEqual({ delivered: 'new_turn' });
    await c.waitFor(() => completions() >= 3);
  });

  it('marks active sessions failed when app-server crashes, then restarts', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'crash now',
      localImagePaths: [],
      readOnly: false,
    });
    const failed = await c.waitFor(sessionEvent('failed'));
    expect(failed).toMatchObject({ summary: expect.stringContaining('exited') });
    expect((await adapter.getStatus(SES))?.status).toBe('failed');
    // A new session after restart works (thread is resumed in the fresh process on demand).
    await new Promise((r) => setTimeout(r, 150));
    await adapter.startSession({
      sessionId: SES2,
      project: proj(),
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(
      (e) => e.kind === 'session_event' && e.type === 'completed' && e.sessionId === SES2,
    );
  });

  it('resumes a persisted session from disk in a new adapter instance', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('completed'));
    await adapter.shutdown();

    const again = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    const c2 = collector();
    again.subscribe(c2.emit);
    const list = await again.listSessions();
    expect(list.map((s) => s.sessionId)).toContain(SES);
    const r = await again.sendInstruction({
      sessionId: SES,
      instruction: 'again',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(r).toEqual({ delivered: 'new_turn' });
    await c2.waitFor(sessionEvent('completed'));
    await again.shutdown();
  });
});

describe('CodexAdapter read-only persistence (finding 5)', () => {
  let home: string;
  let project: string;
  let rpcLog: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-ro-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    rpcLog = path.join(home, 'rpc.jsonl');
    process.env.FAKE_CODEX_RPC_LOG = rpcLog;
  });
  afterEach(() => {
    delete process.env.FAKE_CODEX_RPC_LOG;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('re-sends sandbox=read-only on thread/resume after a restart', async () => {
    const first = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    const c = collector();
    first.subscribe(c.emit);
    await first.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: true,
    });
    await c.waitFor(sessionEvent('completed'));
    await first.shutdown();
    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'codex-sessions.json'), 'utf8'));
    expect(persisted[SES].readOnly).toBe(true);

    const again = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    const c2 = collector();
    again.subscribe(c2.emit);
    await again.sendInstruction({
      sessionId: SES,
      instruction: 'again',
      mode: 'auto',
      localImagePaths: [],
    });
    await c2.waitFor(sessionEvent('completed'));
    await again.shutdown();

    const calls = fs
      .readFileSync(rpcLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    const start = calls.find((c) => c.method === 'thread/start');
    const resume = calls.find((c) => c.method === 'thread/resume');
    expect(start?.params.sandbox).toBe('read-only');
    expect(resume?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
  });
});

describe('CodexAdapter session map bounds and honesty (BR-3, BR-4)', () => {
  let home: string;
  let project: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-map-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('a completed session is still completed after a daemon restart', async () => {
    const first = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    const c = collector();
    first.subscribe(c.emit);
    await first.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('completed'));
    await first.shutdown();

    // `listSessions` used to hard-code `idle`, and the cloud upserts what a `device.hello`
    // carries — so every reconnect offered this finished session back as resumable.
    const again = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    try {
      expect(await again.listSessions()).toEqual([
        expect.objectContaining({ sessionId: SES, status: 'completed', activeTurn: false }),
      ]);
      expect(await again.getStatus(SES)).toMatchObject({ status: 'completed' });
    } finally {
      await again.shutdown();
    }
  });

  it('bounds a session map that grew to 1200 entries', async () => {
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 1200; i++) {
      const at = new Date(Date.now() - (1200 - i) * 60_000).toISOString();
      seeded[`ses_${i.toString(16).padStart(32, '0')}`] = {
        threadId: `thread-${i}`,
        projectId: PROJ,
        projectPath: project,
        startedAt: at,
        updatedAt: at,
        lastStatus: 'completed',
      };
    }
    fs.writeFileSync(path.join(home, 'codex-sessions.json'), JSON.stringify(seeded));
    const grown = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    try {
      const list = await grown.listSessions();
      expect(list.length).toBe(500);
      expect(list.every((x) => x.status === 'completed')).toBe(true);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(home, 'codex-sessions.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(onDisk).length).toBe(500);
      expect(grown.appServerRunning).toBe(false); // listing must not start anything
    } finally {
      await grown.shutdown();
    }
  });
});

describe('CodexAdapter process lifecycle under load', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-pool-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const proj = () => ({ projectId: PROJ, path: project, displayName: 'demo' });

  it('spawns exactly one app-server even when two sessions start concurrently', async () => {
    const rpcLog = path.join(home, 'rpc-concurrent.jsonl');
    process.env.FAKE_CODEX_RPC_LOG = rpcLog;
    const a = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj2-'));
    try {
      await Promise.all([
        a.startSession({
          sessionId: SES,
          project: proj(),
          instruction: 'run tests',
          localImagePaths: [],
          readOnly: false,
        }),
        a.startSession({
          sessionId: SES2,
          project: {
            projectId: 'proj_0000000000000000000000000000000b',
            path: other,
            displayName: 'two',
          },
          instruction: 'run tests',
          localImagePaths: [],
          readOnly: false,
        }),
      ]);
      expect(a.appServerRunning).toBe(true);
      const lines = fs.readFileSync(rpcLog, 'utf8').trim().split('\n');
      const method = (l: string) => (JSON.parse(l) as { method: string }).method;
      expect(lines.filter((l) => method(l) === 'initialize')).toHaveLength(1);
      expect(lines.filter((l) => method(l) === 'thread/start')).toHaveLength(2);
    } finally {
      delete process.env.FAKE_CODEX_RPC_LOG;
      fs.rmSync(other, { recursive: true, force: true });
      await a.shutdown();
    }
  });

  it('gives up restarting after a bounded number of consecutive crashes', async () => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', '-e', 'process.exit(9);//'],
      restartDelayMs: 5,
      maxRestartAttempts: 2,
      requestTimeoutMs: 300,
      log: false,
    });
    await expect(
      a.startSession({
        sessionId: SES,
        project: proj(),
        instruction: 'go',
        localImagePaths: [],
        readOnly: false,
      }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 250));
    expect(a.appServerRunning).toBe(false);
    await a.shutdown();
  });
});

describe('CodexAdapter when a whole turn arrives in one chunk', () => {
  let home: string;
  let project: string;
  let adapter: CodexAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-coalesce-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    process.env.FAKE_CODEX_COALESCE = '1';
    adapter = new CodexAdapter({ home, codexCommand: ['node', FIXTURE], log: false });
  });
  afterEach(async () => {
    delete process.env.FAKE_CODEX_COALESCE;
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const proj = () => ({ projectId: PROJ, path: project, displayName: 'demo' });

  it('does not resurrect a turn whose completion was processed first', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('completed'));
    const st = await adapter.getStatus(SES);
    expect(st?.status).toBe('completed');
    expect(st?.activeTurn).toBe(false);
    // the last status event the daemon saw must agree
    const last = c.events.filter((e) => e.kind === 'session').at(-1);
    expect(last).toMatchObject({ session: { status: 'completed', activeTurn: false } });
  });

  it('still accepts a follow-up afterwards (no dead activeTurnId left behind)', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('completed'));
    // A stale activeTurnId would make this try to steer a finished turn and fail.
    const res = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'run them again',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(res).toEqual({ delivered: 'new_turn' });
    await c.waitFor(() => c.events.filter(sessionEvent('completed')).length >= 2);
    expect((await adapter.getStatus(SES))?.status).toBe('completed');
  });
});

describe('CodexAdapter approval inside one coalesced chunk', () => {
  let home: string;
  let project: string;
  let adapter: CodexAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-coalesce2-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    process.env.FAKE_CODEX_COALESCE = '1';
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      approvalTimeoutMs: 5000,
      log: false,
    });
  });
  afterEach(async () => {
    delete process.env.FAKE_CODEX_COALESCE;
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('keeps waiting_for_approval instead of rewinding to working', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'please approve the migration',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor((e) => e.kind === 'approval_requested');
    expect((await adapter.getStatus(SES))?.status).toBe('waiting_for_approval');
  });
});

describe('CodexAdapter restart policy', () => {
  let home: string;
  let project: string;
  let spawnLog: string;

  const FLAKY = fileURLToPath(new URL('./__fixtures__/flaky-app-server.mjs', import.meta.url));
  const spawns = () =>
    fs.existsSync(spawnLog)
      ? fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-restart-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    spawnLog = path.join(home, 'spawns.log');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('stops respawning a server that keeps dying right after the handshake', async () => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FLAKY],
      restartDelayMs: 10,
      maxRestartDelayMs: 40,
      maxRestartAttempts: 2,
      // No uptime here counts as healthy, so the backoff cannot be reset by a handshake.
      healthyUptimeMs: 10 * 60_000,
      requestTimeoutMs: 2000,
      log: false,
      env: { FLAKY_MODE: 'crash', FLAKY_SPAWN_LOG: spawnLog },
    });
    try {
      await a
        .startSession({
          sessionId: SES,
          project: { projectId: PROJ, path: project, displayName: 'demo' },
          instruction: 'go',
          localImagePaths: [],
          readOnly: false,
        })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
      // 1 initial + at most `maxRestartAttempts` automatic restarts, then it gives up.
      expect(spawns().length).toBeGreaterThanOrEqual(2);
      expect(spawns().length).toBeLessThanOrEqual(3);
      expect(a.appServerRunning).toBe(false);
    } finally {
      await a.shutdown();
    }
  });

  it('kills the child when the initialize handshake never completes', async () => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FLAKY],
      restartDelayMs: 10_000, // no automatic restart inside this test
      maxRestartAttempts: 0,
      requestTimeoutMs: 200,
      log: false,
      env: { FLAKY_MODE: 'mute', FLAKY_SPAWN_LOG: spawnLog },
    });
    try {
      await expect(
        a.startSession({
          sessionId: SES,
          project: { projectId: PROJ, path: project, displayName: 'demo' },
          instruction: 'go',
          localImagePaths: [],
          readOnly: false,
        }),
      ).rejects.toThrow(/timed out/);
      const [line] = spawns();
      const pid = Number.parseInt((line ?? '').split(' ')[0] ?? '0', 10);
      expect(pid).toBeGreaterThan(0);
      // The child ignores EOF on stdin, so only an explicit kill can have removed it.
      await new Promise((r) => setTimeout(r, 2600));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await a.shutdown();
    }
  });
});
