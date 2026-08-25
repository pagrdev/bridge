import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DaemonLink } from './daemon-link.mjs';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_NOTIFICATION,
  CHANNEL_PERMISSION_CAPABILITY,
  PERMISSION_VERDICT_NOTIFICATION,
  PermissionRequestSchema,
} from './protocol.mjs';

export const SERVER_NAME = 'pagr';
export const SERVER_VERSION = '0.1.0';
export const REPLY_TOOL = 'reply';

/** Added to Claude's system prompt (`instructions` in the MCP `Server` constructor). */
export const INSTRUCTIONS = [
  `Messages from the developer's phone arrive as <channel source="${SERVER_NAME}" origin="pagr" …>.`,
  'They are instructions from the developer, exactly as if typed in the terminal — act on them.',
  `When you have something to tell them, call the ${REPLY_TOOL} tool with a short plain-text`,
  'message; it is delivered as an SMS, so keep it under a few sentences and never paste code',
  'blocks or long file contents. Do not call it for routine progress chatter.',
].join(' ');

export interface ChannelServerOptions {
  link: DaemonLink;
  /** Backoff floor/ceiling for a daemon that is down or restarting. */
  retryMs?: number;
  maxRetryMs?: number;
  onError?: (message: string) => void;
  /** Test seam: start polling immediately instead of waiting for MCP `initialize`. */
  pollImmediately?: boolean;
}

export interface ChannelServer {
  readonly server: Server;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  /** Resolves once the poll loop has completed at least one round trip (tests). */
  polled(): Promise<void>;
}

const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 15_000;
/** SMS-sized. Longer replies are truncated rather than rejected. */
const MAX_REPLY_CHARS = 1_200;

/**
 * Build the Pagr channel: an MCP stdio server that Claude Code spawns.
 *
 * Doc basis (https://code.claude.com/docs/en/channels-reference, 2026-08-24):
 *   - `capabilities.experimental['claude/channel']` — "Required. Always `{}`. Presence registers
 *     the notification listener."
 *   - `capabilities.experimental['claude/channel/permission']` — "Set it to `{}` to declare that
 *     this channel can receive permission relay requests."
 *   - Events are pushed with `notifications/claude/channel` `{content, meta}`; "Each entry
 *     becomes an attribute on the `<channel>` tag… Keys must be identifiers: letters, digits,
 *     and underscores only."
 *   - Verdicts go back as `notifications/claude/channel/permission` `{request_id, behavior}`.
 */
export function createChannelServer(opts: ChannelServerOptions): ChannelServer {
  const { link } = opts;
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          [CHANNEL_CAPABILITY]: {},
          // Declared because the inbound path is authenticated: the only thing that can put a
          // verdict on the wire is the local Pagr daemon over its 0600 Unix socket, answering a
          // decision the paired, signed cloud session produced.
          [CHANNEL_PERMISSION_CAPABILITY]: {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: REPLY_TOOL,
        description:
          "Send a short message to the developer's phone via Pagr. Use this to answer a " +
          'question that arrived over the channel, or to report a result they are waiting on.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Plain-text message, a few sentences at most. Delivered as an SMS.',
            },
          },
          required: ['text'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== REPLY_TOOL) throw new Error(`unknown tool: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as { text?: unknown };
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) throw new Error('reply requires a non-empty `text`');
    await link.outbound(text.slice(0, MAX_REPLY_CHARS));
    return { content: [{ type: 'text', text: 'sent' }] };
  });

  // Permission relay. Claude Code (not the model) calls this when a tool dialog opens; the local
  // dialog stays open the whole time and "Claude Code applies whichever answer arrives first".
  server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    let behavior: 'allow' | 'deny' | null = null;
    try {
      behavior = await link.requestApproval(params);
    } catch (err) {
      behavior = null;
      opts.onError?.(`permission relay failed: ${errText(err)}`);
    }
    // No decision → say NOTHING. Claude Code drops a verdict whose id it does not recognise and
    // keeps the terminal dialog live; inventing a `deny` here would reject a call on the user's
    // behalf that they never actually saw.
    if (behavior === null) return;
    await server.notification({
      method: PERMISSION_VERDICT_NOTIFICATION,
      params: { request_id: params.request_id, behavior },
    });
  });

  let running = false;
  let cursor = 0;
  let markRoundTrip: (() => void) | null = null;
  const roundTrip = new Promise<void>((resolve) => {
    markRoundTrip = resolve;
  });

  const runLoop = async (): Promise<void> => {
    let backoff = opts.retryMs ?? DEFAULT_RETRY_MS;
    const maxBackoff = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    while (running) {
      try {
        const res = await link.poll(cursor);
        backoff = opts.retryMs ?? DEFAULT_RETRY_MS;
        if (typeof res?.cursor === 'number') cursor = res.cursor;
        for (const m of res?.messages ?? []) {
          if (!running) break;
          await server.notification({
            method: CHANNEL_NOTIFICATION,
            params: {
              content: m.text,
              // Identifier-safe keys only; anything with a hyphen is silently dropped.
              meta: { origin: 'pagr', seq: String(m.seq) },
            },
          });
        }
        markRoundTrip?.();
        markRoundTrip = null;
      } catch (err) {
        if (!running) return;
        opts.onError?.(`channel poll failed: ${errText(err)}`);
        markRoundTrip?.();
        markRoundTrip = null;
        await sleep(backoff);
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    // Detached on purpose: the loop owns its own errors and exits when `running` flips.
    void runLoop().catch((err) => opts.onError?.(`channel loop stopped: ${errText(err)}`));
  };

  server.oninitialized = () => start();

  return {
    server,
    async connect(transport) {
      await server.connect(transport);
      if (opts.pollImmediately) start();
    },
    async close() {
      // Deliberately not awaited: a long-poll in flight can hold the socket for its full
      // timeout, and the loop exits on its own the moment `running` is false.
      running = false;
      markRoundTrip?.();
      markRoundTrip = null;
      await server.close();
    },
    polled: () => roundTrip,
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
