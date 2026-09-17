import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const STUBBORN = fileURLToPath(new URL('./__fixtures__/stubborn-claude.mjs', import.meta.url));
const SES = 'ses_00000000000000000000000000000001';
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

describe('ClaudeAdapter against fake claude', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter;
  const proj = () => ({ projectId: PROJ, path: project, displayName: 'demo' });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      approvalTimeoutMs: 400,
      env: { FAKE_CLAUDE_ARGS_FILE: path.join(home, 'args.json') },
    });
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('probe reports cli-hooks + authenticated from `claude auth status`', async () => {
    const s = await adapter.probe();
    expect(s).toMatchObject({
      provider: 'claude',
      mode: 'cli-hooks',
      installed: true,
      providerVersion: '2.1.220',
      authStatus: 'authenticated',
    });
    expect(s.capabilities.canSteerActiveTurn).toBe(false);
    expect(s.capabilities.canRelayApprovals).toBe(true);
  });

  it('probe reports unauthenticated + disabled variants', async () => {
    const out = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      env: { FAKE_CLAUDE_LOGGED_OUT: '1' },
      log: false,
    });
    expect(await out.probe()).toMatchObject({
      authStatus: 'unauthenticated',
      detail: 'Run `claude` once and sign in',
    });
    const missing = new ClaudeAdapter({ home, claudeCommand: ['/nonexistent/claude'], log: false });
    expect(await missing.probe()).toMatchObject({ mode: 'disabled', installed: false });
  });

  it('repeated probes reuse the cached version and sign-in instead of re-forking claude', async () => {
    // The daemon probes on every gateway connect; a flapping network used to mean two forks of
    // `claude` per reconnect (`--version` and `auth status`).
    const trace = path.join(home, 'trace.txt');
    const a = new ClaudeAdapter({
      home: path.join(home, 'probe-home'),
      claudeCommand: ['node', FIXTURE],
      env: { FAKE_CLAUDE_TRACE: trace },
      log: false,
    });
    try {
      for (let i = 0; i < 5; i++) expect((await a.probe()).authStatus).toBe('authenticated');
      expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
        '--version',
        'auth status',
      ]);
      // A zero TTL turns memoisation off, so the freshness can still be forced.
      const live = new ClaudeAdapter({
        home: path.join(home, 'probe-home-2'),
        claudeCommand: ['node', FIXTURE],
        env: { FAKE_CLAUDE_TRACE: trace },
        versionCacheMs: 0,
        authCacheMs: 0,
        log: false,
      });
      await live.probe();
      await live.probe();
      await live.shutdown();
      expect(fs.readFileSync(trace, 'utf8').trim().split('\n').length).toBe(6);
    } finally {
      await a.shutdown();
    }
  });

  it('a completed session is still completed after a daemon restart (BR-4)', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'say hello',
      localImagePaths: [],
      readOnly: true,
    });
    await c.waitFor(sessionEvent('completed'));
    await adapter.shutdown();

    // Same PAGR_HOME, new process: `listSessions` used to hard-code `idle` for everything it
    // remembered, so every reconnect told the cloud this finished session was resumable.
    const restarted = new ClaudeAdapter({ home, claudeCommand: ['node', FIXTURE], log: false });
    try {
      expect(await restarted.listSessions()).toEqual([
        expect.objectContaining({ sessionId: SES, status: 'completed', activeTurn: false }),
      ]);
      expect(await restarted.getStatus(SES)).toMatchObject({ status: 'completed' });
    } finally {
      await restarted.shutdown();
    }
  });

  it('bounds a session map that grew to 1200 entries (BR-3)', async () => {
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 1200; i++) {
      const at = new Date(Date.now() - (1200 - i) * 60_000).toISOString();
      seeded[`ses_${i.toString(16).padStart(32, '0')}`] = {
        claudeSessionId: `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`,
        projectId: PROJ,
        projectPath: project,
        startedAt: at,
        updatedAt: at,
        lastStatus: 'completed',
      };
    }
    fs.writeFileSync(path.join(home, 'claude-sessions.json'), JSON.stringify(seeded));
    const grown = new ClaudeAdapter({ home, claudeCommand: ['node', FIXTURE], log: false });
    try {
      const list = await grown.listSessions();
      expect(list.length).toBe(500);
      // The newest survive, and each keeps the status it finished with.
      expect(list.every((x) => x.status === 'completed')).toBe(true);
      expect(list.some((x) => x.sessionId === `ses_${(1199).toString(16).padStart(32, '0')}`)).toBe(
        true,
      );
      expect(list.some((x) => x.sessionId === `ses_${(0).toString(16).padStart(32, '0')}`)).toBe(
        false,
      );
      // The sweep is written back, so the file stops growing rather than being re-read entire.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(home, 'claude-sessions.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(onDisk).length).toBe(500);
    } finally {
      await grown.shutdown();
    }
  });

  it('starts a session with the verified flags/env and completes', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'say hello',
      localImagePaths: ['/tmp/shot.png'],
      readOnly: true,
    });
    await c.waitFor(sessionEvent('started'));
    const done = await c.waitFor(sessionEvent('completed'));
    expect(done).toMatchObject({
      summary: expect.stringContaining('See screenshot at /tmp/shot.png'),
    });
    expect((await adapter.getStatus(SES))?.status).toBe('completed');

    const args = JSON.parse(fs.readFileSync(path.join(home, 'args.json'), 'utf8'));
    expect(args.argv).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'stdio',
        '--setting-sources',
        '--session-id',
        '--disallowedTools',
      ]),
    );
    expect(args.argv[args.argv.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    // The person's own configuration, whole: a bridge session reads the same settings their own
    // `claude` reads in this checkout, and keeps the MCP servers they configured.
    expect(args.argv[args.argv.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    expect(args.argv).not.toContain('--strict-mcp-config');
    // SEC-6: read-only must actually mean read-only; Bash alone is a write path (`sed -i`).
    expect(args.argv[args.argv.indexOf('--disallowedTools') + 1].split(',')).toEqual(
      expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task']),
    );
    expect(args.env.PAGR_SESSION_ID).toBe(SES);
    // SEC-17: a cloud-started agent is not handed the daemon's IPC socket path.
    expect(args.env.PAGR_DAEMON_SOCK).toBeUndefined();
    expect(fs.realpathSync(args.cwd)).toBe(fs.realpathSync(project));
    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions.json'), 'utf8'));
    expect(persisted[SES].claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('relays a Write permission via control_request and honours allow', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'please write hello.txt',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req).toMatchObject({
      actionType: 'file_change',
      providerRequestId: expect.stringMatching(/^toolu_/),
    });
    expect(req.preview).toBe('Write hello.txt'); // project-relative, never absolute (item 15)
    expect(req.preview).not.toContain('hi\n');
    expect(req.hints.touchesOutsideProject).toBeFalsy();
    expect((await adapter.getStatus(SES))?.status).toBe('waiting_for_approval');
    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
    });
    expect(await c.waitFor((e) => e.kind === 'approval_resolved_locally')).toMatchObject({
      resolution: 'allowed',
    });
    expect(await c.waitFor(sessionEvent('completed'))).toMatchObject({
      summary: 'Wrote hello.txt. DONE',
    });
  });

  it('denies on timeout (never auto-allows)', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'write it',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor((e) => e.kind === 'approval_requested');
    expect(await c.waitFor((e) => e.kind === 'approval_resolved_locally')).toMatchObject({
      resolution: 'timed_out',
    });
    expect(await c.waitFor(sessionEvent('completed'))).toMatchObject({
      summary: 'Could not write hello.txt.',
    });
  });

  it('queues follow-ups during a turn, delivers after result, new_turn when idle on same process', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'write first',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    const q = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'then say two',
      mode: 'steer',
      localImagePaths: [],
    });
    expect(q).toEqual({ delivered: 'queued' });
    await c.waitFor(sessionEvent('queued_followup'));
    await adapter.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'deny',
    });
    await c.waitFor(sessionEvent('followup_delivered'));
    await c.waitFor(
      (e) =>
        e.kind === 'session_event' && e.type === 'completed' && e.summary === 'Echo: then say two',
    );
    const r = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'three',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(r).toEqual({ delivered: 'new_turn' });
    await c.waitFor(
      (e) => e.kind === 'session_event' && e.type === 'completed' && e.summary === 'Echo: three',
    );
    // Still one process: only one args file write with --session-id (no --resume yet).
    expect(JSON.parse(fs.readFileSync(path.join(home, 'args.json'), 'utf8')).argv).not.toContain(
      '--resume',
    );
  });

  it('stops a hanging turn with SIGINT', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'hang around',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('agent_message'));
    await adapter.stopSession(SES);
    await c.waitFor(sessionEvent('stopped'));
    expect((await adapter.getStatus(SES))?.status).toBe('stopped');
  });

  it('reports failed results and crashes', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'fail please',
      localImagePaths: [],
      readOnly: false,
    });
    expect(await c.waitFor(sessionEvent('failed'))).toMatchObject({
      summary: expect.stringContaining('error_during_execution'),
    });

    const SES2 = 'ses_00000000000000000000000000000002';
    await adapter.startSession({
      sessionId: SES2,
      project: proj(),
      instruction: 'crash now',
      localImagePaths: [],
      readOnly: false,
    });
    const f = await c.waitFor(
      (e) => e.kind === 'session_event' && e.type === 'failed' && e.sessionId === SES2,
    );
    expect(f).toMatchObject({ summary: expect.stringContaining('code 7') });
  });

  it('resumes a persisted session with --resume in a fresh adapter', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'one',
      localImagePaths: [],
      readOnly: false,
    });
    await c.waitFor(sessionEvent('completed'));
    await adapter.shutdown();

    const again = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      env: { FAKE_CLAUDE_ARGS_FILE: path.join(home, 'args2.json') },
      log: false,
    });
    const c2 = collector();
    again.subscribe(c2.emit);
    expect((await again.listSessions()).map((s) => s.sessionId)).toContain(SES);
    expect(
      await again.sendInstruction({
        sessionId: SES,
        instruction: 'two',
        mode: 'auto',
        localImagePaths: [],
      }),
    ).toEqual({ delivered: 'new_turn' });
    await c2.waitFor(
      (e) => e.kind === 'session_event' && e.type === 'completed' && e.summary === 'Echo: two',
    );
    const args = JSON.parse(fs.readFileSync(path.join(home, 'args2.json'), 'utf8'));
    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions.json'), 'utf8'));
    expect(args.argv[args.argv.indexOf('--resume') + 1]).toBe(persisted[SES].claudeSessionId);
    await again.shutdown();
  });

  it('keeps a read-only session read-only across resume in a fresh adapter (finding 5)', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'one',
      localImagePaths: [],
      readOnly: true,
    });
    await c.waitFor(sessionEvent('completed'));
    await adapter.shutdown();
    const persisted = JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions.json'), 'utf8'));
    expect(persisted[SES].readOnly).toBe(true);

    const again = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      env: { FAKE_CLAUDE_ARGS_FILE: path.join(home, 'args2.json') },
      log: false,
    });
    const c2 = collector();
    again.subscribe(c2.emit);
    await again.sendInstruction({
      sessionId: SES,
      instruction: 'two',
      mode: 'auto',
      localImagePaths: [],
    });
    await c2.waitFor(
      (e) => e.kind === 'session_event' && e.type === 'completed' && e.summary === 'Echo: two',
    );
    const args = JSON.parse(fs.readFileSync(path.join(home, 'args2.json'), 'utf8'));
    expect(args.argv).toContain('--resume');
    expect(args.argv).toContain('--disallowedTools');
    await again.shutdown();
  });
});

describe('ClaudeAdapter process pool', () => {
  let home: string;
  let projects: string[];
  let adapter: ClaudeAdapter;

  const start = async (n: number, instruction: string) => {
    await adapter.startSession({
      sessionId: `ses_0000000000000000000000000000000${n}`,
      project: {
        projectId: `proj_000000000000000000000000000000${n}${n}`,
        path: projects[n] as string,
        displayName: `p${n}`,
      },
      instruction,
      localImagePaths: [],
      readOnly: false,
    });
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-pool-'));
    projects = [1, 2, 3].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    projects.unshift('');
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      maxLiveProcesses: 2,
      log: false,
    });
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    for (const p of projects) if (p) fs.rmSync(p, { recursive: true, force: true });
  });

  it('never runs more `claude` children than the pool allows', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    await start(1, 'one');
    await c.waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    await start(2, 'two');
    await start(3, 'three');
    expect(adapter.liveProcessCount).toBeLessThanOrEqual(2);
  });

  it('evicts the least recently used idle session, and resumes it on demand', async () => {
    const c = collector();
    adapter.subscribe(c.emit);
    const done = (id: string) => (e: AdapterEvent) =>
      e.kind === 'session_event' && e.type === 'completed' && e.sessionId === id;
    await start(1, 'one');
    await c.waitFor(done('ses_00000000000000000000000000000001'));
    await start(2, 'two');
    await c.waitFor(done('ses_00000000000000000000000000000002'));
    await start(3, 'three');
    await c.waitFor(done('ses_00000000000000000000000000000003'));
    expect(adapter.liveProcessCount).toBeLessThanOrEqual(2);
    // the evicted session is still usable: it comes back with --resume
    const res = await adapter.sendInstruction({
      sessionId: 'ses_00000000000000000000000000000001',
      instruction: 'again',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(res).toEqual({ delivered: 'new_turn' });
  });

  it('refuses a new session when every process in the pool is mid-turn', async () => {
    await start(1, 'hang here');
    await start(2, 'hang here');
    await expect(start(3, 'three')).rejects.toThrow(/limit of 2 live/);
  });
});

describe('ClaudeAdapter pool refusal is clean', () => {
  it('leaves no phantom session behind when the pool is full', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-full-'));
    const projects = [1, 2, 3].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    const a = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      maxLiveProcesses: 1,
      log: false,
    });
    try {
      await a.startSession({
        sessionId: 'ses_00000000000000000000000000000001',
        project: { projectId: PROJ, path: projects[0] as string, displayName: 'one' },
        instruction: 'hang here',
        localImagePaths: [],
        readOnly: false,
      });
      const blocked = 'ses_00000000000000000000000000000002';
      await expect(
        a.startSession({
          sessionId: blocked,
          project: {
            projectId: 'proj_0000000000000000000000000000000b',
            path: projects[1] as string,
            displayName: 'two',
          },
          instruction: 'hello',
          localImagePaths: [],
          readOnly: false,
        }),
      ).rejects.toThrow(/limit of 1 live/);
      expect(await a.getStatus(blocked)).toBeNull();
      expect((await a.listSessions()).map((s) => s.sessionId)).not.toContain(blocked);
      expect(a.liveProcessCount).toBe(1);
    } finally {
      await a.shutdown();
      fs.rmSync(home, { recursive: true, force: true });
      for (const p of projects) fs.rmSync(p, { recursive: true, force: true });
    }
  });
});

describe('ClaudeAdapter drains evicted children', () => {
  it('kills an idle child that ignores EOF instead of orphaning it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-drain-'));
    const projects = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    const pidFile = path.join(home, 'pids.log');
    const a = new ClaudeAdapter({
      home,
      claudeCommand: ['node', STUBBORN],
      maxLiveProcesses: 1,
      retireGraceMs: 100,
      log: false,
      env: { STUBBORN_PID_LOG: pidFile },
    });
    const c = collector();
    a.subscribe(c.emit);
    try {
      await a.startSession({
        sessionId: 'ses_00000000000000000000000000000001',
        project: { projectId: PROJ, path: projects[0] as string, displayName: 'one' },
        instruction: 'hello',
        localImagePaths: [],
        readOnly: false,
      });
      await c.waitFor(sessionEvent('completed'));
      const firstPid = Number.parseInt(
        fs.readFileSync(pidFile, 'utf8').trim().split('\n')[0] ?? '',
        10,
      );
      expect(firstPid).toBeGreaterThan(0);

      // The pool is full and the only child is idle → it must be evicted AND actually die.
      await a.startSession({
        sessionId: 'ses_00000000000000000000000000000002',
        project: {
          projectId: 'proj_0000000000000000000000000000000b',
          path: projects[1] as string,
          displayName: 'two',
        },
        instruction: 'hello',
        localImagePaths: [],
        readOnly: false,
      });
      expect(() => process.kill(firstPid, 0)).toThrow();
      expect(a.liveProcessCount).toBe(1);
    } finally {
      await a.shutdown();
      fs.rmSync(home, { recursive: true, force: true });
      for (const p of projects) fs.rmSync(p, { recursive: true, force: true });
    }
  });
});

/**
 * MOB-035. The options an approval card carries, and what each one actually does to Claude.
 *
 * The property that matters: "allow always" is not a Pagr policy. It hands Claude back the very
 * `permission_suggestions` it offered, so the rule lands in the user's own Claude Code settings —
 * and it is offered only when Claude supplied some.
 */
describe('ClaudeAdapter approval options (MOB-035)', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter | null = null;
  let controlFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-opt-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-opt-'));
    controlFile = path.join(home, 'control.jsonl');
  });
  afterEach(async () => {
    await adapter?.shutdown();
    adapter = null;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const make = (env: Record<string, string> = {}): ClaudeAdapter => {
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      approvalTimeoutMs: 5_000,
      env: { FAKE_CLAUDE_CONTROL_FILE: controlFile, ...env },
    });
    return adapter;
  };

  const ask = async (a: ClaudeAdapter, instruction: string) => {
    const c = collector();
    a.subscribe(c.emit);
    await a.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction,
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.waitFor((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    return { c, req };
  };

  const controlLines = (): Array<Record<string, unknown>> =>
    fs.existsSync(controlFile)
      ? fs
          .readFileSync(controlFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  /**
   * Wait for the fake Claude to have written a control line.
   *
   * `approval_resolved_locally` is emitted when the adapter hands the answer to the process, not
   * when the process has flushed it to disk, so reading `controlLines()[0]` straight after that
   * event is a race — PR #19 saw it fail. Polling the file is the only deterministic way to wait
   * for another process's write; a fixed sleep would be the same race with better odds.
   */
  const waitForControlLine = async (index = 0, ms = 20_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const line = controlLines()[index];
      if (line) return line;
      if (Date.now() >= deadline)
        throw new Error(`timeout waiting for control line ${index} in ${controlFile}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('offers "allow always" only when the request carried permission suggestions', async () => {
    const { req } = await ask(make(), 'write always please');
    expect(req.options).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always', label: 'Allow always' },
      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
    ]);
  });

  it('offers allow once / reject when Claude suggested no rules to persist', async () => {
    const { req } = await ask(make(), 'please write hello.txt');
    expect(req.options?.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  it('PAGR_ALLOW_ALWAYS=0 takes the option away even when Claude offered rules', async () => {
    const { req } = await ask(make({ PAGR_ALLOW_ALWAYS: '0' }), 'write always please');
    expect(req.options?.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  it('allow_always answers Claude with updatedPermissions; allow_once never does', async () => {
    const a = make();
    const { c, req } = await ask(a, 'write always please');
    await a.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
      optionId: 'allow_always',
    });
    await c.waitFor((e) => e.kind === 'approval_resolved_locally');
    const response = (await waitForControlLine(0)).response as {
      response: { behavior: string; updatedPermissions?: unknown[] };
    };
    expect(response.response).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: '//tmp/**' }] },
      ],
    });
    await c.waitFor(sessionEvent('completed'));

    // The same prompt answered "once" writes no rule anywhere.
    fs.writeFileSync(controlFile, '');
    const second = await a.sendInstruction({
      sessionId: SES,
      instruction: 'write always please, again',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(second.delivered).toBe('new_turn');
    const again = await c.waitFor(
      (e) => e.kind === 'approval_requested' && e.approvalId !== req.approvalId,
    );
    if (again.kind !== 'approval_requested') throw new Error('unreachable');
    await a.respondToApproval({
      approvalId: again.approvalId,
      providerRequestId: again.providerRequestId,
      decision: 'allow',
      optionId: 'allow_once',
    });
    await c.waitFor(
      (e) => e.kind === 'approval_resolved_locally' && e.approvalId === again.approvalId,
    );
    const onceResponse = (await waitForControlLine(0)).response as {
      response: { behavior: string; updatedPermissions?: unknown[] };
    };
    expect(onceResponse.response.behavior).toBe('allow');
    expect(onceResponse.response.updatedPermissions).toBeUndefined();
  });

  it('marks an approval answered elsewhere when the tool result arrives without our answer', async () => {
    const a = make();
    const { c, req } = await ask(a, 'write elsewhere');
    const resolved = await c.waitFor((e) => e.kind === 'approval_resolved_locally');
    expect(resolved).toMatchObject({
      approvalId: req.approvalId,
      resolution: 'allowed',
      source: 'terminal',
      answeredElsewhere: true,
    });
    // Nothing was written back to Claude: the person had already answered in their terminal.
    expect(controlLines()).toEqual([]);
    // …and the prompt is gone, so a late answer from a phone finds nothing to answer.
    await expect(
      a.respondToApproval({
        approvalId: req.approvalId,
        providerRequestId: req.providerRequestId,
        decision: 'allow',
      }),
    ).rejects.toThrow(/unknown or expired approval/);
  });
});
