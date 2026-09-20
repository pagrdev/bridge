import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { isRunOnceFrame } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';
import { runOnceAllowedTools } from './run-once.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const PROJ = 'proj_0000000000000000000000000000000a';
const ALLOWED = ['.pagr/**'];

describe('runOnceAllowedTools', () => {
  it('permits reading, read-only git, and writing only under the caller’s globs', () => {
    const tools = runOnceAllowedTools(ALLOWED);
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash(git status:*)');
    expect(tools).toContain('Write(.pagr/**)');
    expect(tools).toContain('Edit(.pagr/**)');
    // No unscoped write, no general Bash, and nothing that commits: the WIP commit is the
    // bridge's own git subprocess (HND-003), not something the model runs.
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Bash');
    expect(tools.some((t) => t.includes('git commit'))).toBe(false);
  });
});

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
      allowedWrites: ALLOWED,
      timeoutMs: 15_000,
      projectId: PROJ,
      ...over,
    });

  const frames = () => events.filter((e) => e.kind === 'frame');

  it('writes a file under the allowed path and resolves with it there', async () => {
    const rel = '.pagr/handoff/hnd_1.md';
    const res = await run(`write file ${rel}`);
    expect(res.outcome).toBe('completed');
    expect(fs.existsSync(path.join(project, rel))).toBe(true);
    expect(res.output).toContain('Wrote');
    expect(res.error).toBeUndefined();
  });

  it('passes print mode, the allowlist and sealed settings on the argv', async () => {
    await run('write file .pagr/handoff/hnd_2.md');
    const { argv, env, cwd } = JSON.parse(
      fs.readFileSync(path.join(home, 'args.json'), 'utf8'),
    ) as { argv: string[]; env: Record<string, string | undefined>; cwd: string };
    expect(cwd).toBe(fs.realpathSync(project));
    expect(argv).toContain('-p');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Write(.pagr/**)');
    expect(argv).toContain('Read');
    // Sealed: the checked-out repo's own settings and MCP servers cannot grant this run a tool,
    // because nobody is watching it to notice that they did.
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,local');
    expect(argv).toContain('--strict-mcp-config');
    // Prompts come back to us over stdio, which is what makes auto-denial possible at all.
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    // The daemon socket is never handed to a child.
    expect(env.PAGR_DAEMON_SOCK).toBeUndefined();
  });

  it('is refused by the agent when it writes outside the allowed globs', async () => {
    const outside = 'notes/escape.md';
    fs.mkdirSync(path.join(project, 'notes'), { recursive: true });
    const res = await run(`write file ${outside}`);
    expect(fs.existsSync(path.join(project, outside))).toBe(false);
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
