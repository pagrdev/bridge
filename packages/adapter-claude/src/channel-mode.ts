import type { AgentCapabilities, AgentConnectionStatus, ChannelBridge } from '@pagr/bridge-core';
import { getChannelBridge } from '@pagr/bridge-core';

/**
 * ADR 0001 mode `approved-channel` — the only path on which Pagr can steer an in-flight Claude
 * Code turn for real, instead of queueing a follow-up.
 *
 * Claude Code "Channels" are a research preview: custom channels are not on Anthropic's approved
 * allowlist, so a user must start `claude` with `--dangerously-load-development-channels`. This
 * whole file is therefore behind `PAGR_CLAUDE_CHANNEL=1` and off by default; GA does not depend
 * on it (ADR 0001: "feature-flagged; only enabled if Pagr's channel plugin is allowlisted").
 */

export const CHANNEL_FLAG_ENV = 'PAGR_CLAUDE_CHANNEL';

export function channelModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHANNEL_FLAG_ENV] === '1';
}

export const CHANNEL_PROBE_DETAIL =
  'Claude Code channel mode is ON (PAGR_CLAUDE_CHANNEL=1) and a channel is attached, so ' +
  'instructions inject into the running Claude Code turn. This is a research-preview, ' +
  'development-flag-only path.';

/**
 * What the cloud is told when the flag is on but nothing is polling. The distinction matters:
 * `canSteerActiveTurn: true` makes the product promise "I interrupted your agent", and that must
 * never be said about a follow-up that will actually sit in a queue.
 */
export const CHANNEL_ARMED_DETAIL =
  'Claude Code channel mode is enabled (PAGR_CLAUDE_CHANNEL=1) but no channel is attached yet, ' +
  'so instructions will be QUEUED, not steered. Run `pagr claude channel-setup`, then start ' +
  'Claude Code with `claude --dangerously-load-development-channels server:pagr` in a ' +
  'registered project.';

/** Where a session lives, as far as the channel is concerned. */
export interface ChannelTarget {
  cwd: string;
  projectId: string;
}

/**
 * Adapter-side view of the daemon's `ChannelBridge`. A project is channel-attached from its
 * first `channel.poll`, i.e. from the moment a Pagr channel server is actually running inside a
 * Claude Code session for that project.
 */
export class ChannelMode {
  constructor(private readonly bridge: ChannelBridge = getChannelBridge()) {}

  /**
   * The live channel for this session, or null when nothing is attached — in which case the
   * caller must fall back to the ordinary `cli-hooks` behaviour rather than dropping the text.
   *
   * `fallback` is what the adapter itself knows (bridge-spawned sessions); the bridge's own
   * binding covers sessions the adapter never saw, such as the synthetic session minted for the
   * user's own interactive `claude` by the permission hook.
   */
  resolve(sessionId: string, fallback?: ChannelTarget | null): ChannelTarget | null {
    const bound = this.bridge.bindingFor(sessionId);
    if (bound && this.bridge.isAttached(bound.cwd)) return bound;
    if (fallback && this.bridge.isAttached(fallback.cwd)) return fallback;
    return null;
  }

  /** Queue the text; the channel server's long-poll picks it up and injects it. */
  deliver(target: ChannelTarget, text: string): void {
    this.bridge.bindSession(targetSessionKeyless(target), target);
    this.bridge.enqueue(target.cwd, text);
  }

  isAttached(cwd: string): boolean {
    return this.bridge.isAttached(cwd);
  }

  /** Any project with a live channel right now — i.e. can this device steer at all? */
  hasAttachedProject(): boolean {
    return this.bridge.attachedProjects().length > 0;
  }

  attachedProjects(): string[] {
    return this.bridge.attachedProjects();
  }
}

/**
 * Bindings are stored per session id; `deliver` has only the target, so it re-binds under a
 * project-scoped key. Harmless duplication that keeps `attachedProjects()` diagnosable.
 */
const targetSessionKeyless = (t: ChannelTarget): string => `project:${t.projectId}`;

/** Capability patch applied on top of the adapter's `cli-hooks` defaults. */
export function channelCapabilities(base: AgentCapabilities): AgentCapabilities {
  return { ...base, canSteerActiveTurn: true, canReceiveLiveExternalMessages: true };
}

/**
 * Patch a `cli-hooks` probe result for channel mode.
 *
 * `attached` is the truth the cloud needs: the flag being on only means the daemon *accepts* a
 * channel. Until a channel server is actually polling for a registered project, nothing can be
 * steered, so the capability stays false and the mode stays `cli-hooks` — the bridge reports what
 * it can do this second, not what it could do if the user ran another command.
 */
export function channelStatus(
  base: AgentConnectionStatus,
  attached = false,
): AgentConnectionStatus {
  const detail = attached ? CHANNEL_PROBE_DETAIL : CHANNEL_ARMED_DETAIL;
  return {
    ...base,
    mode: attached ? 'approved-channel' : base.mode,
    capabilities: attached ? channelCapabilities(base.capabilities) : { ...base.capabilities },
    detail: base.detail ? `${base.detail}. ${detail}` : detail,
  };
}
