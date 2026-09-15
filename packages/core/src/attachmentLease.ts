import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { deleteAttachment } from './attachments.js';

export interface AttachmentLeaseOptions {
  /** Directory the leased files must live under. Anything outside it is never deleted. */
  dir: string;
  /**
   * Backstop: a lease this old is swept even if its turn never reported an end (a wedged
   * provider, a lost event). Default one hour — longer than any turn that can still be reading
   * the file, far shorter than the daemon's 24 h `cleanupTmp`.
   */
  ttlMs?: number;
  now?: () => Date;
  /** Injected for tests. Defaults to `deleteAttachment` (unlink, ignore ENOENT). */
  remove?: (path: string) => void;
}

interface Lease {
  leaseId: string;
  sessionId: string;
  paths: string[];
  takenAtMs: number;
}

interface SessionLeases {
  /** Lease ids in the order they were taken; a turn consumes them in that order. */
  order: string[];
  /**
   * True while a turn that was handed one of these leases is believed to be running. Adapters
   * report the end of a turn twice (a `session` status AND a `session_event`); this flag makes
   * the second report a no-op instead of freeing the NEXT turn's files.
   */
  turnActive: boolean;
}

export const DEFAULT_ATTACHMENT_LEASE_TTL_MS = 60 * 60_000;

/**
 * Keeps downloaded attachments on disk for the lifetime of the agent turn that referenced them.
 *
 * An adapter call returns as soon as the turn is written to the agent's stdin (Claude Code) or the
 * `turn/start` RPC returns (Codex) — both long before the model actually opens the file. Deleting
 * on return therefore races the agent and the screenshot silently disappears. A lease instead ends
 * when the turn does: on a `completed` / `failed` report, when the session stops, or — only as a
 * backstop — when `sweep` finds it older than the TTL.
 *
 * Leases for one session are consumed in the order they were taken, so a follow-up queued behind a
 * running turn keeps its own images until its own turn ends.
 */
export class AttachmentLeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly bySession = new Map<string, SessionLeases>();
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly remove: (path: string) => void;

  constructor(o: AttachmentLeaseOptions) {
    this.dir = resolve(o.dir);
    this.ttlMs = o.ttlMs ?? DEFAULT_ATTACHMENT_LEASE_TTL_MS;
    this.now = o.now ?? (() => new Date());
    this.remove = o.remove ?? deleteAttachment;
  }

  /** Hold `paths` for the turn `sessionId` is about to run. Returns the lease id. */
  acquire(sessionId: string, paths: string[]): string {
    const leaseId = `lease_${randomUUID()}`;
    this.leases.set(leaseId, {
      leaseId,
      sessionId,
      paths: [...paths],
      takenAtMs: this.now().getTime(),
    });
    const s = this.bySession.get(sessionId) ?? { order: [], turnActive: false };
    s.order.push(leaseId);
    s.turnActive = true;
    this.bySession.set(sessionId, s);
    return leaseId;
  }

  /** A turn for this session began (or resumed): its lease must survive until it ends. */
  noteTurnStarted(sessionId: string): void {
    const s = this.bySession.get(sessionId);
    if (s && s.order.length > 0) s.turnActive = true;
  }

  /**
   * A turn for this session ended. Frees the oldest outstanding lease — the one that turn was
   * handed. Repeated end reports for the same turn are ignored. Returns files deleted.
   */
  noteTurnEnded(sessionId: string): number {
    const s = this.bySession.get(sessionId);
    if (!s?.turnActive) return 0;
    s.turnActive = false;
    const leaseId = s.order[0];
    return leaseId === undefined ? 0 : this.release(leaseId);
  }

  /** Free one lease (its turn never started, or it is being swept). Returns files deleted. */
  release(leaseId: string): number {
    const lease = this.leases.get(leaseId);
    if (!lease) return 0;
    this.leases.delete(leaseId);
    const s = this.bySession.get(lease.sessionId);
    if (s) {
      s.order = s.order.filter((id) => id !== leaseId);
      if (s.order.length === 0) this.bySession.delete(lease.sessionId);
    }
    return this.unlink(lease);
  }

  /** The session is over (stopped, gone): free everything it still holds. */
  releaseSession(sessionId: string): number {
    const s = this.bySession.get(sessionId);
    if (!s) return 0;
    let n = 0;
    for (const leaseId of [...s.order]) n += this.release(leaseId);
    return n;
  }

  /** Shutdown: nothing is going to read these files again. */
  releaseAll(): number {
    let n = 0;
    for (const leaseId of [...this.leases.keys()]) n += this.release(leaseId);
    return n;
  }

  /** Backstop for a turn that never reported an end. Returns files deleted. */
  sweep(): number {
    const cutoff = this.now().getTime() - this.ttlMs;
    let n = 0;
    for (const lease of [...this.leases.values()])
      if (lease.takenAtMs <= cutoff) n += this.release(lease.leaseId);
    return n;
  }

  /** Files currently held for a session (oldest lease first). */
  pathsFor(sessionId: string): string[] {
    const s = this.bySession.get(sessionId);
    if (!s) return [];
    return s.order.flatMap((id) => this.leases.get(id)?.paths ?? []);
  }

  get size(): number {
    return this.leases.size;
  }

  /**
   * Delete only inside the attachments directory. `fetchAttachment` already builds every path from
   * a schema-checked `att_…` id, so this can only fire on a future caller mistake — but a lease
   * registry that will unlink whatever path it is handed is not one worth having.
   */
  private unlink(lease: Lease): number {
    let n = 0;
    for (const p of lease.paths) {
      const rel = relative(this.dir, resolve(p));
      if (rel === '' || rel.startsWith('..') || resolve(p) !== resolve(this.dir, rel)) continue;
      this.remove(p);
      n++;
    }
    return n;
  }
}
