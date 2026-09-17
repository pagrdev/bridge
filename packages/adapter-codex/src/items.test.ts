import { describe, expect, it, vi } from 'vitest';
import {
  changeKindOf,
  DeltaCoalescer,
  framesForItem,
  framesForTurns,
  type MappedFrame,
  parseUnifiedDiff,
} from './items.js';
import type { ThreadItem } from './protocol.js';

const live = { source: 'app_server' as const, turnId: 'turn_1' };

describe('framesForItem', () => {
  it('maps an agent message to an assistant frame keyed on the item id', () => {
    const frames = framesForItem({ type: 'agentMessage', id: 'it1', text: 'All 12 pass' }, live);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body).toEqual({ kind: 'assistant', text: 'All 12 pass' });
    expect(frames[0]?.meta).toMatchObject({ source: 'app_server', turnId: 'turn_1', final: true });
    expect(frames[0]?.providerRecordId).toBe('it1');
  });

  it('drops an empty agent message rather than sending a blank frame', () => {
    expect(framesForItem({ type: 'agentMessage', id: 'it1', text: '   ' }, live)).toEqual([]);
  });

  it('joins reasoning summary and content into one thinking frame', () => {
    const frames = framesForItem(
      { type: 'reasoning', id: 'r1', summary: ['Weighing options'], content: ['because X'] },
      live,
    );
    expect(frames[0]?.body).toEqual({
      kind: 'thinking',
      text: 'Weighing options\n\nbecause X',
    });
  });

  it('maps a user message, counting images without carrying their bytes', () => {
    const frames = framesForItem(
      {
        type: 'userMessage',
        id: 'u1',
        content: [
          { type: 'text', text: 'look at this', text_elements: [] },
          { type: 'localImage', path: '/tmp/a.png' },
        ],
      },
      live,
    );
    expect(frames[0]?.body).toEqual({ kind: 'user', text: 'look at this', images: 1 });
  });

  it('maps a completed command to one terminal frame with the aggregated output', () => {
    const item: ThreadItem = {
      type: 'commandExecution',
      id: 'c1',
      command: 'pnpm test',
      cwd: '/p',
      status: 'completed',
      aggregatedOutput: 'ok 1\nok 2\n',
      exitCode: 0,
    };
    const frames = framesForItem(item, live);
    expect(frames[0]?.body).toEqual({
      kind: 'terminal',
      command: 'pnpm test',
      stdout: 'ok 1\nok 2\n',
      stderr: '',
      exitCode: 0,
      interrupted: false,
    });
  });

  it('reports an aborted command as interrupted', () => {
    const frames = framesForItem(
      {
        type: 'commandExecution',
        id: 'c1',
        command: 'sleep 100',
        status: 'aborted',
        aggregatedOutput: '',
        exitCode: null,
      },
      live,
    );
    expect(frames[0]?.body).toMatchObject({ interrupted: true });
    expect(frames[0]?.meta).toMatchObject({ status: 'interrupted' });
  });

  it('makes one diff frame per changed file, with the change kind off the item', () => {
    const item: ThreadItem = {
      type: 'fileChange',
      id: 'f1',
      status: 'completed',
      changes: [
        {
          path: '/p/src/app.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,3 @@\n line one\n+added\n line two\n',
        },
        { path: '/p/src/new.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1,1 @@\n+brand new\n' },
      ],
    };
    const frames = framesForItem(item, live);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.body).toMatchObject({
      kind: 'diff',
      path: '/p/src/app.ts',
      changeKind: 'update',
    });
    expect(frames[1]?.body).toMatchObject({
      kind: 'diff',
      path: '/p/src/new.ts',
      changeKind: 'add',
    });
    // Two frames from one item still dedupe independently.
    expect(frames[0]?.providerRecordId).toBe('f1:diff0');
    expect(frames[1]?.providerRecordId).toBe('f1:diff1');
  });

  it('keeps an unparseable diff whole instead of losing it', () => {
    const frames = framesForItem(
      {
        type: 'fileChange',
        id: 'f1',
        changes: [{ path: '/p/a', kind: { type: 'delete' }, diff: 'binary files differ' }],
      },
      live,
    );
    expect(frames[0]?.body).toMatchObject({ newText: 'binary files differ', changeKind: 'delete' });
  });

  it('maps an MCP tool call to a call + result pair', () => {
    const frames = framesForItem(
      {
        type: 'mcpToolCall',
        id: 'm1',
        server: 'github',
        tool: 'list_prs',
        status: 'completed',
        arguments: { repo: 'pagr' },
        result: { content: [{ type: 'text', text: '3 open' }], isError: false },
      },
      live,
    );
    expect(frames.map((f) => f.body.kind)).toEqual(['tool_call', 'tool_result']);
    expect(frames[0]?.body).toMatchObject({
      toolName: 'github/list_prs',
      toolKind: 'other',
      input: { repo: 'pagr' },
    });
    expect(frames[1]?.body).toMatchObject({ content: '3 open', isError: false });
  });

  it('marks a failed dynamic tool call as an error result', () => {
    const frames = framesForItem(
      {
        type: 'dynamicToolCall',
        id: 'd1',
        namespace: 'repl',
        tool: 'run',
        status: 'failed',
        success: false,
        contentItems: [{ type: 'text', text: 'boom' }],
      },
      live,
    );
    expect(frames[0]?.body).toMatchObject({ toolName: 'repl.run' });
    expect(frames[1]?.body).toMatchObject({ isError: true, content: 'boom' });
  });

  it('maps a web search to a fetch-kind tool call', () => {
    const frames = framesForItem(
      { type: 'webSearch', id: 'w1', action: { type: 'search', query: 'codex daemon' } },
      live,
    );
    expect(frames[0]?.body).toMatchObject({ toolKind: 'fetch', title: 'Search: codex daemon' });
  });

  it('produces nothing for an item type it has no mapping for', () => {
    expect(framesForItem({ type: 'contextCompaction', id: 'z1' }, live)).toEqual([]);
  });
});

describe('backfill keys', () => {
  it('keys a backfilled item on (turnId, position), not on the renumbered item id', () => {
    const frames = framesForTurns([
      {
        id: 'turn-1',
        items: [
          { type: 'agentMessage', id: 'item-1', text: 'hello' },
          { type: 'agentMessage', id: 'item-2', text: 'again' },
        ],
      },
    ]);
    expect(frames.map((f) => f.providerRecordId)).toEqual(['turn-1#0', 'turn-1#1']);
    expect(frames.every((f) => f.meta.source === 'backfill')).toBe(true);
  });

  it('gives the same key on a second read, so a backfill run twice adds nothing', () => {
    const turns = [
      { id: 't', items: [{ type: 'agentMessage', id: 'x', text: 'hi' } as ThreadItem] },
    ];
    expect(framesForTurns(turns)[0]?.providerRecordId).toBe(
      framesForTurns(turns)[0]?.providerRecordId,
    );
  });
});

describe('parseUnifiedDiff', () => {
  it('reads the hunk header and its lines', () => {
    const hunks = parseUnifiedDiff('@@ -10,3 +10,4 @@\n a\n+b\n-c\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 });
    expect(hunks[0]?.lines).toEqual([' a', '+b', '-c', '']);
  });

  it('defaults a single-line hunk to a length of one', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n')[0]).toMatchObject({
      oldLines: 1,
      newLines: 1,
    });
  });
});

describe('changeKindOf', () => {
  it('reads the tagged union, and anything unexpected is an update', () => {
    expect(changeKindOf({ path: 'a', kind: { type: 'add' }, diff: '' })).toBe('add');
    expect(changeKindOf({ path: 'a', kind: { type: 'delete' }, diff: '' })).toBe('delete');
    expect(changeKindOf({ path: 'a', kind: { type: 'update', move_path: null }, diff: '' })).toBe(
      'update',
    );
  });
});

describe('DeltaCoalescer', () => {
  it('coalesces on the byte budget and numbers the chunks', () => {
    const out: MappedFrame[] = [];
    const c = new DeltaCoalescer({ emit: (f) => out.push(f), flushBytes: 8, flushMs: 10_000 });
    for (const delta of ['abcd', 'efgh', 'ijkl', 'mnop']) {
      c.push({ owner: 'thr', itemId: 'i1', turnId: 't1', kind: 'assistant', delta });
    }
    expect(out).toHaveLength(2);
    expect(out[0]?.body).toEqual({ kind: 'assistant', text: 'abcdefgh' });
    expect(out[0]?.meta).toMatchObject({ status: 'streaming', final: false });
    expect(out.map((f) => f.providerRecordId)).toEqual(['i1#0', 'i1#1']);
  });

  it('coalesces on the timer when the budget is never reached', () => {
    vi.useFakeTimers();
    try {
      const out: MappedFrame[] = [];
      const c = new DeltaCoalescer({ emit: (f) => out.push(f), flushBytes: 4096, flushMs: 750 });
      c.push({ owner: 'thr', itemId: 'i1', turnId: 't1', kind: 'thinking', delta: 'hm' });
      expect(out).toHaveLength(0);
      vi.advanceTimersByTime(750);
      expect(out[0]?.body).toEqual({ kind: 'thinking', text: 'hm' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the owner back so the caller can route the frame', () => {
    const owners: string[] = [];
    const c = new DeltaCoalescer({ emit: (_f, owner) => owners.push(owner), flushBytes: 1 });
    c.push({ owner: 'thread-9', itemId: 'i', turnId: 't', kind: 'assistant', delta: 'x' });
    expect(owners).toEqual(['thread-9']);
  });

  it('streams command output as terminal chunks that still name the command', () => {
    const out: MappedFrame[] = [];
    const c = new DeltaCoalescer({ emit: (f) => out.push(f), flushBytes: 2 });
    c.push({
      owner: 'thr',
      itemId: 'c1',
      turnId: 't1',
      kind: 'terminal',
      delta: 'ok\n',
      command: 'pnpm test',
    });
    expect(out[0]?.body).toEqual({
      kind: 'terminal',
      command: 'pnpm test',
      stdout: 'ok\n',
      stderr: '',
      interrupted: false,
    });
  });

  it('drops the buffer when the item completes: the final frame carries the whole message', () => {
    vi.useFakeTimers();
    try {
      const out: MappedFrame[] = [];
      const c = new DeltaCoalescer({ emit: (f) => out.push(f), flushMs: 750 });
      c.push({ owner: 'thr', itemId: 'i1', turnId: 't1', kind: 'assistant', delta: 'par' });
      c.finish('i1', 'assistant');
      vi.advanceTimersByTime(5000);
      expect(out).toEqual([]);
      expect(c.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
