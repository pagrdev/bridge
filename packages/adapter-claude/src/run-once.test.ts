import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { isRunOnceFrame, runOnceSessionId } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const PROJ = 'proj_0000000000000000000000000000000a';

describe('ClaudeAdapter.runOnce against fake claude', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter;
  let events: AdapterEvent[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-run-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-'));
    fs.mkdirSync(path.join(project, '.pagr', 'handoff'), { recursive: true });
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      env: { FAKE_CLAUDE_ARGS_FILE: path.join(home, 'args.json') },
      mirror: false,
    });
    events = [];
    adapter.subscribe((e) => events.push(e));
  });
  afterEach(async () => {
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const run = (prompt: string, over: Partial<Parameters<ClaudeAdapter['runOnce']>[0]> = {}) =>
    adapter.runOnce({
      cwd: project,
      prompt,
      kind: 'handoff' as const,
      timeoutMs: 15_000,
      projectId: PROJ,
      ...over,
    });

  const frames = () => events.filter((e) => e.kind === 'frame');

  /** Poll rather than sleep: a run becomes live when its child does, not after a fixed wait. */
  const waitFor = async (cond: () => boolean, ms = 5_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > until) throw new Error('condition never became true');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('writes the file it was asked for and resolves with it there', async () => {
    const rel = '.pagr/handoff/hnd_1.md';
    const res = await run(`write file ${rel}`);
    expect(res.outcome).toBe('completed');
    expect(fs.existsSync(path.join(project, rel))).toBe(true);
    expect(res.output).toContain('Wrote');
    expect(res.error).toBeUndefined();
  });

  /**
   * A run is an ordinary agent run in an ordinary checkout, so it is not fenced into `.pagr`.
   * Constraining it was never a boundary: Pagr starts full sessions in this same repository on
   * a text message, and this is strictly less than one of those.
   */
  it('is not confined to .pagr — it may write a source file like any other run', async () => {
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const res = await run('write file src/index.ts');
    expect(res.outcome).toBe('completed');
    expect(fs.existsSync(path.join(project, 'src', 'index.ts'))).toBe(true);
  });

  it('passes print mode, acceptEdits and the user’s own settings on the argv', async () => {
    await run('write file .pagr/handoff/hnd_2.md');
    const { argv, env, cwd } = JSON.parse(
      fs.readFileSync(path.join(home, 'args.json'), 'utf8'),
    ) as { argv: string[]; env: Record<string, string | undefined>; cwd: string };
    // The repository itself, exactly as a session gets it.
    expect(cwd).toBe(fs.realpathSync(project));
    expect(argv).toContain('-p');
    // Nothing narrows what the run may use.
    expect(argv).not.toContain('--allowedTools');
    // The one flag a run does not share with a session, and it is about nobody being attached.
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // The person's own settings, and their MCP servers, exactly as a session loads them.
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    expect(argv).not.toContain('--strict-mcp-config');
    // Prompts come back to us over stdio, which is what makes auto-denial possible at all.
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    // The daemon socket is never handed to a child.
    expect(env.PAGR_DAEMON_SOCK).toBeUndefined();
  });

  /**
   * The auto-deny that remains is about interactivity, not containment: nobody is attached to
   * answer, and `allow` is not the bridge's to give (`core/src/deviceFloor.ts`). A prompt that
   * is never answered is a handoff that hangs until its timeout.
   */
  it('denies a prompt it cannot relay, rather than hanging on it', async () => {
    const outside = path.join(path.dirname(project), 'escape.md');
    const res = await run(`write file ${outside}`);
    expect(fs.existsSync(outside)).toBe(false);
    expect(res.outcome).toBe('completed');
    expect(res.output).toContain('Could not write');
    // The refusal is the agent's: it asked, and the run denied it on the spot.
    expect(events.some((e) => e.kind === 'approval_requested')).toBe(false);
    expect(
      frames().some(
        (e) =>
          e.kind === 'frame' && e.body.kind === 'system' && e.body.subtype === 'run_once_denied',
      ),
    ).toBe(true);
  });

  it('kills a hung run at the timeout and reports it', async () => {
    const res = await run('hang', { timeoutMs: 700 });
    expect(res.outcome).toBe('timeout');
    expect(res.error).toBeUndefined();
    expect(res.durationMs).toBeGreaterThanOrEqual(600);
    expect(
      frames().some(
        (e) =>
          e.kind === 'frame' && e.body.kind === 'system' && e.body.subtype === 'run_once_timeout',
      ),
    ).toBe(true);
  });

  it('types a non-zero exit as a failure rather than throwing', async () => {
    const res = await run('crash');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code === 'exited' || res.error?.code === 'start_failed').toBe(true);
    expect(res.exitCode).toBe(7);
  });

  it('types an error the agent reports itself', async () => {
    const res = await run('fail');
    expect(res.outcome).toBe('failed');
    expect(res.error?.code).toBe('agent_error');
    expect(res.output).toContain('Something went wrong');
  });

  it('cancels on an abort signal', async () => {
    const ac = new AbortController();
    const p = run('hang', { signal: ac.signal, timeoutMs: 20_000 });
    setTimeout(() => ac.abort(), 200);
    expect((await p).outcome).toBe('canceled');
  });

  /**
   * HND-019. A run used to be registered nowhere, which took visibility and cancellation away
   * along with steering. These four tests are the tripwire on each half of that.
   */
  it('is a session while it runs: listed, answered by getStatus, and announced', async () => {
    const runId = 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sessionId = runOnceSessionId('claude', runId);
    const pending = run('hang', { runId });
    await waitFor(() => adapter.oneShots().length === 1);

    const listed = await adapter.listSessions();
    const row = listed.find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('working');
    expect(row?.provider).toBe('claude');
    expect(row?.projectId).toBe(PROJ);
    expect(row?.displayName).toBe('Writing the handoff');
    // It is ours, and we can do everything to it: that is what `full` means.
    expect(row?.controlLevel).toBe('full');
    expect(row?.origin).toBe('pagr');
    expect(row?.oneShot).toEqual({ kind: 'handoff', runId });
    expect(await adapter.getStatus(sessionId)).toMatchObject({ sessionId, status: 'working' });
    expect(events.filter((e) => e.kind === 'session_event' && e.type === 'started')).toHaveLength(
      1,
    );

    await adapter.stopSession(sessionId);
    await pending;
  });

  it('stops when told to, and reports itself canceled rather than failed', async () => {
    const runId = 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const sessionId = runOnceSessionId('claude', runId);
    const pending = run('hang', { runId });
    await waitFor(() => adapter.oneShots().length === 1);

    await adapter.stopSession(sessionId);
    const res = await pending;
    expect(res.outcome).toBe('canceled');
    expect(res.error).toBeUndefined();
    // And the row settles as stopped, not failed, in the list and in the event stream.
    expect(await adapter.getStatus(sessionId)).toBeNull();
    expect(adapter.oneShots()).toEqual([]);
    const last = events.filter((e) => e.kind === 'session_event').at(-1);
    expect(last).toMatchObject({ type: 'stopped', sessionId });
  });

  it('takes an instruction mid-run — queued, then run as the next turn on the same process', async () => {
    const runId = 'run_cccccccccccccccccccccccccccccccc';
    const sessionId = runOnceSessionId('claude', runId);
    const pending = run('slow one', { runId });
    await waitFor(() => adapter.oneShots().length === 1);

    // Claude takes no live steer (ADR 0001), so `queued` is the honest answer — the same one an
    // ordinary Claude session gives for a follow-up sent mid-turn.
    const sent = await adapter.sendInstruction({
      sessionId,
      instruction: 'two',
      mode: 'auto',
      localImagePaths: [],
    });
    expect(sent).toEqual({ delivered: 'queued' });
    expect(events.some((e) => e.kind === 'session_event' && e.type === 'queued_followup')).toBe(
      true,
    );

    // The run does NOT end at the first `result`: the queued turn goes out on the same process,
    // and both turns are in the output the caller gets back.
    const res = await pending;
    expect(res.outcome).toBe('completed');
    expect(res.output).toContain('Echo: one');
    expect(res.output).toContain('Echo: two');
    expect(events.some((e) => e.kind === 'session_event' && e.type === 'followup_delivered')).toBe(
      true,
    );
  });

  it('keeps its frames nested under the run, exactly as before', async () => {
    const res = await run('write file .pagr/handoff/hnd_3.md');
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
