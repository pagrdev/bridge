import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';

/**
 * Full-fidelity frames, approval options and questions, against the fake app-server.
 *
 * These run over the private stdio child: what a frame says does not depend on which link it
 * arrived over, and a child is cheaper than a socket. `CODEX_HOME` is a temp directory throughout
 * and `attachDaemon` is off, so nothing here can reach a real daemon.
 */

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const SES = 'ses_00000000000000000000000000000001';
const PROJ = 'proj_0000000000000000000000000000000a';

type Frame = Extract<AdapterEvent, { kind: 'frame' }>;
const framesOf = (events: AdapterEvent[]): Frame[] =>
  events.filter((e): e is Frame => e.kind === 'frame');

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
  const waitFor = (pred: (e: AdapterEvent) => boolean, ms = 10_000): Promise<AdapterEvent> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for an event')), ms);
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

const rpc = (file: string): Array<{ method: string; params: Record<string, unknown> }> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
    : [];

describe('frames from app-server items', () => {
  let home: string;
  let project: string;
  let rpcLog: string;
  let adapter: CodexAdapter;
  let events: AdapterEvent[];
  let waitFor: ReturnType<typeof collector>['waitFor'];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    rpcLog = path.join(home, 'rpc.log');
    const c = collector();
    events = c.events;
    waitFor = c.waitFor;
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      attachDaemon: false,
      approvalTimeoutMs: 5000,
      streamFlushBytes: 16,
      streamFlushMs: 25,
      log: false,
      env: { FAKE_CODEX_RPC_LOG: rpcLog },
    });
    adapter.subscribe(c.emit);
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const start = (instruction: string) =>
    adapter.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction,
      localImagePaths: [],
      readOnly: false,
    });

  it('coalesces agent message deltas into streaming frames, then replaces them with the final one', async () => {
    await start('hello');
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const assistant = framesOf(events).filter((f) => f.body.kind === 'assistant');
    const streaming = assistant.filter((f) => f.meta.status === 'streaming');
    const final = assistant.filter((f) => f.meta.final === true);
    expect(streaming.length).toBeGreaterThan(0);
    expect(final.length).toBeGreaterThan(0);
    // Streaming chunks are numbered off the item id, so the phone can order them.
    expect(streaming[0]?.providerRecordId).toMatch(/#0$/);
    // The final frame carries the whole message and is keyed on the item itself.
    expect(final.at(-1)?.body).toMatchObject({ kind: 'assistant', text: 'All 12 tests pass.' });
    expect(final.at(-1)?.providerRecordId).not.toContain('#');
  }, 30_000);

  it('turns command output into terminal frames and the completed item into the whole run', async () => {
    await start('please run the tests');
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const terminal = framesOf(events).filter((f) => f.body.kind === 'terminal');
    const chunks = terminal.filter((f) => f.meta.status === 'streaming');
    expect(chunks.length).toBeGreaterThan(0);
    // Even a chunk says which command it came from.
    expect(chunks[0]?.body).toMatchObject({ command: 'pnpm test' });
    const complete = terminal.find((f) => f.meta.final === true);
    expect(complete?.body).toMatchObject({
      kind: 'terminal',
      command: 'pnpm test',
      stdout: 'ok 1\nok 2\nall good\n',
      exitCode: 0,
      interrupted: false,
    });
  }, 30_000);

  it('makes one diff frame per changed file', async () => {
    await start('please patch it');
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const diffs = framesOf(events).filter((f) => f.body.kind === 'diff');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]?.body).toMatchObject({ changeKind: 'update' });
    expect(diffs[1]?.body).toMatchObject({ changeKind: 'add' });
    expect(diffs[0]?.body.kind === 'diff' && diffs[0]?.body.hunks?.[0]).toMatchObject({
      oldStart: 1,
      newLines: 3,
    });
  }, 30_000);

  it('streams reasoning as thinking frames', async () => {
    await start('think about it');
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const thinking = framesOf(events).filter((f) => f.body.kind === 'thinking');
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.at(-1)?.body).toMatchObject({
      kind: 'thinking',
      text: 'Considering the options carefully.',
    });
  }, 30_000);

  it('reads a whole thread back as backfill frames', async () => {
    const s = await start('hello');
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const threadId = rpc(rpcLog).find((c) => c.method === 'turn/start')?.params.threadId as string;
    const frames = await adapter.readThreadFrames(threadId);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.meta.source === 'backfill')).toBe(true);
    // Keyed on (turn, position): `thread/read` renumbers item ids, so ids cannot be the key.
    expect(frames[0]?.providerRecordId).toMatch(/#\d+$/);
    expect(s.sessionId).toBe(SES);
  }, 30_000);
});

describe('approval options', () => {
  let home: string;
  let project: string;
  let rpcLog: string;
  let adapter: CodexAdapter;
  let waitFor: ReturnType<typeof collector>['waitFor'];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    rpcLog = path.join(home, 'rpc.log');
    const c = collector();
    waitFor = c.waitFor;
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      attachDaemon: false,
      approvalTimeoutMs: 5000,
      frames: false,
      log: false,
      env: { FAKE_CODEX_RPC_LOG: rpcLog },
    });
    adapter.subscribe(c.emit);
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const start = (instruction: string) =>
    adapter.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction,
      localImagePaths: [],
      readOnly: false,
    });

  const answers = () => rpc(rpcLog).filter((c) => c.method === '<response>');

  it('offers the three options the Codex enums really have, and no others', async () => {
    await start('approve this');
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    expect(asked.kind === 'approval_requested' && asked.options).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_session', label: 'Allow for this session' },
      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
    ]);
    expect(asked.kind === 'approval_requested' && asked.source).toBe('owned');
  }, 30_000);

  it('sends `acceptForSession` when the user picked "allow for this session"', async () => {
    await start('approve this');
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    if (asked.kind !== 'approval_requested') throw new Error('wrong event');
    await adapter.respondToApproval({
      approvalId: asked.approvalId,
      providerRequestId: asked.providerRequestId,
      decision: 'allow',
      optionId: 'allow_session',
    });
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(answers().at(-1)?.params.result).toMatchObject({ decision: 'acceptForSession' });
  }, 30_000);

  it('falls back to the plain decision when a v1 cloud sends no option', async () => {
    await start('approve this');
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    if (asked.kind !== 'approval_requested') throw new Error('wrong event');
    await adapter.respondToApproval({
      approvalId: asked.approvalId,
      providerRequestId: asked.providerRequestId,
      decision: 'allow',
    });
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(answers().at(-1)?.params.result).toMatchObject({ decision: 'accept' });
  }, 30_000);

  it('scopes a permission grant to the session when that is what was chosen', async () => {
    await start('needs permission');
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    if (asked.kind !== 'approval_requested') throw new Error('wrong event');
    await adapter.respondToApproval({
      approvalId: asked.approvalId,
      providerRequestId: asked.providerRequestId,
      decision: 'allow',
      optionId: 'allow_session',
    });
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    const result = answers().at(-1)?.params.result as { scope: string; permissions: unknown };
    expect(result.scope).toBe('session');
    expect(result.permissions).toMatchObject({ network: { allowAll: true } });
  }, 30_000);

  it('denies a permission request with an empty grant, which is what a denial is', async () => {
    await start('needs permission');
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    if (asked.kind !== 'approval_requested') throw new Error('wrong event');
    await adapter.respondToApproval({
      approvalId: asked.approvalId,
      providerRequestId: asked.providerRequestId,
      decision: 'deny',
      optionId: 'reject_once',
    });
    await waitFor((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(answers().at(-1)?.params.result).toEqual({ permissions: {}, scope: 'turn' });
  }, 30_000);
});

describe('questions', () => {
  let home: string;
  let project: string;
  let adapter: CodexAdapter;
  let events: AdapterEvent[];
  let waitFor: ReturnType<typeof collector>['waitFor'];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
    const c = collector();
    events = c.events;
    waitFor = c.waitFor;
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      attachDaemon: false,
      log: false,
    });
    adapter.subscribe(c.emit);
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('relays `requestUserInput` and answers it by option index', async () => {
    await adapter.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'ask me something',
      localImagePaths: [],
      readOnly: false,
    });
    const asked = await waitFor((e) => e.kind === 'question_asked');
    if (asked.kind !== 'question_asked') throw new Error('wrong event');
    expect(asked.answerable).toBe(true);
    expect(asked.secret).toEqual([false, true]);
    expect(asked.questions[0]).toMatchObject({
      header: 'Deploy target',
      multiSelect: false,
      options: [
        { label: 'staging', description: 'safe' },
        { label: 'production', description: 'careful' },
      ],
    });
    // The question also lands as a sealed frame, so the phone can render it from the transcript.
    expect(framesOf(events).some((f) => f.body.kind === 'question')).toBe(true);

    await adapter.answerQuestion({
      providerRequestId: asked.providerRequestId,
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, optionIndexes: [], freeText: 'sk-secret' },
      ],
    });
    const done = await waitFor(
      (e) =>
        e.kind === 'session_event' && e.type === 'agent_message' && e.summary.includes('Answered'),
    );
    // The agent is told the labels of the options chosen, keyed by the question's own id.
    expect(done.kind === 'session_event' && done.summary).toContain('production');
    expect(done.kind === 'session_event' && done.summary).toContain('sk-secret');
  }, 30_000);

  it('refuses to answer a question twice', async () => {
    await adapter.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'ask me something',
      localImagePaths: [],
      readOnly: false,
    });
    const asked = await waitFor((e) => e.kind === 'question_asked');
    if (asked.kind !== 'question_asked') throw new Error('wrong event');
    await adapter.answerQuestion({
      providerRequestId: asked.providerRequestId,
      answers: [{ questionIndex: 0, optionIndexes: [0] }],
    });
    await expect(
      adapter.answerQuestion({
        providerRequestId: asked.providerRequestId,
        answers: [{ questionIndex: 0, optionIndexes: [1] }],
      }),
    ).rejects.toThrow(/unknown or expired question/);
  }, 30_000);
});
