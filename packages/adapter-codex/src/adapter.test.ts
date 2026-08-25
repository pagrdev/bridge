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

  it('probe reports installed + unauthenticated via account/read', async () => {
    const s = await adapter.probe();
    expect(s).toMatchObject({
      provider: 'codex',
      mode: 'app-server',
      installed: true,
      providerVersion: '0.149.1',
      authStatus: 'unauthenticated',
    });
    expect(s.capabilities.canSteerActiveTurn).toBe(true);
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(false);
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
    expect(summary.status).toBe('working');
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
