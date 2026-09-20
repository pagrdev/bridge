import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcMethodError, type IpcServer, type ProjectRecord } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { errJson, fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

/**
 * `pagr review` against a fake daemon.
 *
 * Every test here talks to an `IpcServer` on the harness socket and to temp directories. Nothing
 * reaches a real repository, a real agent or a real `~/.codex`: the two methods the command
 * calls — `review.range` and `review.run` — are canned, and what is under test is the CLI's half
 * of the contract. What it says it is about to review, what it prints when the verdict comes
 * back, and which exit code a person's script sees.
 */

const PROJECT = 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REV = 'rev_0123456789abcdef0123456789abcdef';

let h: Harness;
let server: IpcServer | null = null;
let root: string;
let repo: string;
let calls: Array<{ method: string; params: unknown }>;

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  projectId: PROJECT,
  path: repo,
  displayName: 'checkout-api',
  aliases: [],
  allowNonGit: false,
  addedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

/** What `review.range` answers: which commits, and why those. */
const ranged = (over: Record<string, unknown> = {}) => ({
  repo,
  branch: 'feat/retry',
  range: 'HEAD~1..HEAD',
  basis: 'last_commit',
  commits: ['abc1234 feat: retry the webhook'],
  dirtyFiles: 0,
  ...over,
});

/** What `review.run` answers once the reviewer has written its report. */
const reviewed = (over: Record<string, unknown> = {}) => ({
  reviewId: REV,
  reviewer: 'codex',
  projectId: PROJECT,
  repo,
  range: 'HEAD~1..HEAD',
  intent: 'feat: retry the webhook',
  path: join(repo, '.pagr', 'review', REV, 'review.md'),
  relativePath: `.pagr/review/${REV}/review.md`,
  verdict: 'block',
  summary: 'the retry never terminates',
  verdictLine: 'verdict: block — the retry never terminates',
  instruction: `Read .pagr/review/${REV}/review.md and fix the blocking findings`,
  ...over,
});

async function daemon(
  methods: Record<string, (p: unknown) => unknown>,
  over: { projects?: ProjectRecord[] } = {},
): Promise<IpcServer> {
  const record =
    (method: string, fn: (p: unknown) => unknown) =>
    (p: unknown): unknown => {
      calls.push({ method, params: p });
      return fn(p);
    };
  const all: Record<string, (p: unknown) => unknown> = {
    status: () => ({ paired: true, sessions: 0, projects: 1 }),
    'projects.list': () => over.projects ?? [project()],
    'review.range': () => ranged(),
    'review.run': () => reviewed(),
    ...methods,
  };
  server = await fakeDaemon(
    h.home,
    Object.fromEntries(Object.entries(all).map(([k, v]) => [k, record(k, v)])),
  );
  return server;
}

const paramsFor = (method: string): unknown =>
  calls.find((c) => c.method === method)?.params ?? null;

beforeEach(() => {
  h = harness();
  calls = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-review-')));
  repo = join(root, 'checkout-api');
  mkdirSync(repo, { recursive: true });
  h.overrides.env = { ...h.overrides.env, HOME: root };
  h.overrides.cwd = () => repo;
});

afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('pagr review', () => {
  it('runs the review for the project in this directory and prints the report path', async () => {
    await daemon({
      'review.run': () =>
        reviewed({ verdict: 'approve', verdictLine: 'verdict: approve — bounded and tested' }),
    });
    const code = await h.run(['review', '--with', 'codex']);
    expect(code).toBe(EXIT.ok);
    expect(paramsFor('review.range')).toEqual({ projectId: PROJECT });
    expect(paramsFor('review.run')).toEqual({
      projectId: PROJECT,
      reviewer: 'codex',
      range: 'HEAD~1..HEAD',
      // Nobody passed `--intent`, so the newest commit's own subject is what the reviewer is told.
      intent: 'feat: retry the webhook',
    });
    expect(plain(h.stdout)).toContain(join(repo, '.pagr', 'review', REV, 'review.md'));
  });

  it('prints the verdict line exactly as the reviewer wrote it', async () => {
    const line = '**Verdict:** BLOCK – applyMigration drops the column before the backfill';
    await daemon({ 'review.run': () => reviewed({ verdictLine: line }) });
    await h.run(['review', '--with', 'codex']);
    // Not recomposed from the parsed verdict and summary: the reviewer's own sentence, whole.
    expect(plain(h.stdout).split('\n')).toContain(line);
  });

  it('says which commits it defaulted to, before the reviewer is started', async () => {
    await daemon({});
    await h.run(['review', '--with', 'codex']);
    const out = plain(h.stdout);
    expect(out).toContain('reviewing HEAD~1..HEAD with codex');
    expect(out).toContain('the last commit, abc1234 feat: retry the webhook');
    expect(out.indexOf('reviewing HEAD~1..HEAD')).toBeLessThan(out.indexOf('verdict:'));
  });

  it('says out loud that a dirty tree is committed first', async () => {
    await daemon({
      'review.range': () => ranged({ basis: 'uncommitted', commits: [], dirtyFiles: 3 }),
    });
    await h.run(['review', '--with', 'codex']);
    const out = plain(h.stdout);
    expect(out).toContain('your 3 uncommitted file(s), which Pagr commits first');
    // And the reviewer is told what it is reading, without a commit subject to borrow.
    expect(paramsFor('review.run')).toMatchObject({ intent: 'uncommitted work on feat/retry' });
  });

  it('passes --range to the daemon and reviews what came back', async () => {
    await daemon({
      'review.range': () =>
        ranged({ range: 'v1.2.0..HEAD', basis: 'explicit', commits: ['a1 one', 'b2 two'] }),
    });
    await h.run(['review', '--with', 'codex', '--range', 'v1.2.0']);
    expect(paramsFor('review.range')).toEqual({ projectId: PROJECT, range: 'v1.2.0' });
    expect(paramsFor('review.run')).toMatchObject({ range: 'v1.2.0..HEAD' });
    expect(plain(h.stdout)).toContain('2 commit(s) you named');
  });

  it('prefers the intent the person gave over the one derived from the range', async () => {
    await daemon({});
    await h.run(['review', '--with', 'codex', '--intent', '  make refunds idempotent  ']);
    expect(paramsFor('review.run')).toMatchObject({ intent: 'make refunds idempotent' });
  });

  it('hands the findings to the agent that wrote the code, without acting on them', async () => {
    await daemon({});
    await h.run(['review', '--with', 'codex']);
    const out = plain(h.stdout);
    expect(out).toContain(`Read .pagr/review/${REV}/review.md and fix the blocking findings`);
    // Nothing was started: `pagr review` reads, and a person decides what happens next.
    expect(calls.map((c) => c.method)).toEqual([
      'status',
      'projects.list',
      'review.range',
      'review.run',
    ]);
  });

  it('does not offer the fix line for an approval', async () => {
    await daemon({
      'review.run': () => reviewed({ verdict: 'approve', verdictLine: 'verdict: approve — fine' }),
    });
    await h.run(['review', '--with', 'codex']);
    expect(plain(h.stdout)).not.toContain('fix the blocking findings');
  });

  it('warns when the reviewer did not write the contract, and still shows its line', async () => {
    await daemon({
      'review.run': () =>
        reviewed({
          verdict: 'comment',
          verdictLine: 'Approve with reservations',
          note: 'no verdict line: the review began with "Approve with reservations"',
        }),
    });
    const code = await h.run(['review', '--with', 'codex']);
    expect(code).toBe(EXIT.ok);
    const out = plain(h.stdout);
    expect(out).toContain('Approve with reservations');
    expect(out).toContain('no verdict line');
  });
});

describe('exit codes', () => {
  /**
   * One `pagr review --with codex` in its own harness, torn down afterwards.
   *
   * Only the exit-code tests need this: they run several different outcomes in one `it`, and a
   * shared daemon would let the second run see the first one's socket.
   */
  const exitFor = async (methods: Record<string, (p: unknown) => unknown>): Promise<number> => {
    const outerH = h;
    const outerServer = server;
    const outerCalls = calls;
    h = harness();
    h.overrides.env = { ...h.overrides.env, HOME: root };
    h.overrides.cwd = () => repo;
    calls = [];
    const own = await daemon(methods);
    try {
      return await h.run(['review', '--with', 'codex']);
    } finally {
      await own.close();
      h.cleanup();
      h = outerH;
      server = outerServer;
      calls = outerCalls;
    }
  };

  it('0 when the reviewer approved, and 0 for comments', async () => {
    expect(await exitFor({ 'review.run': () => reviewed({ verdict: 'approve' }) })).toBe(EXIT.ok);
    expect(await exitFor({ 'review.run': () => reviewed({ verdict: 'comment' }) })).toBe(EXIT.ok);
  });

  it('5 when the reviewer blocked — the whole point of running it in a script', async () => {
    expect(await exitFor({})).toBe(EXIT.precondition);
  });

  it('1 when the review was attempted and produced nothing', async () => {
    await daemon({
      'review.run': () => {
        throw new IpcMethodError('no_report', 'codex finished its turn without writing a review');
      },
    });
    const code = await h.run(['review', '--with', 'codex']);
    expect(code).toBe(EXIT.error);
    expect(plain(h.stderr)).toContain('without writing a review');
  });

  it('2 for a --with that is not an agent', async () => {
    await daemon({});
    expect(await h.run(['review', '--with', 'cursor'])).toBe(EXIT.usage);
    expect(plain(h.stderr)).toContain('--with must be claude or codex');
    expect(calls.some((c) => c.method === 'review.range')).toBe(false);
  });

  it('2 when --with is missing altogether', async () => {
    await daemon({});
    expect(await h.run(['review'])).toBe(EXIT.usage);
  });

  it('2 for a range this repository cannot read', async () => {
    await daemon({
      'review.range': () => {
        throw new IpcMethodError('bad_range', 'nope..HEAD is not a range this repository has');
      },
    });
    const code = await h.run(['review', '--with', 'codex', '--range', 'nope..HEAD']);
    expect(code).toBe(EXIT.usage);
    expect(calls.some((c) => c.method === 'review.run')).toBe(false);
  });

  it('3 when the daemon is not running', async () => {
    expect(await h.run(['review', '--with', 'codex'])).toBe(EXIT.daemonDown);
  });

  it('5 when there is nothing sensible to point a reviewer at', async () => {
    for (const [code, message] of [
      ['not_a_repo', 'that directory is not a git work tree'],
      ['no_commits', 'this repository has no commits yet'],
      ['root_commit', 'the only commit here is its first'],
    ] as const) {
      const got = await exitFor({
        'review.range': () => {
          throw new IpcMethodError(code, message);
        },
      });
      expect(got, code).toBe(EXIT.precondition);
    }
  });

  it('5 for a directory in no registered project, without asking the daemon anything else', async () => {
    await daemon({}, { projects: [project({ path: join(root, 'elsewhere') })] });
    const code = await h.run(['review', '--with', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain('no registered project');
    expect(calls.some((c) => c.method === 'review.range')).toBe(false);
  });

  it('keeps the three apart: 5 blocked, 1 failed, 2 usage', async () => {
    const blocked = await exitFor({});
    const failed = await exitFor({
      'review.run': () => {
        throw new IpcMethodError('no_report', 'codex could not be started');
      },
    });
    await daemon({});
    const usage = await h.run(['review', '--with', 'cursor']);
    expect([blocked, failed, usage]).toEqual([EXIT.precondition, EXIT.error, EXIT.usage]);
    expect(new Set([blocked, failed, usage]).size).toBe(3);
  });
});

describe('--json', () => {
  it('writes exactly one document, carrying the verdict line and the path', async () => {
    await daemon({
      'review.run': () => reviewed({ verdict: 'approve', verdictLine: 'verdict: approve — fine' }),
    });
    const code = await h.run(['review', '--with', 'codex', '--json']);
    expect(code).toBe(EXIT.ok);
    const doc = lastJson(h) as Record<string, unknown>;
    expect(doc).toMatchObject({
      reviewId: REV,
      verdict: 'approve',
      verdictLine: 'verdict: approve — fine',
      path: join(repo, '.pagr', 'review', REV, 'review.md'),
      range: 'HEAD~1..HEAD',
      basis: 'last_commit',
    });
    expect(h.stdout.join('\n').trim().startsWith('{')).toBe(true);
  });

  it('still exits 5 on a block, with the document and nothing else on stdout', async () => {
    await daemon({});
    const code = await h.run(['review', '--with', 'codex', '--json']);
    expect(code).toBe(EXIT.precondition);
    expect((lastJson(h) as Record<string, unknown>).verdict).toBe('block');
  });

  it('reports a refused range as the one error document', async () => {
    await daemon({
      'review.range': () => {
        throw new IpcMethodError('not_a_repo', 'that directory is not a git work tree');
      },
    });
    const code = await h.run(['review', '--with', 'codex', '--json']);
    expect(code).toBe(EXIT.precondition);
    expect(errJson(h).error).toMatchObject({ code: 'not_a_repo', exitCode: EXIT.precondition });
  });
});
