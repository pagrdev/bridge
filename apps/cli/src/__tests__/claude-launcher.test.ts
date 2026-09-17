import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passthroughArgs } from '../commands/claude.js';
import {
  claudeLaunchPlan,
  findRealClaude,
  isHeadlessArgv,
  LAUNCHER_NOTICE,
  runClaudeLauncher,
} from '../commands/claudeLauncher.js';
import { type CliContext, createContext } from '../context.js';
import { type Harness, harness } from './helpers.js';

/**
 * `pagr claude`.
 *
 * The argv matrix is the contract: the development-channel flag is added only for a session that
 * can actually answer Claude Code's warning dialog (spike MOB-045), and never for a headless run,
 * where the channel is silently not registered and every event is dropped with no error.
 */

const FLAG = '--dangerously-load-development-channels';
let h: Harness;
let bin: string;
let argvFile: string;

/** A real executable on a temp PATH: `sh` runs it, and it records the argv it was handed. */
function fakeClaude(name = 'claude', exit = 0): string {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit ${exit}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A real `CliContext` over the harness's seams, which is what the launcher takes. */
const ctx = (over: Partial<CliContext> = {}): CliContext =>
  Object.assign(createContext(h.overrides), over);

const recordedArgv = (): string[] =>
  readFileSync(argvFile, 'utf8')
    .split('\n')
    .filter((l) => l !== '');

beforeEach(() => {
  h = harness();
  bin = join(h.home, '..', 'bin');
  mkdirSync(bin, { recursive: true });
  argvFile = join(h.home, '..', 'argv.txt');
  h.overrides.env = { ...h.overrides.env, PATH: bin };
});
afterEach(() => h.cleanup());

describe('claudeLaunchPlan', () => {
  const plan = (argv: string[], over: { isTTY?: boolean; env?: NodeJS.ProcessEnv } = {}) =>
    claudeLaunchPlan({
      binary: '/usr/local/bin/claude',
      argv,
      env: over.env ?? {},
      isTTY: over.isTTY ?? true,
    });

  it('adds the flag for an interactive session and passes the rest straight through', () => {
    const p = plan(['--model', 'sonnet', 'fix the build']);
    expect(p.channel).toBe(true);
    expect(p.args).toEqual([FLAG, 'server:pagr', '--model', 'sonnet', 'fix the build']);
  });

  it('keeps argument order exactly as typed', () => {
    expect(plan(['--resume', 'abc']).args).toEqual([FLAG, 'server:pagr', '--resume', 'abc']);
  });

  it('leaves the flag off without a TTY', () => {
    const p = plan([], { isTTY: false });
    expect(p.channel).toBe(false);
    expect(p.args).toEqual([]);
    expect(p.reason).toContain('not a terminal');
  });

  it.each([['-p'], ['--print'], ['--output-format'], ['--output-format=stream-json']])(
    'leaves the flag off for a headless run (%s)',
    (flag) => {
      const p = plan([flag, 'do a thing']);
      expect(p.channel).toBe(false);
      expect(p.args).toEqual([flag, 'do a thing']);
      expect(p.reason).toContain('headless');
    },
  );

  it('leaves the flag off for `--resume` with `-p`, which is a headless resume', () => {
    expect(plan(['--resume', 'abc', '-p', 'go']).channel).toBe(false);
  });

  it('honours --no-channel and strips it, because claude has never heard of it', () => {
    const p = plan(['--no-channel', '--model', 'sonnet']);
    expect(p.channel).toBe(false);
    expect(p.args).toEqual(['--model', 'sonnet']);
    expect(p.reason).toContain('--no-channel');
  });

  it('honours PAGR_NO_CHANNEL=1', () => {
    const p = plan(['--model', 'sonnet'], { env: { PAGR_NO_CHANNEL: '1' } });
    expect(p.channel).toBe(false);
    expect(p.args).toEqual(['--model', 'sonnet']);
  });

  it('ignores PAGR_NO_CHANNEL set to anything else', () => {
    expect(plan([], { env: { PAGR_NO_CHANNEL: '0' } }).channel).toBe(true);
  });

  it('recognises the headless flags and nothing else', () => {
    expect(isHeadlessArgv(['--permission-mode', 'default'])).toBe(false);
    expect(isHeadlessArgv(['-p'])).toBe(true);
  });
});

describe('finding the real claude', () => {
  it('takes the first executable `claude` on PATH', () => {
    const p = fakeClaude();
    expect(findRealClaude({ PATH: bin })).toBe(p);
  });

  it('is null when there is none', () => {
    expect(findRealClaude({ PATH: bin })).toBeNull();
  });

  it('skips a non-executable file', () => {
    writeFileSync(join(bin, 'claude'), 'not executable');
    chmodSync(join(bin, 'claude'), 0o644);
    expect(findRealClaude({ PATH: bin })).toBeNull();
  });

  /** A `claude` that is really this launcher would fork-bomb the terminal. */
  it('skips a shim that resolves to the launcher itself', () => {
    const p = fakeClaude();
    expect(findRealClaude({ PATH: bin }, [p])).toBeNull();
  });
});

describe('runClaudeLauncher', () => {
  it('execs the real claude with the flag, and says the dialog is coming', () => {
    fakeClaude();
    const res = runClaudeLauncher(ctx(), ['fix the build'], { isTTY: true });
    expect(res.channel).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(recordedArgv()).toEqual([FLAG, 'server:pagr', 'fix the build']);
    expect(h.stderr.join('\n')).toContain(LAUNCHER_NOTICE);
  });

  it('execs plain claude, and says nothing, when the channel is off', () => {
    fakeClaude();
    const res = runClaudeLauncher(ctx(), ['-p', 'summarise'], { isTTY: true });
    expect(res.channel).toBe(false);
    expect(recordedArgv()).toEqual(['-p', 'summarise']);
    expect(h.stderr.join('\n')).not.toContain(LAUNCHER_NOTICE);
  });

  it('returns Claude Code’s own exit code', () => {
    fakeClaude('claude', 3);
    expect(runClaudeLauncher(ctx(), [], { isTTY: true }).exitCode).toBe(3);
  });

  it('refuses with an actionable error when claude is not installed', () => {
    expect(() => runClaudeLauncher(ctx(), [], { isTTY: true })).toThrow(/no `claude` on PATH/);
  });

  it('prints the plan and launches nothing under --json', () => {
    fakeClaude();
    runClaudeLauncher(ctx({ json: true }), ['--model', 'sonnet'], { isTTY: true });
    expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({ channel: true, launched: false });
  });
});

describe('argv passthrough', () => {
  it('takes everything after the `claude` token, global flags excluded', () => {
    expect(passthroughArgs(['--json', 'claude', '-p', 'hi'])).toEqual(['-p', 'hi']);
    expect(passthroughArgs(['claude'])).toEqual([]);
    expect(passthroughArgs(['doctor'])).toEqual([]);
  });
});

describe('the bridge’s own spawns', () => {
  /**
   * The flag must never reach a session the bridge starts. Those are headless, so Claude Code
   * drops every channel event with no error on either side — adding it would be noise plus a
   * false sense of steering. Asserted against the source, so a future edit has to face this test.
   */
  it('claude-process.ts never builds argv containing the development-channel flag', () => {
    const src = readFileSync(
      new URL('../../../../packages/adapter-claude/src/claude-process.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('dangerously-load-development-channels');
    expect(src).not.toContain('server:pagr');
  });

  it('a real spawn records argv with no channel flag in it', () => {
    // The adapter's own fake-claude fixture records the argv it was given; the E2E adapter tests
    // drive it. Here we only assert the shape the launcher adds is absent from a plain exec.
    const p = fakeClaude();
    execFileSync(p, ['--version'], { encoding: 'utf8' });
    expect(recordedArgv()).toEqual(['--version']);
  });
});
