import {
  DEFAULT_BACKFILL_BYTES,
  isAdopted,
  isLiveStatus,
  JOURNAL_RETENTION_DAYS,
  type ProjectRecord,
  type SessionRecord,
  UNREGISTERED_PROJECT,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, daemonDownError, EXIT } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, table, warn } from '../output.js';

export interface SessionsOptions {
  /** Re-check every session against its provider and clear anything that only claims to run. */
  reconcile?: boolean;
}

interface Reconciled {
  sessionId: string;
  provider: string;
  status: string;
  outcome: string;
  reason: string;
}

/** What `sessions.journal` reports per session: how much transcript, and how far behind. */
interface JournalRow {
  lastSeq: number;
  bytes: number;
  sent: number;
  acked: number;
  updatedAt: string;
}

interface PurgeResult {
  removed: string[];
  bytesFreed: number;
  totalBytes: number;
}

interface BackfillResult {
  frames: number;
  bytes: number;
  lastSeq: number;
  truncated: boolean;
}

/**
 * How much Pagr may drive a session, worked out from what this Mac recorded about it.
 *
 * Deliberately the conservative reading rather than the adapter's: this command runs against
 * `sessions.json`, which knows whether Pagr started a session and not whether a channel is bound
 * to it right now. A session the phone can steer shows here as `approvals` at worst, never the
 * other way round — under-promising in a local listing is free, over-promising is not.
 */
function controlOf(s: SessionRecord): string {
  if (!isAdopted(s)) return 'full';
  return s.projectId === UNREGISTERED_PROJECT ? 'none' : 'approvals';
}

const bytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`;
};

/** `30d`, `12h`, `45m` → milliseconds. Returns null for anything else. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([dhm])$/.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
}

export async function runSessions(ctx: CliContext, opts: SessionsOptions = {}): Promise<void> {
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const client = ipc(ctx);

  if (opts.reconcile) {
    const changed = await client.call<Reconciled[]>('sessions.reconcile', undefined, 30_000);
    if (ctx.json) {
      printJson(ctx, changed);
      return;
    }
    if (changed.length === 0) {
      ctx.out(ok('every session matches its provider — nothing to reconcile'));
      return;
    }
    ctx.out(
      table(
        changed.map((c) => [c.sessionId, c.provider, c.outcome, c.status, dim(c.reason)]),
        ['SESSION', 'AGENT', 'OUTCOME', 'NOW', 'WHY'],
      ),
    );
    return;
  }

  const [list, projects, journals] = await Promise.all([
    client.call<SessionRecord[]>('sessions.list'),
    client.call<ProjectRecord[]>('projects.list').catch(() => [] as ProjectRecord[]),
    client
      .call<Record<string, JournalRow>>('sessions.journal')
      .catch(() => ({}) as Record<string, JournalRow>),
  ]);
  const nameOf = new Map(projects.map((p) => [p.projectId, p.displayName]));
  if (ctx.json) {
    printJson(
      ctx,
      list.map((s) => ({
        ...s,
        origin: isAdopted(s) ? 'terminal' : 'pagr',
        controlLevel: controlOf(s),
        journal: journals[s.sessionId] ?? { lastSeq: 0, bytes: 0, sent: 0, acked: 0 },
      })),
    );
    return;
  }
  if (list.length === 0) {
    ctx.out(dim('no sessions'));
    return;
  }
  ctx.out(
    table(
      list.map((s) => {
        const j = journals[s.sessionId];
        return [
          s.sessionId,
          s.provider,
          isLiveStatus(s.status) ? bold(s.status) : s.status,
          // A session with no registered project is still real; naming its directory makes the fix
          // obvious instead of leaving an empty cell.
          s.projectId === UNREGISTERED_PROJECT
            ? dim(s.cwd ?? 'no registered project')
            : (nameOf.get(s.projectId) ?? s.projectId),
          s.oneShot ? `pagr · ${s.oneShot.kind}` : isAdopted(s) ? 'terminal' : dim('pagr'),
          controlOf(s),
          j?.lastSeq ? String(j.lastSeq) : dim('—'),
          j?.bytes ? bytes(j.bytes) : dim('—'),
          dim(s.updatedAt),
        ];
      }),
      ['SESSION', 'AGENT', 'STATUS', 'PROJECT', 'ORIGIN', 'CONTROL', 'SEQ', 'JOURNAL', 'UPDATED'],
    ),
  );
  const live = list.filter((s) => isLiveStatus(s.status)).length;
  const runs = list.filter((s) => s.oneShot !== undefined);
  const adopted = list.filter(isAdopted);
  const unregistered = adopted.filter((s) => s.projectId === UNREGISTERED_PROJECT);
  const journalBytes = Object.values(journals).reduce((n, j) => n + j.bytes, 0);
  ctx.out('');
  ctx.out(dim(`${list.length} session(s), ${live} live`));
  if (journalBytes > 0)
    ctx.out(
      dim(
        `${bytes(journalBytes)} of transcript in ~/.pagr/journal — \`pagr sessions purge\` frees what is past retention`,
      ),
    );
  for (const r of runs)
    ctx.out(
      dim(
        `  ${r.sessionId} is Pagr ${r.oneShot?.kind === 'handoff' ? 'writing a handoff' : 'reviewing a diff'} — it can be stopped and told what to focus on, like any session`,
      ),
    );
  if (adopted.length > 0)
    ctx.out(
      dim(
        `${adopted.length} started by you, not by Pagr: it can relay approvals only — no instructions, no stop, no resume`,
      ),
    );
  for (const s of unregistered)
    ctx.out(
      dim(
        `  ${s.cwd ?? 'that directory'} is in no registered project, so its prompts stay in the terminal — \`pagr projects add ${s.cwd ?? '<dir>'}\``,
      ),
    );
}

export interface PurgeOptions {
  olderThan?: string;
  yes?: boolean;
}

/**
 * Delete journals past their retention.
 *
 * What it touches is `~/.pagr/journal/*` and nothing else. Claude Code's own transcripts under
 * `~/.claude` are that program's files, and Pagr has no business deleting them — which is also
 * why purging is safe: the history is still on this Mac, and a later `session.backfill` rebuilds
 * the journal from the transcript.
 */
export async function runSessionsPurge(ctx: CliContext, opts: PurgeOptions = {}): Promise<void> {
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const text = opts.olderThan ?? `${JOURNAL_RETENTION_DAYS}d`;
  const ms = parseDuration(text);
  if (ms === null)
    throw new CliError(
      `could not read \`--older-than ${text}\` — use a number of days, hours or minutes, e.g. 30d`,
      EXIT.usage,
    );
  const days = ms / 86_400_000;
  // `--yes` is required in every mode, `--json` included: this deletes files, and a script that
  // did not ask for that should not get it because it happened to be machine-readable.
  if (!opts.yes) {
    if (ctx.json) {
      printJson(ctx, { purged: false, olderThan: text, reason: 'needs --yes' });
      return;
    }
    ctx.out(
      warn(
        `this deletes every journal in ~/.pagr/journal untouched for longer than ${text} — the phone keeps what it already has, and anything still on this Mac can be backfilled again`,
      ),
    );
    ctx.out(dim('  nothing under ~/.claude is touched. Re-run with --yes to go ahead.'));
    return;
  }
  const result = await ipc(ctx).call<PurgeResult>('sessions.purge', { days }, 60_000);
  if (ctx.json) {
    printJson(ctx, result);
    return;
  }
  if (result.removed.length === 0) {
    ctx.out(ok(`nothing older than ${text}; ${bytes(result.totalBytes)} of journal kept`));
    return;
  }
  ctx.out(
    ok(
      `purged ${result.removed.length} journal(s), freed ${bytes(result.bytesFreed)}; ${bytes(result.totalBytes)} kept`,
    ),
  );
}

export interface BackfillOptions {
  from?: string;
  to?: string;
  maxBytes?: string;
}

/**
 * Run a backfill from the Mac itself.
 *
 * Identical code path to a phone's `session.backfill` — the same guard, the same journal, the same
 * seal — so a session can be replayed and checked without pairing a device. What it does NOT do is
 * pretend to deliver: with no phone key pinned the frames are journaled and counted, and the
 * result says how many would have gone out.
 */
export async function runSessionsBackfill(
  ctx: CliContext,
  sessionId: string,
  opts: BackfillOptions = {},
): Promise<void> {
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const num = (text: string | undefined, what: string): number | undefined => {
    if (text === undefined) return undefined;
    const n = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new CliError(`\`--${what} ${text}\` is not a whole number`, EXIT.usage);
    return n;
  };
  const result = await ipc(ctx).call<BackfillResult>(
    'sessions.backfill',
    {
      sessionId,
      fromSeq: num(opts.from, 'from') ?? 1,
      ...(opts.to !== undefined ? { toSeq: num(opts.to, 'to') } : {}),
      maxBytes: num(opts.maxBytes, 'max-bytes') ?? DEFAULT_BACKFILL_BYTES,
    },
    // A cold transcript replay reads every file of the session; a minute is generous and finite.
    120_000,
  );
  if (ctx.json) {
    printJson(ctx, result);
    return;
  }
  ctx.out(
    ok(
      `backfilled ${result.frames} frame(s), ${bytes(result.bytes)}, up to #${result.lastSeq}${
        result.truncated ? ' — more remains, ask again from the next seq' : ''
      }`,
    ),
  );
}

export function registerSessions(program: Command, getCtx: () => CliContext): void {
  const sessions = program
    .command('sessions')
    .description('list agent sessions known to the daemon')
    .option(
      '--reconcile',
      'ask each provider what it still knows and clear any session that only claims to run',
    )
    // Commander runs this only for a bare `pagr sessions`; a subcommand below handles itself.
    .action((opts: SessionsOptions) => runSessions(getCtx(), opts));

  sessions
    .command('purge')
    .description('delete session journals past their retention (never touches ~/.claude)')
    .option(
      '--older-than <age>',
      `journals untouched for longer than this (default ${JOURNAL_RETENTION_DAYS}d)`,
    )
    .option('--yes', 'do it without asking')
    .action((opts: PurgeOptions) => runSessionsPurge(getCtx(), opts));

  sessions
    .command('backfill <sessionId>')
    .description('replay a session’s transcript to your phones, from this Mac')
    .option('--from <seq>', 'first frame to send (default 1)')
    .option('--to <seq>', 'last frame to send (default: everything)')
    .option('--max-bytes <n>', 'byte budget for this run')
    .action((sessionId: string, opts: BackfillOptions) =>
      runSessionsBackfill(getCtx(), sessionId, opts),
    );
}
