import type { ToolKind } from '@pagr/bridge-core';
import { relativizePaths } from './heuristics.js';
/**
 * Parser for Claude Code `--output-format stream-json` lines (Claude Code 2.1.220, verified
 * 2026-08-24 against real output + https://code.claude.com/docs/en/headless; block fidelity and
 * `tool_use_result` re-verified 2026-09-17 against a live `--verbose` run).
 *
 * Shapes observed on the wire:
 *   {"type":"system","subtype":"init","session_id":"…","cwd":"…","tools":[…]}
 *   {"type":"system","subtype":"hook_started"|"hook_response"|"notification"|"thinking_tokens",…}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"…"} |
 *        {"type":"tool_use","id":"toolu_…","name":"Bash","input":{…}} | {"type":"thinking",…}]},…}
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"…",
 *        "content":"…","is_error":false}]},"tool_use_result":{…},"uuid":"…","timestamp":"…"}
 *   {"type":"result","subtype":"success"|"error_*","is_error":bool,"result":"…","session_id":"…",
 *        "num_turns":n,"total_cost_usd":…}
 *   With `--permission-prompt-tool stdio` (SDK control protocol):
 *   {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"Write",
 *        "input":{…},"tool_use_id":"toolu_…","permission_suggestions":[…]}}
 *   {"type":"control_cancel_request","request_id":"…"}
 *
 * Two views of the same line:
 *
 *   - `parseStreamRecord` — EVERY content block, in order, plus the line's own `uuid`, `timestamp`
 *     and (on a `user` line) the `tool_use_result` sidecar. This is what the frame path reads: a
 *     turn's thinking, its second and third tool call and the bodies of its results are all things
 *     the phone is entitled to see, and the old parser threw them away.
 *   - `parseStreamLine` — the original one-event-per-line view, derived from the record. It still
 *     collapses an assistant message to `tools[0]` or its joined text, because that is exactly
 *     what the clipped `session.event` summaries want, and every existing caller reads it.
 *
 * `tool_use_result` (snake_case on the wire; `toolUseResult` in the on-disk transcript) is the same
 * object in both places — `{stdout, stderr, interrupted, …}` for Bash, `{structuredPatch,
 * originalFile, oldString, newString, replaceAll, …}` for Edit, `{content, filePath,
 * structuredPatch, originalFile, type:'create'}` for Write. Verified 2026-09-17 on 2.1.220 with
 * `--verbose`, which is a flag the bridge already passes, so diffs and terminal output need no
 * transcript read in the normal case (see `diffs.ts` for the fallback that covers the abnormal one).
 */

// ---------- blocks ----------

/** One block of an `assistant` message. Unknown block types survive as `other`, never dropped. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'other'; blockType: string };

/** One block of a `user` message: a tool's output, the person's own words, or an image. */
export type UserBlock =
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { type: 'text'; text: string }
  | { type: 'image' }
  | { type: 'other'; blockType: string };

/**
 * One entry of `permission_suggestions` on a `can_use_tool` control request: a permission rule
 * Claude is offering to persist if the user says "always". Opaque to Pagr on purpose — the shape
 * is Claude's, it is echoed back verbatim as `updatedPermissions`, and nothing here reads inside.
 */
export type PermissionSuggestion = Record<string, unknown>;

/** Every line shape, with nothing collapsed. */
export type StreamRecord =
  | { type: 'init'; sessionId: string; raw: Record<string, unknown> }
  | { type: 'system'; subtype: string; text: string; raw: Record<string, unknown> }
  | {
      type: 'assistant_blocks';
      blocks: AssistantBlock[];
      uuid?: string;
      at?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'user_blocks';
      blocks: UserBlock[];
      /** Claude's own structured result for the tool, when the line carried one. */
      toolUseResult?: unknown;
      uuid?: string;
      at?: string;
      raw: Record<string, unknown>;
    }
  | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null }
  | {
      type: 'permission_request';
      requestId: string;
      toolUseId: string | null;
      toolName: string;
      input: Record<string, unknown>;
      /**
       * Present (and non-empty) only when Claude offered rules to persist. That is exactly when
       * an "allow always" means anything, so it is what the option list is built from.
       */
      suggestions?: PermissionSuggestion[];
    }
  | { type: 'permission_cancel'; requestId: string }
  | { type: 'other'; raw: Record<string, unknown> }
  | { type: 'invalid'; line: string };

/** The original, collapsed view. Derived from `StreamRecord`; unchanged for every caller. */
export type StreamEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null }
  | {
      type: 'permission_request';
      requestId: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions?: PermissionSuggestion[];
    }
  | { type: 'permission_cancel'; requestId: string }
  | { type: 'other'; raw: Record<string, unknown> }
  | { type: 'invalid'; line: string };

// ---------- the record parser ----------

export function parseStreamRecord(line: string): StreamRecord {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'invalid', line };
  let m: unknown;
  try {
    m = JSON.parse(trimmed);
  } catch {
    return { type: 'invalid', line };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { type: 'invalid', line };
  const o = m as Record<string, unknown>;
  const uuid = typeof o.uuid === 'string' ? o.uuid : undefined;
  const at = typeof o.timestamp === 'string' ? o.timestamp : undefined;
  switch (o.type) {
    case 'system': {
      if (o.subtype === 'init' && typeof o.session_id === 'string')
        return { type: 'init', sessionId: o.session_id, raw: o };
      // Every other subtype — `hook_started`, `hook_response`, `notification`, `thinking_tokens`,
      // `compact_boundary` — is a real thing that happened in the session, so it is named rather
      // than lumped into `other`. The text is whatever human-readable field the subtype carries.
      return {
        type: 'system',
        subtype: String(o.subtype ?? 'unknown'),
        text: systemText(o),
        raw: o,
      };
    }
    case 'assistant':
      return {
        type: 'assistant_blocks',
        blocks: contentOf(o).map(assistantBlock),
        ...(uuid ? { uuid } : {}),
        ...(at ? { at } : {}),
        raw: o,
      };
    case 'user': {
      const sidecar = o.tool_use_result ?? o.toolUseResult;
      return {
        type: 'user_blocks',
        blocks: contentOf(o).map(userBlock),
        ...(sidecar !== undefined ? { toolUseResult: sidecar } : {}),
        ...(uuid ? { uuid } : {}),
        ...(at ? { at } : {}),
        raw: o,
      };
    }
    case 'result':
      return {
        type: 'result',
        ok: o.is_error !== true && o.subtype === 'success',
        subtype: String(o.subtype ?? 'unknown'),
        text: typeof o.result === 'string' ? o.result : '',
        sessionId: typeof o.session_id === 'string' ? o.session_id : null,
      };
    case 'control_request': {
      const req = (o.request ?? {}) as Record<string, unknown>;
      if (req.subtype !== 'can_use_tool') return { type: 'other', raw: o };
      const suggestions = Array.isArray(req.permission_suggestions)
        ? (req.permission_suggestions.filter(
            (x) => x !== null && typeof x === 'object',
          ) as PermissionSuggestion[])
        : [];
      return {
        type: 'permission_request',
        requestId: String(o.request_id ?? ''),
        toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : null,
        toolName: String(req.tool_name ?? 'tool'),
        input: (req.input && typeof req.input === 'object' ? req.input : {}) as Record<
          string,
          unknown
        >,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      };
    }
    case 'control_cancel_request':
      return { type: 'permission_cancel', requestId: String(o.request_id ?? '') };
    default:
      return { type: 'other', raw: o };
  }
}

function assistantBlock(c: Record<string, unknown>): AssistantBlock {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: typeof c.text === 'string' ? c.text : '' };
    case 'thinking':
      // `signature` rides along and is a model artefact, not something anyone reads. Dropped.
      return { type: 'thinking', text: typeof c.thinking === 'string' ? c.thinking : '' };
    case 'tool_use':
      return {
        type: 'tool_use',
        toolUseId: String(c.id ?? ''),
        name: String(c.name ?? 'tool'),
        input: (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>,
      };
    default:
      return { type: 'other', blockType: String(c.type ?? 'unknown') };
  }
}

function userBlock(c: Record<string, unknown>): UserBlock {
  switch (c.type) {
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: String(c.tool_use_id ?? ''),
        isError: c.is_error === true,
        content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''),
      };
    case 'text':
      return { type: 'text', text: typeof c.text === 'string' ? c.text : '' };
    case 'image':
      // The bytes are never journaled, sealed or logged: only the fact that one rode along.
      return { type: 'image' };
    default:
      return { type: 'other', blockType: String(c.type ?? 'unknown') };
  }
}

/** Whatever a non-`init` system line says in words, if it says anything. */
function systemText(o: Record<string, unknown>): string {
  for (const k of ['message', 'text', 'notification', 'hook_name', 'title']) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

// ---------- the derived, collapsed view ----------

/**
 * Collapse a record into the legacy one-event view.
 *
 * This is the lossy half on purpose: `session.event` summaries are one clipped line each, and a
 * turn that called three tools still only needs the first one named. Everything the collapse
 * throws away is carried by the record, which is what the frame path reads.
 */
export function legacyEvent(r: StreamRecord): StreamEvent {
  switch (r.type) {
    case 'init':
      return { type: 'init', sessionId: r.sessionId };
    case 'system':
      return { type: 'other', raw: r.raw };
    case 'assistant_blocks': {
      const tool = r.blocks.find((b) => b.type === 'tool_use');
      if (tool && tool.type === 'tool_use')
        return {
          type: 'tool_use',
          toolUseId: tool.toolUseId,
          name: tool.name,
          input: tool.input,
        };
      const texts = r.blocks.filter((b) => b.type === 'text');
      if (texts.length > 0)
        return {
          type: 'assistant_text',
          text: texts.map((t) => (t.type === 'text' ? t.text : '')).join('\n'),
        };
      return { type: 'other', raw: r.raw };
    }
    case 'user_blocks': {
      const res = r.blocks.find((b) => b.type === 'tool_result');
      if (res?.type !== 'tool_result') return { type: 'other', raw: r.raw };
      return {
        type: 'tool_result',
        toolUseId: res.toolUseId,
        isError: res.isError,
        content: res.content,
      };
    }
    case 'permission_request':
      return { ...r, toolUseId: r.toolUseId ?? '' };
    default:
      return r;
  }
}

export function parseStreamLine(line: string): StreamEvent {
  return legacyEvent(parseStreamRecord(line));
}

function contentOf(o: Record<string, unknown>): Array<Record<string, unknown>> {
  const msg = o.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

/** Build the stdin line for a user turn (`--input-format stream-json`). */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

/**
 * Build the stdin line answering a `can_use_tool` control request. Shape mirrors the Agent SDK's
 * PermissionResult: `{behavior:'allow', updatedInput}` | `{behavior:'deny', message}` (verified
 * 2026-08-24: allow → tool ran; file was created).
 *
 * An allow may also carry `updatedPermissions` — the request's own `permission_suggestions`,
 * handed back so Claude writes them into ITS settings. That is what "allow always" means: the
 * rule belongs to Claude Code, not to Pagr, and Pagr keeps no copy of it.
 */
export function controlResponseLine(
  requestId: string,
  decision:
    | {
        behavior: 'allow';
        updatedInput: Record<string, unknown>;
        updatedPermissions?: PermissionSuggestion[];
      }
    | { behavior: 'deny'; message: string },
): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision },
  })}\n`;
}

/** Human preview of a tool invocation for approval cards. Never full file contents. */
export function previewForTool(
  toolName: string,
  input: Record<string, unknown>,
  projectPath?: string,
): string {
  return relativizePaths(rawPreview(toolName, input), projectPath);
}

function rawPreview(toolName: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (toolName) {
    case 'Bash':
      return `$ ${s('command') ?? ''}`;
    case 'Write':
      return `Write ${s('file_path') ?? '?'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${s('file_path') ?? '?'}`;
    case 'NotebookEdit':
      return `Edit notebook ${s('notebook_path') ?? '?'}`;
    case 'Read':
      return `Read ${s('file_path') ?? '?'}`;
    case 'WebFetch':
      return `Fetch ${s('url') ?? '?'}`;
    default: {
      const keys = Object.keys(input).slice(0, 4);
      const brief = keys.map((k) => `${k}=${JSON.stringify(input[k]).slice(0, 60)}`).join(' ');
      return `${toolName} ${brief}`.trim();
    }
  }
}

export function actionTypeForTool(
  toolName: string,
): 'command_execution' | 'file_change' | 'permission' | 'tool_use' | 'other' {
  if (toolName === 'Bash') return 'command_execution';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'file_change';
  return 'tool_use';
}

/**
 * Claude Code's tool names → the ACP kind the phone draws a glyph from.
 *
 * The phone must not need a table of Claude's tool names to know that something was read, searched
 * for, edited or run — that is the whole point of the ACP kind, and it is what lets a Codex or an
 * ACP agent's frames render in the same list. Anything unrecognised, MCP tools (`mcp__*`) and
 * subagents included, is honestly `other` rather than guessed at.
 */
export function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'ExitPlanMode':
      return 'switch_mode';
    default:
      // Task/Agent (a subagent is its own transcript), AskUserQuestion (B7 turns it into a
      // `question` frame; until then it is an ordinary tool call), TodoWrite, every MCP tool.
      return 'other';
  }
}

/**
 * Dedupe key for one block of one line.
 *
 * A line read twice — over stdio and again out of the transcript, or after a rotation sent the
 * tailer back to the start of a file — must produce the frame once. Claude gives no per-block id,
 * so the line's own `uuid` plus the block's position is what says "the same block", and both
 * readers derive it the same way so their frames collide in the journal instead of doubling up.
 */
export const blockFrameId = (uuid: string | undefined, index: number): string | undefined =>
  uuid ? `${uuid}:${index}` : undefined;

export function filePathsOf(input: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path', 'path'].flatMap((k) =>
    typeof input[k] === 'string' ? [input[k] as string] : [],
  );
}
