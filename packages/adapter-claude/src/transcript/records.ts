import { z } from 'zod';
import { MAX_PERSISTED_OUTPUT_BYTES, readPersistedOutput } from '../diffs.js';
import {
  type AssistantBlock,
  parseStreamRecord,
  type StreamRecord,
  type UserBlock,
} from '../stream-json.js';

/**
 * The on-disk transcript, parsed the way another program's file has to be parsed: permissively.
 *
 * `~/.claude/projects/<encoded cwd>/<session>.jsonl` is Claude Code's own record format. It is not
 * a documented interface, it gains record types between releases, and the mirror reads it on a
 * machine whose `claude` can be updated at any moment. So the contract here is deliberately weak:
 * every line must be an object with a string `type`, and nothing else is required. A line that
 * fails even that is skipped; a `type` this version has no frame for is skipped and COUNTED, so a
 * new record type shows up in `pagr doctor` as a number instead of as silence.
 *
 * The content itself is the same shape as the stream-json wire format — the records are the same
 * objects plus an envelope (`uuid`, `parentUuid`, `cwd`, `sessionId`, `isSidechain`, `isMeta`) and
 * `toolUseResult` in camelCase — so `parseStreamRecord` does the block-level work and this module
 * only adds the envelope. One parser, one set of block semantics, whichever way the bytes arrived.
 */

/** The weakest thing a transcript line must be. Everything else is read off `raw`. */
const Line = z.object({ type: z.string().min(1) }).passthrough();

/**
 * Record types this version knows about and deliberately makes no frame for.
 *
 * They are real and they are not news: a file-history snapshot is Claude's undo buffer, a
 * `pr-link` is a URL it remembered, `mode` is a UI state change. Listing them is what lets the
 * unknown-type counter mean "Claude Code started writing something new", which is the only
 * reason to have the counter at all.
 */
export const IGNORED_RECORD_TYPES: ReadonlySet<string> = new Set([
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'pr-link',
  'mode',
  'relocated',
  'ai-title',
  'last-prompt',
]);

export type TranscriptBody =
  | { kind: 'assistant'; blocks: AssistantBlock[] }
  | { kind: 'user'; blocks: UserBlock[]; toolUseResult?: unknown }
  | { kind: 'system'; subtype: string; text: string }
  | { kind: 'summary'; summary: string; leafUuid?: string }
  | { kind: 'custom-title'; title: string }
  | { kind: 'agent-name'; name: string }
  | { kind: 'queue-operation'; operation: string }
  /** A type this version knows about and makes no frame for. */
  | { kind: 'ignored' }
  /** A type this version has never seen. Counted once, never a failure. */
  | { kind: 'unknown' };

export interface TranscriptRecord {
  /** The raw `type` string, kept verbatim so the unknown-type counter can name it. */
  type: string;
  body: TranscriptBody;
  /** Claude's own id for the line. The mirror's dedupe key, so a re-tail costs no new frames. */
  uuid?: string;
  parentUuid?: string | null;
  /** The session the line belongs to — the truth, over any file name. */
  sessionId?: string;
  /** The working directory, from the record. The encoded directory name is lossy; this is not. */
  cwd?: string;
  timestamp?: string;
  /** A subagent's own turn. Its frames hang off the Task call, not off the main thread. */
  isSidechain: boolean;
  /** Bookkeeping Claude wrote for itself (`<command-name>` blocks, hook echoes). Never a frame. */
  isMeta: boolean;
  /** The summary written when a conversation was compacted. */
  isCompactSummary: boolean;
  /** Shown in Claude's own transcript view only; never part of what the model was sent. */
  isVisibleInTranscriptOnly: boolean;
  raw: Record<string, unknown>;
}

const bool = (v: unknown): boolean => v === true;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * One transcript line → one record, or null when the line is not a record at all.
 *
 * Null covers a blank line, a half-written tail (the tailer holds partial lines back, but a
 * truncated file can still leave one), and anything that is not a JSON object with a `type`.
 */
export function parseTranscriptRecord(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const checked = Line.safeParse(parsed);
  if (!checked.success) return null;
  const raw = checked.data as Record<string, unknown>;
  return {
    type: raw.type as string,
    body: bodyOf(raw, trimmed),
    ...(str(raw.uuid) ? { uuid: raw.uuid as string } : {}),
    ...(raw.parentUuid !== undefined
      ? { parentUuid: (str(raw.parentUuid) ?? null) as string }
      : {}),
    ...(str(raw.sessionId) ? { sessionId: raw.sessionId as string } : {}),
    ...(str(raw.cwd) ? { cwd: raw.cwd as string } : {}),
    ...(str(raw.timestamp) ? { timestamp: raw.timestamp as string } : {}),
    isSidechain: bool(raw.isSidechain),
    isMeta: bool(raw.isMeta),
    isCompactSummary: bool(raw.isCompactSummary),
    isVisibleInTranscriptOnly: bool(raw.isVisibleInTranscriptOnly),
    raw,
  };
}

/**
 * The typed half. `user`, `assistant` and `system` go through `parseStreamRecord` so the block
 * semantics are shared with the stdio path verbatim; the rest are small enough to narrow here.
 */
function bodyOf(raw: Record<string, unknown>, line: string): TranscriptBody {
  switch (raw.type) {
    case 'assistant':
    case 'user':
    case 'system': {
      const rec: StreamRecord = parseStreamRecord(line);
      if (rec.type === 'assistant_blocks') return { kind: 'assistant', blocks: rec.blocks };
      if (rec.type === 'user_blocks')
        return {
          kind: 'user',
          blocks: rec.blocks,
          ...(rec.toolUseResult !== undefined ? { toolUseResult: rec.toolUseResult } : {}),
        };
      if (rec.type === 'system') return { kind: 'system', subtype: rec.subtype, text: rec.text };
      // `system`/`subtype:init` collapses to `init` on the wire; on disk it carries no blocks.
      if (rec.type === 'init') return { kind: 'system', subtype: 'init', text: '' };
      return { kind: 'ignored' };
    }
    case 'summary':
      return {
        kind: 'summary',
        summary: str(raw.summary) ?? '',
        ...(str(raw.leafUuid) ? { leafUuid: raw.leafUuid as string } : {}),
      };
    case 'custom-title':
      return { kind: 'custom-title', title: str(raw.title) ?? str(raw.customTitle) ?? '' };
    case 'agent-name':
      return { kind: 'agent-name', name: str(raw.name) ?? str(raw.agentName) ?? '' };
    case 'queue-operation':
      return { kind: 'queue-operation', operation: str(raw.operation) ?? '' };
    default:
      return IGNORED_RECORD_TYPES.has(String(raw.type)) ? { kind: 'ignored' } : { kind: 'unknown' };
  }
}

/**
 * Record types seen that this version has no frame for, counted once each per daemon lifetime.
 *
 * "Once per type" is the whole design: a Claude Code release that adds a record type writes it on
 * every line of every session, and a log line per occurrence would drown the daemon log in the
 * one situation where somebody needs to read it.
 */
export class UnknownRecordTypes {
  private readonly seen = new Map<string, number>();

  /** Count it. True only the first time this type is seen — the caller logs on true. */
  note(type: string): boolean {
    const prior = this.seen.get(type) ?? 0;
    this.seen.set(type, prior + 1);
    return prior === 0;
  }

  get size(): number {
    return this.seen.size;
  }

  counts(): Record<string, number> {
    return Object.fromEntries([...this.seen.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** Subagent sidecar (`agent-<id>.meta.json`). Every field optional: it is another program's file. */
export const SubagentMeta = z
  .object({
    agentType: z.string().optional(),
    description: z.string().optional(),
    /** The `Task` call this subagent belongs to — the frame its transcript hangs from. */
    toolUseId: z.string().optional(),
    spawnDepth: z.number().int().nonnegative().max(8).optional(),
  })
  .passthrough();
export type SubagentMeta = z.infer<typeof SubagentMeta>;

export function parseSubagentMeta(text: string): SubagentMeta | null {
  try {
    const parsed = SubagentMeta.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A spilled tool output, read back in full.
 *
 * `persistedOutputPath` is a path out of another program's JSON, so it is treated as a value from
 * outside this process: `readPersistedOutput` resolves it through `realpath` and refuses anything
 * that does not land under `~/.claude/projects`, then keeps at most the last 4 MiB. Re-exported
 * here so the transcript mirror has one door to the filesystem and it is the vetted one.
 */
export function readSpilledOutput(filePath: string, home: string): string | null {
  return readPersistedOutput(filePath, { home, maxBytes: MAX_PERSISTED_OUTPUT_BYTES });
}
