import { homedir } from 'node:os';
import {
  type HandoffListResult,
  handoffCaptureTimeoutMs,
  IpcClientError,
  isLiveStatus,
  listHandoffs,
  type ProjectRecord,
  ProjectRegistry,
  projectContaining,
  type SessionRecord,
  UNREGISTERED_PROJECT,
} from '@pagr/bridge-core';
import type { SessionSummary } from '@pagr/protocol';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, daemonDownError, EXIT } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, say, shortId, table, warn } from '../output.js';
import { tildify } from './projects.js';

/**
 * `pagr handoff` — the mid-task switch, from the terminal, with no cloud in it.
 *
 * It is the same engine the phone drives: the daemon runs `session.handoff.capture` through the
 * dispatcher, which writes the file, WIP-commits the work and stops the sender, and then
 * `agent.start_session` on the receiving agent. Two calls, because they are two things: the
 * handoff exists whether or not anything is started on it.
 *
 * `--no-start` is the reason this command matters more than a convenience wrapper. Pagr can
 * drive Claude Code and Codex; it cannot drive Cursor, Gemini CLI, Aider or whatever the person
 * is running in the other window. With `--no-start` the capture still runs in full — a real
 * file, a real WIP commit, a real path — and the person is handed the path and the one line to
 * paste. The feature is honest about the agents it cannot start instead of pretending they do
 * not exist.
 */

/** What `handoff.capture` answers with: the ack's result plus where the file landed. */
export interface CaptureResponse {
  handoffId: string;
  from: string;
  to: string;
  sessionId: string;
  projectId: string;
  repo: string;
  /** Absolute. The thing `--no-start` exists to print. */
  path: string;
  /** `.pagr/handoff/<id>.md` — what the receiving agent is told to read. */
  relativePath: string;
  /** The exact line to paste into an agent Pagr cannot start. */
  instruction: string;
  writer: string;
  summary: string;
  wipCommit?: string;
  filesChanged: number;
  truncated: boolean;
}

export interface HandoffOptions {
  to?: string;
  session?: string;
  note?: string;
  /** Commander's `--no-start`: true unless the flag was passed. */
  start?: boolean;
}

const PROVIDERS = ['claude', 'codex'] as const;
type ProviderName = (typeof PROVIDERS)[number];

const isProvider = (s: string): s is ProviderName => (PROVIDERS as readonly string[]).includes(s);

/**
 * IPC error code → exit code.
 *
 * The contract the acceptance criteria ask for: a switch that was REFUSED (this Mac will not do
 * that — the directory is not a repository, the receiver is not signed in, another agent already
 * holds the tree) exits 5, while a switch that was attempted and FAILED (the agent never wrote
 * the file, a pre-commit hook rejected the WIP commit, the sender would not stop) exits 1. They
 * are different problems with different fixes, and a script must be able to tell them apart
 * without reading English.
 */
const EXIT_FOR_CODE: Record<string, number> = {
  capability_unsupported: EXIT.precondition,
  unknown_session: EXIT.precondition,
  unknown_project: EXIT.precondition,
  not_negotiated: EXIT.precondition,
  rate_limited: EXIT.precondition,
  invalid_payload: EXIT.usage,
  provider_error: EXIT.error,
};

/** Any IPC failure, as the CliError the exit-code contract describes. */
function fromIpc(err: unknown, hint?: string): CliError {
  if (!(err instanceof IpcClientError)) return new CliError(String(err), EXIT.error);
  if (err.code === 'connect') return daemonDownError();
  return new CliError(err.message, EXIT_FOR_CODE[err.code] ?? EXIT.error, {
    code: err.code,
    ...(hint ? { hint } : {}),
  });
}

/**
 * Which session is being handed off.
 *
 * `--session` wins and is checked against what the daemon knows, so a typo is a named refusal
 * rather than a capture against nothing. Without it: the project containing the current
 * directory, and the one live session in it. Zero is a precondition (there is nothing to hand
 * over); two or more is a USAGE error, because the person has to say which — guessing "the most
 * recent" would silently hand over the wrong window's work, and that is unrecoverable in the way
 * a second's typing is not.
 */
export function pickSession(
  sessions: SessionRecord[],
  projects: ProjectRecord[],
  cwd: string,
  explicit: string | undefined,
): SessionRecord {
  if (explicit) {
    const rec = sessions.find((s) => s.sessionId === explicit);
    if (!rec)
      throw new CliError(`no session ${explicit} on this Mac`, EXIT.precondition, {
        code: 'unknown_session',
        hint: 'run `pagr sessions` to see what is running',
      });
    return rec;
  }
  const project = projectContaining(projects, cwd);
  if (!project)
    throw new CliError(
      `${tildify(cwd)} is in no registered project, so there is no session to hand off`,
      EXIT.precondition,
      {
        code: 'no_project',
        hint: `run \`pagr projects add ${tildify(cwd)}\`, or name the session with --session <id>`,
      },
    );
  const live = sessions.filter((s) => s.projectId === project.projectId && isLiveStatus(s.status));
  if (live.length === 0)
    throw new CliError(`no live session in ${project.displayName}`, EXIT.precondition, {
      code: 'no_live_session',
      hint: 'run `pagr sessions` to see what this Mac knows about, or pass --session <id>',
    });
  if (live.length > 1)
    throw new CliError(
      `${live.length} live sessions in ${project.displayName} — say which one with --session <id>`,
      EXIT.usage,
      {
        code: 'ambiguous_session',
        hint: live.map((s) => `--session ${s.sessionId}  (${s.provider})`).join('\n       '),
      },
    );
  return live[0] as SessionRecord;
}

/**
 * How long to wait on the capture.
 *
 * The daemon's own bound plus two minutes: the capture itself is capped at
 * `PAGR_HANDOFF_CAPTURE_TIMEOUT_MS` (90 s by default), and after it come the WIP commit — which
 * runs the person's `pre-commit` hook, and that can be a full test suite — and stopping the
 * sender. A socket timeout shorter than the work would report a failure for something that is
 * still running and about to succeed.
 */
export const captureCallTimeoutMs = (env: NodeJS.ProcessEnv): number =>
  handoffCaptureTimeoutMs(env) + 120_000;

export async function runHandoff(
  ctx: CliContext,
  cwd: string,
  opts: HandoffOptions,
): Promise<void> {
  const to = (opts.to ?? '').trim().toLowerCase();
  if (!isProvider(to))
    throw new CliError(
      `--to must be ${PROVIDERS.join(' or ')}${to ? `, not "${opts.to}"` : ''}`,
      EXIT.usage,
      { code: 'bad_provider' },
    );
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const client = ipc(ctx);
  const [sessions, projects] = await Promise.all([
    client.call<SessionRecord[]>('sessions.list'),
    client.call<ProjectRecord[]>('projects.list'),
  ]);
  const rec = pickSession(sessions, projects, cwd, opts.session);

  say(ctx, dim(`asking ${rec.provider} to write the handoff — this can take a minute…`));
  let captured: CaptureResponse;
  try {
    captured = await client.call<CaptureResponse>(
      'handoff.capture',
      {
        sessionId: rec.sessionId,
        to,
        ...(opts.note ? { note: opts.note } : {}),
      },
      captureCallTimeoutMs(ctx.env),
    );
  } catch (err) {
    throw fromIpc(err, 'nothing was started; `pagr sessions` shows whether the sender is still up');
  }

  // Everything below this line has a file on disk behind it. Whatever happens to the start, the
  // path is printed before the command can exit — spec §9's rule that a handoff that was written
  // is never lost in an error message.
  let started: SessionSummary | null = null;
  let startError: CliError | null = null;
  if (opts.start !== false) {
    if (captured.projectId === UNREGISTERED_PROJECT)
      startError = new CliError(
        `${tildify(captured.repo)} is in no registered project, so ${to} cannot be started in it`,
        EXIT.precondition,
        {
          code: 'unknown_project',
          hint: `run \`pagr projects add ${tildify(captured.repo)}\` and start ${to} yourself, or re-run with --no-start`,
        },
      );
    else
      try {
        started = await client.call<SessionSummary>(
          'handoff.start',
          { handoffId: captured.handoffId, provider: to, projectId: captured.projectId },
          60_000,
        );
      } catch (err) {
        startError = fromIpc(
          err,
          `the handoff is written — start ${to} yourself and paste the line above`,
        );
      }
  }

  if (ctx.json) {
    printJson(ctx, {
      ...captured,
      started,
      ...(startError ? { error: startError.toJson().error } : {}),
    });
    // The document is the output; `index.ts` must not print a second one on top of it.
    if (startError) throw new CliError('', startError.exitCode);
    return;
  }

  report(ctx, captured, started, opts.start === false);
  if (startError) throw startError;
}

/** The human-facing half. `--json` never reaches here. */
function report(
  ctx: CliContext,
  c: CaptureResponse,
  started: SessionSummary | null,
  noStart: boolean,
): void {
  ctx.out(ok(`${c.from} → ${c.to}${c.summary ? `: ${bold(c.summary)}` : ''}`));
  const rows: string[][] = [[dim('handoff'), c.path]];
  if (c.writer === 'receiver')
    rows.push([dim('written by'), `${c.to} — reconstructed from ${c.from}'s transcript`]);
  if (c.wipCommit)
    rows.push([
      dim('wip commit'),
      `${c.wipCommit}  ${dim(`${c.filesChanged} file(s) — nothing was pushed`)}`,
    ]);
  ctx.out(table(rows));
  if (c.truncated)
    ctx.out(warn('the handoff hit the 64 KiB cap; sections were dropped from the bottom'));

  if (noStart) {
    ctx.out('');
    ctx.out('Paste this into your other agent, in this repository:');
    ctx.out('');
    ctx.out(`  ${bold(c.instruction)}`);
    return;
  }
  if (started) ctx.out(ok(`${c.to} started — ${dim(shortId(started.sessionId))}`));
}

export interface HandoffsLsOptions {
  /** Show the whole `# Goal` line instead of one screen-width of it. */
  full?: boolean;
}

/**
 * `pagr handoffs ls` — every handoff file this Mac has written, newest first.
 *
 * Deliberately readable without the daemon: the files are the record, and the registry on disk
 * says which trees to walk. Someone looking for the handoff they made before the Mac rebooted
 * should not have to start a daemon to find it.
 */
export async function runHandoffsLs(ctx: CliContext, opts: HandoffsLsOptions = {}): Promise<void> {
  const projects = await listProjectsForLs(ctx);
  const result = await listHandoffs(projects.map((p) => p.path));
  const nameOf = new Map(projects.map((p) => [p.path, p.displayName]));
  if (ctx.json) {
    printJson(ctx, result);
    return;
  }
  if (result.handoffs.length === 0) {
    ctx.out(dim('no handoffs — `pagr handoff --to codex` makes one'));
    printSkips(ctx, result);
    return;
  }
  ctx.out(
    table(
      result.handoffs.map((h) => [
        shortId(h.handoffId),
        `${h.from}→${h.to}`,
        h.writer,
        nameOf.get(h.repo) ?? tildify(h.repo, ctx.env.HOME ?? homedir()),
        h.created ? dim(h.created) : dim('—'),
        h.problem ? warn(h.problem) : goal(h.summary, opts.full === true),
      ]),
      ['HANDOFF', 'SWITCH', 'WRITER', 'PROJECT', 'CREATED', 'GOAL'],
    ),
  );
  ctx.out('');
  ctx.out(dim(`${result.handoffs.length} handoff(s) — \`pagr handoffs ls --json\` has the paths`));
  printSkips(ctx, result);
}

/** One screen's worth of the goal line, unless `--full`. A wrapped table is not a table. */
const goal = (summary: string, full: boolean): string =>
  full || summary.length <= 60 ? summary : `${summary.slice(0, 59)}…`;

function printSkips(ctx: CliContext, result: HandoffListResult): void {
  for (const s of result.skipped) ctx.out(warn(`could not read ${s.repo}: ${s.reason}`));
}

/** The daemon's list when it is up, the registry file when it is not. */
async function listProjectsForLs(ctx: CliContext): Promise<ProjectRecord[]> {
  if (await daemonStatus(ctx)) return ipc(ctx).call<ProjectRecord[]>('projects.list');
  return new ProjectRegistry({
    file: ctx.paths.projectsFile,
    pagrHome: ctx.home,
    home: ctx.env.HOME ?? homedir(),
  }).list();
}

export function registerHandoff(program: Command, getCtx: () => CliContext): void {
  program
    .command('handoff')
    .description('hand the work in this directory from one agent to the other')
    .requiredOption('--to <agent>', 'the agent that picks the work up: claude or codex')
    .option('--session <id>', 'which session to hand off (default: the one live in this project)')
    .option('--note <text>', 'one line for the receiver: "focus on the refund path"')
    .option('--no-start', 'write the handoff and print its path instead of starting the receiver')
    .action((opts: HandoffOptions) => {
      const ctx = getCtx();
      return runHandoff(ctx, ctx.cwd(), opts);
    });

  const handoffs = program
    .command('handoffs')
    .description('handoffs written on this Mac')
    .action(() => runHandoffsLs(getCtx()));

  handoffs
    .command('ls')
    .description('list every handoff file, newest first, across your registered projects')
    .option('--full', 'print the whole goal line instead of trimming it to the table')
    .action((opts: HandoffsLsOptions) => runHandoffsLs(getCtx(), opts));
}
