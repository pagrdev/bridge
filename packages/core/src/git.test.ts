import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  branch,
  changedFiles,
  commitAll,
  diff,
  diffStat,
  type ExecFileLike,
  ensureExcluded,
  GIT_MAX_BUFFER,
  GIT_TIMEOUT_MS,
  GitError,
  head,
  isDirty,
  isRepo,
  logOneline,
  repoRoot,
  statusPorcelain,
} from './git.js';
import { useTempHome } from './testUtil.js';

/**
 * Raw git, for BUILDING the fixtures only — never for asserting on them.
 *
 * This is the one file allowed to spawn git besides `git.ts` itself (see the grep test at the
 * bottom, which enforces that). Everything under test goes through the module.
 */
const raw = (cwd: string, args: string[]): string =>
  String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

/**
 * A repository that does not depend on the machine's global git config.
 *
 * `core.hooksPath`, `core.excludesFile` and `commit.gpgsign` are pinned locally because a
 * developer running this suite may well have husky, a global ignore file or a signing key set
 * up, any of which would otherwise decide whether these tests pass.
 */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  raw(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [
    ['user.email', 'test@pagr.dev'],
    ['user.name', 'Pagr Test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', join(dir, '.git', 'hooks')],
    ['core.excludesFile', ''],
    ['status.showUntrackedFiles', 'normal'],
  ])
    raw(dir, ['config', k as string, v as string]);
  return dir;
}

function commitFile(dir: string, name: string, body: string, message: string): string {
  writeFileSync(join(dir, name), body);
  raw(dir, ['add', '-A']);
  raw(dir, ['commit', '-q', '-m', message]);
  return raw(dir, ['rev-parse', 'HEAD']).trim();
}

function writeHook(dir: string, name: string, body: string): void {
  const hooks = join(dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const file = join(hooks, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

const SHA = /^[0-9a-f]{40}$/;

describe('git · repository resolution', () => {
  const t = useTempHome('pagr-git-');

  it('finds the root from a subdirectory and reports non-repos as such', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    const deep = join(repo, 'src', 'nested');
    mkdirSync(deep, { recursive: true });

    expect(await repoRoot(deep)).toBe(repo);
    expect(await isRepo(deep)).toBe(true);

    const plain = join(t.home, 'plain');
    mkdirSync(plain);
    expect(await isRepo(plain)).toBe(false);
    expect(await isRepo(join(t.home, 'missing'))).toBe(false);
  });

  it('raises a typed error for a path that is not in a repository', async () => {
    const plain = join(t.home, 'plain');
    mkdirSync(plain);
    for (const call of [
      () => repoRoot(plain),
      () => statusPorcelain(plain),
      () => head(plain),
      () => commitAll(plain, 'nope'),
      () => ensureExcluded(plain, '.pagr/'),
    ]) {
      const err = await call().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(GitError);
      expect(err.code).toBe('not_a_repo');
    }
  });

  it('raises a typed error for a path that does not exist', async () => {
    const err = await statusPorcelain(join(t.home, 'gone')).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('not_found');
  });
});

describe('git · status, head, branch', () => {
  const t = useTempHome('pagr-git-');

  it('reports a clean tree as clean and a dirty tree with its entries', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const sha = commitFile(repo, 'a.txt', 'first\n', 'first');

    expect(await statusPorcelain(repo)).toEqual([]);
    expect(await isDirty(repo)).toBe(false);
    expect(await head(repo)).toBe(sha);
    expect(await branch(repo)).toBe('main');

    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');
    writeFileSync(join(repo, 'new file.txt'), 'untracked\n');
    const status = await statusPorcelain(repo);
    expect(await isDirty(repo)).toBe(true);
    expect(status).toHaveLength(2);
    expect(status).toContain(' M a.txt');
    // `-z` means a space in the name is not quoted and not split.
    expect(status).toContain('?? new file.txt');
  });

  it('answers on a repository with no commits yet', async () => {
    const repo = initRepo(join(t.home, 'empty'));
    expect(await branch(repo)).toBe('main');
    const err = await head(repo).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('no_commits');
  });
});

describe('git · commitAll', () => {
  const t = useTempHome('pagr-git-');

  it('commits a dirty tree, returns the new SHA and leaves the tree clean', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const before = commitFile(repo, 'a.txt', 'first\n', 'first');
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');
    writeFileSync(join(repo, 'b.txt'), 'new\n');

    const res = await commitAll(repo, 'wip(pagr): handoff claude → codex');
    expect(res.committed).toBe(true);
    expect(res.sha).toMatch(SHA);
    expect(res.sha).not.toBe(before);
    expect(res.filesChanged).toBe(2);
    expect(await isDirty(repo)).toBe(false);
    expect(await head(repo)).toBe(res.sha);
    expect(raw(repo, ['log', '-1', '--pretty=%s'])).toContain('wip(pagr): handoff claude → codex');
  });

  it('is a no-op on a clean tree and says so', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const sha = commitFile(repo, 'a.txt', 'first\n', 'first');
    const res = await commitAll(repo, 'wip(pagr): nothing to do');
    expect(res).toEqual({ committed: false, sha, filesChanged: 0 });
    expect(await head(repo)).toBe(sha);
    expect(raw(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('reports a no-op on an empty repository with no HEAD to report', async () => {
    const repo = initRepo(join(t.home, 'empty'));
    expect(await commitAll(repo, 'wip')).toEqual({ committed: false, sha: null, filesChanged: 0 });
  });

  it('makes the first commit in a repository that has none', async () => {
    const repo = initRepo(join(t.home, 'unborn'));
    writeFileSync(join(repo, 'a.txt'), 'first\n');
    const res = await commitAll(repo, 'wip(pagr): first');
    expect(res.committed).toBe(true);
    expect(res.sha).toMatch(SHA);
  });

  it('surfaces a failing pre-commit hook as a typed error carrying the hook message', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    writeHook(
      repo,
      'pre-commit',
      '#!/bin/sh\necho "lint failed: 2 problems in a.txt" >&2\necho "details follow" >&2\nexit 1\n',
    );
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');

    const err = await commitAll(repo, 'wip(pagr): handoff').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('hook_failed');
    // The first line is what the phone shows, verbatim.
    expect(err.detail).toBe('lint failed: 2 problems in a.txt');
    expect(err.stderr).toContain('details follow');
    // Nothing was committed and the work is still there.
    expect(raw(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(await isDirty(repo)).toBe(true);
  });

  it('does not blame a hook git would never have run', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    // Present but not executable: git ignores it, so a failure is not its fault.
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');

    // An empty message is refused by git itself.
    const err = await commitAll(repo, '').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('git_failed');
  });

  it('a passing pre-commit hook still runs and the commit lands', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    writeHook(
      repo,
      'pre-commit',
      '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/hook-ran"\nexit 0\n',
    );
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');

    const res = await commitAll(repo, 'wip(pagr): handoff');
    expect(res.committed).toBe(true);
    expect(readdirSync(join(repo, '.git'))).toContain('hook-ran');
  });
});

describe('git · ranges', () => {
  const t = useTempHome('pagr-git-');

  it('diffs, logs and lists files across a known two-commit range', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const a = commitFile(repo, 'a.txt', 'first\n', 'first commit');
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n');
    writeFileSync(join(repo, 'b.txt'), 'brand new\n');
    raw(repo, ['add', '-A']);
    raw(repo, ['commit', '-q', '-m', 'second commit']);
    const b = raw(repo, ['rev-parse', 'HEAD']).trim();
    const range = `${a}..${b}`;

    expect(await changedFiles(repo, range)).toEqual(['a.txt', 'b.txt']);

    const log = await logOneline(repo, range);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('second commit');
    expect(log[0]).toContain(b.slice(0, 7));

    const patch = await diff(repo, range);
    expect(patch).toContain('+second');
    expect(patch).toContain('+brand new');
    expect(patch).toContain('diff --git a/b.txt b/b.txt');

    const stat = await diffStat(repo, range);
    expect(stat).toContain('2 files changed');

    // No range: the uncommitted work tree.
    expect(await changedFiles(repo)).toEqual([]);
    writeFileSync(join(repo, 'a.txt'), 'first\nsecond\nthird\n');
    expect(await changedFiles(repo)).toEqual(['a.txt']);
  });

  it('a range that does not resolve is a typed error, not a silent empty result', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    const err = await logOneline(repo, 'nope..alsonope').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(['git_failed', 'no_commits']).toContain(err.code);
  });
});

describe('git · ensureExcluded', () => {
  const t = useTempHome('pagr-git-');

  it('appends once and is idempotent across repeated calls', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    commitFile(repo, 'a.txt', 'first\n', 'first');
    const exclude = join(repo, '.git', 'info', 'exclude');

    expect(await ensureExcluded(repo, '.pagr/')).toBe(true);
    expect(await ensureExcluded(repo, '.pagr/')).toBe(false);
    expect(await ensureExcluded(repo, '.pagr/')).toBe(false);

    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines.filter((l) => l.trim() === '.pagr/')).toHaveLength(1);
    expect(lines.at(-1)).toBe('');

    // The excluded directory really is invisible to status.
    mkdirSync(join(repo, '.pagr', 'handoff'), { recursive: true });
    writeFileSync(join(repo, '.pagr', 'handoff', 'hnd_1.md'), '# Goal\n');
    expect(await statusPorcelain(repo)).toEqual([]);

    // A second pattern coexists with the first.
    expect(await ensureExcluded(repo, '.pagr-tmp/')).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toContain('.pagr/\n');
    expect(readFileSync(exclude, 'utf8')).toContain('.pagr-tmp/\n');
  });

  it('creates the file when git did not, and fixes a missing trailing newline', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const exclude = join(repo, '.git', 'info', 'exclude');
    rmSync(exclude, { force: true });
    expect(await ensureExcluded(repo, '.pagr/')).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toBe('.pagr/\n');

    writeFileSync(exclude, '# hand written\nnode_modules');
    expect(await ensureExcluded(repo, '.pagr/')).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toBe('# hand written\nnode_modules\n.pagr/\n');
    expect(await ensureExcluded(repo, '.pagr/')).toBe(false);
  });

  it('never touches .gitignore, which belongs to the user', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    writeFileSync(join(repo, '.gitignore'), 'dist\n');
    commitFile(repo, 'a.txt', 'first\n', 'first');
    await ensureExcluded(repo, '.pagr/');
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('dist\n');
    expect(await isDirty(repo)).toBe(false);
  });
});

describe('git · how the subprocess is run', () => {
  const t = useTempHome('pagr-git-');

  /** Records the call and then fails it the way node fails a timed-out child. */
  function stub(): { calls: Parameters<ExecFileLike>[]; exec: ExecFileLike } {
    const calls: Parameters<ExecFileLike>[] = [];
    const exec: ExecFileLike = (file, args, options, cb) => {
      calls.push([file, args, options, cb]);
      const err = Object.assign(new Error('Command failed: git'), {
        killed: true,
        signal: 'SIGTERM' as const,
        code: null,
      });
      queueMicrotask(() => cb(err, '', ''));
      return undefined;
    };
    return { calls, exec };
  }

  it('turns a killed child into a typed timeout error', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const { calls, exec } = stub();
    const err = await statusPorcelain(repo, { execFile: exec }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('timed out');
    expect(calls).toHaveLength(1);
  });

  it('passes an argument array and a built environment, never a shell string', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const { calls, exec } = stub();
    await commitAll(repo, 'wip', { execFile: exec }).catch(() => {});
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [file, args, options] = call;
    expect(file).toBe('git');
    expect(Array.isArray(args)).toBe(true);
    expect(options.timeout).toBe(GIT_TIMEOUT_MS);
    expect(options.maxBuffer).toBe(GIT_MAX_BUFFER);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(options.env.LC_ALL).toBe('C');
    // A stray GIT_DIR in the daemon's environment must not be able to redirect a commit.
    expect(options.env.GIT_DIR).toBeUndefined();
    expect(options.env.GIT_WORK_TREE).toBeUndefined();
    expect(options.env.GIT_INDEX_FILE).toBeUndefined();
    expect(options.env.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('honours a caller-supplied timeout', async () => {
    const repo = initRepo(join(t.home, 'repo'));
    const { calls, exec } = stub();
    await statusPorcelain(repo, { execFile: exec, timeoutMs: 250 }).catch(() => {});
    expect(calls[0]?.[2].timeout).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// The rule this module exists to make checkable.
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.next']);
/** `git.ts` runs git; `git.test.ts` builds the fixtures it runs against. Nothing else may. */
const ALLOWED = ['packages/core/src/git.ts', 'packages/core/src/git.test.ts'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) sourceFiles(rel, acc);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(ent.name)) acc.push(rel);
  }
  return acc;
}

describe('git · no git subprocess outside this module', () => {
  const SPAWNS_GIT = /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(['"`])git\2/;
  const files = ['packages', 'apps', 'integrations', 'scripts'].flatMap((d) => sourceFiles(d));

  it('has something to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('only git.ts and its test spawn git', () => {
    const offenders = files
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => SPAWNS_GIT.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('only git.ts sets the git child environment', () => {
    const offenders = files
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('GIT_TERMINAL_PROMPT'));
    expect(offenders).toEqual([]);
  });

  it("never skips the user's hooks and never reaches a remote", () => {
    // Comments stripped first: the module DOCUMENTS that it does none of these.
    const code = readFileSync(join(ROOT, 'packages/core/src/git.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of ['no-verify', 'hooksPath', "'push'", "'fetch'", "'pull'", 'remote'])
      expect(code).not.toContain(forbidden);
  });
});
