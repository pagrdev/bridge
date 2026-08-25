import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface ReplayCacheOptions {
  /** Max entries retained. Default 5000. */
  maxEntries?: number;
  /** Persist file (best-effort). Omitted → memory only. */
  file?: string;
  now?: () => number;
}

/**
 * Bounded LRU set of `(key → expiresAtMs)`. Used for command nonces / ids.
 * Entries past their expiry are evicted lazily; the oldest entry is evicted when full.
 */
export class ReplayCache {
  private readonly entries = new Map<string, number>();
  private readonly max: number;
  private readonly file: string | undefined;
  private readonly now: () => number;

  constructor(opts: ReplayCacheOptions = {}) {
    this.max = opts.maxEntries ?? 5000;
    this.file = opts.file;
    this.now = opts.now ?? (() => Date.now());
    if (this.file) this.load();
  }

  /** True if the key has been seen and is not yet expired. */
  has(key: string): boolean {
    const exp = this.entries.get(key);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Record a key. Returns false if it was already present (replay).
   * `expiresAtMs` bounds how long the key must be remembered.
   */
  add(key: string, expiresAtMs: number): boolean {
    if (this.has(key)) return false;
    this.entries.set(key, expiresAtMs);
    this.prune();
    this.persist();
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.entries) if (exp <= t) this.entries.delete(k);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number')
            this.entries.set(item[0], item[1]);
        }
      }
      this.prune();
    } catch {
      // missing or corrupt: start empty
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries]), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // best effort only
    }
  }
}
