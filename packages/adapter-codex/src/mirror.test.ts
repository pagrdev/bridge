import { describe, expect, it, vi } from 'vitest';
import type { MappedFrame } from './items.js';
import { FileLogger } from './logger.js';
import { type MirroredThread, TerminalThreadMirror } from './mirror.js';
import type { Thread } from './protocol.js';

/**
 * The mirror on its own, against a scripted app-server.
 *
 * The adapter-level half of this lives in `terminal-threads.test.ts`, which drives a real fake
 * daemon over a Unix socket. These are the decisions that are easier to pin down exactly: which
 * calls are made, in what order, and above all which are NOT made.
 */

const thread = (over: Partial<Thread> & { id: string }): Thread => ({
  preview: '',
  cwd: '/tmp/project',
  createdAt: 0,
  updatedAt: 0,
  status: { type: 'idle' },
  name: null,
  turns: [],
  ...over,
});

interface Harness {
  mirror: TerminalThreadMirror;
  calls: Array<{ method: string; params: unknown }>;
  threads: MirroredThread[];
  frames: Array<{ threadId: string; frames: MappedFrame[] }>;
  now: { ms: number };
}

function harness(
  respond: (method: string, params: unknown) => unknown,
  over: Partial<Parameters<typeof TerminalThreadMirror.prototype.constructor>[0]> = {},
): Harness {
  const calls: Array<{ method: string; params: unknown }> = [];
  const threads: MirroredThread[] = [];
  const frames: Array<{ threadId: string; frames: MappedFrame[] }> = [];
  const now = { ms: 1_000_000 };
  const mirror = new TerminalThreadMirror({
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      const out = respond(method, params);
      if (out instanceof Error) throw out;
      return out as T;
    },
    isOurs: () => false,
    onThread: (t) => threads.push(t),
    onFrames: (threadId, f) => frames.push({ threadId, frames: f }),
    logger: new FileLogger(null),
    nowMs: () => now.ms,
    ...over,
  });
  return { mirror, calls, threads, frames, now };
}

const listOf = (...data: Thread[]) => ({ data, nextCursor: null });

describe('discovery', () => {
  it('follows the cursor instead of reading only the first page', async () => {
    const h = harness((method, params) => {
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
      if (method === 'thread/list') {
        const cursor = (params as { cursor?: string }).cursor;
        return cursor
          ? { data: [thread({ id: 'b' })], nextCursor: null }
          : { data: [thread({ id: 'a' })], nextCursor: '1' };
      }
      return {};
    });
    await h.mirror.discover();
    expect(h.mirror.list().map((t) => t.threadId)).toEqual(['a', 'b']);
    // Nothing was resumed: neither thread is loaded in this server, so both are read-only.
    expect(h.calls.filter((c) => c.method === 'thread/resume')).toHaveLength(0);
  });

  it('asks the state DB rather than rescanning rollouts', async () => {
    const h = harness((method) =>
      method === 'thread/list' ? listOf() : { data: [], nextCursor: null },
    );
    await h.mirror.discover();
    const list = h.calls.find((c) => c.method === 'thread/list');
    expect(list?.params).toMatchObject({ useStateDbOnly: true });
  });

  it('subscribes to a daemon-hosted thread by resuming it', async () => {
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: ['tui-1'], nextCursor: null };
      if (method === 'thread/list') return listOf(thread({ id: 'tui-1' }));
      return {};
    });
    await h.mirror.discover();
    expect(h.calls.map((c) => c.method)).toContain('thread/resume');
    expect(h.mirror.get('tui-1')?.subscribed).toBe(true);
    expect(h.mirror.get('tui-1')?.hosting).toBe('daemon');
  });

  it('picks up a loaded thread that `thread/list` does not show yet', async () => {
    // A thread has no list entry until its first user message, which is exactly when a TUI
    // thread is worth mirroring.
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: ['fresh'], nextCursor: null };
      if (method === 'thread/list') return listOf();
      return {};
    });
    await h.mirror.discover();
    expect(h.mirror.get('fresh')?.hosting).toBe('daemon');
  });

  it('demotes a writer-locked thread to read-only polling and stops resuming it', async () => {
    let resumes = 0;
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: ['owned'], nextCursor: null };
      if (method === 'thread/list') return listOf(thread({ id: 'owned' }));
      if (method === 'thread/resume') {
        resumes++;
        return new Error(
          'thread/resume failed: thread owned already has an active writer (-32600)',
        );
      }
      if (method === 'thread/read') return { thread: thread({ id: 'owned' }) };
      return {};
    });
    await h.mirror.discover();
    expect(h.mirror.get('owned')?.hosting).toBe('foreign');
    expect(h.mirror.get('owned')?.subscribed).toBe(false);
    await h.mirror.discover();
    // `thread/loaded/list` still names it, but we know better than to grab at the lock again.
    expect(resumes).toBe(1);
  });

  it('retries a thread that has no first user message yet', async () => {
    let resumes = 0;
    let materialized = false;
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: ['fresh'], nextCursor: null };
      if (method === 'thread/list') return listOf(thread({ id: 'fresh' }));
      if (method === 'thread/resume') {
        resumes++;
        if (!materialized)
          return new Error('thread/resume failed: no rollout found for thread id fresh (-32600)');
        return { thread: thread({ id: 'fresh' }) };
      }
      return {};
    });
    await h.mirror.discover();
    expect(h.mirror.get('fresh')?.subscribed).toBe(false);
    materialized = true;
    await h.mirror.discover();
    expect(resumes).toBe(2);
    expect(h.mirror.get('fresh')?.subscribed).toBe(true);
  });

  it('never touches a thread this bridge started', async () => {
    const calls: string[] = [];
    const mirror = new TerminalThreadMirror({
      request: async <T>(method: string): Promise<T> => {
        calls.push(method);
        return (
          method === 'thread/list'
            ? listOf(thread({ id: 'ours' }))
            : { data: ['ours'], nextCursor: null }
        ) as T;
      },
      isOurs: (id) => id === 'ours',
      onThread: () => {
        throw new Error('adopted a thread we started');
      },
      onFrames: () => {},
      logger: new FileLogger(null),
    });
    await mirror.discover();
    expect(mirror.list()).toEqual([]);
    expect(calls).not.toContain('thread/resume');
  });
});

describe('idle unsubscribe', () => {
  it('lets a quiet thread go, so its writer lock is not held on our account', async () => {
    const h = harness(
      (method) => {
        if (method === 'thread/loaded/list') return { data: ['tui-1'], nextCursor: null };
        if (method === 'thread/list') return listOf(thread({ id: 'tui-1' }));
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
        return {};
      },
      { idleUnsubscribeMs: 5 * 60_000 },
    );
    await h.mirror.discover();
    expect(h.mirror.get('tui-1')?.subscribed).toBe(true);

    h.now.ms += 4 * 60_000;
    await h.mirror.sweep();
    expect(h.calls.map((c) => c.method)).not.toContain('thread/unsubscribe');

    h.now.ms += 2 * 60_000;
    await h.mirror.sweep();
    expect(h.calls.map((c) => c.method)).toContain('thread/unsubscribe');
    expect(h.mirror.get('tui-1')?.subscribed).toBe(false);
  });

  it('keeps a busy thread: activity restarts the clock', async () => {
    const h = harness(
      (method) => {
        if (method === 'thread/loaded/list') return { data: ['tui-1'], nextCursor: null };
        if (method === 'thread/list') return listOf(thread({ id: 'tui-1' }));
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
        return {};
      },
      { idleUnsubscribeMs: 60_000 },
    );
    await h.mirror.discover();
    h.now.ms += 50_000;
    h.mirror.noteActivity('tui-1');
    h.now.ms += 50_000;
    await h.mirror.sweep();
    expect(h.calls.map((c) => c.method)).not.toContain('thread/unsubscribe');
  });

  it('hands every subscription back when it stops', async () => {
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: ['tui-1'], nextCursor: null };
      if (method === 'thread/list') return listOf(thread({ id: 'tui-1' }));
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      return {};
    });
    await h.mirror.discover();
    await h.mirror.stop();
    expect(h.calls.filter((c) => c.method === 'thread/unsubscribe')).toHaveLength(1);
  });
});

describe('read-only polling', () => {
  const foreign = (turns: Thread['turns']) =>
    thread({ id: 'owned', status: { type: 'active', activeFlags: [] }, turns });

  async function pollingHarness(turnsRef: { turns: Thread['turns'] }): Promise<Harness> {
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
      if (method === 'thread/list')
        return listOf(thread({ id: 'owned', status: { type: 'active', activeFlags: [] } }));
      if (method === 'thread/read') return { thread: foreign(turnsRef.turns) };
      return {};
    });
    await h.mirror.discover();
    return h;
  }

  it('turns the items it has not seen into frames, once', async () => {
    const turnsRef = {
      turns: [
        {
          id: 'turn-1',
          status: 'completed' as const,
          error: null,
          items: [
            { type: 'agentMessage', id: 'item-1', text: 'one' },
            { type: 'agentMessage', id: 'item-2', text: 'two' },
          ],
        },
      ],
    };
    const h = await pollingHarness(turnsRef);
    await h.mirror.sweep();
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.frames.map((f) => f.providerRecordId)).toEqual(['turn-1#0', 'turn-1#1']);

    // A second read returns the same thread; nothing new must come out of it.
    await h.mirror.sweep();
    expect(h.frames).toHaveLength(1);

    turnsRef.turns[0]?.items.push({ type: 'agentMessage', id: 'item-3', text: 'three' });
    await h.mirror.sweep();
    expect(h.frames[1]?.frames.map((f) => f.providerRecordId)).toEqual(['turn-1#2']);
  });

  it('holds back the last item of a turn that is still running', async () => {
    const turnsRef = {
      turns: [
        {
          id: 'turn-1',
          status: 'inProgress' as const,
          error: null,
          items: [
            { type: 'agentMessage', id: 'item-1', text: 'settled' },
            {
              type: 'commandExecution',
              id: 'item-2',
              command: 'pnpm test',
              status: 'inProgress',
              aggregatedOutput: 'partial',
            },
          ],
        },
      ],
    };
    const h = await pollingHarness(turnsRef);
    await h.mirror.sweep();
    expect(h.frames[0]?.frames.map((f) => f.body.kind)).toEqual(['assistant']);

    // The command finishes: now it is safe to send, with its whole output.
    const turn = turnsRef.turns[0];
    if (turn) {
      turn.status = 'completed' as never;
      turn.items[1] = {
        type: 'commandExecution',
        id: 'item-2',
        command: 'pnpm test',
        status: 'completed',
        aggregatedOutput: 'partial and the rest',
        exitCode: 0,
      };
    }
    await h.mirror.sweep();
    expect(h.frames[1]?.frames[0]?.body).toMatchObject({
      kind: 'terminal',
      stdout: 'partial and the rest',
    });
  });

  it('says nothing about a thread that is not materialized yet', async () => {
    const h = harness((method) => {
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
      if (method === 'thread/list')
        return listOf(thread({ id: 'fresh', status: { type: 'active', activeFlags: [] } }));
      if (method === 'thread/read')
        return new Error('thread/read failed: thread fresh is not materialized yet (-32600)');
      return {};
    });
    await h.mirror.discover();
    await h.mirror.sweep();
    expect(h.frames).toEqual([]);
  });

  it('stops polling a foreign thread once it has been idle long enough', async () => {
    const h = harness(
      (method) => {
        if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
        if (method === 'thread/list') return listOf(thread({ id: 'owned' })); // idle
        if (method === 'thread/read') return { thread: thread({ id: 'owned' }) };
        return {};
      },
      { idleUnsubscribeMs: 60_000 },
    );
    await h.mirror.discover();
    await h.mirror.sweep();
    expect(h.calls.filter((c) => c.method === 'thread/read')).toHaveLength(1);
    h.now.ms += 120_000;
    await h.mirror.sweep();
    expect(h.calls.filter((c) => c.method === 'thread/read')).toHaveLength(1);
  });
});

describe('timers', () => {
  it('arms discovery and the sweep, and never holds the process open', async () => {
    vi.useFakeTimers();
    try {
      const h = harness((method) =>
        method === 'thread/list' ? listOf() : { data: [], nextCursor: null },
      );
      h.mirror.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.calls.filter((c) => c.method === 'thread/list').length).toBeGreaterThan(0);
      await h.mirror.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
