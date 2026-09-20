import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { isRunOnceFrame } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';
import { runOnceThreadParams, runOnceTurnParams } from './run-once.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const PROJ = 'proj_0000000000000000000000000000000a';
const ALLOWED = ['.pagr/**'];

describe('the params a headless codex run uses', () => {
  it('starts the thread workspace-write, never asking, with the roots as config', () => {
    const { params, writableRoots } = runOnceThreadParams({
      cwd: '/repo',
      allowedWrites: ALLOWED,
    });
    expect(params.cwd).toBe('/repo');
    expect(params.approvalPolicy).toBe('never');
    expect(params.sandbox).toBe('workspace-write');
    expect(writableRoots).toEqual(['/repo/.pagr']);
    expect(params.config).toEqual({
      sandbox_workspace_write: {
        writable_roots: ['/repo/.pagr'],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    });
  });

  it('restates the policy on the turn, where writableRoots can actually be spelled', () => {
    const turn = runOnceTurnParams('thr_1', {
      cwd: '/repo',
      prompt: 'write the handoff',
      allowedWrites: ALLOWED,
    });
    expect(turn.threadId).toBe('thr_1');
    expect(turn.input).toEqual([{ type: 'text', text: 'write the handoff', text_elements: [] }]);
    expect(turn.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/repo/.pagr'],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });
});

describe('CodexAdapter.runOnce against the fake app-server', () => {
  let home: string;
  let project: string;
  let outside: string;
  let rpcLog: string;
  let adapter: CodexAdapter;
  let events: AdapterEvent[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-run-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-elsewhere-'));
    rpcLog = path.join(home, 'rpc.ndjson');
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      restartDelayMs: 50,
      log: false,
      env: { FAKE_CODEX_RPC_LOG: rpcLog },
    });
    events = [];
    adapter.subscribe((e) => events.push(e));
  });
  afterEach(async () => {
    await adapter.shutdown();
    for (const dir of [home, project, outside]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (prompt: string, over: Partial<Parameters<CodexAdapter['runOnce']>[0]> = {}) =>
    adapter.runOnce({
      cwd: project,
      prompt,
      allowedWrites: ALLOWED,
      timeoutMs: 15_000,
      projectId: PROJ,
      ...over,
    });

  const rpc = (): Array<{ method: string; params: Record<string, unknown> }> =>
    fs
      .readFileSync(rpcLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const frames = () => events.filter((e) => e.kind === 'frame');

  it('writes a file under the allowed path and resolves with it there', async () => {
    const rel = '.pagr/handoff/hnd_1.md';
    const res = await run(`write file ${rel}`);
    expect(res.outcome).toBe('completed');
    expect(fs.existsSync(path.join(project, rel))).toBe(true);
    expect(res.output).toContain('Wrote');
  });

  it('asks for workspace-write with the roots, and never for an approval', async () => {
    await run('write file .pagr/handoff/hnd_2.md');
    const start = rpc().find((l) => l.method === 'thread/start');
    expect(start?.params.cwd).toBe(project);
    expect(start?.params.approvalPolicy).toBe('never');
    expect(start?.params.sandbox).toBe('workspace-write');
    expect(start?.params.config).toEqual({
      sandbox_workspace_write: {
        writable_roots: [path.join(project, '.pagr')],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    });
    const turn = rpc().find((l) => l.method === 'turn/start');
    expect(turn?.params.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [path.join(project, '.pagr')],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it('is refused by the sandbox when it writes outside the workspace', async () => {
    const target = path.join(outside, 'escape.md');
    const res = await run(`write file ${target}`);
    expect(fs.existsSync(target)).toBe(false);
    expect(res.output).toContain('Sandbox denied');
    // The refusal happened inside the agent; nothing here inspected the tree afterwards, and no
    // approval was ever raised for a phone to answer.
    expect(events.some((e) => e.kind === 'approval_requested')).toBe(false);
  });

  it('interrupts and reports a run that never finishes its turn', async () => {
    const res = await run('wait', { timeoutMs: 700 });
    expect(res.outcome).toBe('timeout');
    expect(res.error).toBeUndefined();
    expect(rpc().some((l) => l.method === 'turn/interrupt')).toBe(true);
  });

  it('types an app-server that dies mid-turn as a failure', async () => {
    const res = await run('crash');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code).toBe('exited');
  });

  it('types a turn the agent itself failed', async () => {
    const res = await run('fail');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code).toBe('agent_error');
    expect(res.error?.message).toContain('model exploded');
  });

  it('cancels on an abort signal', async () => {
    const ac = new AbortController();
    const p = run('wait', { signal: ac.signal, timeoutMs: 20_000 });
    setTimeout(() => ac.abort(), 200);
    expect((await p).outcome).toBe('canceled');
  });

  it('is never a controllable session', async () => {
    const res = await run('write file .pagr/handoff/hnd_3.md');
    expect(await adapter.listSessions()).toEqual([]);
    expect(await adapter.getStatus(res.sessionId)).toBeNull();
    await expect(
      adapter.sendInstruction({
        sessionId: res.sessionId,
        instruction: 'keep going',
        mode: 'auto',
        localImagePaths: [],
      }),
    ).rejects.toThrow(/unknown session/);
    expect(events.some((e) => e.kind === 'session')).toBe(false);
    expect(events.some((e) => e.kind === 'session_event')).toBe(false);
    const got = frames();
    expect(got.length).toBeGreaterThan(0);
    expect(
      got.every(
        (e) => e.kind === 'frame' && e.sessionId === res.sessionId && isRunOnceFrame(e.meta),
      ),
    ).toBe(true);
  });

  it('drops its frames when the caller names no project', async () => {
    const res = await run('write file .pagr/handoff/hnd_4.md', { projectId: undefined });
    expect(res.outcome).toBe('completed');
    expect(frames()).toEqual([]);
  });
});

/**
 * The ordering the shipped code got wrong, made deterministic.
 *
 * `stop()` interrupts and only then settles, so anything the interrupt shakes loose can be
 * handled first and decide the run instead. Whether it was handled first depended on whether the
 * server's two writes shared a read chunk, which under the full parallel suite they did about one
 * gate run in three — a cancel the caller asked for, reported as a crash.
 *
 * `FAKE_CODEX_INTERRUPT_RACE` makes the losing order the only order, in the two shapes that
 * matter: the interrupt landing (`interrupted`), and the turn finishing on its own in the very
 * same instant (`completed`). The second is the one that survives claiming the outcome only at
 * the `interrupted` and `turn/start` call sites, so both belong here.
 */
describe.each([
  ['answers the turn interrupted before it answers the interrupt', 'interrupted'],
  ['completes the turn normally in the same instant as the interrupt', 'completed'],
])('CodexAdapter.runOnce when the server %s', (_label, mode) => {
  let home: string;
  let project: string;
  let adapter: CodexAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-race-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-race-'));
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      restartDelayMs: 50,
      log: false,
      env: { FAKE_CODEX_INTERRUPT_RACE: mode },
    });
  });
  afterEach(async () => {
    await adapter.shutdown();
    for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const raced = (over: Partial<Parameters<CodexAdapter['runOnce']>[0]> = {}) =>
    adapter.runOnce({
      cwd: project,
      prompt: 'wait',
      allowedWrites: ALLOWED,
      timeoutMs: 15_000,
      projectId: PROJ,
      ...over,
    });

  it('reports the cancel, not what the cancel caused', async () => {
    const ac = new AbortController();
    const p = raced({ signal: ac.signal, timeoutMs: 20_000 });
    setTimeout(() => ac.abort(), 200);
    const res = await p;
    expect(res.outcome).toBe('canceled');
    expect(res.error).toBeUndefined();
  });

  it('reports the timeout, not what the timeout caused', async () => {
    const res = await raced({ timeoutMs: 400 });
    expect(res.outcome).toBe('timeout');
    expect(res.error).toBeUndefined();
  });
});

describe('CodexAdapter.runOnce and outcomes it did not ask for', () => {
  let home: string;
  let project: string;
  let adapter: CodexAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-codex-unasked-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-unasked-'));
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      restartDelayMs: 50,
      log: false,
      env: { FAKE_CODEX_INTERRUPT_RACE: 'interrupted' },
    });
  });
  afterEach(async () => {
    await adapter.shutdown();
    for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (prompt: string) =>
    adapter.runOnce({
      cwd: project,
      prompt,
      allowedWrites: ALLOWED,
      timeoutMs: 15_000,
      projectId: PROJ,
    });

  // The claim only outranks messages inside the window it opened. A run nobody stopped reports
  // exactly what happened to it, which is what makes the claim safe to enforce in `settle`.
  it('still types a turn the agent failed as an agent error', async () => {
    const res = await run('fail');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code).toBe('agent_error');
    expect(res.error?.message).toContain('model exploded');
  });

  it('still types an app-server that died mid-turn as exited', async () => {
    const res = await run('crash');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code).toBe('exited');
  });

  it('still completes a run that finished before anything stopped it', async () => {
    const res = await run('write file .pagr/handoff/hnd_race.md');
    expect(res.outcome).toBe('completed');
    expect(res.error).toBeUndefined();
  });
});
