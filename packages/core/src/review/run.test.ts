import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOnceInput, RunOnceOutcome, RunOnceResult } from '../adapters/runOnce.js';
import type { ExecFileLike } from '../git.js';
import { useTempHome } from '../testUtil.js';
import {
  awaitReview,
  type PreparedReview,
  prepareReview,
  REVIEW_TIMEOUT_ENV,
  REVIEW_TIMEOUT_MS,
  type ReviewRunner,
  ReviewStartError,
  reviewApplyInstruction,
  reviewTimeoutMs,
  reviewWipCommitMessage,
} from './run.js';

const REVIEW_ID = `rev_${'b'.repeat(32)}`;
const RANGE = 'HEAD~1..HEAD';
const HEAD_SHA = '9'.repeat(40);

/**
 * git, faked at the process boundary.
 *
 * `git.ts` owns the only real git subprocess in this tree and a grep test fails the build if
 * another file spawns one — this file included. So the runner is injected through the module's
 * own `execFile` seam, which also means no test here touches a real repository, a real index or
 * a real hook. Every call is recorded, because for a review the ORDER is load bearing: the WIP
 * commit has to happen before the packet is built or the reviewer reads the wrong change.
 */
interface FakeGitOptions {
  /** Porcelain entries. Empty means a clean tree. */
  dirty?: string[];
  /** Fail `commit` as a rejecting `pre-commit` hook would. */
  hookFails?: string;
}

function fakeGit(root: string, log: string[], o: FakeGitOptions = {}): ExecFileLike {
  const dirty = o.dirty ?? [];
  let committed = false;
  return (_file, args, _options, cb) => {
    const a = [...args];
    const argv = a.join(' ');
    log.push(`git ${argv}`);
    const done = (stdout: string): undefined => {
      queueMicrotask(() => cb(null, stdout, ''));
      return undefined;
    };
    const fail = (stderr: string, code = 1): undefined => {
      const err = Object.assign(new Error('Command failed: git'), { code, stderr, stdout: '' });
      queueMicrotask(() => cb(err, '', stderr));
      return undefined;
    };
    if (argv === 'rev-parse --show-toplevel') return done(`${root}\n`);
    if (argv === 'rev-parse --absolute-git-dir') return done(`${join(root, '.git')}\n`);
    if (argv === 'rev-parse HEAD') return done(`${HEAD_SHA}\n`);
    if (argv === 'rev-parse --git-path hooks') return done(`${join(root, '.git', 'hooks')}\n`);
    if (a[0] === 'status') return done(committed ? '' : dirty.map((e) => `${e}\0`).join(''));
    if (argv === 'add -A') return done('');
    if (a[0] === 'commit') {
      if (o.hookFails) return fail(o.hookFails, 1);
      committed = true;
      return done('');
    }
    if (a[0] === 'log') return done('abc1234 feat: retry the webhook\n');
    if (a[0] === 'diff' && a[1] === '--stat') return done(' src/send.ts | 2 +-\n');
    if (a[0] === 'diff' && a[1] === '--name-only') return done('src/send.ts\0');
    if (a[0] === 'diff')
      return done('diff --git a/src/send.ts b/src/send.ts\n@@ -1 +1 @@\n-old\n+new\n');
    return fail(`unexpected: git ${argv}`, 128);
  };
}

/** What a hook that rejects a commit actually looks like to `git.ts`. */
const HOOK_STDERR = 'lint-staged: 3 problems (3 errors, 0 warnings)\n';

interface FakeRunOptions {
  /** `[after ms, contents]` — what the agent writes into `review.md`, and when. */
  writes?: Array<[number, string]>;
  /** End the run by itself this long after it starts. Absent: it runs until it is aborted. */
  endsAfterMs?: number;
  outcome?: RunOnceOutcome;
  /** Throw instead of running, as an adapter with no agent installed would. */
  throws?: Error;
}

/**
 * A reviewing agent, as far as this module can tell: something that takes a prompt and may put
 * a file on disk because of it, on its own schedule.
 */
class FakeReviewer implements ReviewRunner {
  readonly calls: RunOnceInput[] = [];
  aborted = false;

  constructor(
    private readonly file: string,
    private readonly o: FakeRunOptions = {},
  ) {}

  async runOnce(input: RunOnceInput): Promise<RunOnceResult> {
    this.calls.push(input);
    if (this.o.throws) throw this.o.throws;
    const started = Date.now();
    const timers = (this.o.writes ?? []).map(([at, body]) =>
      setTimeout(() => {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, body);
      }, at),
    );
    await new Promise<void>((resolve) => {
      const finish = () => {
        for (const timer of timers) clearTimeout(timer);
        resolve();
      };
      if (this.o.endsAfterMs !== undefined) setTimeout(finish, this.o.endsAfterMs);
      input.signal?.addEventListener(
        'abort',
        () => {
          this.aborted = true;
          finish();
        },
        { once: true },
      );
    });
    return {
      runId: input.runId ?? 'run_fake',
      sessionId: 'ses_fake',
      outcome: this.o.outcome ?? (this.aborted ? 'canceled' : 'completed'),
      output: '',
      durationMs: Date.now() - started,
    };
  }
}

const prepare = (root: string, log: string[], git: FakeGitOptions = {}) =>
  prepareReview({
    reviewId: REVIEW_ID,
    repo: root,
    range: RANGE,
    intent: 'add a retry to the webhook sender',
    reviewer: 'codex',
    env: {},
    git: { execFile: fakeGit(root, log, git) },
  });

/** Short bounds: these tests are about ordering, not about waiting. */
const run = (prepared: PreparedReview, runner: ReviewRunner, over: Record<string, number> = {}) =>
  awaitReview({
    prepared,
    reviewer: 'codex',
    runner,
    projectId: `proj_${'c'.repeat(32)}`,
    timeoutMs: 2_000,
    pollIntervalMs: 5,
    reReadGraceMs: 60,
    env: {},
    ...over,
  });

describe('prepareReview', () => {
  const t = useTempHome('pagr-review-run-');

  it('commits a dirty tree BEFORE building the packet, so the review is of the real change', async () => {
    const log: string[] = [];
    writeFileSync(join(t.home, 'send.ts'), 'export const send = () => 1;\n');
    const prepared = await prepare(t.home, log, { dirty: [' M src/send.ts', '?? src/retry.ts'] });

    expect(prepared.wipCommit).toBe(HEAD_SHA);
    expect(prepared.filesChanged).toBe(2);
    const commands = log.map((l) => l.replace(/ [^ ]*\.git[^ ]*/, ''));
    // `.pagr/` is excluded before `add -A` can sweep an earlier handoff note into the commit.
    expect(commands.indexOf('git rev-parse --absolute-git-dir')).toBeLessThan(
      commands.indexOf('git add -A'),
    );
    expect(commands.indexOf('git add -A')).toBeLessThan(
      commands.findIndex((c) => c.startsWith('git commit')),
    );
    expect(commands.findIndex((c) => c.startsWith('git commit'))).toBeLessThan(
      commands.findIndex((c) => c.startsWith('git log')),
    );
    expect(log.some((l) => l.includes(reviewWipCommitMessage('codex')))).toBe(true);
    expect(readFileSync(prepared.packet.packetPath, 'utf8')).toContain('# Review packet');
  });

  it('commits nothing when the tree is clean', async () => {
    const log: string[] = [];
    const prepared = await prepare(t.home, log);
    expect(prepared.wipCommit).toBeUndefined();
    expect(prepared.filesChanged).toBe(0);
    expect(log).not.toContain('git add -A');
  });

  it("reports the user's own pre-commit hook as the reason, rather than starting a reviewer", async () => {
    mkdirSync(join(t.home, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(t.home, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    const err = await prepare(t.home, [], {
      dirty: [' M src/send.ts'],
      hookFails: HOOK_STDERR,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewStartError);
    expect((err as ReviewStartError).reason).toBe('hook_failed');
  });

  it('points the reviewer at the packet and at the one file it is asked to write', async () => {
    const prepared = await prepare(t.home, []);
    expect(prepared.prompt).toContain(prepared.packet.packetPath);
    expect(prepared.prompt).toContain(prepared.reviewPath);
    // The reviewer is never told how the author got there (ADR 0019 decision 4).
    expect(prepared.prompt).not.toContain('handoff');
    // Every path a run is given is absolute, so nothing depends on where it resolves one from.
    expect(isAbsolute(prepared.packet.packetPath)).toBe(true);
    expect(isAbsolute(prepared.reviewPath)).toBe(true);
  });
});

describe('awaitReview', () => {
  const t = useTempHome('pagr-review-await-');

  it('parses the verdict the reviewer wrote and stops the run without waiting for its turn', async () => {
    const prepared = await prepare(t.home, []);
    const reviewer = new FakeReviewer(prepared.reviewPath, {
      writes: [[5, 'verdict: block — drops the column before the backfill\n\n### findings\n']],
    });
    const outcome = await run(prepared, reviewer);

    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') throw new Error('unreachable');
    expect(outcome.verdict).toBe('block');
    expect(outcome.summary).toBe('drops the column before the backfill');
    expect(outcome.note).toBeUndefined();
    expect(outcome.reRead).toBe(false);
    expect(outcome.text).toContain('### findings');
    // The prompt told it to write the file and stop; once it has, nothing else it does is wanted.
    expect(reviewer.aborted).toBe(true);
    expect(reviewer.calls[0]).toMatchObject({ cwd: prepared.repo });
  });

  it('degrades an unreadable verdict to comment and carries the line the reviewer wrote', async () => {
    const prepared = await prepare(t.home, []);
    const reviewer = new FakeReviewer(prepared.reviewPath, {
      writes: [[5, 'Approve with reservations\n\nThe retry looks fine to me.\n']],
    });
    const outcome = await run(prepared, reviewer);

    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') throw new Error('unreachable');
    expect(outcome.verdict).toBe('comment');
    expect(outcome.note).toContain('Approve with reservations');
    expect(outcome.reRead).toBe(false);
    // The findings underneath are still worth sending; losing them over punctuation is worse.
    expect(outcome.text).toContain('The retry looks fine to me.');
  });

  it('re-reads once when the agent revises a report whose first line was unreadable', async () => {
    const prepared = await prepare(t.home, []);
    const reviewer = new FakeReviewer(prepared.reviewPath, {
      writes: [
        [5, '# Review\n\nverdict: block — the retry never terminates\n'],
        [40, 'verdict: block — the retry never terminates\n\n### src/send.ts:12\n'],
      ],
    });
    const outcome = await run(prepared, reviewer, { reReadGraceMs: 500 });

    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') throw new Error('unreachable');
    expect(outcome.verdict).toBe('block');
    expect(outcome.note).toBeUndefined();
    expect(outcome.reRead).toBe(true);
    expect(outcome.text.startsWith('verdict:')).toBe(true);
  });

  it('does not mistake a file the agent has created but not filled for an empty report', async () => {
    const prepared = await prepare(t.home, []);
    const reviewer = new FakeReviewer(prepared.reviewPath, {
      writes: [
        [5, ''],
        [40, 'verdict: approve — the retry is bounded and the test covers it\n'],
      ],
    });
    const outcome = await run(prepared, reviewer, { reReadGraceMs: 10 });

    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') throw new Error('unreachable');
    expect(outcome.verdict).toBe('approve');
  });

  it('reads a report from an agent that wrote it and exited in the same tick', async () => {
    const prepared = await prepare(t.home, []);
    // No timer, no waiting to be aborted: the report is on disk before `runOnce` returns, and
    // the run has already settled by the time the wait is set up. A fast model, a cached answer
    // or a warm local agent all look like this — and the verdict must survive it, because the
    // alternative is telling somebody their review failed while the review sits next to them.
    const reviewer: ReviewRunner = {
      runOnce: async (input: RunOnceInput): Promise<RunOnceResult> => {
        mkdirSync(dirname(prepared.reviewPath), { recursive: true });
        writeFileSync(prepared.reviewPath, 'verdict: approve — the retry is bounded\n');
        return {
          runId: input.runId ?? 'run_fast',
          sessionId: 'ses_fast',
          outcome: 'completed',
          output: '',
          durationMs: 0,
        };
      },
    };
    const outcome = await run(prepared, reviewer);
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') throw new Error('unreachable');
    expect(outcome.verdict).toBe('approve');
    expect(outcome.summary).toBe('the retry is bounded');
  });

  it('says so, in one line, when the agent finishes its turn without writing anything', async () => {
    const prepared = await prepare(t.home, []);
    const outcome = await run(prepared, new FakeReviewer(prepared.reviewPath, { endsAfterMs: 5 }));

    expect(outcome.outcome).toBe('no_report');
    if (outcome.outcome !== 'no_report') throw new Error('unreachable');
    expect(outcome.message).toBe('codex finished its turn without writing a review');
    expect(outcome.path).toBe(prepared.reviewPath);
  });

  it('survives an agent that cannot be started at all', async () => {
    const prepared = await prepare(t.home, []);
    const outcome = await run(
      prepared,
      new FakeReviewer(prepared.reviewPath, { throws: new Error('codex is not installed') }),
    );

    expect(outcome.outcome).toBe('no_report');
    if (outcome.outcome !== 'no_report') throw new Error('unreachable');
    expect(outcome.message).toContain('codex is not installed');
  });

  it('gives up at the timeout rather than waiting on an agent that never answers', async () => {
    const prepared = await prepare(t.home, []);
    const reviewer = new FakeReviewer(prepared.reviewPath);
    const outcome = await run(prepared, reviewer, { timeoutMs: 40 });

    expect(outcome.outcome).toBe('no_report');
    expect(reviewer.aborted).toBe(true);
  });
});

describe('review bounds and wording', () => {
  it('reads its timeout from the environment and falls back on nonsense', () => {
    expect(reviewTimeoutMs({})).toBe(REVIEW_TIMEOUT_MS);
    expect(reviewTimeoutMs({ [REVIEW_TIMEOUT_ENV]: '1500' })).toBe(1500);
    expect(reviewTimeoutMs({ [REVIEW_TIMEOUT_ENV]: 'soon' })).toBe(REVIEW_TIMEOUT_MS);
    expect(reviewTimeoutMs({ [REVIEW_TIMEOUT_ENV]: '-1' })).toBe(REVIEW_TIMEOUT_MS);
  });

  it('names the report by a repo-relative path and asks only for the blocking findings', () => {
    expect(reviewApplyInstruction(REVIEW_ID)).toBe(
      `Read .pagr/review/${REVIEW_ID}/review.md and fix the blocking findings`,
    );
  });
});
