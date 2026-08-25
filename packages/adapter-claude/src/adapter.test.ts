import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
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
  const waitFor = (pred: (e: AdapterEvent) => boolean, ms = 5000): Promise<AdapterEvent> => {
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
        '--session-id',
        '--disallowedTools',
      ]),
    );
    expect(args.argv[args.argv.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.env.PAGR_SESSION_ID).toBe(SES);
    expect(args.env.PAGR_DAEMON_SOCK).toBe(path.join(home, 'run', 'daemon.sock'));
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
    expect(req.preview).toContain('Write ');
    expect(req.preview).not.toContain('hi\n');
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
});
