import type { Provider, SessionStatus } from '@pagr/protocol';
import { readJson, writeJson } from './jsonFile.js';

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  projectId: string;
  providerSessionId: string;
  providerThreadId?: string;
  status: SessionStatus;
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

/** Persistent map `sessionId → SessionRecord` at `~/.pagr/sessions.json`. */
export class SessionStore {
  private map = new Map<string, SessionRecord>();
  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
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

  /** Retention + ceiling in one call. Returns how many records were dropped. */
  prune(opts: { retentionMs?: number; maxEntries?: number } = {}): {
    expired: number;
    evicted: number;
  } {
    const expired = this.pruneTerminal(opts.retentionMs ?? DEFAULT_SESSION_RETENTION_MS);
    const evicted = this.capEntries(opts.maxEntries ?? DEFAULT_MAX_SESSION_RECORDS);
    return { expired, evicted };
  }

  remove(sessionId: string): void {
    this.map.delete(sessionId);
    this.persist();
  }
  private persist(): void {
    if (this.file) writeJson(this.file, Object.fromEntries(this.map));
  }
}
