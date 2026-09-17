import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { dim } from '../output.js';
import { CHANNEL_SERVER_NAME, DEV_CHANNEL_FLAG } from './claudeChannel.js';

/**
 * `pagr claude` — start Claude Code with the Pagr channel loaded.
 *
 * Spike MOB-045 settled the shape of this. Claude Code shows a full-screen
 * "WARNING: Loading development channels" dialog on EVERY launch that names a development
 * channel, and nothing persists the acceptance: no key in `~/.claude.json`, none in
 * `~/.claude/settings.json`, on 2.1.220 and on 2.1.274 alike. So there is no shim on PATH and no
 * automated keystroke — the dialog is the consent gate, its position varies (folder trust, then
 * the project MCP consent, then the warning) and its option numbering differs by version.
 *
 * Plain `claude` therefore stays exactly as it was, and its sessions stay `approvals_only`. A
 * user who wants their phone to take a turn in a terminal runs `pagr claude` and presses Enter
 * once, which is why the launcher prints one line saying the dialog is coming.
 */

export const LAUNCHER_NOTICE =
  'Loading the Pagr channel — Claude will ask you to confirm development channels; press Enter.';

/** Our own flag; it must never reach `claude`, which has no idea what it means. */
export const NO_CHANNEL_FLAG = '--no-channel';
export const NO_CHANNEL_ENV = 'PAGR_NO_CHANNEL';

/**
 * Argv that means "this session cannot answer a dialog".
 *
 * A headless run (`-p`, `--print`, any `--output-format`) never renders the warning: the channel
 * is silently NOT registered and every event is dropped with no error on either side, which the
 * spike measured directly. Adding the flag there would be pure noise plus a false promise of
 * steering, so the launcher leaves it off.
 */
const HEADLESS_FLAGS = new Set(['-p', '--print', '--output-format']);

export interface LaunchPlan {
  /** The real `claude` to exec. */
  binary: string;
  /** Full argv for it, `$@` passed through minus our own flags. */
  args: string[];
  /** Whether the channel flag was added. */
  channel: boolean;
  /** Why not, when it was not. One short clause, shown only in `--json`. */
  reason?: string;
}

export interface LaunchPlanInput {
  binary: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** `process.stdin.isTTY`: a dialog needs a terminal to be answered in. */
  isTTY: boolean;
}

export function isHeadlessArgv(argv: string[]): boolean {
  return argv.some((a) => HEADLESS_FLAGS.has(a) || a.startsWith('--output-format='));
}

/** Pure: what `pagr claude` would run. Everything the tests care about lives here. */
export function claudeLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const passthrough = input.argv.filter((a) => a !== NO_CHANNEL_FLAG);
  const off = (reason: string): LaunchPlan => ({
    binary: input.binary,
    args: passthrough,
    channel: false,
    reason,
  });
  if (input.argv.includes(NO_CHANNEL_FLAG)) return off(`${NO_CHANNEL_FLAG} was given`);
  if (input.env[NO_CHANNEL_ENV] === '1') return off(`${NO_CHANNEL_ENV}=1 is set`);
  if (!input.isTTY) return off('stdin is not a terminal, so the warning cannot be answered');
  if (isHeadlessArgv(input.argv))
    return off(
      'this is a headless run (-p / --print / --output-format); channel events are dropped',
    );
  return {
    binary: input.binary,
    args: [DEV_CHANNEL_FLAG, `server:${CHANNEL_SERVER_NAME}`, ...passthrough],
    channel: true,
  };
}

/**
 * The real `claude`, found by walking PATH ourselves.
 *
 * `selfPaths` are skipped: if somebody has put a `claude` on PATH that is really this launcher
 * (a shim, an alias file, a symlink into `pagr`), execing it would fork-bomb the terminal. Paths
 * are compared after `realpath`, so a symlink chain into the same file is caught too.
 */
export function findRealClaude(
  env: NodeJS.ProcessEnv = process.env,
  selfPaths: string[] = [],
): string | null {
  const self = new Set(selfPaths.map(canonical).filter((p): p is string => p !== null));
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const real = canonical(candidate);
    if (real && self.has(real)) continue;
    return candidate;
  }
  return null;
}

const canonical = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

export interface LauncherOptions {
  /** Test seam; defaults to `child_process.spawnSync` with inherited stdio. */
  run?: (binary: string, args: string[]) => { status: number | null; signal?: string | null };
  /** Test seam; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
}

/**
 * Run the launcher. Never returns in production — the exit code is Claude Code's own, so
 * `pagr claude && something` behaves exactly like `claude && something`.
 */
export function runClaudeLauncher(
  ctx: CliContext,
  argv: string[],
  opts: LauncherOptions = {},
): LaunchPlan & { exitCode: number } {
  const binary = findRealClaude(ctx.env, [ctx.binPath, process.argv[1] ?? '']);
  if (!binary)
    throw new CliError('no `claude` on PATH', EXIT.precondition, {
      code: 'claude_not_installed',
      hint: 'install Claude Code: npm i -g @anthropic-ai/claude-code, then run `claude` once and sign in',
    });
  const plan = claudeLaunchPlan({
    binary,
    argv,
    env: ctx.env,
    isTTY: opts.isTTY ?? Boolean(process.stdin.isTTY),
  });
  if (ctx.json) {
    // A machine asked what would happen; running an interactive Claude Code under --json would
    // interleave its TUI with our JSON and neither would be readable.
    ctx.out(JSON.stringify({ ...plan, launched: false }, null, 2));
    return { ...plan, exitCode: 0 };
  }
  if (plan.channel) ctx.err(dim(LAUNCHER_NOTICE));
  const run = opts.run ?? defaultRun;
  const res = run(plan.binary, plan.args);
  // A child killed by a signal has no exit status; 130 is the shell's convention for SIGINT and
  // is what a user who pressed Ctrl-C expects to see in `$?`.
  const exitCode = res.status ?? (res.signal ? 130 : 0);
  return { ...plan, exitCode };
}

function defaultRun(
  binary: string,
  args: string[],
): { status: number | null; signal?: string | null } {
  const res = spawnSync(binary, args, { stdio: 'inherit' });
  return { status: res.status, signal: res.signal };
}
