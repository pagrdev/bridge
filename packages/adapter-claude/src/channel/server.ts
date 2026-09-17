import { LineBuffer } from '@pagr/bridge-core';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_NOTIFICATION,
  CHANNEL_PERMISSION_CAPABILITY,
  DEFAULT_PROTOCOL_VERSION,
  INSTRUCTIONS,
  MAX_REPLY_CHARS,
  PERMISSION_REQUEST_NOTIFICATION,
  PERMISSION_VERDICT_NOTIFICATION,
  parsePermissionRequest,
  REPLY_TOOL,
  SERVER_NAME,
  SERVER_VERSION,
} from './protocol.js';
import type { DaemonLink } from './types.js';

/**
 * The Pagr channel: a JSON-RPC stdio server that Claude Code spawns.
 *
 * Claude Code loads it as an MCP server, but only four messages matter — `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call` — plus the two channel
 * notifications. Writing those by hand costs about a hundred lines and removes the MCP SDK from
 * the dependency graph of a process that runs inside the user's own terminal.
 *
 * Doc basis (https://code.claude.com/docs/en/channels-reference, 2026-08-24):
 *   - `capabilities.experimental['claude/channel']` — "Required. Always `{}`. Presence registers
 *     the notification listener."
 *   - `capabilities.experimental['claude/channel/permission']` — "Set it to `{}` to declare that
 *     this channel can receive permission relay requests."
 *   - Events are pushed with `notifications/claude/channel` `{content, meta}`; "Each entry becomes
 *     an attribute on the `<channel>` tag… Keys must be identifiers: letters, digits, and
 *     underscores only."
 *   - Verdicts go back as `notifications/claude/channel/permission` `{request_id, behavior}`.
 *
 * stdout belongs to the transport — every diagnostic goes to stderr, which Claude Code captures
 * in `~/.claude/debug/<session-id>.txt`.
 */

export interface ChannelServerOptions {
  link: DaemonLink;
  /** Defaults to `process.stdin`/`process.stdout`; tests pass a fake peer. */
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  /** Backoff floor/ceiling for a daemon that is down or restarting. */
  retryMs?: number;
  maxRetryMs?: number;
  onError?: (message: string) => void;
  /** Test seam: poll without waiting for Claude Code's `initialized`. */
  pollImmediately?: boolean;
}

export interface ChannelServer {
  start(): void;
  stop(): void;
  /** Resolves once the poll loop has completed at least one round trip (tests). */
  polled(): Promise<void>;
}

const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 15_000;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export function createChannelServer(opts: ChannelServerOptions): ChannelServer {
  const { link } = opts;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const lines = new LineBuffer();
  const fail = (m: string) => opts.onError?.(m);

  let running = false;
  let looping = false;
  let cursor = 0;
  let markRoundTrip: (() => void) | null = null;
  const roundTrip = new Promise<void>((resolve) => {
    markRoundTrip = resolve;
  });

  const write = (msg: Record<string, unknown>): void => {
    try {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    } catch (err) {
      fail(`write failed: ${errText(err)}`);
    }
  };
  const notify = (method: string, params: unknown): void => write({ method, params });

  const onRequest = async (id: unknown, method: string, params: unknown): Promise<void> => {
    switch (method) {
      case 'initialize':
        write({
          id,
          result: {
            protocolVersion: protocolVersionOf(params),
            capabilities: {
              experimental: {
                [CHANNEL_CAPABILITY]: {},
                // Declared because the inbound path is authenticated: the only thing that can put
                // a verdict on the wire is the local Pagr daemon over its 0600 Unix socket,
                // answering a decision the paired, signed cloud session produced.
                [CHANNEL_PERMISSION_CAPABILITY]: {},
              },
              tools: {},
            },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        });
        return;
      case 'tools/list':
        write({
          id,
          result: {
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
                      description:
                        'Plain-text message, a few sentences at most. Delivered as an SMS.',
                    },
                  },
                  required: ['text'],
                },
              },
            ],
          },
        });
        return;
      case 'tools/call': {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (p.name !== REPLY_TOOL) {
          write({ id, error: { code: -32602, message: `unknown tool: ${String(p.name)}` } });
          return;
        }
        const args = (p.arguments ?? {}) as { text?: unknown };
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) {
          write({ id, error: { code: -32602, message: 'reply requires a non-empty `text`' } });
          return;
        }
        try {
          await link.outbound(text.slice(0, MAX_REPLY_CHARS));
        } catch (err) {
          // A tool error, not a transport error: Claude Code shows it to the user and the session
          // carries on, which is what should happen when the daemon is simply not running.
          write({
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `could not reach the Pagr daemon: ${errText(err)}` }],
            },
          });
          return;
        }
        write({ id, result: { content: [{ type: 'text', text: 'sent' }] } });
        return;
      }
      default:
        write({ id, error: { code: -32601, message: `unknown method: ${method}` } });
    }
  };

  const onNotification = async (method: string, params: unknown): Promise<void> => {
    if (method === 'notifications/initialized') {
      start();
      return;
    }
    if (method !== PERMISSION_REQUEST_NOTIFICATION) return;
    const req = parsePermissionRequest(params);
    if (!req) {
      fail('permission_request with no request_id/tool_name; ignored');
      return;
    }
    let behavior: 'allow' | 'deny' | null = null;
    try {
      behavior = await link.requestApproval(req);
    } catch (err) {
      behavior = null;
      fail(`permission relay failed: ${errText(err)}`);
    }
    // No decision → say NOTHING. Claude Code drops a verdict whose id it does not recognise and
    // keeps the terminal dialog live; inventing a `deny` here would reject a call on the user's
    // behalf that they never actually saw.
    if (behavior === null) return;
    notify(PERMISSION_VERDICT_NOTIFICATION, { request_id: req.request_id, behavior });
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      fail('ignored a line that was not JSON');
      return;
    }
    if (typeof msg.method !== 'string') return; // a response to something we never asked
    const handler =
      msg.id === undefined || msg.id === null
        ? onNotification(msg.method, msg.params)
        : onRequest(msg.id, msg.method, msg.params);
    void handler.catch((err: unknown) => fail(`handler failed: ${errText(err)}`));
  };

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
          notify(CHANNEL_NOTIFICATION, {
            content: m.text,
            // Identifier-safe keys only; anything with a hyphen is silently dropped. `followup`
            // is what lets the transcript tailer recognise this turn and report it delivered.
            meta: {
              origin: 'pagr',
              seq: String(m.seq),
              ...(m.followupId ? { followup: m.followupId } : {}),
            },
          });
        }
        settle();
      } catch (err) {
        if (!running) return;
        fail(`channel poll failed: ${errText(err)}`);
        settle();
        await sleep(backoff);
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    }
  };

  const settle = (): void => {
    markRoundTrip?.();
    markRoundTrip = null;
  };

  function start(): void {
    if (looping) return;
    looping = true;
    running = true;
    // Detached on purpose: the loop owns its own errors and exits when `running` flips.
    void runLoop().catch((err: unknown) => fail(`channel loop stopped: ${errText(err)}`));
  }

  return {
    start() {
      running = true;
      input.setEncoding?.('utf8');
      input.on('data', (chunk: string | Buffer) => {
        for (const line of lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
          onLine(line);
      });
      input.on('end', () => {
        const rest = lines.flush();
        if (rest) onLine(rest);
      });
      if (opts.pollImmediately) start();
    },
    stop() {
      // The in-flight long poll can hold the socket for its full timeout; the loop exits on its
      // own the moment `running` is false, so nothing is awaited here.
      running = false;
      settle();
    },
    polled: () => roundTrip,
  };
}

/** Echo the client's `protocolVersion` when it sent one; MCP says an unknown one is negotiated. */
function protocolVersionOf(params: unknown): string {
  if (typeof params !== 'object' || params === null) return DEFAULT_PROTOCOL_VERSION;
  const v = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof v === 'string' && v !== '' ? v : DEFAULT_PROTOCOL_VERSION;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
