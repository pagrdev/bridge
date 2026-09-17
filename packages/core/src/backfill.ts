import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, Provider, SessionSummaryV2 } from '@pagr/protocol';
import { type FrameBody, frameBodyBytes } from './frames.js';
import type { JournalEntry, JournalMeta, JournalStore } from './journal.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { getMirrorBridge, type MirrorProject } from './mirrorBridge.js';
import type { SessionRecord } from './sessions.js';

/**
 * History and backfill: the part of the transcript the phone does not have.
 *
 * The retention decision this module implements is one line of the shared contract — *the cloud
 * keeps 30 days, the phone keeps forever, anything older comes from the Mac on demand* — and
 * everything here follows from it. The Mac is the only machine that holds the whole history, so
 * it has to be able to answer two questions:
 *
 *   1. **What is there?** `listHistory` — every session this Mac can still produce frames for,
 *      whether or not it ever streamed them. Three sources, merged by session id: the journal
 *      (sessions this bridge has already framed), the Claude transcripts on disk (sessions
 *      started before Pagr was installed, or in a folder that was registered later), and the
 *      Codex app-server's `thread/list`.
 *   2. **Give me frames N to M.** `backfill` — re-sealed out of the journal when the journal has
 *      them, and out of the provider's own record when it does not, in which case the journal is
 *      built first so the same request twice costs one replay, not two.
 *
 * Three rules that are not negotiable:
 *
 *   - **A backfill never invents a `seq`.** Seqs come from the journal and only from the journal
 *     (`journal.ts`), so a replayed transcript is journaled first and streamed second. That is
 *     what makes "the phone has everything up to 412" still true after a backfill.
 *   - **One at a time.** A backfill reads files, allocates seqs and seals; two at once on one Mac
 *     would interleave with live traffic and with each other. The second request is refused
 *     (`rate_limited`), not queued — a phone that asked twice gets a fast honest answer.
 *   - **Nothing new leaves the Mac.** Backfill reads exactly the files the transcript mirror
 *     already reads and the bodies are sealed exactly as live frames are. What changes is *when*
 *     they are sent, never *what* the cloud can see.
 */

// ---------- limits ----------

/** Longest history window a request may ask for. */
export const MAX_HISTORY_DAYS = 365;
/** Default window when the request does not say. */
export const DEFAULT_HISTORY_DAYS = 30;
/** Most sessions one `session.list_history` answers with. */
export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Default byte budget for one backfill, and the ceiling a caller may raise it to.
 *
 * These bound the WORK, not the wire: the `session.backfill` command schema caps what a phone may
 * ask for far lower (1 MiB by default, 8 MiB at most), and a command is clamped by its own schema
 * before it reaches here. The larger numbers are for the local trigger — `pagr sessions backfill`
 * on the Mac itself, where the frames are going to a socket on the same machine.
 */
export const DEFAULT_BACKFILL_BYTES = 16 * 1024 * 1024;
export const MAX_BACKFILL_BYTES = 64 * 1024 * 1024;

/** Frames between `session.event progress` reports. */
export const BACKFILL_PROGRESS_EVERY = 100;

/** Journal entries read from disk at once while streaming. Bounds peak memory on a huge session. */
export const BACKFILL_READ_CHUNK = 200;

/**
 * Bytes read from each end of a transcript when indexing history.
 *
 * History needs five small facts out of a file that can be hundreds of megabytes — the session
 * id, the working directory, the first timestamp and whatever the session is called. All of them
 * are near one end or the other, and reading the middle of every transcript on a Mac with a
 * thousand sessions is how a "list my history" tap turns into a minute of disk.
 */
export const HISTORY_SCAN_BYTES = 128 * 1024;

// ---------- ids ----------

/**
 * The same `ses_…` the daemon mints for a hook-adopted session and the mirror mints for a tailed
 * one (`syntheticSessionId` in `daemon.ts`, `syntheticClaudeSessionId` in the Claude adapter), so
 * a session found three ways is ONE session on the phone.
 *
 * Duplicated rather than imported because importing `daemon.ts` from here would close a cycle
 * (daemon → dispatcher → backfill), and because it is a wire-visible identity: if the minting ever
 * changes, this must fail a test rather than follow it silently. `backfill.test.ts` asserts the
 * three agree.
 */
export function historySessionId(provider: Provider, providerSessionId: string): string {
  return `ses_${createHash('sha256').update(`${provider}:${providerSessionId}`).digest('hex').slice(0, 32)}`;
}

// ---------- sources ----------

/** One frame a source can replay, before the journal has given it a seq. */
export interface ReplayFrame {
  body: FrameBody;
  /** `source` is overwritten with `backfill`: these frames are a replay, and say so. */
  meta: Omit<JournalMeta, 'source'> & { source?: JournalMeta['source'] };
  /** The provider's own id, so replaying a session the bridge already streamed costs no frames. */
  providerRecordId?: string;
  at?: string;
}

/** A session this Mac can describe, before it is merged with what the journal and the store know. */
export interface DiscoveredSession {
  /** `ses_…`, minted by `historySessionId` from the provider's own id. */
  sessionId: string;
  /** The provider's own id — a Claude session uuid, a Codex thread id. LOCAL ONLY. */
  providerSessionId: string;
  provider: Provider;
  /** The session's working directory, when the source knows it. Local only, never sent. */
  cwd?: string;
  displayName?: string;
  taskSummary?: string;
  startedAt: string;
  updatedAt: string;
  origin: NonNullable<SessionSummaryV2['origin']>;
}

/**
 * Somewhere a session's history can be read from: the Claude transcripts, the Codex app-server.
 *
 * The journal is not a source — it is the destination every source is replayed into, and the only
 * thing that allocates a `seq`.
 */
export interface BackfillSource {
  provider: Provider;
  /** Sessions this source can see, no older than `since`. Never throws at its caller. */
  list(since: Date): Promise<DiscoveredSession[]>;
  /**
   * Every frame of one session, in order, for the journal to number. Null when this source has
   * nothing for that id — which is normal: each source is asked about every unknown session.
   */
  replay(session: DiscoveredSession): Promise<ReplayFrame[] | null>;
}

// ---------- the guard ----------

/**
 * One backfill at a time on this Mac.
 *
 * Not a queue. A backfill competes with live frames for the socket, for the disk and for the
 * journal's append lock, and a phone that fires two requests because the first looked slow should
 * be told so rather than made to wait twice as long for both.
 */
export class BackfillGuard {
  private held: string | null = null;

  get busy(): boolean {
    return this.held !== null;
  }

  /** The session a backfill is running for, or null. */
  get holder(): string | null {
    return this.held;
  }

  /** Take the slot, or null when somebody already has it. The return value releases it. */
  take(sessionId: string): (() => void) | null {
    if (this.held !== null) return null;
    this.held = sessionId;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.held === sessionId) this.held = null;
    };
  }
}

export type BackfillErrorCode = 'unknown_session' | 'rate_limited' | 'invalid_payload';

export class BackfillError extends Error {
  constructor(
    readonly code: BackfillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackfillError';
  }
}

// ---------- the service ----------

export interface BackfillProgress {
  sessionId: string;
  projectId: string;
  provider: Provider;
  frames: number;
  bytes: number;
  lastSeq: number;
}

export interface BackfillResult {
  frames: number;
  bytes: number;
  /** Highest seq actually sent. `fromSeq - 1` when nothing was. */
  lastSeq: number;
  /** True when the budget stopped the stream before the requested range ended. */
  truncated: boolean;
}

export interface HistoryQuery {
  provider?: Provider;
  projectId?: string;
  sinceDays?: number;
  limit?: number;
}

export interface BackfillRequest {
  sessionId: string;
  fromSeq: number;
  toSeq?: number;
  maxBytes?: number;
}

export interface BackfillServiceOptions {
  journal: JournalStore;
  /** Re-seal one journaled entry into the events that carry it. Empty means nothing can be sent. */
  seal: (entry: JournalEntry) => DeviceEvent[];
  emit: (event: DeviceEvent) => void;
  /** A live session's own summary, which always wins over anything history can infer. */
  live?: (sessionId: string) => SessionSummaryV2 | null;
  /** What this Mac already recorded about a session, live or adopted. */
  record?: (sessionId: string) => SessionRecord | null;
  /** `$HOME` holding `.claude`. Null or absent turns the transcript source off. */
  claudeHome?: string | null;
  /** Which project a directory belongs to. Defaults to the daemon's mirror bridge. */
  projectFor?: (cwd: string) => MirrorProject | null;
  /** Codex and anything later. The Claude transcripts are built in (`claudeHome`). */
  sources?: BackfillSource[];
  /** Replay a Claude transcript into frames. Supplied by the Claude adapter; absent in tests. */
  replayTranscript?: (session: DiscoveredSession) => Promise<ReplayFrame[] | null>;
  /** Keep the Mac awake for the duration. Returns the release. */
  hold?: (reason: string) => () => void;
  /** Called every `BACKFILL_PROGRESS_EVERY` frames. */
  onProgress?: (p: BackfillProgress) => void;
  guard?: BackfillGuard;
  now?: () => Date;
  logger?: Logger;
}

export class BackfillService {
  readonly guard: BackfillGuard;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly o: BackfillServiceOptions) {
    this.guard = o.guard ?? new BackfillGuard();
    this.logger = o.logger ?? silentLogger;
    this.now = o.now ?? (() => new Date());
  }

  // ---------- listing ----------

  /**
   * Every session this Mac can still serve, newest first.
   *
   * A session appears here because the journal has frames for it, because Claude left a
   * transcript, or because Codex still lists the thread — and the same session found three ways
   * is one row, because all three mint the same `ses_…` from the provider's own id.
   *
   * A session that is live right now is described by its own summary rather than by anything
   * inferred from a file: the live path knows its control level and the history path cannot. One
   * that is not live is `controlLevel: 'none'` — reading a finished transcript does not let Pagr
   * do anything with it, and saying otherwise would put a dead "send" button on the phone.
   */
  async listHistory(q: HistoryQuery = {}): Promise<SessionSummaryV2[]> {
    const days = clamp(q.sinceDays ?? DEFAULT_HISTORY_DAYS, 1, MAX_HISTORY_DAYS);
    const limit = clamp(q.limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
    const since = new Date(this.now().getTime() - days * 24 * 3600_000);

    const found = new Map<string, DiscoveredSession>();
    const add = (s: DiscoveredSession) => {
      const had = found.get(s.sessionId);
      found.set(s.sessionId, had ? mergeDiscovered(had, s) : s);
    };
    for (const s of this.discoverTranscripts(since)) add(s);
    for (const source of this.o.sources ?? []) {
      try {
        for (const s of await source.list(since)) add(s);
      } catch (err) {
        this.logger.warn('a history source could not be listed', {
          provider: source.provider,
          error: String(err),
        });
      }
    }
    for (const s of this.discoverJournal(since)) add(s);

    const out: SessionSummaryV2[] = [];
    for (const s of found.values()) {
      const summary = this.summarise(s);
      if (!summary) continue;
      if (q.provider && summary.provider !== q.provider) continue;
      if (q.projectId && summary.projectId !== q.projectId) continue;
      out.push(summary);
    }
    out.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    return out.slice(0, limit);
  }

  /**
   * Sessions with a journal on disk.
   *
   * The journal's first line carries the provider and the project, which is the whole reason the
   * two routing fields are written into every line (`journal.ts`): a session can be described
   * from its transcript alone, without a session store that may have pruned the row months ago.
   */
  private discoverJournal(since: Date): DiscoveredSession[] {
    const out: DiscoveredSession[] = [];
    for (const sessionId of this.o.journal.sessionIds()) {
      let first: JournalEntry | undefined;
      let last: JournalEntry | undefined;
      try {
        const journal = this.o.journal.journal(sessionId);
        const firstSeq = journal.firstSequence();
        if (firstSeq === 0) continue;
        first = journal.read(firstSeq, firstSeq)[0];
        last = journal.read(journal.lastSeq(), journal.lastSeq())[0];
      } catch (err) {
        this.logger.warn('could not read a journal while listing history', {
          sessionId,
          error: String(err),
        });
        continue;
      }
      if (!first) continue;
      const updatedAt = last?.at ?? first.at;
      if ((Date.parse(updatedAt) || 0) < since.getTime()) continue;
      out.push({
        sessionId,
        // The journal knows the frame's session, not the provider's own id for it. A source that
        // does know contributes it through the merge; nothing here needs it.
        providerSessionId: this.o.record?.(sessionId)?.providerSessionId ?? '',
        provider: first.provider,
        startedAt: first.at,
        updatedAt,
        origin: this.o.record?.(sessionId)?.adopted ? 'terminal' : 'pagr',
      });
    }
    return out;
  }

  /** Claude sessions with a transcript on disk, whether or not this bridge ever saw them. */
  private discoverTranscripts(since: Date): DiscoveredSession[] {
    const home = this.o.claudeHome;
    if (!home) return [];
    const out: DiscoveredSession[] = [];
    for (const t of scanClaudeTranscripts(home, since)) {
      out.push({
        sessionId: historySessionId('claude', t.claudeSessionId),
        providerSessionId: t.claudeSessionId,
        provider: 'claude',
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...(t.title ? { displayName: t.title } : {}),
        startedAt: t.startedAt,
        updatedAt: t.updatedAt,
        origin: 'terminal',
      });
    }
    return out;
  }

  /**
   * One discovered session as the phone sees it.
   *
   * Returns null for a session in a directory no project covers: a `SessionSummary` has to name a
   * `proj_…` id, so such a session stays local — it is listed by `pagr sessions`, never sent.
   */
  private summarise(s: DiscoveredSession): SessionSummaryV2 | null {
    const live = this.o.live?.(s.sessionId);
    if (live)
      return { ...live, ...(live.lastSeq === undefined ? this.lastSeqOf(s.sessionId) : {}) };

    const rec = this.o.record?.(s.sessionId) ?? null;
    const cwd = s.cwd ?? rec?.cwd;
    const project = cwd ? this.projectFor(cwd) : null;
    const projectId = project?.projectId ?? rec?.projectId ?? '';
    if (!projectId) return null;
    return {
      sessionId: s.sessionId,
      projectId,
      provider: s.provider,
      // Never a live status. This session is not running as far as anything here knows, and a
      // history row that claims `working` would hold a working tree and this Mac's power
      // assertion against a session nobody can see.
      status: 'idle',
      activeTurn: false,
      ...(s.displayName ? { displayName: s.displayName.slice(0, 120) } : {}),
      ...(s.taskSummary ? { taskSummary: s.taskSummary.slice(0, 500) } : {}),
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      // Not live, so there is nothing Pagr may do with it beyond show it.
      controlLevel: 'none',
      origin: s.origin,
      ...(project ? { projectStatus: project.status } : {}),
      ...(project?.handle ? { repoHandle: project.handle } : {}),
      ...this.lastSeqOf(s.sessionId),
    };
  }

  private lastSeqOf(sessionId: string): { lastSeq?: number } {
    try {
      const lastSeq = this.o.journal.lastSeq(sessionId);
      return lastSeq > 0 ? { lastSeq } : {};
    } catch {
      return {};
    }
  }

  private projectFor(cwd: string): MirrorProject | null {
    const ask = this.o.projectFor ?? ((p: string) => getMirrorBridge().projectFor(p));
    try {
      return ask(cwd);
    } catch {
      return null;
    }
  }

  // ---------- backfilling ----------

  /**
   * Stream journaled frames from `fromSeq`, building the journal first when it is empty.
   *
   * The two halves are deliberately not one step. Replaying a transcript ALLOCATES SEQS, and seqs
   * are permanent: once a session's transcript has been journaled, every later backfill of it —
   * and every resume — answers with the same numbers and the same bodies. A phone that asks for
   * 1–500 twice gets the same 500 frames both times, which is the property the whole cursor
   * scheme rests on.
   */
  async backfill(req: BackfillRequest): Promise<BackfillResult> {
    const fromSeq = Math.max(1, Math.floor(req.fromSeq));
    const toSeq = req.toSeq === undefined ? undefined : Math.floor(req.toSeq);
    if (toSeq !== undefined && toSeq < fromSeq)
      throw new BackfillError('invalid_payload', 'toSeq is before fromSeq');
    const maxBytes = clamp(req.maxBytes ?? DEFAULT_BACKFILL_BYTES, 1, MAX_BACKFILL_BYTES);

    const release = this.guard.take(req.sessionId);
    if (!release)
      throw new BackfillError(
        'rate_limited',
        `a backfill is already running on this Mac (${this.guard.holder}); try again when it finishes`,
      );
    const unhold = this.o.hold?.('backfill') ?? (() => {});
    try {
      if (this.o.journal.lastSeq(req.sessionId) === 0) await this.build(req.sessionId);
      const last = this.o.journal.lastSeq(req.sessionId);
      if (last === 0)
        throw new BackfillError(
          'unknown_session',
          'this Mac has no transcript for that session, and no provider could replay one',
        );
      return this.stream(req.sessionId, fromSeq, toSeq ?? last, maxBytes);
    } finally {
      unhold();
      release();
    }
  }

  /**
   * Journal a session this bridge never streamed, by replaying the provider's own record.
   *
   * Every source is asked, because a session id says which provider it came from only once one of
   * them claims it. Frames are appended with their `providerRecordId`, so a session that was
   * partly streamed live and then backfilled does not grow a second copy of the overlap — the
   * journal's dedupe is what makes replaying "the whole file" the safe thing to do.
   */
  private async build(sessionId: string): Promise<void> {
    const since = new Date(0);
    const candidates: Array<{ source: BackfillSource | null; session: DiscoveredSession }> = [];
    for (const s of this.discoverTranscripts(since))
      if (s.sessionId === sessionId) candidates.push({ source: null, session: s });
    for (const source of this.o.sources ?? []) {
      try {
        for (const s of await source.list(since))
          if (s.sessionId === sessionId) candidates.push({ source, session: s });
      } catch (err) {
        this.logger.warn('a history source could not be listed for a backfill', {
          provider: source.provider,
          error: String(err),
        });
      }
    }

    for (const { source, session } of candidates) {
      let frames: ReplayFrame[] | null = null;
      try {
        frames = source
          ? await source.replay(session)
          : ((await this.o.replayTranscript?.(session)) ?? null);
      } catch (err) {
        this.logger.warn('could not replay a session for a backfill', {
          sessionId,
          error: String(err),
        });
        continue;
      }
      if (!frames || frames.length === 0) continue;
      const project = session.cwd ? this.projectFor(session.cwd) : null;
      const projectId = project?.projectId ?? this.o.record?.(sessionId)?.projectId ?? '';
      if (!projectId) {
        // Nothing inside a directory no project covers is journaled. Same rule as the mirror's.
        this.logger.info('refusing to journal a backfill for an unregistered directory', {
          sessionId,
        });
        return;
      }
      let journaled = 0;
      for (const f of frames) {
        const res = this.o.journal.append(sessionId, f.body, {
          projectId,
          provider: session.provider,
          meta: { ...f.meta, source: 'backfill' },
          ...(f.providerRecordId ? { providerRecordId: f.providerRecordId } : {}),
          ...(f.at ? { at: f.at } : {}),
        });
        if (!res.duplicate) journaled++;
      }
      this.o.journal.journal(sessionId).flush();
      this.logger.info('built a session journal from the provider’s own record', {
        sessionId,
        provider: session.provider,
        frames: journaled,
        replayed: frames.length,
      });
      return;
    }
  }

  /** Re-seal and send `[fromSeq, toSeq]`, stopping on the byte budget. */
  private stream(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    maxBytes: number,
  ): BackfillResult {
    let frames = 0;
    let bytes = 0;
    let lastSeq = fromSeq - 1;
    let truncated = false;
    let projectId = '';
    let provider: Provider = 'claude';

    for (let at = fromSeq; at <= toSeq && !truncated; at += BACKFILL_READ_CHUNK) {
      const upto = Math.min(at + BACKFILL_READ_CHUNK - 1, toSeq);
      const entries = this.o.journal.read(sessionId, at, upto);
      for (const entry of entries) {
        projectId = entry.projectId;
        provider = entry.provider;
        const events = this.o.seal(backfilled(entry));
        const cost = events.reduce(
          (n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8'),
          // A frame nothing can be sealed for still costs its body: the budget has to shrink or
          // a journal that cannot be sent would loop forever reporting no progress.
          events.length === 0 ? frameBodyBytes(entry.body) : 0,
        );
        // Always send at least one frame: a budget smaller than the first frame would otherwise
        // return "nothing, and there is more", which no phone can make progress from.
        if (frames > 0 && bytes + cost > maxBytes) {
          truncated = true;
          break;
        }
        for (const e of events) this.o.emit(e);
        frames++;
        bytes += cost;
        lastSeq = entry.seq;
        if (frames % BACKFILL_PROGRESS_EVERY === 0)
          this.o.onProgress?.({ sessionId, projectId, provider, frames, bytes, lastSeq });
      }
    }
    if (!truncated && lastSeq < toSeq && this.o.journal.lastSeq(sessionId) > lastSeq)
      truncated = true;
    if (frames > 0 && frames % BACKFILL_PROGRESS_EVERY !== 0)
      this.o.onProgress?.({ sessionId, projectId, provider, frames, bytes, lastSeq });
    this.logger.info('backfilled a session', { sessionId, frames, bytes, lastSeq, truncated });
    return { frames, bytes, lastSeq, truncated };
  }
}

/** The same entry, stamped as a replay. The phone renders it identically; the cloud can tell. */
const backfilled = (entry: JournalEntry): JournalEntry => ({
  ...entry,
  meta: { ...entry.meta, source: 'backfill' },
});

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));

function mergeDiscovered(a: DiscoveredSession, b: DiscoveredSession): DiscoveredSession {
  const earlier = (x: string, y: string) => ((Date.parse(x) || 0) <= (Date.parse(y) || 0) ? x : y);
  const later = (x: string, y: string) => ((Date.parse(x) || 0) >= (Date.parse(y) || 0) ? x : y);
  return {
    ...a,
    ...b,
    // A field one source knows and the other does not must survive the merge in either order.
    providerSessionId: b.providerSessionId || a.providerSessionId,
    ...((a.cwd ?? b.cwd) ? { cwd: b.cwd ?? a.cwd } : {}),
    ...((a.displayName ?? b.displayName) ? { displayName: b.displayName ?? a.displayName } : {}),
    ...((a.taskSummary ?? b.taskSummary) ? { taskSummary: b.taskSummary ?? a.taskSummary } : {}),
    startedAt: earlier(a.startedAt, b.startedAt),
    updatedAt: later(a.updatedAt, b.updatedAt),
  };
}

// ---------- the Claude transcript index ----------

/** What one Claude session's transcripts say about themselves, before it becomes a summary. */
export interface TranscriptHistoryEntry {
  claudeSessionId: string;
  /** Every file that is part of this session: the live one and its superseded variants. */
  files: string[];
  cwd?: string;
  title?: string;
  startedAt: string;
  updatedAt: string;
}

/** A transcript file name Claude writes, excluding a subagent's own (`agent-<id>.jsonl`). */
function transcriptSessionId(fileName: string): string | null {
  if (fileName.startsWith('agent-')) return null;
  const m = /^([0-9a-fA-F-]{8,})\.jsonl(?:\.superseded-.+)?$/.exec(fileName);
  return m?.[1] ?? null;
}

/**
 * Index `~/.claude/projects/*` into one entry per session.
 *
 * The directory name is Claude's lossy encoding of a working tree and is never decoded: the `cwd`
 * comes out of the records, exactly as everywhere else in this bridge. Superseded and orphaned
 * variants of one session are folded into that session — they are the same conversation, and
 * showing a person four rows for one afternoon is a bug, not extra information.
 *
 * `memory/`, `subagents/` and every other nested directory are skipped: a subagent's transcript is
 * part of its parent session, not a session of its own, and `memory/` is Claude's own notes.
 */
export function scanClaudeTranscripts(home: string, since: Date): TranscriptHistoryEntry[] {
  const root = join(home, '.claude', 'projects');
  const bySession = new Map<string, TranscriptHistoryEntry>();
  for (const projectDir of readdirSafe(root)) {
    if (projectDir === 'memory') continue;
    const dir = join(root, projectDir);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const name of readdirSafe(dir)) {
      const claudeSessionId = transcriptSessionId(name);
      if (!claudeSessionId) continue;
      const file = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      if (st.mtimeMs < since.getTime()) continue;
      const facts = readTranscriptFacts(file, st.size);
      const startedAt = new Date(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs)).toISOString();
      const updatedAt = new Date(st.mtimeMs).toISOString();
      const had = bySession.get(claudeSessionId);
      if (!had) {
        bySession.set(claudeSessionId, {
          claudeSessionId,
          files: [file],
          ...(facts.cwd ? { cwd: facts.cwd } : {}),
          ...(facts.title ? { title: facts.title } : {}),
          startedAt,
          updatedAt,
        });
        continue;
      }
      had.files.push(file);
      if (!had.cwd && facts.cwd) had.cwd = facts.cwd;
      // A title from any variant counts: the live file often has none and the one it replaced does.
      if (facts.title) had.title = facts.title;
      if (Date.parse(startedAt) < Date.parse(had.startedAt)) had.startedAt = startedAt;
      if (Date.parse(updatedAt) > Date.parse(had.updatedAt)) had.updatedAt = updatedAt;
    }
  }
  for (const e of bySession.values())
    e.files.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [...bySession.values()];
}

interface TranscriptFacts {
  cwd?: string;
  title?: string;
}

/**
 * The few fields history needs, read from both ends of the file.
 *
 * Title precedence is what Claude itself shows: a title the person set (`custom-title`) beats a
 * name an agent was given (`agent-name`), which beats the model's own one-line `summary`.
 */
function readTranscriptFacts(file: string, size: number): TranscriptFacts {
  const facts: TranscriptFacts = {};
  let best = 0; // 1 summary, 2 agent-name, 3 custom-title
  for (const text of readEnds(file, size)) {
    for (const line of text.split('\n')) {
      if (line.length < 2 || !line.startsWith('{')) continue;
      let raw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        raw = parsed as Record<string, unknown>;
      } catch {
        continue; // a half line at the cut, or a line this version cannot read
      }
      if (!facts.cwd && typeof raw.cwd === 'string' && raw.cwd) facts.cwd = raw.cwd;
      const rank =
        raw.type === 'custom-title'
          ? 3
          : raw.type === 'agent-name'
            ? 2
            : raw.type === 'summary'
              ? 1
              : 0;
      if (rank <= best) continue;
      const title = str(raw.title) ?? str(raw.customTitle) ?? str(raw.name) ?? str(raw.summary);
      if (!title?.trim()) continue;
      facts.title = title.trim();
      best = rank;
    }
  }
  return facts;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The first and last `HISTORY_SCAN_BYTES` of a file, or the whole thing when it is smaller. */
function readEnds(file: string, size: number): string[] {
  const read = (at: number, count: number): string => {
    if (count <= 0) return '';
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(count);
      const n = readSync(fd, buf, 0, count, at);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  };
  try {
    if (size <= HISTORY_SCAN_BYTES * 2) return [read(0, size)];
    return [read(0, HISTORY_SCAN_BYTES), read(size - HISTORY_SCAN_BYTES, HISTORY_SCAN_BYTES)];
  } catch {
    return [];
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
