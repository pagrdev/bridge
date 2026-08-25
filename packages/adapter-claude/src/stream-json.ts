import { relativizePaths } from './heuristics.js';
/**
 * Parser for Claude Code `--output-format stream-json` lines (Claude Code 2.1.220, verified
 * 2026-08-24 against real output + https://code.claude.com/docs/en/headless).
 *
 * Shapes observed on the wire:
 *   {"type":"system","subtype":"init","session_id":"…","cwd":"…","tools":[…]}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"…"} |
 *        {"type":"tool_use","id":"toolu_…","name":"Bash","input":{…}} | {"type":"thinking",…}]},…}
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"…",
 *        "content":"…","is_error":false}]},…}
 *   {"type":"result","subtype":"success"|"error_*","is_error":bool,"result":"…","session_id":"…",
 *        "num_turns":n,"total_cost_usd":…}
 *   With `--permission-prompt-tool stdio` (SDK control protocol):
 *   {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"Write",
 *        "input":{…},"tool_use_id":"toolu_…","permission_suggestions":[…]}}
 *   {"type":"control_cancel_request","request_id":"…"}
 */

export type StreamEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null }
  | {
      type: 'permission_request';
      requestId: string;
      toolUseId: string | null;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: 'permission_cancel'; requestId: string }
  | { type: 'other'; raw: Record<string, unknown> }
  | { type: 'invalid'; line: string };

export function parseStreamLine(line: string): StreamEvent {
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
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init' && typeof o.session_id === 'string') {
        return { type: 'init', sessionId: o.session_id };
      }
      return { type: 'other', raw: o };
    case 'assistant': {
      const content = contentOf(o);
      const texts = content.filter((c) => c.type === 'text' && typeof c.text === 'string');
      const tools = content.filter((c) => c.type === 'tool_use');
      if (tools.length > 0) {
        const t = tools[0] as { id?: string; name?: string; input?: unknown };
        return {
          type: 'tool_use',
          toolUseId: String(t.id ?? ''),
          name: String(t.name ?? 'tool'),
          input: (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>,
        };
      }
      if (texts.length > 0) {
        return { type: 'assistant_text', text: texts.map((t) => String(t.text)).join('\n') };
      }
      return { type: 'other', raw: o };
    }
    case 'user': {
      const r = contentOf(o).find((c) => c.type === 'tool_result') as
        | { tool_use_id?: string; is_error?: boolean; content?: unknown }
        | undefined;
      if (!r) return { type: 'other', raw: o };
      return {
        type: 'tool_result',
        toolUseId: String(r.tool_use_id ?? ''),
        isError: r.is_error === true,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? ''),
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
      return {
        type: 'permission_request',
        requestId: String(o.request_id ?? ''),
        toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : null,
        toolName: String(req.tool_name ?? 'tool'),
        input: (req.input && typeof req.input === 'object' ? req.input : {}) as Record<
          string,
          unknown
        >,
      };
    }
    case 'control_cancel_request':
      return { type: 'permission_cancel', requestId: String(o.request_id ?? '') };
    default:
      return { type: 'other', raw: o };
  }
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
 */
export function controlResponseLine(
  requestId: string,
  decision:
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
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

export function filePathsOf(input: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path', 'path'].flatMap((k) =>
    typeof input[k] === 'string' ? [input[k] as string] : [],
  );
}
