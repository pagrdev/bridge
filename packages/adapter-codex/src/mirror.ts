import { framesForItem, type MappedFrame } from './items.js';
import type { FileLogger } from './logger.js';
import {
  METHODS,
  type Thread,
  type ThreadListParams,
  type ThreadListResponse,
  type ThreadLoadedListResponse,
  type ThreadReadResponse,
  type ThreadStatus,
  type ThreadUnsubscribeResponse,
} from './protocol.js';

/**
 * Terminal Codex threads, mirrored.
 *
 * Two populations, and the difference is not cosmetic (MOB-043 findings 5 and 6):
 *
 *   - **daemon-hosted** — the thread lives in the app-server we are attached to, so
 *     `thread/resume` subscribes us and every `turn/*` and `item/*` notification for it arrives
 *     live. Staying subscribed keeps the thread loaded and its writer lock held (openai/codex
 *     #44449), so a thread that has been quiet for `idleUnsubscribeMs` is let go again.
 *   - **foreign** — the thread is in `thread/list` but belongs to another process (the ChatGPT
 *     desktop app, an IDE extension, `codex exec`). `thread/resume` would fail with "already has
 *     an active writer" and must not even be attempted; `thread/read` works read-only across
 *     processes, so those are polled and diffed by item position.
 *
 * Nothing here ever writes to a thread. Mirroring is `mirror_only` by construction.
 */

export const DISCOVERY_INTERVAL_MS = 30_000;
export const READ_POLL_INTERVAL_MS = 3_000;
export const IDLE_UNSUBSCRIBE_MS = 5 * 60_000;
/** One `thread/list` page. The cursor is followed until the server stops handing one back. */
export const LIST_PAGE_SIZE = 50;
/** Pages per discovery pass: a Mac with thousands of old threads must not stall the sweep. */
export const MAX_LIST_PAGES = 10;

export type Hosting = 'daemon' | 'foreign';

export interface MirroredThread {
  threadId: string;
  cwd: string;
  preview: string;
  hosting: Hosting;
  /** Unix seconds, as the app-server reports them. */
  updatedAt: number;
  status: ThreadStatus;
  /** We hold a `thread/resume` subscription on it right now. */
  subscribed: boolean;
  /**
   * Another process holds its writer lock. Remembered for good: the lock is released when the
   * owner exits, and until then every retry is a pointless grab at somebody else's session.
   */
  lockedElsewhere?: boolean;
  /** Epoch ms of the last thing we saw from it; drives the idle unsubscribe. */
  lastActivityMs: number;
  /**
   * Items already turned into frames, per turn. `thread/read` returns the whole thread every
   * time, so this is what stops the third poll re-sending the first turn.
   */
  emitted: Map<string, number>;
}

export interface MirrorDeps {
  request<T>(method: string, params?: unknown): Promise<T>;
  /** Thread ids this bridge started. Ours are driven, never mirrored. */
  isOurs(threadId: string): boolean;
  /** A thread appeared, or something about it changed. */
  onThread(thread: MirroredThread): void;
  /** Frames read out of a foreign thread. */
  onFrames(threadId: string, frames: MappedFrame[]): void;
  logger: FileLogger;
  nowMs?: () => number;
  discoveryIntervalMs?: number;
  pollIntervalMs?: number;
  idleUnsubscribeMs?: number;
}

/** "no rollout found for thread id …" — the thread has no first user message yet. */
export const isNotMaterialized = (message: string): boolean =>
  /no rollout found|not materialized/i.test(message);

/** "thread … already has an active writer" — somebody else's process owns it. */
export const isWriterLocked = (message: string): boolean => /active writer/i.test(message);

const isActive = (s: ThreadStatus | undefined): boolean => s?.type === 'active';

export class TerminalThreadMirror {
  private readonly threads = new Map<string, MirroredThread>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: MirrorDeps) {}

  private get now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  list(): MirroredThread[] {
    return [...this.threads.values()];
  }

  get(threadId: string): MirroredThread | undefined {
    return this.threads.get(threadId);
  }

  /** Arm the two loops. Both are `unref`'d: a mirror must never hold the process open. */
  start(): void {
    this.stopped = false;
    if (!this.discoveryTimer) {
      this.discoveryTimer = setInterval(() => {
        void this.discover().catch((err) =>
          this.deps.logger.log('warn', 'codex thread discovery failed', {
            message: (err as Error).message,
          }),
        );
      }, this.deps.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS);
      this.discoveryTimer.unref?.();
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.sweep().catch((err) =>
          this.deps.logger.log('warn', 'codex mirror sweep failed', {
            message: (err as Error).message,
          }),
        );
      }, this.deps.pollIntervalMs ?? READ_POLL_INTERVAL_MS);
      this.pollTimer.unref?.();
    }
  }

  /** Stop the loops and hand every subscription back, so no thread stays locked on our account. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.discoveryTimer = null;
    this.pollTimer = null;
    for (const t of this.threads.values()) {
      if (t.subscribed) await this.unsubscribe(t).catch(() => {});
    }
  }

  /** Forget everything: the app-server we learned it from is gone. */
  reset(): void {
    this.threads.clear();
  }

  /** A notification for a mirrored thread arrived: it is alive, so the idle clock restarts. */
  noteActivity(threadId: string, status?: ThreadStatus): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.lastActivityMs = this.now;
    if (status) t.status = status;
  }

  // ---------- discovery ----------

  /** `thread/list` (state-db backed, cursor paginated) + `thread/loaded/list`. */
  async discover(): Promise<void> {
    if (this.stopped) return;
    const loaded = new Set(await this.loadedThreadIds());
    const listed = await this.listThreads();
    for (const thread of listed) {
      if (this.deps.isOurs(thread.id)) continue;
      const existing = this.threads.get(thread.id);
      const hosting: Hosting =
        loaded.has(thread.id) && !existing?.lockedElsewhere ? 'daemon' : 'foreign';
      const t: MirroredThread = existing ?? {
        threadId: thread.id,
        cwd: thread.cwd,
        preview: thread.preview,
        hosting,
        updatedAt: thread.updatedAt,
        status: thread.status,
        subscribed: false,
        lastActivityMs: this.now,
        emitted: new Map(),
      };
      // A thread that got loaded into our daemon (the TUI attached) becomes subscribable; one
      // that left memory goes back to read-only polling.
      if (existing) {
        if (existing.hosting !== hosting) existing.subscribed = false;
        existing.hosting = hosting;
        existing.cwd = thread.cwd;
        existing.preview = thread.preview;
        existing.status = thread.status;
        if (thread.updatedAt > existing.updatedAt) {
          existing.updatedAt = thread.updatedAt;
          existing.lastActivityMs = this.now;
        }
      }
      this.threads.set(thread.id, t);
      this.deps.onThread(t);
      if (hosting === 'daemon' && !t.subscribed) await this.trySubscribe(t);
    }
    // Loaded-but-unlisted threads are real too: `thread/list` hides a thread until its first
    // user message (spike finding 5), and that is exactly when a TUI thread is most interesting.
    for (const id of loaded) {
      if (this.threads.has(id) || this.deps.isOurs(id)) continue;
      const t: MirroredThread = {
        threadId: id,
        cwd: '',
        preview: '',
        hosting: 'daemon',
        updatedAt: 0,
        status: { type: 'idle' },
        subscribed: false,
        lastActivityMs: this.now,
        emitted: new Map(),
      };
      this.threads.set(id, t);
      this.deps.onThread(t);
      await this.trySubscribe(t);
    }
  }

  private async listThreads(): Promise<Thread[]> {
    const out: Thread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params: ThreadListParams = {
        limit: LIST_PAGE_SIZE,
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      };
      const res: ThreadListResponse = await this.deps.request<ThreadListResponse>(
        METHODS.threadList,
        params,
      );
      out.push(...(res.data ?? []));
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  private async loadedThreadIds(): Promise<string[]> {
    try {
      const res = await this.deps.request<ThreadLoadedListResponse>(METHODS.threadLoadedList, {});
      return res.data ?? [];
    } catch (err) {
      // An older app-server without `thread/loaded/list` is not a failure: everything degrades
      // to read-only polling, which works across every process anyway.
      this.deps.logger.log('warn', 'thread/loaded/list unavailable', {
        message: (err as Error).message,
      });
      return [];
    }
  }

  /**
   * Subscribe by resuming. Two failures are expected and neither is an error:
   * a thread with no first user message yet (retried on the next pass, per the spike) and a
   * thread another process holds the writer lock on (demoted to polling, permanently).
   */
  private async trySubscribe(t: MirroredThread): Promise<void> {
    try {
      await this.deps.request(METHODS.threadResume, { threadId: t.threadId });
      t.subscribed = true;
      t.lastActivityMs = this.now;
      this.deps.logger.log('info', 'mirroring a codex thread', { threadId: t.threadId });
    } catch (err) {
      const message = (err as Error).message;
      if (isWriterLocked(message)) {
        t.hosting = 'foreign';
        t.lockedElsewhere = true;
        this.deps.logger.log('info', 'codex thread is owned elsewhere; polling it read-only', {
          threadId: t.threadId,
        });
        return;
      }
      if (isNotMaterialized(message)) {
        this.deps.logger.log('info', 'codex thread has no first message yet; will retry', {
          threadId: t.threadId,
        });
        return;
      }
      this.deps.logger.log('warn', 'thread/resume failed', { threadId: t.threadId, message });
    }
  }

  private async unsubscribe(t: MirroredThread): Promise<void> {
    t.subscribed = false;
    const res = await this.deps.request<ThreadUnsubscribeResponse>(METHODS.threadUnsubscribe, {
      threadId: t.threadId,
    });
    this.deps.logger.log('info', 'released a mirrored codex thread', {
      threadId: t.threadId,
      status: res?.status ?? 'unknown',
    });
  }

  // ---------- the 3 s sweep ----------

  /** Poll the foreign threads that are active, and let go of subscriptions that went quiet. */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    const idleMs = this.deps.idleUnsubscribeMs ?? IDLE_UNSUBSCRIBE_MS;
    for (const t of [...this.threads.values()]) {
      if (t.subscribed && this.now - t.lastActivityMs >= idleMs) {
        await this.unsubscribe(t).catch((err) =>
          this.deps.logger.log('warn', 'thread/unsubscribe failed', {
            threadId: t.threadId,
            message: (err as Error).message,
          }),
        );
        continue;
      }
      if (t.hosting === 'foreign' && this.shouldPoll(t, idleMs)) await this.poll(t);
    }
  }

  /** Active now, or active recently enough that the next item is probably seconds away. */
  private shouldPoll(t: MirroredThread, idleMs: number): boolean {
    return isActive(t.status) || this.now - t.lastActivityMs < idleMs;
  }

  /**
   * One read-only pass over a foreign thread.
   *
   * Diffed by position, never by item id: `thread/read` renumbers items (`item-1`, `item-2`, …)
   * and the live notifications use UUIDv7, so ids are not comparable between the two views
   * (spike finding 7). The last item of an in-progress turn is deliberately left alone — it can
   * still change, and half a command is worse than a command a beat late.
   */
  async poll(t: MirroredThread): Promise<void> {
    let res: ThreadReadResponse;
    try {
      res = await this.deps.request<ThreadReadResponse>(METHODS.threadRead, {
        threadId: t.threadId,
        includeTurns: true,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (isNotMaterialized(message)) return;
      this.deps.logger.log('warn', 'thread/read failed', { threadId: t.threadId, message });
      return;
    }
    const thread = res?.thread;
    if (!thread) return;
    if (thread.cwd && !t.cwd) {
      t.cwd = thread.cwd;
      t.preview = thread.preview ?? t.preview;
      this.deps.onThread(t);
    }
    if (thread.status) t.status = thread.status;
    const frames: MappedFrame[] = [];
    for (const turn of thread.turns ?? []) {
      const items = turn.items ?? [];
      const settled = turn.status === 'inProgress' ? items.length - 1 : items.length;
      const from = t.emitted.get(turn.id) ?? 0;
      for (let i = from; i < settled; i++) {
        const item = items[i];
        if (!item) continue;
        frames.push(
          ...framesForItem(item, {
            turnId: turn.id,
            source: 'app_server',
            index: i,
            key: 'position',
          }),
        );
      }
      if (settled > from) t.emitted.set(turn.id, settled);
    }
    if (frames.length === 0) return;
    t.lastActivityMs = this.now;
    this.deps.onFrames(t.threadId, frames);
  }
}
