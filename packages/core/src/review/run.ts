import { randomBytes } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Provider } from '@pagr/protocol';
import {
  newRunId,
  type RunOnceInput,
  type RunOnceResult,
  runOnceSessionId,
} from '../adapters/runOnce.js';
import {
  type CommitResult,
  commitAll,
  ensureExcluded,
  GitError,
  type GitOptions,
  repoRoot,
} from '../git.js';
import { buildReviewPacket, REVIEW_DIR, type ReviewPacket } from './packet.js';
import { type ParsedVerdict, parseVerdict, reviewPrompt } from './prompt.js';

/**
 * Running a review: commit what is uncommitted, build the packet, hand it to the OTHER agent
 * read-only, and read the one line it is contracted to write (spec §5).
 *
 * The order of the first two steps is the part that is easy to get wrong. The WIP commit
 * happens BEFORE the packet is built, because the range the cloud sends ends at `HEAD` and a
 * review of `HEAD` that silently omitted the twenty minutes of work still in the work tree
 * would be a review of the wrong change — and it would say `approve` about code it never saw.
 * `.pagr/` is excluded before either, so `git add -A` can never sweep an earlier handoff note
 * or review report into the user's history.
 *
 * Everything after that is waiting. {@link awaitReview} starts the reviewer through the
 * adapter's `runOnce` — its own process, no prompts, writes confined to `.pagr` and no further
 * out than that whatever the reviewer decides to do — and watches for `review.md` at the
 * absolute path the packet named, which is not relative to the run's working directory. It does NOT wait for the agent's turn to end: the
 * report is the deliverable, the turn ending is not, and a reviewer that writes its file and
 * then spends four minutes summarising itself to nobody should not hold the verdict hostage.
 * Once the file is read the run is aborted, which is what the prompt already told it to do
 * ("Write the file, then stop").
 *
 * Two concessions to what models actually do, both asked for by the author of HND-030 after
 * watching real reviewers:
 *
 *   1. **One re-read.** Some agents write the report and then revise it — a heading gets added
 *      above the verdict line, a fence gets wrapped around it. So a first line that
 *      {@link parseVerdict} cannot read is not the answer yet: the file is given
 *      {@link REVIEW_REREAD_GRACE_MS} to change, and if it does, the new bytes are read once and
 *      that is final. A first line that parses is taken immediately, which is the common case
 *      and costs nothing.
 *   2. **The bad line travels.** When the verdict still cannot be read, the outcome carries
 *      `note` — which quotes the line the reviewer actually wrote — and the dispatcher puts it
 *      on `review.completed`. `parseVerdict` degrades to `comment`, and without the note a
 *      person cannot tell a reviewer that misformatted its answer from one that judged their
 *      change and had a mild opinion. Those are different facts and they deserve different
 *      replies.
 *
 * This module emits nothing and seals nothing: it returns an outcome, and the dispatcher turns
 * it into `review.completed` and a sealed `review` frame. It never applies a finding, and there
 * is no path here that could — ADR 0019 decision 4.
 */

// ---------- bounds ----------

/**
 * How long a reviewer gets, end to end.
 *
 * Ten minutes, not the handoff's ninety seconds: a review is a cold read of a diff by an agent
 * that has to open the changed files, and the useful ones take minutes. It is a backstop, not a
 * budget — the wait ends the moment the report lands.
 */
export const REVIEW_TIMEOUT_MS = 600_000;

/** Env override, read by {@link reviewTimeoutMs}. */
export const REVIEW_TIMEOUT_ENV = 'PAGR_REVIEW_TIMEOUT_MS';

/** The poll that actually finds the file; `fs.watch` is only the latency optimisation. */
export const REVIEW_POLL_INTERVAL_MS = 1_000;

/**
 * How long an unreadable first line is given to become a readable one.
 *
 * Only ever spent on a report that is already wrong, so it delays nothing in the normal case.
 * Five seconds is a second Write tool call, which is what "the agent revised the file" is.
 */
export const REVIEW_REREAD_GRACE_MS = 5_000;

/** Review bound from the environment; unset or unparseable falls back to the default. */
export function reviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REVIEW_TIMEOUT_ENV];
  if (raw === undefined) return REVIEW_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : REVIEW_TIMEOUT_MS;
}

/** The commit Pagr makes when the tree is dirty at review time. Never pushed (see `git.ts`). */
export const reviewWipCommitMessage = (reviewer: Provider): string =>
  `wip(pagr): review by ${reviewer}`;

/**
 * The one instruction a person's "fix it" turns into, on both branches of `review.apply`.
 *
 * Repo-relative on purpose: it is read by an agent whose cwd is the repository, and a path is
 * the whole of what Pagr passes along. The findings themselves are never summarised, quoted or
 * filtered by us — the reviewer wrote them, the builder reads them, and Pagr relays the
 * person's decision to have that happen (ADR 0017, ADR 0019 decision 4).
 */
export const reviewApplyInstruction = (reviewId: string): string =>
  `Read ${REVIEW_DIR}/${reviewId}/review.md and fix the blocking findings`;

/**
 * The only thing a reviewing run may write.
 *
 * One review's own directory, so a reviewer cannot "helpfully" fix what it found, and two
 * concurrent reviews cannot overwrite each other's report. Claude's rules really are limited to
 * these globs. Codex widens them to `<repo>/.pagr` — its sandbox grants the directory the thread
 * is started in and has no way to express anything narrower (`adapter-codex/src/run-once.ts`) —
 * so on that side a reviewer cannot touch the repository, but could in principle write elsewhere
 * under `.pagr`. Neither can fix what it found, which is the property this exists for.
 */
export const reviewAllowedWrites = (reviewId: string): string[] => [`${REVIEW_DIR}/${reviewId}/**`];

/** Where the reviewer's report goes, under the work tree root. */
export const reviewFilePath = (repoRootDir: string, reviewId: string): string =>
  join(repoRootDir, REVIEW_DIR, reviewId, 'review.md');

/** A `ses_…` for a session started to act on findings. Local: the cloud did not pre-allocate it. */
export const newAppliedSessionId = (): string => `ses_${randomBytes(16).toString('hex')}`;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

// ---------- preparing ----------

/** Why a review never started. Each one is a sentence the command can ack `failed` with. */
export type ReviewStartFailure =
  /** The project directory is not inside a git work tree. */
  | 'not_a_repo'
  /** `.pagr/` could not be added to `.git/info/exclude`, so nothing may be written. */
  | 'not_excluded'
  /** The dirty work tree could not be committed, so the reviewer would read the wrong change. */
  | 'wip_commit_failed'
  /** The user's own `pre-commit` hook rejected the WIP commit. Their code, their policy. */
  | 'hook_failed'
  /** The packet could not be built: a bad range, an unreadable repository, a failed write. */
  | 'packet_failed';

export class ReviewStartError extends Error {
  constructor(
    readonly reason: ReviewStartFailure,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ReviewStartError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface PrepareReviewInput {
  /** `rev_` + 32 hex, from `review.start`. */
  reviewId: string;
  /** Any directory inside the repository under review. */
  repo: string;
  /** `<base>..HEAD`, or any range git accepts. */
  range: string;
  /** One line: what the builder was trying to do. Reduced and capped by the packet builder. */
  intent: string;
  /** The agent that will do the reading, for the WIP commit message. */
  reviewer: Provider;
  env?: NodeJS.ProcessEnv | undefined;
  /** Passed straight to `git.ts`. Tests substitute their own runner. */
  git?: GitOptions | undefined;
}

/** Everything on disk before the reviewer is started. */
export interface PreparedReview {
  reviewId: string;
  /** The resolved work tree root. The reviewer runs here and nowhere else. */
  repo: string;
  packet: ReviewPacket;
  /** `<repo>/.pagr/review/<id>/review.md`. Does not exist yet — that is the point. */
  reviewPath: string;
  /** The reviewer's whole instruction. */
  prompt: string;
  allowedWrites: string[];
  /** The WIP commit, when the tree was dirty. Absent when it was already clean. */
  wipCommit?: string;
  /** Files that commit carried. 0 when nothing was committed. */
  filesChanged: number;
}

/**
 * Commit whatever is uncommitted, then build the packet.
 *
 * Throws {@link ReviewStartError} for everything a person needs told before a reviewer is
 * started, so `review.start` can ack `failed` with a reason rather than acking a review that
 * was never going to happen.
 */
export async function prepareReview(input: PrepareReviewInput): Promise<PreparedReview> {
  const git = input.git ?? {};

  let root: string;
  try {
    root = await repoRoot(input.repo, git);
  } catch (e) {
    throw new ReviewStartError('not_a_repo', errorMessage(e), { cause: e });
  }

  // Before `git add -A` runs, not after: `.pagr/` holds handoff notes and earlier reports, and
  // a WIP commit that swept them into the user's history is not undone by excluding them later.
  try {
    await ensureExcluded(root, '.pagr/', git);
  } catch (e) {
    throw new ReviewStartError(
      'not_excluded',
      `could not exclude .pagr/ in ${root}: ${errorMessage(e)}`,
      { cause: e },
    );
  }

  let commit: CommitResult;
  try {
    commit = await commitAll(root, reviewWipCommitMessage(input.reviewer), git);
  } catch (e) {
    const hook = e instanceof GitError && e.code === 'hook_failed';
    throw new ReviewStartError(hook ? 'hook_failed' : 'wip_commit_failed', errorMessage(e), {
      cause: e,
    });
  }

  let packet: ReviewPacket;
  try {
    packet = await buildReviewPacket({
      repo: root,
      range: input.range,
      intent: input.intent,
      reviewId: input.reviewId,
      ...(input.env ? { env: input.env } : {}),
      git,
    });
  } catch (e) {
    throw new ReviewStartError('packet_failed', errorMessage(e), { cause: e });
  }

  // `fs.watch` wants a directory that already exists; `buildReviewPacket` has just made it.
  try {
    await mkdir(dirname(packet.reviewPath), { recursive: true });
  } catch {
    // Already there in every real case; the poll covers a directory the watch cannot open.
  }

  return {
    reviewId: input.reviewId,
    repo: root,
    packet,
    reviewPath: packet.reviewPath,
    prompt: reviewPrompt({
      packetPath: packet.packetPath,
      outPath: packet.reviewPath,
      repo: root,
    }),
    allowedWrites: reviewAllowedWrites(input.reviewId),
    ...(commit.committed && commit.sha ? { wipCommit: commit.sha } : {}),
    filesChanged: commit.filesChanged,
  };
}

// ---------- running ----------

/**
 * The slice of `CodingAgentAdapter` a review uses: one headless run, nothing else.
 *
 * Structural rather than the whole adapter, because a review never starts, steers or stops a
 * session — the reviewer is not something anybody talks to.
 */
export interface ReviewRunner {
  runOnce(input: RunOnceInput): Promise<RunOnceResult>;
}

export interface AwaitReviewInput {
  prepared: PreparedReview;
  reviewer: Provider;
  runner: ReviewRunner;
  /** Which project the run's frames belong to. Frames are dropped without it. */
  projectId?: string | undefined;
  /** Reuse a run id across a retry. Minted when absent. */
  runId?: string | undefined;
  /** Overrides {@link reviewTimeoutMs}. */
  timeoutMs?: number | undefined;
  /** Overrides {@link REVIEW_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number | undefined;
  /** Overrides {@link REVIEW_REREAD_GRACE_MS}. */
  reReadGraceMs?: number | undefined;
  /** Where the timeout is read from when `timeoutMs` is absent. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Cancels the review from outside: a shutting-down daemon, a person who changed their mind. */
  signal?: AbortSignal | undefined;
}

/** How a review ended. Both variants name the run, so its frames can be found in the journal. */
export type ReviewOutcome =
  /** A report was read. The verdict may still have been interpreted — see `note`. */
  | {
      outcome: 'completed';
      reviewId: string;
      runId: string;
      /** The `ses_…` the run's frames were mirrored under. Never a controllable session. */
      sessionId: string;
      verdict: ParsedVerdict['verdict'];
      summary: string;
      /** Present when the first line was not the contract. Quotes what the reviewer wrote. */
      note?: string;
      path: string;
      /** The report, exactly as written. Goes into the sealed `review` frame and nowhere else. */
      text: string;
      /** True when the first bytes were unreadable and the revised file is what was used. */
      reRead: boolean;
      /** The run's own result, when it ended by itself. Null when it was aborted or threw. */
      run: RunOnceResult | null;
    }
  /** The bound elapsed, or the agent finished and wrote nothing. There is no verdict. */
  | {
      outcome: 'no_report';
      reviewId: string;
      runId: string;
      sessionId: string;
      path: string;
      /** One line for the phone: why there is no review. */
      message: string;
      waitedMs: number;
      run: RunOnceResult | null;
    };

/**
 * Start the reviewer on the prepared packet and answer with what it wrote.
 *
 * Never throws for anything the design anticipates. An agent that cannot be started, one that
 * dies, one that never writes and one that writes nonsense are all things a person gets told in
 * a text message, not stack traces.
 */
export async function awaitReview(input: AwaitReviewInput): Promise<ReviewOutcome> {
  const { prepared, reviewer } = input;
  const runId = input.runId ?? newRunId();
  const sessionId = runOnceSessionId(reviewer, runId);
  const timeoutMs = input.timeoutMs ?? reviewTimeoutMs(input.env);
  const pollIntervalMs = input.pollIntervalMs ?? REVIEW_POLL_INTERVAL_MS;
  const reReadGraceMs = input.reReadGraceMs ?? REVIEW_REREAD_GRACE_MS;

  // Our own controller, chained to the caller's: aborting the run once the report is in hand is
  // this function's business, and it must not reach back into the caller's signal to do it.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener('abort', abort, { once: true });

  // A holder rather than a `let`: the assignment happens inside a closure, and a narrowed
  // `null` read after the await would be a silently wrong "the run never reported".
  const state: { run: RunOnceResult | null; error: string | null } = { run: null, error: null };
  const running = (async () => {
    try {
      state.run = await input.runner.runOnce({
        cwd: prepared.repo,
        prompt: prepared.prompt,
        allowedWrites: prepared.allowedWrites,
        timeoutMs,
        runId,
        signal: controller.signal,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
    } catch (e) {
      state.error = errorMessage(e);
    }
  })();

  const wait = await waitForReview({
    file: prepared.reviewPath,
    timeoutMs,
    pollIntervalMs,
    reReadGraceMs,
    stopWhen: running,
  });

  // The report is the deliverable and it is in hand; the prompt already told the agent to stop.
  controller.abort();
  await running;
  input.signal?.removeEventListener('abort', abort);

  if (wait.kind === 'read') {
    const { parsed } = wait;
    return {
      outcome: 'completed',
      reviewId: prepared.reviewId,
      runId,
      sessionId,
      verdict: parsed.verdict,
      summary: parsed.summary,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
      path: prepared.reviewPath,
      text: wait.text,
      reRead: wait.reRead,
      run: state.run,
    };
  }

  return {
    outcome: 'no_report',
    reviewId: prepared.reviewId,
    runId,
    sessionId,
    path: prepared.reviewPath,
    message: noReportMessage(reviewer, state, wait.waitedMs),
    waitedMs: wait.waitedMs,
    run: state.run,
  };
}

/** Why there is no review, in one line, in the order of what actually went wrong. */
function noReportMessage(
  reviewer: Provider,
  state: { run: RunOnceResult | null; error: string | null },
  waitedMs: number,
): string {
  if (state.error) return `${reviewer} could not be started: ${state.error}`;
  const run = state.run;
  if (run?.outcome === 'failed')
    return `${reviewer} failed before writing its review: ${run.error?.message ?? 'no reason given'}`;
  if (run?.outcome === 'timeout')
    return `${reviewer} ran out of time (${Math.round(waitedMs / 1000)}s) without writing a review`;
  if (run?.outcome === 'completed') return `${reviewer} finished its turn without writing a review`;
  if (run?.outcome === 'canceled') return `the review was stopped before ${reviewer} answered`;
  return `no review after ${Math.round(waitedMs / 1000)}s`;
}

// ---------- the watch ----------

type ReviewWait =
  | { kind: 'read'; text: string; parsed: ParsedVerdict; reRead: boolean }
  | { kind: 'timeout'; waitedMs: number };

interface WaitOptions {
  file: string;
  timeoutMs: number;
  pollIntervalMs: number;
  reReadGraceMs: number;
  /** The run. When it settles the file is checked once more and the wait ends either way. */
  stopWhen: Promise<void>;
}

/**
 * Wait for `review.md`, with one re-read.
 *
 * **Both a watch and a poll, and the poll is the mechanism.** `fs.watch` on macOS is FSEvents,
 * which coalesces, drops events under pressure, says nothing useful on some volumes and can
 * report a change without naming the file. It is a latency optimisation here and nothing more;
 * the one-second poll is what this is built on. (The same reasoning, at more length, is in
 * `handoff/capture.ts`.)
 *
 * The rules, in the order they fire:
 *
 *   - An empty file is not an answer. An agent's `Write` creates before it fills, and reporting
 *     "the reviewer wrote an empty report" because we read it 3 ms early would be a lie about
 *     its work. Empty is treated as "not there yet".
 *   - A readable verdict line ends the wait **immediately**, without waiting for the agent's
 *     turn to end. That is the point of watching rather than awaiting the run.
 *   - An unreadable one starts the grace: the bytes are kept, and if the file changes within
 *     {@link AwaitReviewInput.reReadGraceMs} the new bytes are read once and that is the answer,
 *     good or bad. If it does not change, the first bytes are the answer and the caller reports
 *     what the reviewer wrote instead of a verdict.
 */
function waitForReview(opts: WaitOptions): Promise<ReviewWait> {
  const { file, timeoutMs, pollIntervalMs, reReadGraceMs, stopWhen } = opts;
  const dir = dirname(file);
  const name = basename(file);
  const startedAt = Date.now();

  return new Promise<ReviewWait>((resolve) => {
    let watcher: FSWatcher | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    /**
     * The check currently reading the file, so a second caller QUEUES behind it instead of
     * being dropped.
     *
     * A dropped check was a real lost verdict, not a theoretical one. The last thing this wait
     * does before giving up is `await check()` on the run having ended — and with a boolean
     * "already checking" guard that call returned instantly while the read that was in flight
     * had started before the file existed. A reviewer that wrote its report and exited in the
     * same tick (a cheap model, a cached answer, a fake in a test) was then reported as "finished
     * its turn without writing a review" with the review sitting on disk.
     */
    let inflight: Promise<void> | null = null;
    /** The first unreadable report, and when it was seen. Cleared by nothing: there is one. */
    let first: { text: string; parsed: ParsedVerdict; at: number } | null = null;

    const finish = (result: ReviewWait): void => {
      if (done) return;
      done = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };

    /** Whatever we have when time (or the agent) runs out. */
    const settle = (): void => {
      if (first) finish({ kind: 'read', text: first.text, parsed: first.parsed, reRead: false });
      else finish({ kind: 'timeout', waitedMs: Date.now() - startedAt });
    };

    const readOnce = async (): Promise<void> => {
      if (done) return;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return; // not there yet, or not readable yet
      }
      if (done) return;
      if (text.trim() === '') return; // created, not written yet
      const parsed = parseVerdict(text);
      if (parsed.note === undefined) {
        finish({ kind: 'read', text, parsed, reRead: first !== null });
        return;
      }
      if (first === null) {
        first = { text, parsed, at: Date.now() };
        return;
      }
      // The revision the grace exists for. Whatever it says, it is the reviewer's final word.
      if (text !== first.text) {
        finish({ kind: 'read', text, parsed, reRead: true });
        return;
      }
      if (Date.now() - first.at >= reReadGraceMs) settle();
    };

    /** One read, serialised behind whatever read is already running. */
    const check = (): Promise<void> => {
      const next = (inflight ?? Promise.resolve()).then(readOnce);
      inflight = next.catch(() => undefined);
      return next;
    };

    try {
      watcher = watch(dir, (_event, changed) => {
        if (changed === null || changed === name) void check();
      });
      // An unwatchable directory is not a failed review: the poll covers it.
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }

    poll = setInterval(() => void check(), pollIntervalMs);
    deadline = setTimeout(settle, timeoutMs);

    // The agent has stopped. Look once more — a file written in its last breath is still a
    // review — and then stop waiting for something nothing is going to produce.
    void stopWhen.then(async () => {
      if (done) return;
      await check();
      if (!done) settle();
    });

    void check(); // it may already be there from an earlier attempt
  });
}
