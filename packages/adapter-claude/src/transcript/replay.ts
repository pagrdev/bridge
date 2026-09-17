import type { FrameBody, JournalMeta, ReplayFrame } from '@pagr/bridge-core';
import {
  asToolUseResult,
  type ClaudeToolUseResult,
  diffBodyFor,
  EDIT_TOOLS,
  terminalBodyFor,
} from '../diffs.js';
import {
  type AssistantBlock,
  actionTypeForTool,
  blockFrameId,
  mapToolKind,
  previewForTool,
  type UserBlock,
} from '../stream-json.js';
import { readSpilledOutput, type TranscriptRecord } from './records.js';
import { type TailedRecord, TailerStateStore, TranscriptTailer } from './tailer.js';

/**
 * A Claude transcript, read once, whole, into frames.
 *
 * The mirror follows a transcript forever and emits as it goes. A backfill wants the opposite: one
 * pass over everything Claude has ever written for a session, right now, with no watches left
 * behind and no state written down — the journal, not `tailer-state.json`, is what remembers a
 * backfill happened, because the journal is what dedupes it.
 *
 * So the tailer is reused in one-shot mode: a `TailerStateStore(null)` keeps its offsets in
 * memory, one `poll()` reads every file of the session from byte zero, and `stop()` throws the
 * whole thing away. That is deliberately the SAME reader the live path uses — superseded variants,
 * subagent transcripts, half-written lines and inode changes are all somebody else's solved
 * problem — so a replayed session and a mirrored one cannot drift.
 *
 * The record → frame mapping below is the mirror's, in the same order and with the same
 * `providerRecordId`s, which is what makes replaying a session this bridge already streamed cost
 * zero new frames (the journal dedupes every one of them). It is written out here rather than
 * called into `ClaudeMirror` because the mirror's copy is bound to a live `MirroredSession`;
 * unifying the two is a refactor, not a backfill.
 */

export interface TranscriptReplayOptions {
  /** `$HOME` holding `.claude`. Tests point this at a temp directory; never the real one. */
  home: string;
  /** The session's working directory, which decides the encoded project directory name. */
  cwd: string;
  claudeSessionId: string;
  /** The registered project root, for the tool-call titles. Falls back to `cwd`. */
  projectPath?: string;
  /** Include the session's subagent transcripts. Default true, as the mirror does. */
  subagents?: boolean;
}

/** Tool calls one replay remembers while waiting for their results. */
export const MAX_REPLAY_TOOL_CALLS = 4096;

/**
 * Every frame a Claude session's transcript produces, in file order.
 *
 * Never throws: a transcript that cannot be read is an empty replay, and the caller reports "this
 * Mac has nothing for that session" rather than a stack trace from another program's file format.
 */
export function replayTranscript(o: TranscriptReplayOptions): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  const toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const projectPath = o.projectPath ?? o.cwd;
  const tailer = new TranscriptTailer({
    home: o.home,
    cwd: o.cwd,
    claudeSessionId: o.claudeSessionId,
    // In memory: a replay must not move the live tailer's offsets, or the next mirror poll would
    // skip records it has not emitted.
    state: new TailerStateStore(null),
    onRecord: (t) => {
      for (const f of framesForTailed(t, { home: o.home, projectPath, toolCalls })) out.push(f);
    },
    onError: () => {
      // A file that vanished or cannot be opened contributes nothing; the rest still replay.
    },
    ...(o.subagents !== undefined ? { subagents: o.subagents } : {}),
  });
  try {
    tailer.poll();
  } finally {
    tailer.stop();
  }
  return out;
}

interface ReplayContext {
  home: string;
  projectPath: string;
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>;
}

/** One tailed record → the frames it makes. The mirror's rules, verbatim. */
function framesForTailed(t: TailedRecord, ctx: ReplayContext): ReplayFrame[] {
  const rec = t.record;
  // Claude's own bookkeeping — command echoes, hook output, lines it showed you and never sent to
  // the model. Real, and not a transcript of the work.
  if (rec.isMeta || rec.isVisibleInTranscriptOnly) return [];
  switch (rec.body.kind) {
    case 'assistant':
      return assistantFrames(rec, rec.body.blocks, t, ctx);
    case 'user':
      return userFrames(rec, rec.body.blocks, rec.body.toolUseResult, t, ctx);
    case 'summary':
      if (!rec.isCompactSummary || !rec.body.summary.trim()) return [];
      return [
        frame(
          { kind: 'system', subtype: 'compact_summary', text: rec.body.summary },
          t,
          {},
          rec.uuid,
          rec.timestamp,
        ),
      ];
    default:
      return [];
  }
}

function assistantFrames(
  rec: TranscriptRecord,
  blocks: AssistantBlock[],
  t: TailedRecord,
  ctx: ReplayContext,
): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  blocks.forEach((b, i) => {
    const id = blockFrameId(rec.uuid, i);
    switch (b.type) {
      case 'thinking':
        if (!b.text.trim()) return;
        out.push(frame({ kind: 'thinking', text: b.text }, t, {}, id, rec.timestamp));
        return;
      case 'text':
        if (!b.text.trim()) return;
        out.push(frame({ kind: 'assistant', text: b.text }, t, {}, id, rec.timestamp));
        return;
      case 'tool_use':
        remember(ctx, b.toolUseId, { name: b.name, input: b.input });
        out.push(
          frame(
            {
              kind: 'tool_call',
              toolCallId: b.toolUseId,
              toolName: b.name,
              toolKind: mapToolKind(b.name),
              title: previewForTool(b.name, b.input, ctx.projectPath),
              input: b.input,
            },
            t,
            { parentFrameId: b.toolUseId, actionType: actionTypeForTool(b.name) },
            b.toolUseId,
            rec.timestamp,
          ),
        );
        return;
      default:
        return;
    }
  });
  return out;
}

function userFrames(
  rec: TranscriptRecord,
  blocks: UserBlock[],
  toolUseResult: unknown,
  t: TailedRecord,
  ctx: ReplayContext,
): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  const results = blocks.filter((b) => b.type === 'tool_result');
  // `toolUseResult` describes THE tool call the line carries. On a line with two results there is
  // no way to say which one it belongs to, so it belongs to neither.
  const sidecar = results.length === 1 ? asToolUseResult(toolUseResult) : null;
  const images = blocks.filter((b) => b.type === 'image').length;
  blocks.forEach((b, i) => {
    const id = blockFrameId(rec.uuid, i);
    if (b.type === 'text') {
      if (!b.text.trim()) return;
      out.push(
        frame(
          { kind: 'user', text: b.text, ...(images ? { images } : {}) },
          t,
          {},
          id,
          rec.timestamp,
        ),
      );
      return;
    }
    if (b.type !== 'tool_result') return;
    out.push(
      frame(
        { kind: 'tool_result', toolCallId: b.toolUseId, content: b.content, isError: b.isError },
        t,
        { parentFrameId: b.toolUseId, status: b.isError ? 'error' : 'ok' },
        `${b.toolUseId}:result`,
        rec.timestamp,
      ),
    );
    const call = ctx.toolCalls.get(b.toolUseId);
    if (!call) return;
    if (call.name === 'Bash') {
      const body = terminalBody(b, call.input, sidecar, ctx);
      out.push(
        frame(
          body,
          t,
          {
            parentFrameId: b.toolUseId,
            status: body.interrupted ? 'interrupted' : b.isError ? 'error' : 'ok',
          },
          `${b.toolUseId}:terminal`,
          rec.timestamp,
        ),
      );
      return;
    }
    if (!EDIT_TOOLS.has(call.name)) return;
    const body = diffBodyFor({ toolName: call.name, input: call.input, result: sidecar });
    if (body)
      out.push(
        frame(body, t, { parentFrameId: b.toolUseId }, `${b.toolUseId}:diff`, rec.timestamp),
      );
  });
  return out;
}

function terminalBody(
  res: Extract<UserBlock, { type: 'tool_result' }>,
  input: Record<string, unknown>,
  sidecar: ClaudeToolUseResult | null,
  ctx: ReplayContext,
): Extract<FrameBody, { kind: 'terminal' }> {
  const spillPath = sidecar?.persistedOutputPath;
  const spilled = typeof spillPath === 'string' ? readSpilledOutput(spillPath, ctx.home) : null;
  return terminalBodyFor({
    command: typeof input.command === 'string' ? input.command : '',
    content: res.content,
    isError: res.isError,
    result: sidecar,
    spilled,
  });
}

function remember(
  ctx: ReplayContext,
  id: string,
  call: { name: string; input: Record<string, unknown> },
): void {
  if (!id) return;
  ctx.toolCalls.set(id, call);
  while (ctx.toolCalls.size > MAX_REPLAY_TOOL_CALLS) {
    const oldest = ctx.toolCalls.keys().next();
    if (oldest.done) break;
    ctx.toolCalls.delete(oldest.value);
  }
}

function frame(
  body: FrameBody,
  t: TailedRecord,
  meta: Omit<Partial<JournalMeta>, 'source'>,
  providerRecordId?: string,
  at?: string,
): ReplayFrame {
  const subagent = t.subagent;
  const parentFrameId = meta.parentFrameId ?? t.parentFrameId;
  return {
    body,
    meta: {
      ...meta,
      ...(parentFrameId ? { parentFrameId } : {}),
      ...(subagent ? { subagent } : {}),
      source: 'backfill',
    },
    ...(providerRecordId ? { providerRecordId: scoped(providerRecordId, subagent) } : {}),
    ...(at ? { at } : {}),
  };
}

/**
 * A subagent's ids live in its own transcript, so they are scoped before they become a dedupe key
 * — identically to the mirror, or a backfill of a session the mirror already streamed would
 * journal every subagent frame a second time.
 */
const scoped = (id: string, subagent?: { id: string }): string =>
  subagent ? `agent:${subagent.id}:${id}` : id;
