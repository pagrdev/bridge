import type { Provider, SessionStatus } from '@pagr/protocol';
import { readJson, writeJson } from './jsonFile.js';

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  projectId: string;
  providerSessionId: string;
  providerThreadId?: string;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
}

const TERMINAL = new Set<SessionStatus>(['completed', 'failed', 'stopped']);

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
  remove(sessionId: string): void {
    this.map.delete(sessionId);
    this.persist();
  }
  private persist(): void {
    if (this.file) writeJson(this.file, Object.fromEntries(this.map));
  }
}
