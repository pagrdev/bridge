import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The bridge's only git subprocess.
 *
 * Everything else that knows about repositories reads files (`projects.ts` parses `.git/config`,
 * `scan.ts` looks for `.git` directories). This module is the one place that RUNS git, so the
 * blast radius of "Pagr executed something on my machine" is a single reviewable file:
 *
 * - `execFile` with an explicit argument array. Never a shell string, so a branch called
 *   `; rm -rf ~` is an argument and not a command.
 * - A built environment, not the daemon's. `GIT_TERMINAL_PROMPT=0` so nothing can block on a
 *   credential prompt, `GIT_OPTIONAL_LOCKS=0` so a read never writes to the index the user's own
 *   git is holding, `LC_ALL=C` so parsing does not depend on the user's locale. HOME is kept
 *   because a commit must use the user's real identity, signing key and hooks.
 * - 30 s timeout, 10 MiB of output, cwd always the repository root — resolved first, so a path
 *   that is not inside a work tree is refused before any mutating command runs.
 * - Hooks are NOT skipped. No `--no-verify`, no `-c core.hooksPath=`. A `pre-commit` hook that
 *   fails fails the commit, and its first line comes back on the error so the phone can say why.
 * - Nothing here writes to a remote. There is no push, fetch or pull in this module, by design.
 */

export type GitErrorCode =
  /** The path is not inside a git work tree (or is a bare repository). */
  | 'not_a_repo'
  /** The path does not exist, or is not a directory. */
  | 'not_found'
  /** No `git` on PATH. */
  | 'git_missing'
  /** The repository has no commits yet, and the command needs one. */
  | 'no_commits'
  /** git ran longer than the timeout and was killed. */
  | 'timeout'
  /** Output exceeded `maxBuffer` — a diff far larger than anything worth sending to a phone. */
  | 'too_large'
  /** A hook (pre-commit, commit-msg, …) rejected the commit. `detail` is the hook's first line. */
  | 'hook_failed'
  /** git exited non-zero for any other reason. */
  | 'git_failed'
  /** Writing `.git/info/exclude` failed. */
  | 'io';

export class GitError extends Error {
  /** The first non-empty line of the child's stderr (or stdout when stderr was silent). */
  readonly detail: string | undefined;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(
    readonly code: GitErrorCode,
    message: string,
    o: {
      detail?: string | undefined;
      stderr?: string | undefined;
      exitCode?: number | null | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'GitError';
    this.detail = o.detail;
    this.stderr = o.stderr ?? '';
    this.exitCode = o.exitCode ?? null;
    if (o.cause !== undefined) this.cause = o.cause;
  }
}

/** Fields of a `child_process.execFile` error this module actually looks at. */
interface ExecFail extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
}

/** The shape of `child_process.execFile` this module uses. Tests substitute their own. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    killSignal: NodeJS.Signals;
    windowsHide: boolean;
  },
  callback: (error: ExecFail | null, stdout: string, stderr: string) => void,
) => unknown;

export interface GitOptions {
  /** Substitute runner. Tests only — production always uses `child_process.execFile`. */
  execFile?: ExecFileLike | undefined;
  /** Per-call timeout. Defaults to {@link GIT_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
}

/** Long enough for a real `commit` with a slow `pre-commit` hook; short enough to text about. */
export const GIT_TIMEOUT_MS = 30_000;
/** 10 MiB. A diff bigger than this is not going to a phone anyway. */
export const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Variables a child git is allowed to inherit.
 *
 * PATH finds the binary. HOME (and the XDG/config overrides) is what makes the commit the user's
 * own — their `user.email`, their `commit.gpgsign`, their `core.hooksPath`. TMPDIR keeps git's
 * scratch files where the OS wants them. Everything else the daemon happens to carry —
 * `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, a stray `GIT_AUTHOR_*` from whatever launched
 * us — is dropped, so a variable in the daemon's environment can never redirect a commit.
 */
const INHERITED = [
  'PATH',
  'HOME',
  // macOS: the `git` in /usr/bin is a shim that picks a toolchain; without this it can refuse
  // to run at all on a Mac with Xcode installed but its licence unaccepted.
  'DEVELOPER_DIR',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'XDG_CONFIG_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of INHERITED) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // Never ask a human for a password: there is no terminal here and the phone cannot answer.
  env.GIT_TERMINAL_PROMPT = '0';
  // A status/diff for the phone must not take the index lock out from under the user's own git.
  env.GIT_OPTIONAL_LOCKS = '0';
  // Porcelain is stable, but error text and `--abbrev-ref` output are not. Pin the locale.
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

const firstLine = (s: string): string | undefined =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

/** Run git in an existing directory. Does not resolve the repo root — callers do that first. */
function runIn(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const exec = opts.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  return new Promise((res, rej) => {
    exec(
      'git',
      args,
      {
        cwd,
        env: gitEnv(),
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        // SIGTERM, not SIGKILL: git removes `index.lock` on SIGTERM. A killed `git commit` that
        // leaves a stale lock behind breaks the user's next commit in their own terminal.
        killSignal: 'SIGTERM',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return res({ stdout: String(stdout), stderr: String(stderr) });
        const out = String(err.stdout ?? stdout ?? '');
        const errOut = String(err.stderr ?? stderr ?? '');
        rej(classify(err, args, out, errOut));
      },
    );
  });
}

function classify(
  err: ExecFail,
  args: readonly string[],
  stdout: string,
  stderr: string,
): GitError {
  const detail = firstLine(stderr) ?? firstLine(stdout);
  const where = `git ${args.join(' ')}`;
  if (err.code === 'ENOENT')
    return new GitError('git_missing', 'git is not installed or not on PATH', { cause: err });
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return new GitError('too_large', `${where} produced more than ${GIT_MAX_BUFFER} bytes`, {
      cause: err,
    });
  if (err.killed || err.signal)
    return new GitError('timeout', `${where} timed out`, { detail, stderr, cause: err });
  const lower = stderr.toLowerCase();
  if (
    lower.includes('not a git repository') ||
    lower.includes('must be run in a work tree') ||
    lower.includes('this operation must be run in a work tree')
  )
    return new GitError('not_a_repo', detail ?? `${where}: not a git repository`, {
      detail,
      stderr,
      exitCode: typeof err.code === 'number' ? err.code : null,
    });
  if (lower.includes("ambiguous argument 'head'") || lower.includes('unknown revision'))
    return new GitError('no_commits', detail ?? `${where}: no commits yet`, {
      detail,
      stderr,
      exitCode: typeof err.code === 'number' ? err.code : null,
    });
  return new GitError('git_failed', detail ?? `${where} failed`, {
    detail,
    stderr,
    exitCode: typeof err.code === 'number' ? err.code : null,
  });
}

/** NUL-separated output → entries, with the trailing empty field dropped. */
const zsplit = (s: string): string[] => s.split('\0').filter((e) => e.length > 0);

function requireDirectory(dir: string): string {
  const abs = resolve(dir);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (cause) {
    throw new GitError('not_found', `${abs} does not exist`, { cause });
  }
  if (!st.isDirectory()) throw new GitError('not_found', `${abs} is not a directory`);
  return abs;
}

/**
 * The work tree root containing `dir`.
 *
 * Every other function in this module calls this first and uses the result as cwd, so a command
 * can never run somewhere that only looked like a repository.
 */
export async function repoRoot(dir: string, opts: GitOptions = {}): Promise<string> {
  const abs = requireDirectory(dir);
  const { stdout } = await runIn(abs, ['rev-parse', '--show-toplevel'], opts);
  const root = stdout.trim();
  if (!root) throw new GitError('not_a_repo', `${abs} is not inside a git work tree`);
  return resolve(root);
}

/** True when `dir` is inside a git work tree. False when it is not, or does not exist. */
export async function isRepo(dir: string, opts: GitOptions = {}): Promise<boolean> {
  try {
    await repoRoot(dir, opts);
    return true;
  } catch (e) {
    if (e instanceof GitError && (e.code === 'not_a_repo' || e.code === 'not_found')) return false;
    throw e;
  }
}

/** Run git at the repository root containing `dir`. */
async function run(dir: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const root = await repoRoot(dir, opts);
  const { stdout } = await runIn(root, args, opts);
  return stdout;
}

/**
 * `git status --porcelain`, one entry per changed path, status code included (`' M src/a.ts'`).
 *
 * `-z` so a filename with a space, a quote or a newline in it survives; for a rename git emits
 * the original path as a following field, which is consumed so one changed path is one entry.
 */
export async function statusPorcelain(dir: string, opts: GitOptions = {}): Promise<string[]> {
  const raw = await run(dir, ['status', '--porcelain=v1', '-z'], opts);
  const fields = zsplit(raw);
  const entries: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry === undefined) continue;
    entries.push(entry);
    // `R  new\0old\0` / `C  new\0old\0`: the source path is a field of its own, not an entry.
    if (entry.startsWith('R') || entry.startsWith('C')) i++;
  }
  return entries;
}

/** True when the work tree has uncommitted changes, untracked files included. */
export async function isDirty(dir: string, opts: GitOptions = {}): Promise<boolean> {
  return (await statusPorcelain(dir, opts)).length > 0;
}

/** The full SHA of HEAD. Throws `no_commits` in a repository with no commits yet. */
export async function head(dir: string, opts: GitOptions = {}): Promise<string> {
  return (await run(dir, ['rev-parse', 'HEAD'], opts)).trim();
}

/**
 * The current branch name, `'HEAD'` when detached.
 *
 * `branch --show-current` rather than `rev-parse --abbrev-ref`: it also answers on a repository
 * whose first commit has not been made, where `rev-parse` has nothing to resolve.
 */
export async function branch(dir: string, opts: GitOptions = {}): Promise<string> {
  return (await run(dir, ['branch', '--show-current'], opts)).trim() || 'HEAD';
}

export interface CommitResult {
  /** False when the tree was already clean: nothing was staged and nothing was committed. */
  committed: boolean;
  /** The new commit's SHA, or the existing HEAD when nothing was committed (null in an empty repo). */
  sha: string | null;
  /** Changed paths as of just before the commit — what the phone means by "3 files". */
  filesChanged: number;
}

/**
 * `git add -A && git commit -m <message>`, with the user's hooks running.
 *
 * A clean tree is not an error: nothing is staged, nothing is committed, and `committed` is
 * false so the caller can say so rather than inventing a commit. A hook that rejects the commit
 * raises `GitError('hook_failed')` with the hook's own first line in `detail`, which is the
 * sentence the phone shows.
 */
export async function commitAll(
  dir: string,
  message: string,
  opts: GitOptions = {},
): Promise<CommitResult> {
  const root = await repoRoot(dir, opts);
  const changed = await statusPorcelain(root, opts);
  const headOrNull = async (): Promise<string | null> => {
    try {
      return (await runIn(root, ['rev-parse', 'HEAD'], opts)).stdout.trim();
    } catch (e) {
      if (e instanceof GitError && e.code === 'no_commits') return null;
      throw e;
    }
  };
  if (changed.length === 0) return { committed: false, sha: await headOrNull(), filesChanged: 0 };

  await runIn(root, ['add', '-A'], opts);
  try {
    // No `--no-verify`: the user's pre-commit hook is theirs and it runs.
    await runIn(root, ['commit', '-m', message], opts);
  } catch (e) {
    throw e instanceof GitError && e.code === 'git_failed' && (await hasCommitHook(root, opts))
      ? new GitError('hook_failed', e.detail ?? 'a git hook rejected the commit', {
          detail: e.detail,
          stderr: e.stderr,
          exitCode: e.exitCode,
          cause: e,
        })
      : e;
  }
  const sha = (await runIn(root, ['rev-parse', 'HEAD'], opts)).stdout.trim();
  return { committed: true, sha, filesChanged: changed.length };
}

/**
 * Whether this repository has a hook that can veto a commit.
 *
 * git gives a failing hook no distinguishing exit code or message, so the only honest way to say
 * "your pre-commit hook rejected this" instead of "git failed" is to look for one. `--git-path`
 * respects `core.hooksPath`, so a repo-wide husky/lefthook directory is found too.
 */
async function hasCommitHook(root: string, opts: GitOptions): Promise<boolean> {
  let hooks: string;
  try {
    hooks = (await runIn(root, ['rev-parse', '--git-path', 'hooks'], opts)).stdout.trim();
  } catch {
    return false;
  }
  if (!hooks) return false;
  const base = resolve(root, hooks);
  // git only runs a hook that is executable, so neither does this check.
  return ['pre-commit', 'commit-msg', 'prepare-commit-msg'].some((h) => {
    try {
      return (statSync(join(base, h)).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

/** A revision or range is passed before `--` so a ref that looks like a path stays a ref. */
const rev = (args: string[], range?: string): string[] =>
  range ? [...args, range, '--'] : [...args, '--'];

/** `git diff --stat [range]`. Without a range: the work tree against the index and HEAD. */
export async function diffStat(
  dir: string,
  range?: string,
  opts: GitOptions = {},
): Promise<string> {
  return run(dir, rev(['diff', '--stat'], range), opts);
}

/** `git diff [range]`, the full patch. Capped by `maxBuffer`, which raises `too_large`. */
export async function diff(dir: string, range?: string, opts: GitOptions = {}): Promise<string> {
  return run(dir, rev(['diff'], range), opts);
}

/** `git log --oneline [range]`, newest first, one entry per commit. */
export async function logOneline(
  dir: string,
  range?: string,
  opts: GitOptions = {},
): Promise<string[]> {
  const out = await run(dir, rev(['log', '--oneline', '--no-decorate'], range), opts);
  return out.split('\n').filter((l) => l.trim().length > 0);
}

/** Paths touched by `range` (or by the uncommitted work tree when no range is given). */
export async function changedFiles(
  dir: string,
  range?: string,
  opts: GitOptions = {},
): Promise<string[]> {
  return zsplit(await run(dir, rev(['diff', '--name-only', '-z'], range), opts));
}

/**
 * Add `pattern` to `.git/info/exclude`, once.
 *
 * `.git/info/exclude`, never `.gitignore`: `.gitignore` is a tracked file that belongs to the
 * user and their team, and Pagr hiding its own `.pagr/` directory is not a change anyone should
 * find in their next diff. Returns true when the line was added, false when it was already there.
 */
export async function ensureExcluded(
  dir: string,
  pattern: string,
  opts: GitOptions = {},
): Promise<boolean> {
  const root = await repoRoot(dir, opts);
  const gitDir = (await runIn(root, ['rev-parse', '--absolute-git-dir'], opts)).stdout.trim();
  if (!gitDir) throw new GitError('not_a_repo', `${root} has no git directory`);
  const file = resolve(gitDir, 'info', 'exclude');
  const wanted = pattern.trim();
  if (!wanted) throw new GitError('io', 'ensureExcluded: pattern is empty');
  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (existing.split('\n').some((l) => l.trim() === wanted)) return false;
    mkdirSync(dirname(file), { recursive: true });
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(file, `${existing}${sep}${wanted}\n`);
    return true;
  } catch (cause) {
    if (cause instanceof GitError) throw cause;
    throw new GitError('io', `could not update ${file}`, { cause });
  }
}
