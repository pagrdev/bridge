import type { PermissionBehavior, PermissionRequest } from './protocol.js';

export interface ChannelPollMessage {
  seq: number;
  text: string;
  /** Correlates this follow-up's `queued` → `picked_up` → `delivered` states. */
  followupId?: string;
}

export interface ChannelPollResponse {
  cursor: number;
  messages: ChannelPollMessage[];
}

/**
 * Everything the channel server needs from the outside world. The real implementation talks only
 * to the local Pagr daemon over its Unix-domain socket; tests substitute a fake.
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
