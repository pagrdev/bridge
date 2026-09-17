import fs from 'node:fs';
import path from 'node:path';
import {
  projectDirFor,
  sessionIdOfTranscript,
  subagentIdOfFile,
  subagentMetaFile,
  subagentsDir,
} from './paths.js';
import { parseSubagentMeta, parseTranscriptRecord, type TranscriptRecord } from './records.js';

/**
 * Following a transcript Claude Code is still writing.
 *
 * The hard parts are not "read the new bytes". They are the four things that happen to a file a
 * different program owns:
 *
 *   - **It is replaced.** Claude rewrites a transcript and leaves `<session>.jsonl.superseded-<ts>`
 *     behind. The new file has a new inode at the same path, so an offset carried across is
 *     meaningless: the tailer notices the inode change and reads the new file from zero. What
 *     stops that becoming a duplicated transcript is the record's own `uuid`, which the mirror
 *     turns into `providerRecordId` and the journal dedupes on.
 *   - **It is truncated.** Same answer, detected by a size below the offset.
 *   - **It is split.** Superseded and orphaned variants of one session sit beside each other in
 *     the project directory. They are all tailed, and they are all the same session, because
 *     identity comes from the `sessionId` INSIDE the records, never from a file name.
 *   - **It is half-written.** A poll can land between the bytes of a line. Only whole lines are
 *     parsed, and the offset only ever advances past bytes that decoded cleanly, so a line split
 *     across two polls is read once, whole.
 *
 * `fs.watch` on the directory is the fast path and a one-second poll is the floor, because
 * `fs.watch` on macOS misses events under load and drops silently when a directory is replaced.
 * Neither is trusted alone.
 */

/** How often the tailer reads regardless of what `fs.watch` said. */
export const DEFAULT_POLL_MS = 1000;
/** How long a burst of `fs.watch` events is collapsed into one read. */
export const WATCH_DEBOUNCE_MS = 25;
/** Record ids one tailer remembers, so a reopen does not re-emit what it just emitted. */
export const SEEN_UUID_LIMIT = 4096;
/** Shortest gap between two writes of `tailer-state.json`. */
export const STATE_FLUSH_MS = 1000;

/** Where one file has been read up to. */
export interface TailerFileState {
  /** Inode at the time of the read. A different one is a different file at the same path. */
  inode: number;
  /** Bytes consumed. Only ever advanced past bytes that decoded into whole lines. */
  offset: number;
  /**
   * The tail after the last newline, when it decoded cleanly. Held so a long line being written
   * slowly is not re-read on every poll; empty whenever the file ends on a newline.
   */
  partialLine: string;
}

/**
 * `~/.pagr/tailer-state.json` — one entry per transcript file this Mac has read.
 *
 * Ids, inode numbers and byte offsets. It holds no transcript content beyond `partialLine`, which
 * is at most the last unterminated line of a file the daemon is mid-read on, and it exists so a
 * daemon restart resumes where it stopped instead of replaying every session it has ever seen.
 */
export class TailerStateStore {
  private data: Record<string, TailerFileState> = {};
  private dirty = false;
  private lastWriteMs = 0;

  constructor(
    private readonly file: string | null,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        this.data = parsed as Record<string, TailerFileState>;
    } catch {
      this.data = {};
    }
  }

  get(filePath: string): TailerFileState | undefined {
    return this.data[filePath];
  }

  set(filePath: string, state: TailerFileState): void {
    this.data[filePath] = state;
    this.dirty = true;
    if (this.nowMs() - this.lastWriteMs >= STATE_FLUSH_MS) this.flush();
  }

  forget(filePath: string): void {
    if (!(filePath in this.data)) return;
    delete this.data[filePath];
    this.dirty = true;
  }

  /** Drop entries for files that no longer exist, so the file cannot grow without bound. */
  sweep(): number {
    let n = 0;
    for (const key of Object.keys(this.data)) {
      if (fs.existsSync(key)) continue;
      delete this.data[key];
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  get size(): number {
    return Object.keys(this.data).length;
  }

  flush(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    this.lastWriteMs = this.nowMs();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Best effort. Losing the state costs a replay the journal dedupes, never a lost frame.
    }
  }
}

/** Which file a record came out of, and what that file is. */
export interface TailedRecord {
  record: TranscriptRecord;
  /** Absolute path of the transcript file. Local only; never part of a frame. */
  file: string;
  /** Present when the record came from `<session>/subagents/agent-<id>.jsonl`. */
  subagent?: { id: string; depth: number };
  /** The `Task` tool call the subagent belongs to, from its `agent-<id>.meta.json`. */
  parentFrameId?: string;
}

export interface TranscriptTailerOptions {
  /** `$HOME` holding `.claude`. Tests point this at a temp directory. */
  home: string;
  /** The session's working directory, which decides the encoded project directory name. */
  cwd: string;
  claudeSessionId: string;
  state: TailerStateStore;
  onRecord: (r: TailedRecord) => void;
  /** Called when a read fails. The tailer never throws at its callers. */
  onError?: (err: Error, file: string) => void;
  pollMs?: number;
  /** Include the session's subagent transcripts. Default true. */
  subagents?: boolean;
}

/**
 * One session's transcript, and every file that is part of it, followed until `stop()`.
 */
export class TranscriptTailer {
  private readonly projectDir: string;
  private readonly agentsDir: string;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  /** Record uuids emitted in this tailer's lifetime, so a reopen re-reads without re-emitting. */
  private readonly seen = new Set<string>();
  private readonly subagentMeta = new Map<string, { depth: number; toolUseId?: string }>();
  private files: string[] = [];
  private stopped = false;

  constructor(private readonly o: TranscriptTailerOptions) {
    this.projectDir = projectDirFor(o.home, o.cwd);
    this.agentsDir = subagentsDir(o.home, o.cwd, o.claudeSessionId);
    this.pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  }

  /** Files this tailer is currently following. Reported by `pagr doctor`. */
  get watchedFiles(): string[] {
    return [...this.files];
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
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // already gone
      }
    }
    this.watchers.clear();
    this.o.state.flush();
  }

  /** Re-scan for files, then read whatever is new in each. Safe to call at any time. */
  poll(): void {
    if (this.stopped) return;
    this.ensureWatch(this.projectDir);
    if (this.o.subagents !== false) this.ensureWatch(this.agentsDir);
    this.files = this.discoverFiles();
    for (const file of this.files) this.readFile(file);
  }

  /**
   * Every file that is part of this session: the live transcript, its superseded and orphaned
   * variants, and each subagent's own transcript. Ordered so the main thread is read before the
   * subagents it spawned.
   */
  private discoverFiles(): string[] {
    const main: string[] = [];
    for (const name of readdir(this.projectDir)) {
      if (sessionIdOfTranscript(name) !== this.o.claudeSessionId) continue;
      main.push(path.join(this.projectDir, name));
    }
    // `<session>.jsonl` first, then the superseded variants oldest-name-first, so a replay after a
    // rotation reads the history before the file that replaced it.
    main.sort((a, b) => a.length - b.length || a.localeCompare(b));
    const agents: string[] = [];
    if (this.o.subagents !== false)
      for (const name of readdir(this.agentsDir)) {
        if (!subagentIdOfFile(name)) continue;
        agents.push(path.join(this.agentsDir, name));
      }
    agents.sort();
    return [...main, ...agents];
  }

  private ensureWatch(dir: string): void {
    if (this.watchers.has(dir) || !fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // already closed
        }
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      // No watch: the poll is the floor and covers it.
    }
  }

  private schedule(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.poll();
    }, WATCH_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  private readFile(file: string): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return; // vanished between the scan and the read
    }
    if (!st.isFile()) return;

    const prior = this.o.state.get(file);
    const inode = Number(st.ino);
    let offset = 0;
    let partial = '';
    if (prior && prior.inode === inode && prior.offset <= st.size) {
      offset = prior.offset;
      partial = prior.partialLine;
    }
    // Everything else — no state, a new inode at this path, or a file now shorter than we had
    // read — means the bytes we counted are not the bytes that are there. Start again from zero
    // and let `seen` and the journal's `providerRecordId` dedupe suppress the replay.
    if (offset === st.size && !prior) this.o.state.set(file, { inode, offset, partialLine: '' });
    if (offset >= st.size) return;

    let buf: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const want = st.size - offset;
        buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, offset);
        if (read < want) buf = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.o.onError?.(err as Error, file);
      return;
    }

    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // Not one whole line yet. Leave the offset where it is; the next poll sees the newline.
      return;
    }
    const complete = partial + buf.subarray(0, lastNewline + 1).toString('utf8');
    const tailBytes = buf.subarray(lastNewline + 1);
    // Only carry the tail forward when it is valid UTF-8 on its own; otherwise the file ends
    // mid-character and those bytes are left in place to be re-read with the rest of the glyph.
    const tailText = tailBytes.toString('utf8');
    const tailClean = Buffer.byteLength(tailText, 'utf8') === tailBytes.length;
    this.o.state.set(file, {
      inode,
      offset: offset + (tailClean ? buf.length : lastNewline + 1),
      partialLine: tailClean ? tailText : '',
    });

    const subagent = this.subagentOf(file);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      const record = parseTranscriptRecord(line);
      if (!record) continue;
      if (record.uuid) {
        if (this.seen.has(record.uuid)) continue;
        this.remember(record.uuid);
      }
      this.o.onRecord({
        record,
        file,
        ...(subagent ? { subagent: { id: subagent.id, depth: subagent.depth } } : {}),
        ...(subagent?.toolUseId ? { parentFrameId: subagent.toolUseId } : {}),
      });
    }
  }

  private remember(uuid: string): void {
    this.seen.add(uuid);
    if (this.seen.size <= SEEN_UUID_LIMIT) return;
    const oldest = this.seen.values().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }

  /** The subagent a file belongs to, with the `Task` call and depth from its sidecar. */
  private subagentOf(file: string): { id: string; depth: number; toolUseId?: string } | null {
    const id = subagentIdOfFile(path.basename(file));
    if (!id) return null;
    const cached = this.subagentMeta.get(id);
    if (cached) return { id, ...cached };
    let meta: { depth: number; toolUseId?: string } = { depth: 1 };
    try {
      const parsed = parseSubagentMeta(fs.readFileSync(subagentMetaFile(file), 'utf8'));
      if (parsed)
        meta = {
          depth: parsed.spawnDepth ?? 1,
          ...(parsed.toolUseId ? { toolUseId: parsed.toolUseId } : {}),
        };
    } catch {
      // No sidecar (yet). Depth 1 is the honest default: it is a subagent of this session.
    }
    this.subagentMeta.set(id, meta);
    return { id, ...meta };
  }
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
