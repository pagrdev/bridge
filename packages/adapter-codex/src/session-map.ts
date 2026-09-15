import fs from 'node:fs';
import path from 'node:path';

export interface PersistedSession {
  threadId: string;
  projectId: string;
  projectPath: string;
  displayName?: string;
  /** Read-only sessions must be resumed with the read-only sandbox (finding 5). */
  readOnly?: boolean;
  startedAt: string;
  updatedAt: string;
  lastStatus: string;
}

/** Statuses a session never comes back from; only these are ever aged out. */
const TERMINAL = new Set(['completed', 'failed', 'stopped']);

/**
 * Terminal sessions stay resumable for a week — comfortably past the cloud's 24h follow-up
 * window, and short enough that the map stays small on a busy Mac. Mirrors the daemon's
 * `sessions.json` policy (`DEFAULT_SESSION_RETENTION_MS` in `@pagr/bridge-core`).
 */
export const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * Hard ceiling on entries. Retention alone is not a bound: a script that starts a session a
 * second would still grow the file without limit inside the retention window — and every entry
 * used to be copied into `device.hello` on every connect until the frame blew the gateway's
 * 256 KiB cap and the bridge reconnect-looped forever (BR-3).
 */
export const DEFAULT_MAX_SESSION_ENTRIES = 500;

export interface PruneOptions {
  retentionMs?: number;
  maxEntries?: number;
  /** Session ids that must survive whatever happens — the ones running right now. */
  protect?: ReadonlySet<string>;
  nowMs?: number;
}

/**
 * Cloud session id (`ses_…`) → Codex thread id map, persisted as JSON under PAGR_HOME.
 * Contains no secrets: ids, the registered project path, and timestamps only.
 */
export class SessionMap {
  private data: Record<string, PersistedSession> = {};
  constructor(private readonly file: string) {
    this.load();
  }

  get size(): number {
    return Object.keys(this.data).length;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, PersistedSession>;
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(sessionId: string): PersistedSession | undefined {
    return this.data[sessionId];
  }
  set(sessionId: string, s: PersistedSession): void {
    this.data[sessionId] = s;
    this.save();
  }
  update(sessionId: string, patch: Partial<PersistedSession>): void {
    const cur = this.data[sessionId];
    if (!cur) return;
    this.data[sessionId] = { ...cur, ...patch };
    this.save();
  }
  /** Forget a session whose first turn never started, so it cannot show up as a phantom. */
  remove(sessionId: string): void {
    if (!(sessionId in this.data)) return;
    delete this.data[sessionId];
    this.save();
  }
  entries(): Array<[string, PersistedSession]> {
    return Object.entries(this.data);
  }

  /**
   * Retention sweep plus a hard ceiling, in one call. Terminal entries go first — by age past
   * `retentionMs`, then oldest-first to get under `maxEntries`. A non-terminal entry is only
   * evicted when terminal ones alone cannot get the map under the ceiling, and a protected
   * (live) one never is: losing the mapping for a session that is still running is worse than a
   * slightly oversized file. Returns how many entries were dropped.
   */
  prune(opts: PruneOptions = {}): { expired: number; evicted: number } {
    const retentionMs = opts.retentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_SESSION_ENTRIES;
    const protect = opts.protect ?? new Set<string>();
    const cutoff = (opts.nowMs ?? Date.now()) - retentionMs;
    const age = (s: PersistedSession): number => Date.parse(s.updatedAt) || 0;
    let expired = 0;
    let evicted = 0;
    for (const [id, s] of Object.entries(this.data)) {
      if (protect.has(id) || !TERMINAL.has(s.lastStatus)) continue;
      if (age(s) < cutoff) {
        delete this.data[id];
        expired++;
      }
    }
    const ids = Object.keys(this.data);
    if (ids.length > maxEntries) {
      const byAge = ids
        .filter((id) => !protect.has(id))
        .sort(
          (a, b) => age(this.data[a] as PersistedSession) - age(this.data[b] as PersistedSession),
        );
      let over = ids.length - maxEntries;
      for (const pass of [true, false]) {
        for (const id of byAge) {
          if (over <= 0) break;
          const s = this.data[id];
          if (!s || TERMINAL.has(s.lastStatus) !== pass) continue;
          delete this.data[id];
          over--;
          evicted++;
        }
      }
    }
    if (expired + evicted > 0) this.save();
    return { expired, evicted };
  }
  findByThread(threadId: string): string | undefined {
    for (const [sid, s] of Object.entries(this.data)) if (s.threadId === threadId) return sid;
    return undefined;
  }
}
