import type { DiffHunk, FrameBody, JournalMeta, ToolKind } from '@pagr/bridge-core';
import type { FileUpdateChange, ThreadItem, UserInput } from './protocol.js';

/**
 * Codex `ThreadItem`s → transcript frames.
 *
 * One item can become more than one frame — a `fileChange` is one `diff` per file, a tool call is
 * a `tool_call` and a `tool_result` — so everything here returns a list. Nothing is invented: an
 * item type with no mapping produces nothing at all rather than a `system` frame saying so.
 *
 * `providerRecordId` is what makes a transcript that is read twice produce one frame. Live items
 * carry UUIDv7 ids; `thread/read` renumbers them `item-1`, `item-2`, … (spike finding 7), so a
 * backfill keys on (turnId, position) instead and the two never collide.
 */

export interface MappedFrame {
  body: FrameBody;
  meta: JournalMeta;
  providerRecordId?: string;
}

export interface ItemMapOptions {
  turnId?: string;
  source: 'app_server' | 'backfill';
  /** Position of the item within its turn. Used by the `position` key. */
  index?: number;
  /**
   * What the frame dedupes on. `item` uses the live UUIDv7 item id; `position` uses
   * (turnId, index), which is the only stable key for anything read back through `thread/read`,
   * where ids are renumbered `item-1`, `item-2`, … Defaults to `position` for a backfill.
   */
  key?: 'item' | 'position';
}

/** The id a frame from this item dedupes on, plus a suffix for items that make several. */
export function recordIdFor(item: ThreadItem, o: ItemMapOptions, suffix?: string): string {
  const key = o.key ?? (o.source === 'backfill' ? 'position' : 'item');
  const base = key === 'position' ? `${o.turnId ?? 'turn'}#${o.index ?? 0}` : (item.id ?? 'item');
  return suffix ? `${base}:${suffix}` : base;
}

function metaFor(o: ItemMapOptions, extra: Partial<JournalMeta> = {}): JournalMeta {
  return {
    source: o.source,
    ...(o.turnId ? { turnId: o.turnId } : {}),
    ...extra,
  } as JournalMeta;
}

const textOfInput = (content: UserInput[] | undefined): { text: string; images: number } => {
  let text = '';
  let images = 0;
  for (const c of content ?? []) {
    if (c.type === 'text') text += (text ? '\n' : '') + c.text;
    else if (c.type === 'localImage') images++;
  }
  return { text, images };
};

/** `changes[].kind` is a tagged union upstream; the frame's is a plain three-way. */
export function changeKindOf(change: FileUpdateChange): 'add' | 'update' | 'delete' {
  const kind = change.kind as unknown;
  const type =
    typeof kind === 'string' ? kind : ((kind as { type?: string } | null)?.type ?? 'update');
  return type === 'add' || type === 'delete' ? type : 'update';
}

/**
 * `@@ -a,b +c,d @@` hunks out of the unified diff the app-server already rendered.
 *
 * The bridge does not re-diff anything: Codex ships the patch text with the item, and re-deriving
 * it from the working tree would read files the user never asked us to read. When a diff is in a
 * shape this does not recognise it is kept whole in `newText` — visibly a diff, never a silent
 * loss.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')
      current.lines.push(line);
    else if (line.startsWith('\\'))
      current.lines.push(line); // "\ No newline at end of file"
    else current = null; // a new file header ends the hunk
  }
  return hunks;
}

export function diffFrames(
  item: Extract<ThreadItem, { type: 'fileChange' }>,
  o: ItemMapOptions,
): MappedFrame[] {
  return item.changes.map((change, i) => {
    const hunks = parseUnifiedDiff(change.diff ?? '');
    const body: FrameBody = {
      kind: 'diff',
      path: change.path,
      changeKind: changeKindOf(change),
      ...(hunks.length > 0 ? { hunks } : { newText: change.diff ?? '' }),
    };
    return {
      body,
      meta: metaFor(o, { final: true, status: 'ok' }),
      providerRecordId: recordIdFor(item, o, `diff${i}`),
    };
  });
}

const toolResultText = (parts: Array<{ text?: string }> | null | undefined): string =>
  (parts ?? [])
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n');

function toolFrames(
  item: ThreadItem,
  o: ItemMapOptions,
  spec: {
    toolName: string;
    toolKind: ToolKind;
    title: string;
    input: unknown;
    content: string;
    isError: boolean;
  },
): MappedFrame[] {
  const toolCallId = item.id;
  return [
    {
      body: {
        kind: 'tool_call',
        toolCallId,
        toolName: spec.toolName,
        toolKind: spec.toolKind,
        title: spec.title,
        input: spec.input ?? null,
      },
      meta: metaFor(o, { final: true, status: 'ok' }),
      providerRecordId: recordIdFor(item, o, 'call'),
    },
    {
      body: {
        kind: 'tool_result',
        toolCallId,
        content: spec.content,
        isError: spec.isError,
      },
      meta: metaFor(o, { final: true, status: spec.isError ? 'error' : 'ok' }),
      providerRecordId: recordIdFor(item, o, 'result'),
    },
  ];
}

/** Frames for one COMPLETED item. Streaming deltas are the coalescer's job, not this one's. */
export function framesForItem(item: ThreadItem, o: ItemMapOptions): MappedFrame[] {
  switch (item.type) {
    case 'agentMessage': {
      const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text ?? '';
      if (!text.trim()) return [];
      return [
        {
          body: { kind: 'assistant', text },
          meta: metaFor(o, { final: true, status: 'ok' }),
          providerRecordId: recordIdFor(item, o),
        },
      ];
    }
    case 'reasoning': {
      const r = item as Extract<ThreadItem, { type: 'reasoning' }>;
      const text = [...(r.summary ?? []), ...(r.content ?? [])].filter(Boolean).join('\n\n');
      if (!text.trim()) return [];
      return [
        {
          body: { kind: 'thinking', text },
          meta: metaFor(o, { final: true, status: 'ok' }),
          providerRecordId: recordIdFor(item, o),
        },
      ];
    }
    case 'userMessage': {
      const u = item as Extract<ThreadItem, { type: 'userMessage' }>;
      const { text, images } = textOfInput(u.content);
      if (!text.trim() && images === 0) return [];
      return [
        {
          body: { kind: 'user', text, ...(images ? { images } : {}) },
          meta: metaFor(o, { final: true, status: 'ok' }),
          providerRecordId: recordIdFor(item, o),
        },
      ];
    }
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      const interrupted = c.status === 'aborted';
      return [
        {
          body: {
            kind: 'terminal',
            command: c.command ?? '',
            // The app-server merges the two streams into `aggregatedOutput`; claiming a split
            // it never made would be a lie about where a line came from.
            stdout: c.aggregatedOutput ?? '',
            stderr: '',
            ...(typeof c.exitCode === 'number' ? { exitCode: c.exitCode } : {}),
            interrupted,
          },
          meta: metaFor(o, {
            final: true,
            status: interrupted ? 'interrupted' : c.status === 'failed' ? 'error' : 'ok',
          }),
          providerRecordId: recordIdFor(item, o),
        },
      ];
    }
    case 'fileChange':
      return diffFrames(item as Extract<ThreadItem, { type: 'fileChange' }>, o);
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      const isError = m.error != null || m.result?.isError === true || m.status === 'failed';
      const errText = typeof m.error === 'string' ? m.error : (m.error?.message ?? '');
      return toolFrames(item, o, {
        toolName: `${m.server}/${m.tool}`,
        toolKind: 'other',
        title: `${m.server} · ${m.tool}`,
        input: m.arguments ?? null,
        content: toolResultText(m.result?.content) || errText,
        isError,
      });
    }
    case 'dynamicToolCall': {
      const d = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      const name = d.namespace ? `${d.namespace}.${d.tool}` : d.tool;
      return toolFrames(item, o, {
        toolName: name,
        toolKind: 'other',
        title: name,
        input: d.arguments ?? null,
        content: toolResultText(d.contentItems),
        isError: d.success === false || d.status === 'failed',
      });
    }
    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
      const a = w.action ?? { type: 'other' as const };
      const query =
        a.type === 'search'
          ? (a.query ?? a.queries?.join(', ') ?? '')
          : a.type === 'openPage' || a.type === 'findInPage'
            ? (a.url ?? '')
            : '';
      return toolFrames(item, o, {
        toolName: 'web_search',
        toolKind: 'fetch',
        title: query ? `Search: ${query}` : 'Web search',
        input: a,
        content: query,
        isError: false,
      });
    }
    default:
      return [];
  }
}

/** Every frame in a `thread/read` thread, in order. The B12 backfill reads through this. */
export function framesForTurns(
  turns: Array<{ id: string; items?: ThreadItem[] }>,
  source: 'app_server' | 'backfill' = 'backfill',
): MappedFrame[] {
  const out: MappedFrame[] = [];
  for (const turn of turns) {
    const items = turn.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      out.push(...framesForItem(item, { turnId: turn.id, source, index: i }));
    }
  }
  return out;
}

// ---------- streaming ----------

/** Coalescing budget: a frame every 750 ms, or every 2 KiB, whichever comes first. */
export const STREAM_FLUSH_MS = 750;
export const STREAM_FLUSH_BYTES = 2048;

type StreamKind = 'assistant' | 'thinking' | 'terminal';

interface Stream {
  kind: StreamKind;
  /** Opaque owner tag (the thread id): handed back on flush so the caller can route the frame. */
  owner: string;
  turnId: string;
  buffer: string;
  /** How many streaming frames this item has already produced: the `#n` in the record id. */
  emitted: number;
  timer: NodeJS.Timeout | null;
  /** `commandExecution` only: the command line, so a chunk frame is still self-describing. */
  command?: string;
}

export interface CoalescerOptions {
  emit(frame: MappedFrame, owner: string): void;
  flushMs?: number;
  flushBytes?: number;
}

/**
 * Deltas → streaming frames.
 *
 * A token-by-token `item/agentMessage/delta` stream is one sealed envelope per token if it is
 * relayed naively, so deltas accumulate and leave on a timer or a byte budget. Each streaming
 * frame carries `meta.status: 'streaming'` and `providerRecordId = <itemId>#<n>`, so the phone
 * can append them in order; the `item/completed` that follows produces the whole message once
 * more with `meta.final = true`, which REPLACES the stream rather than adding to it.
 */
export class DeltaCoalescer {
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly o: CoalescerOptions) {}

  private key(itemId: string, kind: StreamKind): string {
    return `${kind}:${itemId}`;
  }

  push(input: {
    owner: string;
    itemId: string;
    turnId: string;
    kind: StreamKind;
    delta: string;
    command?: string;
  }): void {
    const key = this.key(input.itemId, input.kind);
    let s = this.streams.get(key);
    if (!s) {
      s = {
        kind: input.kind,
        owner: input.owner,
        turnId: input.turnId,
        buffer: '',
        emitted: 0,
        timer: null,
      };
      if (input.command) s.command = input.command;
      this.streams.set(key, s);
    }
    if (input.command && !s.command) s.command = input.command;
    s.buffer += input.delta;
    if (Buffer.byteLength(s.buffer, 'utf8') >= (this.o.flushBytes ?? STREAM_FLUSH_BYTES)) {
      this.flush(input.itemId, input.kind);
      return;
    }
    if (!s.timer) {
      s.timer = setTimeout(
        () => this.flush(input.itemId, input.kind),
        this.o.flushMs ?? STREAM_FLUSH_MS,
      );
      s.timer.unref?.();
    }
  }

  /** Emit what has accumulated for one item, if anything has. */
  flush(itemId: string, kind: StreamKind): void {
    const key = this.key(itemId, kind);
    const s = this.streams.get(key);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const text = s.buffer;
    s.buffer = '';
    if (text === '') return;
    const n = s.emitted++;
    const body: FrameBody =
      kind === 'terminal'
        ? {
            kind: 'terminal',
            command: s.command ?? '',
            stdout: text,
            stderr: '',
            interrupted: false,
          }
        : { kind, text };
    this.o.emit(
      {
        body,
        meta: { source: 'app_server', turnId: s.turnId, status: 'streaming', final: false },
        providerRecordId: `${itemId}#${n}`,
      },
      s.owner,
    );
  }

  /** The item finished: drop what is buffered, because the final frame carries the whole thing. */
  finish(itemId: string, kind: StreamKind): void {
    const key = this.key(itemId, kind);
    const s = this.streams.get(key);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.streams.delete(key);
  }

  /** True while any item is mid-stream. */
  get size(): number {
    return this.streams.size;
  }

  clear(): void {
    for (const s of this.streams.values()) if (s.timer) clearTimeout(s.timer);
    this.streams.clear();
  }
}
