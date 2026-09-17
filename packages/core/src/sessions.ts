import type { Provider, SessionStatus } from '@pagr/protocol';
import { readJson, writeJson } from './jsonFile.js';

/**
 * The `projectId` of a session whose `cwd` is inside no project this Mac has registered.
 *
 * It is empty rather than absent because the session is still real: someone is running `claude`
 * in that directory right now and Pagr knows about it. What it cannot do is tell the cloud about
 * it — a `SessionSummary` has to name a `proj_…` id — so such a session is local-only until the
 * directory is registered with `pagr projects add`.
 */
export const UNREGISTERED_PROJECT = '';

/** True for a session the bridge did not start and cannot resume. */
export const isAdopted = (rec: SessionRecord): boolean => rec.adopted === true;

/** True for a session the cloud can be told about: it belongs to a registered project. */
export const isReportable = (rec: SessionRecord): boolean => rec.projectId !== UNREGISTERED_PROJECT;

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  /** `UNREGISTERED_PROJECT` for an adopted session outside every registered project. */
  projectId: string;
  providerSessionId: string;
  providerThreadId?: string;
  status: SessionStatus;
  /**
   * The bridge did not start this session; it learned about it because the provider's permission
   * hook asked the daemon a question. Pagr can relay its approvals and report that it exists. It
   * cannot send it an instruction, stop it, or resume it — the person's own terminal owns it.
   */
  adopted?: boolean;
  /** When this Mac first saw the session. Adopted sessions only. */
  adoptedAt?: string;
  /** The provider session's working directory, as the hook reported it. Adopted sessions only. */
  cwd?: string;
  /** Read-only sessions cannot corrupt a working tree, so they may share one (concurrency.ts). */
  readOnly?: boolean;
  /**
   * The project root this session occupies, recorded when it started. Kept so the working-tree
   * rule still holds after the project is unregistered — or removed and re-added under a new id.
   */
  projectPath?: string;
  startedAt: string;
  updatedAt: string;
}

const TERMINAL = new Set<SessionStatus>(['completed', 'failed', 'stopped']);

/**
 * Terminal sessions stay resumable for a week — comfortably past the cloud's 24h follow-up
 * window, and short enough that a busy machine's `sessions.json` stays small.
 */
export const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 3600_000;
/**
 * Hard ceiling on rows. Retention alone is not a bound: a script that starts a session a second
 * would still write an unbounded file inside the retention window.
 */
export const DEFAULT_MAX_SESSION_RECORDS = 500;

/**
 * How long an adopted session stays in the store after the last thing we heard from it.
 *
 * Adopted sessions never reach a terminal status — nothing tells the bridge that somebody closed
 * their terminal — so the completed-session retention rule would keep every one of them forever.
 * A day is long enough to still see this morning's session in `pagr sessions` and short enough
 * that a year of daily work does not accumulate.
 */
export const DEFAULT_ADOPTED_RETENTION_MS = 24 * 3600_000;

/** Persistent map `sessionId → SessionRecord` at `~/.pagr/sessions.json`. */
export class SessionStore {
  private map = new Map<string, SessionRecord>();
  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
    /**
     * Called after every change to the store. One choke point, because "a session became live /
     * stopped being live" is derived state several callers care about (keep-awake holds the Mac
     * on it) and every mutation here already funnels through `persist`.
     */
    private readonly onChange?: () => void,
  ) {
    if (file) {
      const raw = readJson<Record<string, SessionRecord>>(file, {});
      for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') this.map.set(k, v);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }
  get(sessionId: string): SessionRecord | null {
    return this.map.get(sessionId) ?? null;
  }
  list(): SessionRecord[] {
    return [...this.map.values()];
  }
  upsert(rec: Omit<SessionRecord, 'updatedAt'> & { updatedAt?: string }): SessionRecord {
    const full: SessionRecord = { ...rec, updatedAt: rec.updatedAt ?? this.now().toISOString() };
    this.map.set(full.sessionId, full);
    this.persist();
    return full;
  }
  setStatus(sessionId: string, status: SessionStatus): SessionRecord | null {
    const cur = this.map.get(sessionId);
    if (!cur) return null;
    return this.upsert({ ...cur, status, updatedAt: this.now().toISOString() });
  }
  /**
   * Drop terminal sessions (completed / failed / stopped) whose `updatedAt` is older than
   * `retentionMs`. Live sessions are never pruned; completed ones stay resumable until then.
   */
  pruneTerminal(retentionMs: number): number {
    const cutoff = this.now().getTime() - retentionMs;
    let n = 0;
    for (const [id, rec] of this.map) {
      if (!TERMINAL.has(rec.status)) continue;
      const t = Date.parse(rec.updatedAt);
      if (!Number.isNaN(t) && t < cutoff) {
        this.map.delete(id);
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }
  /**
   * Drop adopted sessions we have not heard from within `retentionMs`. One that is waiting on an
   * answer right this second is kept however old it looks: a prompt can sit unanswered for as
   * long as the person is away from their phone, and dropping the record would strand it.
   */
  pruneAdopted(retentionMs: number): number {
    const cutoff = this.now().getTime() - retentionMs;
    let n = 0;
    for (const [id, rec] of this.map) {
      if (!isAdopted(rec) || rec.status === 'waiting_for_approval') continue;
      const t = Date.parse(rec.updatedAt);
      if (!Number.isNaN(t) && t < cutoff) {
        this.map.delete(id);
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }

  /**
   * Drop the oldest terminal records until at most `max` remain. Non-terminal records are only
   * ever evicted when terminal ones alone cannot get under the ceiling — losing a record for a
   * session that might still be running is worse than a slightly oversized file.
   */
  capEntries(max: number): number {
    if (this.map.size <= max) return 0;
    const byAge = [...this.map.values()].sort(
      (a, b) => (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0),
    );
    let over = this.map.size - max;
    let n = 0;
    for (const rec of byAge) {
      if (over <= 0) break;
      if (!TERMINAL.has(rec.status)) continue;
      this.map.delete(rec.sessionId);
      over--;
      n++;
    }
    for (const rec of byAge) {
      if (over <= 0) break;
      if (!this.map.has(rec.sessionId)) continue;
      this.map.delete(rec.sessionId);
      over--;
      n++;
    }
    if (n) this.persist();
    return n;
  }

  /** Retention (terminal and adopted) + ceiling in one call. Returns how many were dropped. */
  prune(opts: { retentionMs?: number; maxEntries?: number; adoptedRetentionMs?: number } = {}): {
    expired: number;
    evicted: number;
    adopted: number;
  } {
    const expired = this.pruneTerminal(opts.retentionMs ?? DEFAULT_SESSION_RETENTION_MS);
    const adopted = this.pruneAdopted(opts.adoptedRetentionMs ?? DEFAULT_ADOPTED_RETENTION_MS);
    const evicted = this.capEntries(opts.maxEntries ?? DEFAULT_MAX_SESSION_RECORDS);
    return { expired, evicted, adopted };
  }

  remove(sessionId: string): void {
    this.map.delete(sessionId);
    this.persist();
  }
  private persist(): void {
    if (this.file) writeJson(this.file, Object.fromEntries(this.map));
    this.onChange?.();
  }
}
