import {
  type ProjectRecord,
  projectContaining,
  type ResolvedReviewRange,
  reviewIntentFor,
  reviewTimeoutMs,
} from '@pagr/bridge-core';
import type { ReviewVerdict } from '@pagr/protocol';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, daemonDownError, EXIT } from '../errors.js';
import { daemonStatus, fromIpc, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, say, table, warn } from '../output.js';
import { tildify } from './projects.js';

/**
 * `pagr review` — the cross-agent review, from the terminal, with no cloud in it.
 *
 * The sibling of `pagr handoff` (HND-014) and built the same way: the daemon runs the same
 * `review.start` a phone drives, through the same dispatcher, so this is a second door onto one
 * implementation rather than a second implementation. What it adds is the thing a terminal can
 * do and a phone cannot — wait. The cloud's ack means "this review is under way" and the verdict
 * reaches it later as `review.completed`; here the command holds the socket open and prints the
 * verdict itself, because a CLI that answered with a review id would have answered nothing.
 *
 * Two calls, and the first one is the point of the command's design. `review.range` is answered
 * in milliseconds and says WHICH COMMITS are about to be read and why those: a reviewer pointed
 * at the wrong commits is worse than no reviewer, because it comes back `approve` about code it
 * never opened and nothing in that answer says so. The person sees the range before the agent
 * starts, not in the report afterwards.
 */

export interface ReviewOptions {
  with?: string;
  range?: string;
  intent?: string;
}

/** What `review.run` answers with once the reviewer has written its report. */
export interface ReviewRunResponse {
  reviewId: string;
  reviewer: string;
  projectId: string;
  repo: string;
  range: string;
  intent: string;
  /** Absolute path to `review.md`. */
  path: string;
  /** `.pagr/review/<id>/review.md` — what an agent is told to read. */
  relativePath: string;
  verdict: ReviewVerdict;
  summary: string;
  /** The reviewer's own first line. Absent only when the report had no readable line at all. */
  verdictLine?: string;
  /** Why the verdict needed interpreting, when it did. */
  note?: string;
  /** The line to paste into the agent that wrote the code. */
  instruction: string;
}

const PROVIDERS = ['claude', 'codex'] as const;
type ProviderName = (typeof PROVIDERS)[number];
const isProvider = (s: string): s is ProviderName => (PROVIDERS as readonly string[]).includes(s);

/**
 * Verdict → exit code.
 *
 * `block` exits 5 and that is the whole reason a script would run this command: `pagr review
 * --with codex && git push` has to stop on a blocking finding, and it can only do that if the
 * verdict reaches the shell as a number. 5 is "precondition failed" — the change did not clear
 * the check it was submitted to — and it is deliberately NOT 1, which means the review itself
 * broke down, nor 2, which means the command was typed wrong. Those three are the distinction
 * the ticket asks for, and a script that cannot tell them apart would treat a reviewer that
 * crashed as a change that was rejected.
 *
 * `comment` is 0: findings worth reading, nothing that stops the change. That is the reviewer's
 * own distinction and this table does not second-guess it.
 */
export const EXIT_FOR_VERDICT: Record<ReviewVerdict, number> = {
  approve: EXIT.ok,
  comment: EXIT.ok,
  block: EXIT.precondition,
};

/**
 * How long to wait on the run.
 *
 * The reviewer's own bound plus two minutes: `PAGR_REVIEW_TIMEOUT_MS` (ten minutes by default)
 * caps the reviewing agent, and around it sit the WIP commit — which runs the person's
 * `pre-commit` hook, and that can be a whole test suite — and building the packet. A socket
 * timeout shorter than the work would report a failure for a review that is still running.
 */
export const reviewCallTimeoutMs = (env: NodeJS.ProcessEnv): number =>
  reviewTimeoutMs(env) + 120_000;

/** The project containing the current directory, or the refusal that names the fix. */
export function pickProject(projects: ProjectRecord[], cwd: string): ProjectRecord {
  const project = projectContaining(projects, cwd);
  if (!project)
    throw new CliError(
      `${tildify(cwd)} is in no registered project, so there is nothing to review`,
      EXIT.precondition,
      {
        code: 'no_project',
        hint: `run \`pagr projects add ${tildify(cwd)}\``,
      },
    );
  return project;
}

/**
 * What is about to be read, in one line, before anything starts.
 *
 * Every branch names the range itself, so the sentence is checkable against `git log` rather
 * than merely reassuring. The `uncommitted` branch says out loud that Pagr commits first,
 * because the person is about to find a commit in their history that they did not make.
 */
export function rangeLine(r: ResolvedReviewRange, reviewer: string): string {
  const head = `reviewing ${bold(r.range)} with ${reviewer}`;
  if (r.basis === 'uncommitted')
    return `${head} — your ${r.dirtyFiles} uncommitted file(s), which Pagr commits first (nothing is pushed)`;
  const newest = r.commits[0];
  const dirty =
    r.dirtyFiles > 0
      ? `; your ${r.dirtyFiles} uncommitted file(s) are committed first and are inside the range`
      : '';
  if (r.basis === 'last_commit')
    return `${head} — the last commit${newest ? `, ${newest}` : ''}${dirty}`;
  return `${head} — ${r.commits.length} commit(s) you named${dirty}`;
}

export async function runReview(ctx: CliContext, cwd: string, opts: ReviewOptions): Promise<void> {
  const reviewer = (opts.with ?? '').trim().toLowerCase();
  if (!isProvider(reviewer))
    throw new CliError(
      `--with must be ${PROVIDERS.join(' or ')}${reviewer ? `, not "${opts.with}"` : ''}`,
      EXIT.usage,
      { code: 'bad_provider' },
    );
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const client = ipc(ctx);
  const project = pickProject(await client.call<ProjectRecord[]>('projects.list'), cwd);

  let range: ResolvedReviewRange;
  try {
    range = await client.call<ResolvedReviewRange>('review.range', {
      projectId: project.projectId,
      ...(opts.range ? { range: opts.range } : {}),
    });
  } catch (err) {
    throw fromIpc(err, 'nothing was started — pass --range <base>..<head> to say which commits');
  }
  // Before the agent, never after: this is the sentence that lets someone stop a review of the
  // wrong commits while stopping it is still free.
  say(ctx, rangeLine(range, reviewer));
  const intent = (opts.intent ?? reviewIntentFor(range)).trim();

  say(ctx, dim(`asking ${reviewer} to read it — this can take a few minutes…`));
  let result: ReviewRunResponse;
  try {
    result = await client.call<ReviewRunResponse>(
      'review.run',
      { projectId: project.projectId, reviewer, range: range.range, intent },
      reviewCallTimeoutMs(ctx.env),
    );
  } catch (err) {
    throw fromIpc(err, `nothing was changed; ${reviewer} never wrote a report`);
  }

  const document = { ...result, basis: range.basis, commits: range.commits };
  if (ctx.json) printJson(ctx, document);
  else report(ctx, result);

  // The verdict is the answer, so it is the exit code. The document above is already written;
  // an empty message exits on the code without printing a second thing on top of it.
  const code = EXIT_FOR_VERDICT[result.verdict];
  if (code !== EXIT.ok) throw new CliError('', code);
}

/** The human-facing half. `--json` never reaches here. */
function report(ctx: CliContext, r: ReviewRunResponse): void {
  ctx.out(ok(`${r.reviewer} reviewed ${r.range}`));
  ctx.out('');
  // Verbatim, on its own line, unwrapped and unrecomposed: this is the reviewer's sentence and
  // Pagr does not paraphrase a judgement it did not make.
  ctx.out(bold(r.verdictLine ?? `verdict: ${r.verdict} — ${r.summary}`));
  ctx.out('');
  ctx.out(table([[dim('report'), r.path]]));
  if (r.note) ctx.out(warn(r.note));
  if (r.verdict === 'approve') return;
  ctx.out('');
  ctx.out('Hand the findings to the agent that wrote the code:');
  ctx.out('');
  ctx.out(`  ${bold(r.instruction)}`);
}

export function registerReview(program: Command, getCtx: () => CliContext): void {
  program
    .command('review')
    .description('have the other agent review the work in this directory, read-only')
    .requiredOption('--with <agent>', 'the agent that does the reading: claude or codex')
    .option(
      '--range <a..b>',
      'commits to review (default: your uncommitted work, or the last commit)',
    )
    .option('--intent <text>', 'one line for the reviewer: what you were trying to do')
    .action((opts: ReviewOptions) => {
      const ctx = getCtx();
      return runReview(ctx, ctx.cwd(), opts);
    });
}
