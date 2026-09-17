import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  isLiveTranscriptName,
  pidOfSessionFile,
  projectsDir,
  sessionIdOfTranscript,
  sessionsDir,
} from './paths.js';
import { parseTranscriptRecord } from './records.js';

/**
 * Finding the Claude Code sessions the user started themselves.
 *
 * Claude writes `~/.claude/sessions/<pid>.json` (mode 0644) for every interactive process it
 * runs, carrying `{pid, sessionId, cwd, startedAt, version, kind, entrypoint, name, …}`. That is
 * the whole discovery mechanism: no `ps`, no process-table parsing, no guessing a session id from
 * a directory name. Verified on this Mac 2026-09-17.
 *
 * The sibling `<pid>.<hash>.key` files are 0600 and hold Claude's own messaging secret. Nothing
 * here opens them — `pidOfSessionFile` matches `<digits>.json` and nothing else, so a `.key` file
 * is not even a candidate.
 *
 * Liveness is `process.kill(pid, 0)`. `EPERM` counts as alive: it means a process with that pid
 * exists and belongs to somebody else, which is a pid the daemon must not claim to have ended.
 */

/** How often the sessions directory is re-read regardless of what `fs.watch` said. */
export const DEFAULT_DISCOVERY_POLL_MS = 5000;
/**
 * How recently a transcript must have changed for a session with no pid file to count as a
 * session at all. Ten minutes is long enough to survive a laptop lid and short enough that
 * yesterday's transcripts never show up as today's sessions.
 */
export const ORPHAN_WINDOW_MS = 10 * 60_000;
/** How often the (more expensive) orphan sweep runs. The pid files are the fast path. */
export const ORPHAN_SWEEP_MS = 60_000;
/**
 * Hard budget for one orphan sweep. `~/.claude/projects` on a working machine holds thousands of
 * transcripts, and a backstop for a missing pid file must not cost a full tree walk every minute.
 */
export const MAX_ORPHAN_STATS = 500;

/** One Claude Code process, as `~/.claude/sessions/<pid>.json` describes it. */
export interface ClaudeProcessInfo {
  /** Absent for a session seeded from its transcript: there is no pid file to read one from. */
  pid?: number;
  sessionId: string;
  cwd: string;
  /** `claude` for the plain CLI, `claude-vscode` and friends for an IDE host. */
  entrypoint?: string;
  name?: string;
  version?: string;
  /** `live` when a pid file says so and the pid answers; `unknown` when seeded from a transcript. */
  liveness: 'live' | 'unknown';
}

export type DiscoveryEvent =
  | { kind: 'discovered'; session: ClaudeProcessInfo }
  | { kind: 'renamed'; session: ClaudeProcessInfo; previousName?: string }
  | { kind: 'ended'; sessionId: string; session: ClaudeProcessInfo };

const PidFile = z
  .object({
    pid: z.number().int().positive(),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    startedAt: z.string().optional(),
    version: z.string().optional(),
    kind: z.string().optional(),
    entrypoint: z.string().optional(),
    name: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/** Read one `<pid>.json`. Another program's file, so every failure is "not a session". */
export function readPidFile(filePath: string): ClaudeProcessInfo | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const checked = PidFile.safeParse(parsed);
  if (!checked.success) return null;
  const d = checked.data;
  return {
    pid: d.pid,
    sessionId: d.sessionId,
    cwd: d.cwd,
    liveness: 'live',
    ...(d.entrypoint ? { entrypoint: d.entrypoint } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.version ? { version: d.version } : {}),
  };
}

/** `process.kill(pid, 0)`; `EPERM` is a live process this user does not own. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ClaudeProcessWatchOptions {
  /** `$HOME` holding `.claude`. Tests point this at a temp directory. */
  home: string;
  onEvent: (e: DiscoveryEvent) => void;
  /** Injectable so tests never depend on real pids. Defaults to `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
  orphanSweepMs?: number;
  orphanWindowMs?: number;
  /** Set false to skip the transcript backstop entirely (tests, and `PAGR_MIRROR_ORPHANS=0`). */
  orphans?: boolean;
  now?: () => number;
}

/**
 * Watches `~/.claude/sessions` and reports Claude Code processes appearing, being renamed and
 * going away. `fs.watch` plus a five-second poll, for the same reason the tailer has both.
 */
export class ClaudeProcessWatch {
  private readonly dir: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly nowMs: () => number;
  private readonly pollMs: number;
  private readonly orphanSweepMs: number;
  private readonly orphanWindowMs: number;
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private lastOrphanSweepMs = 0;
  private readonly known = new Map<string, ClaudeProcessInfo>();
  private stopped = false;

  constructor(private readonly o: ClaudeProcessWatchOptions) {
    this.dir = sessionsDir(o.home);
    this.isAlive = o.isAlive ?? isProcessAlive;
    this.nowMs = o.now ?? (() => Date.now());
    this.pollMs = o.pollMs ?? DEFAULT_DISCOVERY_POLL_MS;
    this.orphanSweepMs = o.orphanSweepMs ?? ORPHAN_SWEEP_MS;
    this.orphanWindowMs = o.orphanWindowMs ?? ORPHAN_WINDOW_MS;
  }

  /** Sessions currently believed to exist, by Claude session id. */
  list(): ClaudeProcessInfo[] {
    return [...this.known.values()];
  }

  get size(): number {
    return this.known.size;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.watcher?.close();
    } catch {
      // already gone
    }
    this.watcher = null;
  }

  /** One full pass: read every pid file, then reconcile against what we thought was there. */
  poll(): void {
    if (this.stopped) return;
    this.ensureWatch();
    const seen = new Map<string, ClaudeProcessInfo>();
    for (const name of readdir(this.dir)) {
      const pid = pidOfSessionFile(name);
      if (pid === null) continue;
      const info = readPidFile(path.join(this.dir, name));
      if (!info || info.pid !== pid) continue;
      if (!this.isAlive(pid)) continue;
      seen.set(info.sessionId, info);
    }
    if (this.o.orphans !== false && this.nowMs() - this.lastOrphanSweepMs >= this.orphanSweepMs) {
      this.lastOrphanSweepMs = this.nowMs();
      for (const info of this.sweepOrphans(seen)) seen.set(info.sessionId, info);
    } else {
      // Between sweeps, an already-seeded orphan stays until its own sweep retires it.
      for (const [id, info] of this.known)
        if (info.liveness === 'unknown' && !seen.has(id)) seen.set(id, info);
    }
    this.reconcile(seen);
  }

  private reconcile(seen: Map<string, ClaudeProcessInfo>): void {
    for (const [id, info] of seen) {
      const prior = this.known.get(id);
      if (!prior) {
        this.known.set(id, info);
        this.o.onEvent({ kind: 'discovered', session: info });
        continue;
      }
      this.known.set(id, info);
      if (prior.name !== info.name)
        this.o.onEvent({
          kind: 'renamed',
          session: info,
          ...(prior.name ? { previousName: prior.name } : {}),
        });
    }
    for (const [id, info] of [...this.known]) {
      if (seen.has(id)) continue;
      this.known.delete(id);
      this.o.onEvent({ kind: 'ended', sessionId: id, session: info });
    }
  }

  private ensureWatch(): void {
    if (this.watcher || !fs.existsSync(this.dir)) return;
    try {
      const w = fs.watch(this.dir, { persistent: false }, () => this.poll());
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // already closed
        }
        this.watcher = null;
      });
      this.watcher = w;
    } catch {
      // The poll is the floor.
    }
  }

  /**
   * The backstop: a transcript written in the last ten minutes whose session has no pid file.
   *
   * That happens when Claude was killed before it could clean up, and on any build that does not
   * write pid files at all. Such a session is reported with `liveness: 'unknown'` — the mirror
   * still shows what it is doing, and never claims to know that it is running.
   *
   * Budgeted (`MAX_ORPHAN_STATS`) and run on its own slower cadence, because `~/.claude/projects`
   * on a working machine holds thousands of files and a backstop must not cost a tree walk.
   */
  private sweepOrphans(seen: Map<string, ClaudeProcessInfo>): ClaudeProcessInfo[] {
    const cutoff = this.nowMs() - this.orphanWindowMs;
    const root = projectsDir(this.o.home);
    const dirs: Array<{ dir: string; mtimeMs: number }> = [];
    for (const name of readdir(root)) {
      const dir = path.join(root, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory()) dirs.push({ dir, mtimeMs: st.mtimeMs });
      } catch {
        // gone
      }
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: ClaudeProcessInfo[] = [];
    let budget = MAX_ORPHAN_STATS;
    for (const { dir } of dirs) {
      if (budget <= 0) break;
      for (const name of readdir(dir)) {
        if (budget <= 0) break;
        if (!isLiveTranscriptName(name)) continue;
        const id = sessionIdOfTranscript(name);
        if (!id || seen.has(id)) continue;
        budget--;
        const file = path.join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoff) continue;
        const cwd = this.known.get(id)?.cwd ?? cwdOfTranscript(file);
        if (!cwd) continue;
        out.push({ sessionId: id, cwd, liveness: 'unknown' });
      }
    }
    return out;
  }
}

/** The first `cwd` the transcript records. Bounded read: the head of the file, never all of it. */
export const CWD_PROBE_BYTES = 64 * 1024;

export function cwdOfTranscript(file: string): string | null {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(CWD_PROBE_BYTES);
      const read = fs.readSync(fd, buf, 0, CWD_PROBE_BYTES, 0);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const rec = parseTranscriptRecord(line);
    if (rec?.cwd) return rec.cwd;
  }
  return null;
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
