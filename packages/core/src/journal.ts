import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { FrameKind, type FrameMeta, Provider } from '@pagr/protocol';
import { z } from 'zod';
import { FrameBody } from './frames.js';
import { readJson, writeJson } from './jsonFile.js';
import { type Logger, silentLogger } from './logging.js';

/**
 * The session journal: every frame this Mac produced, in full, on this Mac's own disk.
 *
 * Three jobs, and they are all consequences of one decision — the bridge, not the cloud, owns the
 * transcript:
 *
 *   1. **`seq` lives here.** A frame's sequence number is allocated by `append` and nowhere else,
 *      which is what makes "the phone has everything up to 412" a statement with a meaning.
 *   2. **Journaled before sent.** A frame is on disk before it is sealed, so a socket that dies
 *      mid-turn costs a re-send, never a hole in the transcript.
 *   3. **The whole body.** The wire carries a capped, chunked view (`frames.ts`); the journal
 *      keeps what actually happened, which is what `session.backfill` serves later.
 *
 * Format: NDJSON at `<dir>/<sessionId>.log`, 0600 inside a 0700 directory, one object per line —
 * `{seq, at, kind, projectId, provider, providerRecordId?, meta, body}`. The shared contract names
 * `{seq, at, kind, meta, body}`; the two routing fields are here as well so a resume can rebuild
 * the `session.frame` event from the line alone, without asking a session store that may have
 * pruned the row.
 *
 * Alongside it, `<sessionId>.idx`: fixed 16-byte records of `(seq, byteOffset)`, little-endian, so
 * reading from seq 9,000 is a seek rather than a scan. It is a CACHE — every check it fails is
 * answered by rebuilding it from the log, never by refusing to read.
 */

// ---------- records ----------

/** Plaintext facts about a frame, minus the three the wire computes per send. */
export type JournalMeta = Omit<FrameMeta, 'bytes' | 'truncated' | 'chunk'>;

const JournalLine = z.object({
  seq: z.number().int().positive(),
  at: z.string().min(1),
  kind: FrameKind,
  projectId: z.string().min(1),
  provider: Provider,
  providerRecordId: z.string().min(1).optional(),
  meta: z.record(z.unknown()),
  body: FrameBody,
});

export interface JournalEntry {
  /** The session the line belongs to. Not stored in the line — it is the file's name. */
  sessionId: string;
  seq: number;
  at: string;
  kind: FrameBody['kind'];
  projectId: string;
  provider: z.infer<typeof Provider>;
  providerRecordId?: string;
  meta: JournalMeta;
  body: FrameBody;
}

/** What a caller supplies; `seq` and `at` are the journal's to allocate. */
export interface AppendInput {
  projectId: string;
  provider: z.infer<typeof Provider>;
  meta: JournalMeta;
  /** The provider's own id for this record. A second append under the same id is a no-op. */
  providerRecordId?: string;
  /** Overrides the journal's clock. */
  at?: string;
}

export interface AppendResult {
  seq: number;
  at: string;
  /** True when `providerRecordId` had already been journaled: no seq was allocated. */
  duplicate: boolean;
}

// ---------- tuning ----------

/** Frames buffered before an fsync, whatever the timer says. */
export const FSYNC_EVERY_FRAMES = 64;
/** Longest a frame may sit un-fsynced. */
export const FSYNC_EVERY_MS = 250;
/** `providerRecordId`s remembered per session. A re-tail replays the recent tail, not the year. */
export const DEDUPE_WINDOW = 2048;
/** Open log handles a `JournalStore` keeps before closing the least recently used one. */
export const MAX_OPEN_JOURNALS = 32;
/** Default retention for `prune`. */
export const JOURNAL_RETENTION_DAYS = 30;
/** Default ceiling for `prune`, across every session. */
export const JOURNAL_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const IDX_RECORD_BYTES = 16;

export interface SessionJournalOptions {
  dir: string;
  sessionId: string;
  now?: () => Date;
  logger?: Logger;
  fsyncEveryFrames?: number;
  fsyncEveryMs?: number;
  dedupeWindow?: number;
}

/** Why an index was thrown away and rebuilt. Surfaced in the log, and asserted in tests. */
export type IndexRebuildReason =
  | 'missing'
  | 'ragged'
  | 'short'
  | 'out-of-range'
  | 'mismatch'
  | 'unordered';

export class SessionJournal {
  readonly sessionId: string;
  readonly logPath: string;
  readonly indexPath: string;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly fsyncEveryFrames: number;
  private readonly fsyncEveryMs: number;
  private readonly dedupeWindow: number;

  private logFd: number | null = null;
  private idxFd: number | null = null;
  /** Byte offset of each entry, densely indexed: `offsets[i]` is seq `firstSeq + i`. */
  private offsets: number[] = [];
  private firstSeq = 0;
  private size = 0;
  private unsynced = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  /** `providerRecordId → seq`, insertion-ordered so the oldest is the one that falls out. */
  private readonly seen = new Map<string, number>();
  /** Set when the index was rebuilt on open; read by tests and the logs. */
  lastRebuild: IndexRebuildReason | null = null;

  constructor(o: SessionJournalOptions) {
    this.sessionId = o.sessionId;
    this.logPath = join(o.dir, `${o.sessionId}.log`);
    this.indexPath = join(o.dir, `${o.sessionId}.idx`);
    this.now = o.now ?? (() => new Date());
    this.logger = o.logger ?? silentLogger;
    this.fsyncEveryFrames = o.fsyncEveryFrames ?? FSYNC_EVERY_FRAMES;
    this.fsyncEveryMs = o.fsyncEveryMs ?? FSYNC_EVERY_MS;
    this.dedupeWindow = o.dedupeWindow ?? DEDUPE_WINDOW;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  // ---------- reading ----------

  /** Highest seq allocated so far; 0 when the session has no frames. */
  lastSeq(): number {
    return this.offsets.length === 0 ? 0 : this.firstSeq + this.offsets.length - 1;
  }

  /** Lowest seq still on disk; 0 when empty. Below this, only a backfill can help. */
  firstSequence(): number {
    return this.offsets.length === 0 ? 0 : this.firstSeq;
  }

  /** Bytes the log occupies. */
  byteLength(): number {
    return this.size;
  }

  /** Entries with `fromSeq ≤ seq ≤ toSeq`, in order. Missing seqs are simply absent. */
  read(fromSeq: number, toSeq?: number): JournalEntry[] {
    if (this.offsets.length === 0) return [];
    const from = Math.max(fromSeq, this.firstSeq);
    const to = Math.min(toSeq ?? this.lastSeq(), this.lastSeq());
    if (to < from) return [];
    const start = this.offsets[from - this.firstSeq] as number;
    const endIdx = to - this.firstSeq + 1;
    const end = endIdx < this.offsets.length ? (this.offsets[endIdx] as number) : this.size;
    const text = this.readRange(start, end - start);
    const out: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry = parseLine(this.sessionId, line);
      if (entry) out.push(entry);
      else this.logger.warn('skipping an unreadable journal line', { sessionId: this.sessionId });
    }
    return out;
  }

  // ---------- writing ----------

  /**
   * Journal one frame and return the seq it was given.
   *
   * A record the provider has already handed us — the same transcript line read twice after a
   * restart, the same tool result seen on stdio and again on disk — returns the seq it got the
   * first time with `duplicate: true`. That is what stops a re-tail from inventing a second copy
   * of a message on the phone.
   */
  append(body: FrameBody, input: AppendInput): AppendResult {
    const at = input.at ?? this.now().toISOString();
    if (input.providerRecordId) {
      const had = this.seen.get(input.providerRecordId);
      if (had !== undefined) return { seq: had, at, duplicate: true };
    }
    const seq = this.lastSeq() + 1;
    const line = Buffer.from(
      `${JSON.stringify({
        seq,
        at,
        kind: body.kind,
        projectId: input.projectId,
        provider: input.provider,
        ...(input.providerRecordId ? { providerRecordId: input.providerRecordId } : {}),
        meta: input.meta,
        body,
      })}\n`,
      'utf8',
    );
    const offset = this.size;
    writeSync(this.log(), line);
    writeSync(this.idx(), idxRecord(seq, offset));
    if (this.offsets.length === 0) this.firstSeq = seq;
    this.offsets.push(offset);
    this.size += line.byteLength;
    if (input.providerRecordId) this.remember(input.providerRecordId, seq);
    this.unsynced++;
    if (this.unsynced >= this.fsyncEveryFrames) this.flush();
    else this.scheduleFlush();
    return { seq, at, duplicate: false };
  }

  /**
   * Force both files to disk.
   *
   * Batched rather than per-frame because a busy agent produces frames faster than a disk will
   * take one fsync each, and the thing being protected against is a crash, not a torn write: the
   * log is append-only and a partial last line is detected and dropped on the next open.
   */
  flush(): void {
    this.clearTimer();
    if (this.unsynced === 0) return;
    this.unsynced = 0;
    try {
      if (this.logFd !== null) fsyncSync(this.logFd);
      if (this.idxFd !== null) fsyncSync(this.idxFd);
    } catch (err) {
      this.logger.warn('journal fsync failed', { sessionId: this.sessionId, error: String(err) });
    }
  }

  close(): void {
    this.flush();
    if (this.logFd !== null) closeSync(this.logFd);
    if (this.idxFd !== null) closeSync(this.idxFd);
    this.logFd = null;
    this.idxFd = null;
  }

  // ---------- internals ----------

  private log(): number {
    if (this.logFd === null) this.logFd = openSync(this.logPath, 'a', 0o600);
    return this.logFd;
  }

  private idx(): number {
    if (this.idxFd === null) this.idxFd = openSync(this.indexPath, 'a', 0o600);
    return this.idxFd;
  }

  private scheduleFlush(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.flush();
    }, this.fsyncEveryMs);
    this.syncTimer.unref();
  }

  private clearTimer(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private remember(providerRecordId: string, seq: number): void {
    this.seen.set(providerRecordId, seq);
    while (this.seen.size > this.dedupeWindow) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  private readRange(at: number, count: number): string {
    if (count <= 0) return '';
    const fd = openSync(this.logPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(count);
      const read = readSync(fd, buf, 0, count, at);
      return buf.toString('utf8', 0, read);
    } finally {
      closeSync(fd);
    }
  }

  /** Open the pair, validate the index, rebuild it if it does not describe the log. */
  private load(): void {
    this.size = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    if (this.size === 0) {
      this.offsets = [];
      this.firstSeq = 0;
      if (existsSync(this.indexPath)) rmSync(this.indexPath, { force: true });
      return;
    }
    const reason = this.loadIndex();
    if (reason) {
      this.lastRebuild = reason;
      this.logger.warn('rebuilding the session journal index', {
        sessionId: this.sessionId,
        reason,
      });
      this.rebuildIndex();
    }
    this.primeDedupe();
  }

  /** Read the sidecar; return why it cannot be trusted, or null when it can. */
  private loadIndex(): IndexRebuildReason | null {
    if (!existsSync(this.indexPath)) return 'missing';
    const stat = statSync(this.indexPath);
    if (stat.size === 0) return 'missing';
    if (stat.size % IDX_RECORD_BYTES !== 0) return 'ragged';
    const buf = Buffer.allocUnsafe(stat.size);
    const fd = openSync(this.indexPath, 'r');
    try {
      readSync(fd, buf, 0, stat.size, 0);
    } finally {
      closeSync(fd);
    }
    const count = stat.size / IDX_RECORD_BYTES;
    const offsets: number[] = [];
    let first = 0;
    for (let i = 0; i < count; i++) {
      const seq = Number(buf.readBigUInt64LE(i * IDX_RECORD_BYTES));
      const offset = Number(buf.readBigUInt64LE(i * IDX_RECORD_BYTES + 8));
      if (i === 0) first = seq;
      // Seqs are dense and offsets strictly increase: anything else is a damaged sidecar.
      if (seq !== first + i) return 'unordered';
      if (offset >= this.size || (i > 0 && offset <= (offsets[i - 1] as number)))
        return 'out-of-range';
      offsets.push(offset);
    }
    // The last record has to point at a line that really is that seq, or the log was appended to
    // by something that did not update the index (or truncated under it).
    const lastOffset = offsets[count - 1] as number;
    const tail = this.readRange(lastOffset, this.size - lastOffset).split('\n');
    const entry = parseLine(this.sessionId, tail[0] ?? '');
    if (!entry) return 'short';
    if (entry.seq !== first + count - 1) return 'mismatch';
    // Anything after the last indexed line means the log was appended to (or damaged) without
    // the sidecar being updated, so the sidecar no longer describes it.
    if (tail.slice(1).some((line) => line.trim() !== '')) return 'short';
    this.offsets = offsets;
    this.firstSeq = first;
    return null;
  }

  /**
   * Scan the log and write a fresh sidecar.
   *
   * A trailing partial line — the shape a crash mid-append leaves — is dropped and the log is
   * truncated back to the last complete entry, so the next append does not splice a new record
   * onto half of an old one.
   */
  private rebuildIndex(): void {
    const text = this.readRange(0, this.size);
    const offsets: number[] = [];
    let first = 0;
    let at = 0;
    let good = 0;
    let dropped = 0;
    for (const line of text.split('\n')) {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (line.trim() !== '') {
        const entry = parseLine(this.sessionId, line);
        if (entry && (offsets.length === 0 || entry.seq === first + offsets.length)) {
          if (offsets.length === 0) first = entry.seq;
          offsets.push(at);
          good = at + bytes + 1;
        } else dropped++;
      }
      at += bytes + 1;
    }
    if (dropped > 0)
      this.logger.warn('dropped unreadable journal lines while rebuilding the index', {
        sessionId: this.sessionId,
        dropped,
      });
    if (good < this.size) {
      if (this.logFd !== null) {
        closeSync(this.logFd);
        this.logFd = null;
      }
      truncateSync(this.logPath, good);
      this.size = good;
    }
    this.offsets = offsets;
    this.firstSeq = first;
    if (this.idxFd !== null) {
      closeSync(this.idxFd);
      this.idxFd = null;
    }
    rmSync(this.indexPath, { force: true });
    if (offsets.length > 0) {
      const buf = Buffer.allocUnsafe(offsets.length * IDX_RECORD_BYTES);
      offsets.forEach((offset, i) => {
        buf.writeBigUInt64LE(BigInt(first + i), i * IDX_RECORD_BYTES);
        buf.writeBigUInt64LE(BigInt(offset), i * IDX_RECORD_BYTES + 8);
      });
      writeSync(this.idx(), buf);
      this.unsynced = 1;
      this.flush();
    }
  }

  /**
   * Refill the dedupe window from the tail of the log.
   *
   * Without this, a restart is exactly the case the dedupe exists for: the tailer opens the
   * transcript again, re-reads the last records, and every one of them looks new.
   */
  private primeDedupe(): void {
    if (this.offsets.length === 0) return;
    const from = Math.max(this.firstSeq, this.lastSeq() - this.dedupeWindow + 1);
    for (const entry of this.read(from))
      if (entry.providerRecordId) this.seen.set(entry.providerRecordId, entry.seq);
  }
}

function idxRecord(seq: number, offset: number): Buffer {
  const buf = Buffer.allocUnsafe(IDX_RECORD_BYTES);
  buf.writeBigUInt64LE(BigInt(seq), 0);
  buf.writeBigUInt64LE(BigInt(offset), 8);
  return buf;
}

function parseLine(sessionId: string, line: string): JournalEntry | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = JournalLine.safeParse(json);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (d.kind !== d.body.kind) return null;
  return {
    sessionId,
    seq: d.seq,
    at: d.at,
    kind: d.body.kind,
    projectId: d.projectId,
    provider: d.provider,
    ...(d.providerRecordId ? { providerRecordId: d.providerRecordId } : {}),
    meta: d.meta as JournalMeta,
    body: d.body,
  };
}

// ---------- many sessions ----------

export interface JournalStoreOptions {
  dir: string;
  now?: () => Date;
  logger?: Logger;
  /** Open handles kept before the least recently used is closed. */
  maxOpen?: number;
  fsyncEveryFrames?: number;
  fsyncEveryMs?: number;
  dedupeWindow?: number;
}

export interface PruneOptions {
  days?: number;
  maxTotalBytes?: number;
}

export interface PruneResult {
  /** Session ids whose journal was deleted. Their outbox cursors should be forgotten too. */
  removed: string[];
  bytesFreed: number;
  /** Bytes still on disk afterwards. */
  totalBytes: number;
}

/**
 * Every session's journal, with a bounded number of files open at once.
 *
 * The LRU matters on a machine that has had a few thousand sessions: one file descriptor per
 * session, held forever, is how a daemon runs into `EMFILE` three weeks after anyone last looked
 * at it. Closing a journal loses nothing — `seq` is recovered from the index on the next open.
 */
export class JournalStore {
  readonly dir: string;
  private readonly open = new Map<string, SessionJournal>();
  private readonly o: JournalStoreOptions;
  private readonly logger: Logger;
  private readonly maxOpen: number;

  constructor(o: JournalStoreOptions) {
    this.o = o;
    this.dir = o.dir;
    this.logger = o.logger ?? silentLogger;
    this.maxOpen = o.maxOpen ?? MAX_OPEN_JOURNALS;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }

  journal(sessionId: string): SessionJournal {
    const had = this.open.get(sessionId);
    if (had) {
      // Re-insert so the map's own order is the LRU order.
      this.open.delete(sessionId);
      this.open.set(sessionId, had);
      return had;
    }
    const journal = new SessionJournal({
      dir: this.dir,
      sessionId,
      ...(this.o.now ? { now: this.o.now } : {}),
      logger: this.logger,
      ...(this.o.fsyncEveryFrames !== undefined
        ? { fsyncEveryFrames: this.o.fsyncEveryFrames }
        : {}),
      ...(this.o.fsyncEveryMs !== undefined ? { fsyncEveryMs: this.o.fsyncEveryMs } : {}),
      ...(this.o.dedupeWindow !== undefined ? { dedupeWindow: this.o.dedupeWindow } : {}),
    });
    this.open.set(sessionId, journal);
    while (this.open.size > this.maxOpen) {
      const oldest = this.open.keys().next();
      if (oldest.done || oldest.value === sessionId) break;
      this.open.get(oldest.value)?.close();
      this.open.delete(oldest.value);
    }
    return journal;
  }

  append(sessionId: string, body: FrameBody, input: AppendInput): AppendResult {
    return this.journal(sessionId).append(body, input);
  }

  read(sessionId: string, fromSeq: number, toSeq?: number): JournalEntry[] {
    return this.journal(sessionId).read(fromSeq, toSeq);
  }

  lastSeq(sessionId: string): number {
    return this.journal(sessionId).lastSeq();
  }

  /** Session ids with a journal on disk, whether or not they are open. */
  sessionIds(): string[] {
    return journalFiles(this.dir).map((f) => f.sessionId);
  }

  flushAll(): void {
    for (const j of this.open.values()) j.flush();
  }

  closeAll(): void {
    for (const j of this.open.values()) j.close();
    this.open.clear();
  }

  /**
   * Age and size retention, run on the daemon's hourly tick.
   *
   * Whole journals go, not lines inside them: a half-pruned session is a transcript with a hole
   * in the middle, which is worse than a session that is honestly gone. Anything currently open —
   * a live session — is never touched, because deleting a file out from under an append leaves
   * the daemon writing to an unlinked inode.
   */
  prune(opts: PruneOptions = {}): PruneResult {
    const days = opts.days ?? JOURNAL_RETENTION_DAYS;
    const maxTotalBytes = opts.maxTotalBytes ?? JOURNAL_MAX_TOTAL_BYTES;
    const now = (this.o.now ?? (() => new Date()))().getTime();
    const cutoff = now - days * 24 * 3600_000;
    const files = journalFiles(this.dir).filter((f) => !this.open.has(f.sessionId));
    const removed: string[] = [];
    let bytesFreed = 0;

    const drop = (f: JournalFile) => {
      rmSync(f.logPath, { force: true });
      rmSync(f.indexPath, { force: true });
      removed.push(f.sessionId);
      bytesFreed += f.bytes;
    };

    const kept: JournalFile[] = [];
    for (const f of files) {
      if (f.mtimeMs < cutoff) drop(f);
      else kept.push(f);
    }
    // Oldest first, so a size sweep takes the least useful history.
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = totalJournalBytes(this.dir);
    for (const f of kept) {
      if (total <= maxTotalBytes) break;
      drop(f);
      total -= f.bytes;
    }
    if (removed.length > 0)
      this.logger.info('pruned session journals', {
        sessions: removed.length,
        bytesFreed,
        retentionDays: days,
      });
    return { removed, bytesFreed, totalBytes: totalJournalBytes(this.dir) };
  }
}

interface JournalFile {
  sessionId: string;
  logPath: string;
  indexPath: string;
  bytes: number;
  mtimeMs: number;
}

function journalFiles(dir: string): JournalFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: JournalFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const sessionId = name.slice(0, -'.log'.length);
    const logPath = join(dir, name);
    const indexPath = join(dir, `${sessionId}.idx`);
    try {
      const st = statSync(logPath);
      let bytes = st.size;
      try {
        bytes += statSync(indexPath).size;
      } catch {
        // no sidecar yet
      }
      out.push({ sessionId, logPath, indexPath, bytes, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

const totalJournalBytes = (dir: string): number =>
  journalFiles(dir).reduce((n, f) => n + f.bytes, 0);

// ---------- outbox cursors ----------

/** What has been put on the wire for a session, and what the gateway has confirmed. */
export interface OutboxCursor {
  sent: number;
  acked: number;
}

export interface OutboxCursorsOptions {
  file: string;
  /** How long a change may sit before it is written. Default 250 ms. */
  writeDelayMs?: number;
  logger?: Logger;
}

/**
 * `~/.pagr/journal/outbox.json` — `{ sessionId: { sent, acked } }`.
 *
 * `acked` is the load-bearing half: it is what the gateway said it has persisted, and a frame is
 * only ever dropped from the resume set because of it. `sent` is an optimisation — losing it to a
 * crash costs a re-send of frames the gateway already holds, and the gateway de-duplicates on
 * `(session, seq, kind)`, so the write is debounced rather than synchronous.
 */
export class OutboxCursors {
  private readonly file: string;
  private readonly writeDelayMs: number;
  private readonly logger: Logger;
  private cursors: Record<string, OutboxCursor>;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(o: OutboxCursorsOptions) {
    this.file = o.file;
    this.writeDelayMs = o.writeDelayMs ?? 250;
    this.logger = o.logger ?? silentLogger;
    this.cursors = sanitise(readJson<Record<string, unknown>>(o.file, {}));
  }

  get(sessionId: string): OutboxCursor {
    return this.cursors[sessionId] ?? { sent: 0, acked: 0 };
  }

  all(): Record<string, OutboxCursor> {
    return Object.fromEntries(Object.entries(this.cursors).map(([k, v]) => [k, { ...v }]));
  }

  /** Record that everything up to `seq` has been handed to the socket. */
  noteSent(sessionId: string, seq: number): void {
    const cur = this.get(sessionId);
    if (seq <= cur.sent) return;
    this.cursors[sessionId] = { sent: seq, acked: cur.acked };
    this.touch();
  }

  /**
   * Apply a gateway `ack {cursors}` frame.
   *
   * Clamped to `sent`: a cursor ahead of anything this bridge has sent is either a different
   * device's frame or a bug on the other side, and either way it must not be allowed to mark
   * unsent frames as delivered.
   */
  ack(cursors: Record<string, number>): void {
    for (const [sessionId, seq] of Object.entries(cursors)) {
      if (!Number.isFinite(seq) || seq < 0) continue;
      const cur = this.get(sessionId);
      const acked = Math.max(cur.acked, Math.min(Math.floor(seq), cur.sent));
      if (acked === cur.acked) continue;
      this.cursors[sessionId] = { sent: cur.sent, acked };
      this.touch();
    }
  }

  /** Sessions the gateway is behind on, with the range to re-send. */
  pending(): Array<{ sessionId: string; fromSeq: number; toSeq: number }> {
    const out: Array<{ sessionId: string; fromSeq: number; toSeq: number }> = [];
    for (const [sessionId, c] of Object.entries(this.cursors))
      if (c.sent > c.acked) out.push({ sessionId, fromSeq: c.acked + 1, toSeq: c.sent });
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  forget(sessionId: string): void {
    if (!(sessionId in this.cursors)) return;
    delete this.cursors[sessionId];
    this.touch();
  }

  /** Write now, if anything changed. Called on shutdown and by tests. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeJson(this.file, this.cursors);
    } catch (err) {
      this.logger.warn('could not write the outbox cursors', { error: String(err) });
    }
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.writeDelayMs);
    this.timer.unref();
  }
}

function sanitise(raw: Record<string, unknown>): Record<string, OutboxCursor> {
  const out: Record<string, OutboxCursor> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    const v = value as Partial<OutboxCursor> | null;
    const sent = Number.isFinite(v?.sent) ? Math.max(0, Math.floor(v?.sent as number)) : 0;
    const acked = Number.isFinite(v?.acked) ? Math.max(0, Math.floor(v?.acked as number)) : 0;
    out[sessionId] = { sent, acked: Math.min(acked, sent) };
  }
  return out;
}

// ---------- doctor ----------

export interface JournalSessionStat {
  sessionId: string;
  bytes: number;
  updatedAt: string;
  sent: number;
  acked: number;
  /** Frames sent that the gateway has not confirmed. */
  behind: number;
}

export interface JournalStats {
  dir: string;
  exists: boolean;
  sessions: number;
  bytes: number;
  /** ISO timestamp of the oldest journal still on disk, or null when there are none. */
  oldestAt: string | null;
  /** Sessions the gateway has not caught up on, worst first. */
  lagging: JournalSessionStat[];
}

/**
 * Every journal on disk with its cursors, whether or not the gateway is behind on it.
 *
 * `journalStats` answers the doctor's question ("what is falling behind?"); this answers
 * `pagr sessions`' question ("how much history does each session have?"), which needs the rows
 * that are perfectly in sync as well. `behind` is 0 for those, not absent.
 */
export function journalSessions(
  dir: string,
  outboxFile = join(dir, 'outbox.json'),
): JournalSessionStat[] {
  const cursors = sanitise(readJson<Record<string, unknown>>(outboxFile, {}));
  return journalFiles(dir)
    .map((f) => {
      const c = cursors[f.sessionId] ?? { sent: 0, acked: 0 };
      return {
        sessionId: f.sessionId,
        bytes: f.bytes,
        updatedAt: new Date(f.mtimeMs).toISOString(),
        sent: c.sent,
        acked: c.acked,
        behind: Math.max(0, c.sent - c.acked),
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/**
 * What `pagr doctor` reports about the journal. Reads the files directly rather than asking the
 * daemon, because the question "how much of my own disk is this using" has to be answerable when
 * the daemon is not running.
 */
export function journalStats(dir: string, outboxFile = join(dir, 'outbox.json')): JournalStats {
  const files = journalFiles(dir);
  const cursors = sanitise(readJson<Record<string, unknown>>(outboxFile, {}));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const oldest = files.reduce<number | null>(
    (m, f) => (m === null || f.mtimeMs < m ? f.mtimeMs : m),
    null,
  );
  const lagging: JournalSessionStat[] = [];
  for (const f of files) {
    const c = cursors[f.sessionId] ?? { sent: 0, acked: 0 };
    if (c.sent <= c.acked) continue;
    lagging.push({
      sessionId: f.sessionId,
      bytes: f.bytes,
      updatedAt: new Date(f.mtimeMs).toISOString(),
      sent: c.sent,
      acked: c.acked,
      behind: c.sent - c.acked,
    });
  }
  lagging.sort((a, b) => b.behind - a.behind);
  return {
    dir,
    exists: existsSync(dir),
    sessions: files.length,
    bytes,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    lagging,
  };
}
