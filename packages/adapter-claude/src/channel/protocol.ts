/**
 * The Claude Code channel wire contract, transcribed from
 * https://code.claude.com/docs/en/channels-reference (fetched 2026-08-24) and re-verified against
 * 2.1.220 and 2.1.274 in `docs/spikes/2026-09-17-dev-channels-warning.md`.
 *
 * These method names and payload shapes are Claude Code extensions carried over standard MCP;
 * they are not part of the MCP spec, and the docs warn the "protocol contract may change based on
 * feedback" while channels are a research preview.
 *
 * Nothing here imports an MCP SDK. The server speaks the four JSON-RPC messages Claude Code
 * actually sends, and a dependency this file does not have is a dependency that cannot break a
 * process Claude Code spawns inside the user's own terminal.
 */

/** "Declare the `claude/channel` capability so Claude Code registers a notification listener." */
export const CHANNEL_CAPABILITY = 'claude/channel' as const;
/** "Set it to `{}` to declare that this channel can receive permission relay requests." */
export const CHANNEL_PERMISSION_CAPABILITY = 'claude/channel/permission' as const;

/** Inbound-to-Claude event: `{content, meta?}` → `<channel source="…" …>content</channel>`. */
export const CHANNEL_NOTIFICATION = 'notifications/claude/channel' as const;
/** Claude Code → channel, when a permission dialog opens. */
export const PERMISSION_REQUEST_NOTIFICATION =
  'notifications/claude/channel/permission_request' as const;
/** Channel → Claude Code verdict. Silence is legal and leaves the terminal dialog in control. */
export const PERMISSION_VERDICT_NOTIFICATION = 'notifications/claude/channel/permission' as const;

/** What Claude Code 2.1.220–2.1.274 sends on `initialize`. Echoed back verbatim. */
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

export const SERVER_NAME = 'pagr';
export const SERVER_VERSION = '0.2.0';
export const REPLY_TOOL = 'reply';
/** SMS-sized. A longer reply is truncated rather than rejected. */
export const MAX_REPLY_CHARS = 1_200;

/** Added to Claude's system prompt (`instructions` in the `initialize` result). */
export const INSTRUCTIONS = [
  `Messages from the developer's phone arrive as <channel source="${SERVER_NAME}" origin="pagr" …>.`,
  'They are instructions from the developer, exactly as if typed in the terminal — act on them.',
  `When you have something to tell them, call the ${REPLY_TOOL} tool with a short plain-text`,
  'message; it is delivered as an SMS, so keep it under a few sentences and never paste code',
  'blocks or long file contents. Do not call it for routine progress chatter.',
].join(' ');

/**
 * `params` of `notifications/claude/channel/permission_request`.
 *
 * `request_id` is "Five lowercase letters drawn from `a`-`z` without `l`". `description` and
 * `input_preview` are relayed from the model/tool call: the docs say to "Treat as untrusted."
 */
export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export type PermissionBehavior = 'allow' | 'deny';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Hand-rolled because a schema library is a dependency; every field is checked, nothing coerced. */
export function parsePermissionRequest(params: unknown): PermissionRequest | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const request_id = str(p.request_id);
  const tool_name = str(p.tool_name);
  if (!request_id || !tool_name) return null;
  return {
    request_id,
    tool_name,
    description: typeof p.description === 'string' ? p.description : '',
    input_preview: typeof p.input_preview === 'string' ? p.input_preview : '',
  };
}
