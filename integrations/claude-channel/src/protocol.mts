import { z } from 'zod';

/**
 * The Claude Code channel wire contract, transcribed from
 * https://code.claude.com/docs/en/channels-reference (fetched 2026-08-24).
 *
 * These method names and payload shapes are Claude Code extensions carried over standard MCP;
 * they are not part of the MCP spec, and the docs warn the "protocol contract may change based
 * on feedback" while channels are a research preview.
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

/**
 * `params` of `notifications/claude/channel/permission_request`.
 *
 * `request_id` is "Five lowercase letters drawn from `a`-`z` without `l`". `description` and
 * `input_preview` are relayed from the model/tool call: the docs say to "Treat as untrusted."
 */
export const PermissionRequestSchema = z.object({
  method: z.literal(PERMISSION_REQUEST_NOTIFICATION),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional().default(''),
  }),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>['params'];

export type PermissionBehavior = 'allow' | 'deny';
