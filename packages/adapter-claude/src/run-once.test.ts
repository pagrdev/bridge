import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { isRunOnceFrame } from '@pagr/bridge-core';
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
      timeoutMs: 15_000,
      projectId: PROJ,
      ...over,
    });

  const frames = () => events.filter((e) => e.kind === 'frame');

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

  it('is never a controllable session', async () => {
    const res = await run('write file .pagr/handoff/hnd_3.md');
    // Not listed, not resumable, not steerable, not stoppable — and never announced.
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
    // Its frames still reach the phone, marked as a run's.
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
