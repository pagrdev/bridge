import { actionTypeForTool, hintsForCommand } from '@pagr/bridge-adapter-claude';
import { IpcClient, IpcClientError, resolveSocketPath } from '@pagr/bridge-core';
import type { PermissionBehavior, PermissionRequest } from './protocol.mjs';

export interface ChannelPollResponse {
  cursor: number;
  messages: Array<{ seq: number; text: string }>;
}

/**
 * Everything the channel server needs from the outside world. The real implementation talks
 * only to the local Pagr daemon over its Unix-domain socket; tests substitute a fake.
 */
export interface DaemonLink {
  /** Long-poll for texts the cloud queued for this project. Resolves with `messages: []` on idle. */
  poll(cursor: number): Promise<ChannelPollResponse>;
  /** Claude's `reply` tool → daemon → cloud → the developer's phone. */
  outbound(text: string): Promise<void>;
  /**
   * Relay a permission prompt. Resolves `null` when no human decision arrived — the caller must
   * then stay SILENT so Claude Code's own terminal dialog keeps control.
   */
  requestApproval(req: PermissionRequest): Promise<PermissionBehavior | null>;
}

export interface IpcDaemonLinkOptions {
  cwd: string;
  socketPath?: string;
  home?: string;
  /** Must exceed the daemon's `CHANNEL_POLL_TIMEOUT_MS` (25 s) or every poll looks like a failure. */
  pollTimeoutMs?: number;
  approvalTimeoutMs?: number;
  sessionId?: string | undefined;
}

const POLL_TIMEOUT_MS = 30_000;
/** Slightly under Claude Code's 600 s hook cap, matching the PermissionRequest hook's budget. */
const APPROVAL_TIMEOUT_MS = 540_000;

interface ApprovalReply {
  approvalId?: string;
  decision?: PermissionBehavior | null;
  resolution?: string;
}

/** `DaemonLink` backed by the Pagr daemon's IPC socket. No network, no other process. */
export class IpcDaemonLink implements DaemonLink {
  private readonly client: IpcClient;
  readonly socketPath: string;

  constructor(private readonly opts: IpcDaemonLinkOptions) {
    this.socketPath = opts.socketPath ?? resolveSocketPath(opts.home);
    this.client = new IpcClient(this.socketPath);
  }

  poll(cursor: number): Promise<ChannelPollResponse> {
    return this.client.call<ChannelPollResponse>(
      'channel.poll',
      { cwd: this.opts.cwd, cursor },
      this.opts.pollTimeoutMs ?? POLL_TIMEOUT_MS,
    );
  }

  async outbound(text: string): Promise<void> {
    await this.client.call('channel.outbound', {
      cwd: this.opts.cwd,
      text,
      ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
    });
  }

  async requestApproval(req: PermissionRequest): Promise<PermissionBehavior | null> {
    const timeoutMs = this.opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    try {
      const res = await this.client.call<ApprovalReply>(
        'approval.request',
        buildApprovalParams(req, this.opts.cwd, timeoutMs, this.opts.sessionId),
        // Give the daemon a little longer than the deadline we asked it to honour, so a
        // decision that lands right at the wire still reaches us.
        timeoutMs + 15_000,
      );
      const d = res?.decision;
      return d === 'allow' || d === 'deny' ? d : null;
    } catch (err) {
      // Daemon down, project not registered, timeout — all mean "no decision". Never deny on
      // our own initiative: a denial we invented would reject a call the user never saw.
      if (err instanceof IpcClientError) return null;
      return null;
    }
  }
}

/**
 * Shape a relayed prompt into the daemon's existing `approval.request` params.
 *
 * `sessionId: null` + `cwd` is the same interactive path the PermissionRequest hook uses: the
 * daemon maps the cwd onto a registered project and mints a stable local session for it.
 */
export function buildApprovalParams(
  req: PermissionRequest,
  cwd: string,
  timeoutMs: number,
  sessionId?: string | undefined,
): Record<string, unknown> {
  const preview = [`${req.tool_name}: ${req.description}`, req.input_preview]
    .filter((s) => s && s.trim().length > 0)
    .join('\n')
    .slice(0, 1500);
  // `input_preview` is "the tool's arguments as JSON-shaped display text"; for Bash it carries
  // the command, which is exactly what the shell heuristics want.
  const hints = hintsForCommand(`${req.description} ${req.input_preview}`, undefined, undefined);
  return {
    provider: 'claude',
    sessionId: sessionId ?? null,
    cwd,
    providerRequestId: `chan_${req.request_id}`.slice(0, 200),
    actionType: actionTypeForTool(req.tool_name),
    preview,
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    timeoutMs,
  };
}
