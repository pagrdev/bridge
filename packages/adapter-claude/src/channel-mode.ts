import type {
  AgentCapabilities,
  AgentConnectionStatus,
  ChannelBridge,
  ChannelPickup,
} from '@pagr/bridge-core';
import { getChannelBridge } from '@pagr/bridge-core';

/**
 * ADR 0001 mode `approved-channel` — how Pagr gets a follow-up into a Claude Code session that is
 * already running in the user's own terminal.
 *
 * Claude Code "Channels" are a research preview: custom channels are not on Anthropic's approved
 * allowlist, so the session has to be started with `--dangerously-load-development-channels`, and
 * spike MOB-045 established that its warning dialog appears on EVERY launch and cannot be
 * pre-accepted. So there is no shim on PATH and plain `claude` is untouched: a user who wants
 * phone control of a terminal session runs `pagr claude`, which adds the flag for them.
 *
 * What the channel does and does not do is the whole point of this file. A follow-up is rendered
 * in the terminal the instant it arrives and is acted on at the NEXT TURN BOUNDARY (verified on
 * 2.1.220 and 2.1.274). That is queueing into a running turn, not interrupting one, so
 * `canSteerActiveTurn` stays false and `canQueueIntoActiveTurn` is what turns true.
 */

export const CHANNEL_FLAG_ENV = 'PAGR_CLAUDE_CHANNEL';

/** On by default since MOB-037; `PAGR_CLAUDE_CHANNEL=0` opts out, `=1` is a no-op. */
export function channelModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHANNEL_FLAG_ENV] !== '0';
}

export const CHANNEL_PROBE_DETAIL =
  'A Pagr channel is attached, so a follow-up you send is queued into the running Claude Code ' +
  'session and acted on at the next turn boundary. Start such a session with `pagr claude`.';

/**
 * What the cloud is told when the daemon accepts channels but nothing is polling. The distinction
 * matters: a capability is a product promise, and "I put it in your terminal" must never be said
 * about a text that is going to sit in a queue nobody is reading.
 */
export const CHANNEL_ARMED_DETAIL =
  'No Pagr channel is attached, so follow-ups are delivered when the current turn ends. Run ' +
  '`pagr claude channel-install` once, then start Claude Code with `pagr claude` in a registered ' +
  'project to control that terminal from your phone.';

/** Where a session lives, as far as the channel is concerned. */
export interface ChannelTarget {
  cwd: string;
  projectId: string;
}

/** A follow-up handed to the channel server, i.e. `queued` → `picked_up`. */
export type { ChannelPickup };

/**
 * Adapter-side view of the daemon's `ChannelBridge`. A project is channel-attached from its first
 * `channel.poll`, i.e. from the moment a Pagr channel server is actually running inside a Claude
 * Code session for that project.
 */
export class ChannelMode {
  constructor(private readonly bridge: ChannelBridge = getChannelBridge()) {}

  /**
   * The live channel for this session, or null when nothing is attached — in which case the
   * caller must fall back to the ordinary `cli-hooks` behaviour rather than dropping the text.
   *
   * The binding the daemon makes from `~/.claude/sessions/<ppid>.json` is per Claude SESSION, so
   * it names one terminal. `fallback` is the older per-directory answer, kept because a session
   * the permission hook minted before any poll has no pid-derived binding yet.
   */
  resolve(sessionId: string, fallback?: ChannelTarget | null): ChannelTarget | null {
    const bound = this.bridge.bindingFor(sessionId);
    if (bound && this.bridge.isAttached(bound.cwd))
      return { cwd: bound.cwd, projectId: bound.projectId };
    if (fallback && this.bridge.isAttached(fallback.cwd)) return fallback;
    return null;
  }

  /**
   * Queue the text; the channel server's long-poll picks it up and injects it. Returns the
   * follow-up id that correlates the three delivery states the phone is shown.
   */
  deliver(
    target: ChannelTarget,
    text: string,
    routing: { sessionId?: string; followupId?: string } = {},
  ): string {
    const followupId = routing.followupId ?? newFollowupId();
    this.bridge.bindSession(targetSessionKeyless(target), target);
    this.bridge.enqueue(target.cwd, text, {
      followupId,
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      projectId: target.projectId,
    });
    return followupId;
  }

  /** Notified when a queued follow-up is handed to a channel server. Returns a disposer. */
  onPickup(listener: (p: ChannelPickup) => void): () => void {
    return this.bridge.onPickup(listener);
  }

  isAttached(cwd: string): boolean {
    return this.bridge.isAttached(cwd);
  }

  /** Any project with a live channel right now — i.e. can this device reach a terminal at all? */
  hasAttachedProject(): boolean {
    return this.bridge.attachedProjects().length > 0;
  }

  attachedProjects(): string[] {
    return this.bridge.attachedProjects();
  }

  boundSessions(): string[] {
    return this.bridge.boundSessions();
  }
}

/** `fu_` + 16 hex. Short enough to ride as a `<channel followup="…">` attribute. */
export function newFollowupId(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return `fu_${out}`;
}

/**
 * Bindings are stored per session id; `deliver` has only the target, so it re-binds under a
 * project-scoped key. Harmless duplication that keeps `attachedProjects()` diagnosable.
 */
const targetSessionKeyless = (t: ChannelTarget): string => `project:${t.projectId}`;

/**
 * Capability patch applied on top of the adapter's `cli-hooks` defaults.
 *
 * `canSteerActiveTurn` stays FALSE on purpose. The spike measured what a channel event actually
 * does mid-turn: the line renders in the terminal immediately and the model acts on it 6.6 s
 * later, when the turn it was already running finished. That is a queue with a very good
 * notification, and it is what `canQueueIntoActiveTurn` says.
 */
export function channelCapabilities(base: AgentCapabilities): AgentCapabilities {
  return { ...base, canQueueIntoActiveTurn: true, canReceiveLiveExternalMessages: true };
}

/**
 * Patch a `cli-hooks` probe result for channel mode.
 *
 * `attached` is the truth the cloud needs: the daemon accepting channels only means it would
 * answer one. Until a channel server is actually polling for a registered project, nothing can be
 * reached, so the capability stays false and the mode stays `cli-hooks` — the bridge reports what
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
