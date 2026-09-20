import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecFileLike } from '../git.js';
import { useTempHome } from '../testUtil.js';
import { normalizeRange, ReviewRangeError, resolveReviewRange, reviewIntentFor } from './range.js';

/**
 * Choosing the commits a `pagr review` reads.
 *
 * git is faked at its `execFile` seam — only `git.ts` may spawn it, and a test that built real
 * repositories to check a string would be slower and would still not prove the interesting part,
 * which is what this module does with each ANSWER git can give. So every case here is "git says
 * X" → "the range is Y, and the reason it reports is Z".
 *
 * The reason matters as much as the range: it is what the CLI prints before a ten-minute agent
 * starts, and a review of the wrong commits that says nothing about it is the failure this whole
 * module exists to prevent.
 */

interface GitState {
  /** `git status --porcelain` entries. */
  dirty: string[];
  /** Commits `git log <range>` answers with, keyed by range. */
  log: Record<string, string[]>;
  /** Refs that do not resolve: the command fails the way git fails for an unknown revision. */
  head?: 'ok' | 'none';
  branch?: string;
}

function fakeGit(root: string, state: GitState, calls: string[]): ExecFileLike {
  return (_file, args, _options, cb) => {
    const argv = args.join(' ');
    calls.push(argv);
    const done = (stdout: string): undefined => {
      queueMicrotask(() => cb(null, stdout, ''));
      return undefined;
    };
    const fail = (stderr: string): undefined => {
      const err = Object.assign(new Error('Command failed: git'), { code: 128, stdout: '' });
      queueMicrotask(() => cb(err, '', stderr));
      return undefined;
    };
    if (argv === 'rev-parse --show-toplevel') {
      if (root === '')
        return fail('fatal: not a git repository (or any of the parent directories)');
      return done(`${root}\n`);
    }
    if (argv === 'branch --show-current') return done(`${state.branch ?? 'main'}\n`);
    if (args[0] === 'status') return done(state.dirty.map((e) => `${e}\0`).join(''));
    if (argv === 'rev-parse HEAD')
      return state.head === 'none'
        ? fail(
            "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
          )
        : done(`${'7'.repeat(40)}\n`);
    if (args[0] === 'log') {
      // `git log --oneline --no-decorate <range> --`
      const range = args[3] ?? '';
      const commits = state.log[range];
      if (!commits)
        return fail(
          `fatal: ambiguous argument '${range}': unknown revision or path not in the working tree.`,
        );
      return done(`${commits.join('\n')}\n`);
    }
    return fail(`unexpected: git ${argv}`);
  };
}

describe('resolveReviewRange', () => {
  const t = useTempHome('pagr-review-range-');
  let repo: string;
  let calls: string[];

  const resolve_ = (state: GitState, explicit?: string) =>
    resolveReviewRange({
      dir: repo,
      ...(explicit === undefined ? {} : { explicit }),
      git: { execFile: fakeGit(repo, state, calls) },
    });

  beforeEach(() => {
    repo = join(t.home, 'checkout-api');
    mkdirSync(repo, { recursive: true });
    calls = [];
  });

  it('defaults a clean tree to the last commit, and names it', async () => {
    const r = await resolve_({
      dirty: [],
      log: { 'HEAD~1..HEAD': ['abc1234 feat: retry the webhook'] },
    });
    expect(r).toMatchObject({
      repo,
      range: 'HEAD~1..HEAD',
      basis: 'last_commit',
      commits: ['abc1234 feat: retry the webhook'],
      dirtyFiles: 0,
      branch: 'main',
    });
    // The subject, not the sha: it is the author's own description of the change.
    expect(reviewIntentFor(r)).toBe('feat: retry the webhook');
  });

  it('defaults a dirty tree to the WIP commit review.start is about to make', async () => {
    const r = await resolve_({
      dirty: [' M src/send.ts', '?? src/retry.ts'],
      log: { 'HEAD~1..HEAD': ['abc1234 the commit BEFORE the work'] },
      branch: 'feat/retry',
    });
    expect(r).toMatchObject({ range: 'HEAD~1..HEAD', basis: 'uncommitted', dirtyFiles: 2 });
    // The lie this module exists to prevent: listing the commit that HEAD~1..HEAD names RIGHT
    // NOW would advertise the previous commit as the thing about to be reviewed. It is not: the
    // WIP commit moves HEAD first, and until it does there is nothing honest to list.
    expect(r.commits).toEqual([]);
    expect(reviewIntentFor(r)).toBe('uncommitted work on feat/retry');
  });

  it('uses --range as written, and lists what it names', async () => {
    const r = await resolve_(
      { dirty: [], log: { 'abc1234..def5678': ['def5678 two', 'abc9999 one'] } },
      'abc1234..def5678',
    );
    expect(r).toMatchObject({
      range: 'abc1234..def5678',
      basis: 'explicit',
      commits: ['def5678 two', 'abc9999 one'],
    });
  });

  it('reads a bare ref as "since that ref"', async () => {
    const r = await resolve_(
      { dirty: [], log: { 'HEAD~3..HEAD': ['a1 c', 'b2 b', 'c3 a'] } },
      'HEAD~3',
    );
    expect(r.range).toBe('HEAD~3..HEAD');
    expect(r.basis).toBe('explicit');
  });

  it('reports uncommitted files alongside an explicit range, because they land inside it', async () => {
    const r = await resolve_(
      { dirty: [' M src/send.ts'], log: { 'HEAD~2..HEAD': ['a1 one'] } },
      'HEAD~2..HEAD',
    );
    expect(r).toMatchObject({ basis: 'explicit', dirtyFiles: 1 });
  });

  it('refuses a range git does not understand, before any agent is started', async () => {
    await expect(resolve_({ dirty: [], log: {} }, 'nope..HEAD')).rejects.toMatchObject({
      name: 'ReviewRangeError',
      reason: 'bad_range',
    });
  });

  it('refuses a repository with no commits at all', async () => {
    await expect(resolve_({ dirty: [' M a.ts'], log: {}, head: 'none' })).rejects.toMatchObject({
      reason: 'no_commits',
    });
  });

  it('refuses a clean repository whose only commit is its first', async () => {
    // `git log HEAD~1..HEAD` fails there: there is nothing before the root commit.
    await expect(resolve_({ dirty: [], log: {} })).rejects.toMatchObject({
      reason: 'root_commit',
    });
  });

  it('reports a directory that is not a work tree as such', async () => {
    const outside = join(t.home, 'not-a-repo');
    mkdirSync(outside, { recursive: true });
    await expect(
      resolveReviewRange({
        dir: outside,
        git: { execFile: fakeGit('', { dirty: [], log: {} }, calls) },
      }),
    ).rejects.toMatchObject({ reason: 'not_a_repo' });
  });
});

describe('normalizeRange', () => {
  it('leaves a real range alone and completes a bare ref', () => {
    expect(normalizeRange('  abc..def  ')).toBe('abc..def');
    expect(normalizeRange('v1.2.0')).toBe('v1.2.0..HEAD');
    expect(normalizeRange('main...HEAD')).toBe('main...HEAD');
  });

  it('refuses anything that could reach git as an option or a second argument', () => {
    // The protocol's `GitRange` is the guard; this is the layer that turns it into a sentence.
    for (const bad of [
      '--upload-pack=x..HEAD',
      '-x..HEAD',
      'a b..HEAD',
      '',
      '   ',
      'a..b;rm -rf /',
    ])
      expect(() => normalizeRange(bad), bad).toThrow(ReviewRangeError);
  });
});
