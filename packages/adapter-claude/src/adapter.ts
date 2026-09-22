import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  ChannelBridge,
  CodingAgentAdapter,
  FrameBody,
  JournalMeta,
  RunOnceInput,
  RunOnceResult,
  SendInstructionInput,
  SessionSummary,
  StartSessionInput,
} from '@pagr/bridge-core';
import {
  ASK_USER_QUESTION,
  askUserQuestionUpdatedInput,
  claudeApprovalOptions,
  type FrameQuestion,
  type LiveOneShot,
  newRunId,
  OneShotRegistry,
  oneShotSummary,
  type QuestionAnswer,
  questionBodyFor,
  runOnceSessionId,
} from '@pagr/bridge-core';
import { ChannelMode, type ChannelTarget, channelStatus } from './channel-mode.js';
import { ClaudeProcess, sealedModeEnabled } from './claude-process.js';
import {
  asToolUseResult,
  type ClaudeToolUseResult,
  diffBodyFor,
  EDIT_TOOLS,
  readPersistedOutput,
  TranscriptResultLookup,
  terminalBodyFor,
} from './diffs.js';
import { clip, type Hints, hintsForCommand, hintsForFiles, withImages } from './heuristics.js';
import { claudeHookState } from './hooks/install.js';
import { FileLogger } from './logger.js';
import { runClaudeOnce } from './run-once.js';
import { type PersistedSession, SessionMap } from './session-map.js';
import {
  actionTypeForTool,
  blockFrameId as blockId,
  filePathsOf,
  mapToolKind,
  type PermissionSuggestion,
  previewForTool,
  type StreamEvent,
  type StreamRecord,
  type UserBlock,
} from './stream-json.js';
import { ClaudeMirror, type ClaudeMirrorOptions } from './transcript/mirror.js';

export interface ClaudeAdapterOptions {
  home: string;
  /** Base command, default `['claude']`. Tests pass `['node', fixture]`. */
  claudeCommand?: string[];
  approvalTimeoutMs?: number;
  /**
   * Ceiling on `claude` children alive at once. A finished session keeps its process (so the
   * next instruction needs no re-spawn), which without a cap means one process per session
   * forever. Idle processes are ended least-recently-used first; `--resume` brings them back.
   */
  maxLiveProcesses?: number;
  /** How long an evicted child gets to exit on EOF before it is signalled. */
  retireGraceMs?: number;
  /** Extra env for spawned processes (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the `claude --version` memo TTL (tests); 0 disables memoisation. */
  versionCacheMs?: number;
  /** Override the sign-in memo TTL (tests); 0 disables memoisation. */
  authCacheMs?: number;
  /**
   * How long a diff may wait for Claude's own patch to reach the session transcript before the
   * bridge falls back to the one it can compute itself. 0 skips the wait entirely.
   */
  transcriptLookupMs?: number;
  log?: boolean;
  /** ADR 0001 `approved-channel`. Set by `createClaudeAdapter` from `PAGR_CLAUDE_CHANNEL=1`. */
  channel?: boolean;
  /** Test seam; defaults to the daemon's process-wide bridge. */
  channelBridge?: ChannelBridge;
  /**
   * Mirror the Claude Code sessions the user started themselves (B5). Defaults to on, off with
   * `PAGR_MIRROR=0`. The mirror produces frames through this adapter's own emitter and never
   * touches a spawned session — `ClaudeMirror` skips any Claude session id this adapter owns.
   */
  mirror?: boolean;
  /** Test seam: options handed to the mirror on top of the ones the adapter supplies. */
  mirrorOptions?: Partial<ClaudeMirrorOptions>;
}

export const DEFAULT_MAX_CLAUDE_PROCESSES = 6;

/** How long `claude --version` is trusted. The daemon probes on every gateway connect. */
const VERSION_CACHE_MS = 5 * 60_000;
/** Shorter while Claude Code is absent, so an install is noticed quickly. */
const MISSING_CACHE_MS = 30_000;
/** Sign-in state changes under the user, so it is re-read far more often than the version. */
const AUTH_CACHE_MS = 60_000;
/** How long "is the permission hook installed" is trusted. Short: the user can install it live. */
const HOOK_CACHE_MS = 30_000;

/** Presence-only check; the files are never opened. */
const credentialsPresent = (): boolean => {
  const home = os.homedir();
  return (
    fs.existsSync(path.join(home, '.claude', '.credentials.json')) ||
    fs.existsSync(path.join(home, '.claude.json'))
  );
};

/** A tool call this session made, kept until its result arrives so the two can be joined. */
interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

interface LiveSession {
  summary: SessionSummary;
  claudeSessionId: string;
  projectPath: string;
  readOnly: boolean;
  proc: ClaudeProcess | null;
  activeTurn: boolean;
  lastText: string;
  queued: Array<{ instruction: string; images: string[] }>;
  /** For LRU eviction of idle processes when the pool is full. */
  lastActivityMs: number;
  /**
   * `tool_use_id` → what was called, so a `tool_result` can be turned into the right kind of frame.
   *
   * A result line names only the id: whether it is a command's output or a file's new contents is
   * something only the call knew. Bounded (`MAX_REMEMBERED_TOOL_CALLS`) because a long session
   * makes thousands of these and nothing ever asks about an old one again.
   */
  toolCalls: Map<string, ToolCallRecord>;
}

interface PendingApproval {
  approvalId: string;
  requestId: string;
  sessionId: string;
  providerRequestId: string;
  input: Record<string, unknown>;
  /**
   * The rules Claude offered to persist with this prompt. Handed straight back as
   * `updatedPermissions` when the person chooses "allow always"; never read, never stored.
   */
  suggestions: PermissionSuggestion[];
  /** The `tool_use_id` this prompt is about, when Claude named one. */
  toolUseId: string | null;
  timer: NodeJS.Timeout;
}

/**
 * One `AskUserQuestion` waiting for an answer.
 *
 * It arrives on the SAME `can_use_tool` control request an ordinary permission prompt does, and
 * that request id is the only chance to answer it (spike MOB-044): the tool executes the moment a
 * `control_response` lands, with whatever `updatedInput` carries. So the original input is kept
 * verbatim — `questions` has to go back unchanged — alongside the normalised copy the phone saw.
 */
interface PendingQuestion {
  requestId: string;
  sessionId: string;
  providerRequestId: string;
  /** The control request's own `input`, passed back untouched inside `updatedInput`. */
  input: Record<string, unknown>;
  /** The same questions as the phone sees them; indexes from the phone resolve against these. */
  questions: FrameQuestion[];
  toolUseId: string | null;
  timer: NodeJS.Timeout;
}

export const newApprovalId = (): string => `apr_${randomUUID().replace(/-/g, '')}`;

const now = () => new Date().toISOString();

const TERMINAL = new Set<SessionSummary['status']>(['completed', 'failed', 'stopped']);

/** Tool calls a session remembers while waiting for their results. */
export const MAX_REMEMBERED_TOOL_CALLS = 512;

/**
 * How a session with no live process is reported. A finished session keeps the status it
 * finished with: `listSessions` used to hard-code `idle` for every remembered session, and since
 * the cloud upserts what a `device.hello` carries, every reconnect resurrected completed, failed
 * and stopped sessions as resumable on the user's phone (BR-4). Anything non-terminal has no
 * process behind it after a restart, so it is reported as `idle` — resumable, which is true.
 */
export function persistedSummary(sessionId: string, p: PersistedSession): SessionSummary {
  const recorded = p.lastStatus as SessionSummary['status'];
  return {
    sessionId,
    projectId: p.projectId,
    provider: 'claude',
    status: TERMINAL.has(recorded) ? recorded : 'idle',
    activeTurn: false,
    startedAt: p.startedAt,
    updatedAt: p.updatedAt,
    ...(p.displayName ? { displayName: p.displayName } : {}),
  };
}

/** Attachments are referenced by local path; Claude reads them with its own tools. */
/** What a delivery frame says when there is no instruction text to show (the later states). */
const DELIVERY_TEXT = {
  queued: 'Queued for the Claude Code session in your terminal.',
  picked_up: 'Handed to the Claude Code session in your terminal.',
  delivered: 'Claude Code picked it up; it runs at the next turn boundary.',
} as const;

const CAPABILITIES = {
  canStartSession: true,
  canResumeSession: true,
  /** Live steering of an in-flight turn is not faked (ADR 0001); instructions are queued. */
  canSteerActiveTurn: false,
  /** Turns true only with a channel bound: a follow-up lands at the next turn boundary. */
  canQueueIntoActiveTurn: false,
  canReceiveLiveExternalMessages: false,
  canRelayApprovals: true,
  canStop: true,
  canAttachImages: true,
  canListSessions: true,
} as const;

/**
 * Claude adapter, mode `cli-hooks`: spawns the unmodified `claude` binary in the registered
 * project directory using the user's own login. Permission prompts are relayed through the
 * documented stdio permission-prompt protocol; nothing is auto-allowed. Credentials are never
 * read, stored or transmitted.
 */
/**
 * Index of the last `text` block in an assistant message, or -1. The turn-ending iMessage line
 * belongs to exactly one frame, and this is the one a person would read as the answer.
 */
function lastTextBlock(blocks: { type: string }[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]?.type === 'text') return i;
  return -1;
}

export class ClaudeAdapter implements CodingAgentAdapter {
  readonly provider = 'claude' as const;
  private readonly logger: FileLogger;
  private readonly sessions = new Map<string, LiveSession>();
  /**
   * Headless runs in flight, by the `ses_…` each is listed under (HND-019).
   *
   * Separate from `sessions` on purpose: a run has no persisted row, is never resumed, and dies
   * with this process. What it shares with a session is everything a person can do to it, which
   * is why `listSessions`, `getStatus`, `sendInstruction` and `stopSession` all consult it.
   */
  private readonly runs = new OneShotRegistry();
  private readonly pending = new Map<string, PendingApproval>();
  /** Pending `AskUserQuestion` prompts, keyed by the id the dispatcher answers with. */
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly map: SessionMap;
  /** Null only under `PAGR_CLAUDE_CHANNEL=0` (ADR 0001 `approved-channel`). */
  private readonly channel: ChannelMode | null;
  /** Disposes the channel pick-up subscription on `shutdown`. */
  private unsubscribePickup: (() => void) | null = null;
  /** Null when `PAGR_MIRROR=0` or the embedder turned it off. */
  readonly mirror: ClaudeMirror | null;
  private hookCache: { value: boolean; atMs: number } | null = null;
  private shuttingDown = false;
  private versionCache: { value: string | null; atMs: number } | null = null;
  private readonly unknownBlockTypes = new Set<string>();
  private authCache: { value: AgentConnectionStatus['authStatus']; atMs: number } | null = null;

  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.logger = new FileLogger(
      opts.log === false ? null : path.join(opts.home, 'logs', 'claude.log'),
    );
    this.map = new SessionMap(path.join(opts.home, 'claude-sessions.json'));
    this.channel = opts.channel
      ? new ChannelMode(...(opts.channelBridge ? [opts.channelBridge] : []))
      : null;
    // `queued` → `picked_up`: the moment the channel server takes the follow-up off the queue is
    // the moment it stops being merely queued, and it is the only moment the bridge can observe
    // between sending and the transcript showing it.
    this.unsubscribePickup =
      this.channel?.onPickup((p) => {
        if (!p.sessionId || !p.projectId) return;
        this.deliveryFrame(
          { sessionId: p.sessionId, projectId: p.projectId },
          'picked_up',
          p.followupId,
        );
      }) ?? null;
    this.mirror =
      opts.mirror === false
        ? null
        : new ClaudeMirror({
            home: this.claudeHome(),
            pagrHome: opts.home,
            emit: (e) => this.emit(e),
            // The one rule the mirror needs from the adapter: a session this adapter is driving
            // is already streaming the same records over its pipe, so the tailer stays out of it.
            ownsClaudeSession: (id) => this.ownsClaudeSession(id),
            hookInstalled: () => this.hookInstalled(),
            channel: this.channel,
            log: (level, message, fields) => this.logger.log(level, message, fields ?? {}),
            ...(opts.env ? { env: opts.env } : {}),
            ...opts.mirrorOptions,
          });
    this.mirror?.start();
  }

  /** True while this adapter is driving that Claude session itself. */
  ownsClaudeSession(claudeSessionId: string): boolean {
    for (const live of this.sessions.values())
      if (live.claudeSessionId === claudeSessionId) return true;
    return false;
  }

  /**
   * Whether the permission hook is installed for this user, memoised briefly.
   *
   * It decides whether a mirrored terminal session is `approvals_only` or only `mirror_only`, and
   * it is a settings-file read, so it is answered from a short-lived memo rather than on every
   * control-level refresh of every session.
   */
  private hookInstalled(): boolean {
    const nowMs = Date.now();
    if (this.hookCache && nowMs - this.hookCache.atMs < HOOK_CACHE_MS) return this.hookCache.value;
    let value = false;
    try {
      const env = this.opts.env ?? process.env;
      const state = claudeHookState({
        pagrHome: this.opts.home,
        settingsPath: path.join(this.claudeHome(), '.claude', 'settings.json'),
        env,
      });
      value = state.scriptInstalled && state.entryInstalled;
    } catch {
      value = false;
    }
    this.hookCache = { value, atMs: nowMs };
    return value;
  }

  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  /** `claude` children alive right now, including any still being drained out of the pool. */
  get liveProcessCount(): number {
    return this.processCount(null);
  }

  /**
   * Two forks of `claude` used to run on EVERY gateway connect — `--version` and `auth status` —
   * so a flapping network meant a fork storm. Both answers are memoised: the version for a few
   * minutes (shorter while the binary is missing, so an install is noticed quickly), the sign-in
   * for a minute, since that is what actually changes under the user.
   */
  async probe(): Promise<AgentConnectionStatus> {
    const version = await this.claudeVersion();
    if (version === null) {
      return {
        provider: 'claude',
        mode: 'disabled',
        installed: false,
        authStatus: 'unknown',
        capabilities: { ...CAPABILITIES, canStartSession: false, canResumeSession: false },
        detail: 'Install Claude Code (https://code.claude.com), then run `claude` once and sign in',
      };
    }
    const authStatus = await this.claudeAuthStatus();
    const status: AgentConnectionStatus = {
      provider: 'claude',
      mode: 'cli-hooks',
      installed: true,
      providerVersion: version,
      authStatus,
      capabilities: { ...CAPABILITIES },
    };
    if (authStatus !== 'authenticated') status.detail = 'Run `claude` once and sign in';
    return this.channel ? channelStatus(status, this.channel.hasAttachedProject()) : status;
  }

  /** `claude --version`, memoised. Null means "not installed". */
  private async claudeVersion(): Promise<string | null> {
    const cached = this.versionCache;
    const ttl =
      this.opts.versionCacheMs ?? (cached?.value === null ? MISSING_CACHE_MS : VERSION_CACHE_MS);
    if (cached && ttl > 0 && Date.now() - cached.atMs < ttl) return cached.value;
    const raw = await this.run(['--version']);
    const value = raw === null ? null : (/(\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? raw.trim());
    this.versionCache = { value, atMs: Date.now() };
    return value;
  }

  /**
   * Whether the user is signed in, memoised for a minute. `claude auth status` prints JSON
   * including `loggedIn` (exit 0 signed in, 1 if not); ONLY that boolean is read — email and org
   * fields are discarded and never logged. Between refreshes, and on an older CLI without the
   * JSON output, this falls back to the presence (never the contents) of the credentials file.
   */
  private async claudeAuthStatus(): Promise<AgentConnectionStatus['authStatus']> {
    const cached = this.authCache;
    const ttl = this.opts.authCacheMs ?? AUTH_CACHE_MS;
    if (cached && ttl > 0 && Date.now() - cached.atMs < ttl) return cached.value;
    let value: AgentConnectionStatus['authStatus'] = 'unknown';
    const auth = await this.run(['auth', 'status'], true);
    if (auth !== null) {
      try {
        const j = JSON.parse(auth) as { loggedIn?: boolean };
        if (typeof j.loggedIn === 'boolean')
          value = j.loggedIn ? 'authenticated' : 'unauthenticated';
      } catch {
        /* older CLI without JSON output */
      }
    }
    if (value === 'unknown') value = credentialsPresent() ? 'authenticated' : 'unauthenticated';
    this.authCache = { value, atMs: Date.now() };
    return value;
  }

  oneShots(): LiveOneShot[] {
    return this.runs.list();
  }

  async listSessions(): Promise<SessionSummary[]> {
    // Bound what we remember before anyone copies it into a `device.hello` (BR-3).
    this.map.prune({ protect: new Set(this.sessions.keys()) });
    const out = new Map<string, SessionSummary>();
    for (const [sid, p] of this.map.entries()) out.set(sid, persistedSummary(sid, p));
    for (const [sid, s] of this.sessions) out.set(sid, s.summary);
    // Last, so a run always wins over anything that happens to share its id: a live run is the
    // most recent truth about it, and this is the list a person looks at to find running work.
    for (const summary of this.runs.summaries()) out.set(summary.sessionId, summary);
    return [...out.values()];
  }

  providerSessionId(sessionId: string): string | undefined {
    return (
      this.sessions.get(sessionId)?.claudeSessionId ?? this.map.get(sessionId)?.claudeSessionId
    );
  }

  async getStatus(sessionId: string): Promise<SessionSummary | null> {
    const run = this.runs.get(sessionId);
    if (run) return oneShotSummary(run);
    const live = this.sessions.get(sessionId);
    if (live) return live.summary;
    const p = this.map.get(sessionId);
    if (!p) return null;
    return persistedSummary(sessionId, p);
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    if (this.shuttingDown) throw new Error('adapter is shut down');
    // Fail before recording anything: a session that never got a process has nothing to resume,
    // so leaving it in the map would show a phantom session in `pagr sessions` forever.
    await this.reserveProcessSlot(null);
    const claudeSessionId = randomUUID();
    const ts = now();
    const live: LiveSession = {
      summary: {
        sessionId: input.sessionId,
        projectId: input.project.projectId,
        provider: 'claude',
        status: 'starting',
        activeTurn: false,
        startedAt: ts,
        updatedAt: ts,
        taskSummary: clip(input.instruction, 500),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      claudeSessionId,
      projectPath: input.project.path,
      readOnly: input.readOnly,
      proc: null,
      activeTurn: false,
      lastText: '',
      queued: [],
      lastActivityMs: Date.now(),
      toolCalls: new Map(),
    };
    this.sessions.set(input.sessionId, live);
    this.map.set(input.sessionId, {
      claudeSessionId,
      projectId: input.project.projectId,
      projectPath: input.project.path,
      readOnly: input.readOnly,
      startedAt: ts,
      updatedAt: ts,
      lastStatus: 'starting',
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    // No `starting` event before the process exists: the daemon writes every session event
    // straight into its store, and a start that then throws would leave a permanently "live"
    // record holding this working tree and a slot in the session budget. `sendTurn` emits
    // `working` on success, which is the first thing the daemon should hear about.
    try {
      this.spawn(live, { kind: 'new', id: claudeSessionId });
      this.sendTurn(live, input.instruction, input.localImagePaths);
    } catch (err) {
      this.sessions.delete(input.sessionId);
      this.map.remove(input.sessionId);
      throw err;
    }
    return live.summary;
  }

  /**
   * One bounded headless run (`runOnce.ts` in core): the handoff writer, the reviewer.
   *
   * Deliberately not a session. Nothing here writes to `this.sessions` or to the session map, so
   * `listSessions` returns it, `getStatus` answers for it, `sendInstruction` queues onto it and
   * `stopSession` kills it — it is a session Pagr started with a job in mind (HND-019). What it
   * is not is resumable: there is one artefact and the caller is holding the promise for it.
   *
   * It also does not take a slot in `maxLiveProcesses`. That budget exists to stop one `claude`
   * per remembered session piling up forever; a run has a timeout, and making a handoff evict
   * somebody's live conversation to write itself would be a strange trade.
   */
  async runOnce(input: RunOnceInput): Promise<RunOnceResult> {
    const runId = input.runId ?? newRunId();
    const sessionId = runOnceSessionId('claude', runId);
    if (this.shuttingDown) {
      return {
        runId,
        sessionId,
        outcome: 'failed',
        output: '',
        error: { code: 'start_failed', message: 'adapter is shut down' },
        durationMs: 0,
      };
    }
    this.logger.log('info', 'starting a one-shot claude run', {
      runId,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    const env = this.opts.env ?? process.env;
    const settingSources =
      this.opts.env?.PAGR_CLAUDE_SETTING_SOURCES ?? process.env.PAGR_CLAUDE_SETTING_SOURCES;
    return await runClaudeOnce({
      input: { ...input, runId },
      command: this.opts.claudeCommand ?? ['claude'],
      // The same environment a session gets, including whether sealed mode is on: a run is the
      // same agent in the same checkout, so it loads the same settings. `PAGR_DAEMON_SOCK` is
      // dropped for the same reason every spawned session drops it.
      env: this.env({ PAGR_SESSION_ID: sessionId, PAGR_DAEMON_SOCK: undefined }),
      ...(settingSources ? { settingSources } : {}),
      sealed: sealedModeEnabled(env),
      logger: this.logger,
      registry: this.runs,
      onSession: (session) => this.emit({ kind: 'session', session, localCwd: input.cwd }),
      onSessionEvent: (type, summary) => {
        // Same rule as a frame: an event that names no project is an event the cloud cannot
        // route, so it stays here rather than going out addressed to nothing.
        if (!input.projectId) return;
        this.emit({
          kind: 'session_event',
          sessionId,
          projectId: input.projectId,
          type,
          summary,
        });
      },
      onFrame: ({ body, meta, endsTurn }) => {
        // No project means no route: a frame the cloud cannot address is journaled by nobody and
        // sent to nobody, exactly as a mirrored thread in an unregistered directory is.
        if (!input.projectId) return;
        this.emit({
          kind: 'frame',
          sessionId,
          projectId: input.projectId,
          body,
          meta,
          ...(endsTurn ? { endsTurn: true } : {}),
        });
      },
    });
  }

  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    // A headless run Pagr started: it holds its own process, so the text goes straight onto its
    // queue and lands at the next turn boundary. `queued` is the honest word — Claude takes no
    // interrupt (ADR 0001) — and it is the same word this method gives for every other Claude
    // session that is mid-turn.
    const run = this.runs.get(input.sessionId);
    if (run) return run.send(input.instruction, input.localImagePaths);
    // Channel mode: a Pagr channel server is polling for this session, so the text goes into the
    // running Claude Code session (`notifications/claude/channel`). It renders in that terminal at
    // once and the model acts on it at the next turn boundary — so the honest answer is `queued`,
    // and the phone is shown that follow-up move through queued → picked_up → delivered rather
    // than being told its message interrupted anything.
    const target = this.channel?.resolve(input.sessionId, this.locationOf(input.sessionId));
    if (this.channel && target) {
      const followupId = this.channel.deliver(
        target,
        withImages(input.instruction, input.localImagePaths),
        { sessionId: input.sessionId },
      );
      this.deliveryFrame(
        { sessionId: input.sessionId, projectId: target.projectId },
        'queued',
        followupId,
        clip(input.instruction, 500),
      );
      return { delivered: 'queued' };
    }
    const live = this.requireLive(input.sessionId);
    if (live.activeTurn && live.proc?.alive) {
      // No live steering without Channels: queue and deliver after `result` (ADR 0001).
      live.queued.push({ instruction: input.instruction, images: input.localImagePaths });
      this.sessionEvent(live, 'queued_followup', clip(input.instruction, 500));
      return { delivered: 'queued' };
    }
    if (!live.proc?.alive) {
      await this.reserveProcessSlot(live);
      this.spawn(live, { kind: 'resume', id: live.claudeSessionId });
    }
    this.sendTurn(live, input.instruction, input.localImagePaths);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
    // A run stops the way it was always able to: the `AbortSignal` path, reached from the
    // user-facing stop instead of only from a dying daemon.
    const run = this.runs.get(sessionId);
    if (run) {
      await run.stop();
      return;
    }
    const live = this.sessions.get(sessionId);
    if (!live) return;
    live.queued = [];
    this.cancelApprovalsFor(sessionId, 'canceled');
    const proc = live.proc;
    live.proc = null;
    live.activeTurn = false;
    this.setStatus(live, 'stopped', { activeTurn: false, endedAt: now() });
    this.sessionEvent(live, 'stopped', 'Session stopped');
    if (proc?.alive) await proc.stop();
  }

  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
    optionId?: string;
  }): Promise<void> {
    const p = this.pending.get(input.approvalId);
    if (!p) throw new Error(`unknown or expired approval ${input.approvalId}`);
    if (p.providerRequestId !== input.providerRequestId) {
      throw new Error('providerRequestId does not match retained approval request');
    }
    this.pending.delete(input.approvalId);
    clearTimeout(p.timer);
    const live = this.sessions.get(p.sessionId);
    // "Allow always" hands Claude back its own suggested rules, which is how they end up in the
    // user's Claude Code settings rather than in a Pagr-shaped policy of our own. `decision` is
    // still what decides: an option that disagrees with it never persists anything.
    const persist =
      input.decision === 'allow' && input.optionId === 'allow_always' && p.suggestions.length > 0;
    if (live?.proc?.alive) {
      live.proc.answerPermission(
        p.requestId,
        input.decision === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: p.input,
              ...(persist ? { updatedPermissions: p.suggestions } : {}),
            }
          : { behavior: 'deny', message: 'Denied by the user via Pagr' },
      );
    }
    this.emit({
      kind: 'approval_resolved_locally',
      approvalId: p.approvalId,
      resolution: input.decision === 'allow' ? 'allowed' : 'denied',
    });
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // A headless run is a `claude` reading the user's repository with nobody left to read what
    // it writes; it does not outlive the daemon that started it.
    await this.runs.stopAll();
    this.unsubscribePickup?.();
    this.unsubscribePickup = null;
    this.mirror?.stop();
    for (const p of [...this.pendingQuestions.values()]) {
      clearTimeout(p.timer);
      this.pendingQuestions.delete(p.providerRequestId);
      this.emit({
        kind: 'question_resolved_locally',
        sessionId: p.sessionId,
        providerRequestId: p.providerRequestId,
        resolution: 'canceled',
        reason: 'shutdown',
      });
    }
    for (const p of [...this.pending.values()]) {
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
    await Promise.all(
      [...this.sessions.values()].map(async (live) => {
        const proc = live.proc;
        live.proc = null;
        if (!proc?.alive) return;
        if (live.activeTurn) await proc.stop();
        else {
          proc.end();
          await new Promise<void>((r) => {
            const t = setTimeout(() => {
              proc.stop().finally(r);
            }, 1500);
            t.unref();
            proc.once('exit', () => {
              clearTimeout(t);
              r();
            });
          });
        }
      }),
    );
    this.logger.close();
  }

  // ---------- internals ----------

  private run(args: string[], allowNonZero = false): Promise<string | null> {
    const [bin, ...rest] = this.opts.claudeCommand ?? ['claude'];
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(bin, [...rest, ...args], { timeout: 15_000, env: this.env() }, (err, stdout) => {
        if (err && !(allowNonZero && typeof stdout === 'string' && stdout.trim()))
          return resolve(null);
        resolve(String(stdout));
      });
    });
  }

  /**
   * Environment for a spawned child. A key set to `undefined` in `extra` is REMOVED rather than
   * inherited, so the adapter can withhold a variable the daemon itself has (PAGR_DAEMON_SOCK).
   */
  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...process.env, ...(this.opts.env ?? {}), ...extra };
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete merged[k];
    return merged;
  }

  private requireLive(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const p = this.map.get(sessionId);
    if (!p) throw new Error(`unknown session ${sessionId}`);
    const live: LiveSession = {
      summary: {
        sessionId,
        projectId: p.projectId,
        provider: 'claude',
        status: 'idle',
        activeTurn: false,
        startedAt: p.startedAt,
        updatedAt: now(),
        ...(p.displayName ? { displayName: p.displayName } : {}),
      },
      claudeSessionId: p.claudeSessionId,
      projectPath: p.projectPath,
      readOnly: p.readOnly === true,
      proc: null,
      activeTurn: false,
      lastText: '',
      queued: [],
      lastActivityMs: Date.now(),
      toolCalls: new Map(),
    };
    this.sessions.set(sessionId, live);
    return live;
  }

  /** Every session whose `claude` child is still running. */
  private liveProcesses(): LiveSession[] {
    return [...this.sessions.values()].filter((s) => s.proc?.alive);
  }

  /**
   * Children the pool has asked to leave but which have not exited yet. They still occupy a slot:
   * counting only the ones we still hold a session reference for would let a child that ignores
   * EOF push the real process count past the cap while the bookkeeping says otherwise.
   */
  private readonly draining = new Set<ClaudeProcess>();

  private processCount(exclude: LiveSession | null): number {
    return (
      this.liveProcesses().filter((s) => s !== exclude).length +
      [...this.draining].filter((p) => p.alive).length
    );
  }

  /**
   * Make room in the process pool before spawning. Idle children (no turn in flight) are ended
   * oldest-first — they resume from disk with `--resume`, so nothing is lost. If every child is
   * mid-turn the caller is told rather than the Mac being asked to run one more.
   */
  private async reserveProcessSlot(exclude: LiveSession | null): Promise<void> {
    const max = this.opts.maxLiveProcesses ?? DEFAULT_MAX_CLAUDE_PROCESSES;
    if (this.processCount(exclude) < max) return;
    const idle = this.liveProcesses()
      .filter((s) => s !== exclude && !s.activeTurn)
      .sort((a, b) => a.lastActivityMs - b.lastActivityMs);
    for (const victim of idle) {
      if (this.processCount(exclude) < max) break;
      await this.retire(victim, max);
    }
    if (this.processCount(exclude) >= max)
      throw new Error(
        `${this.processCount(exclude)} Claude Code sessions are already mid-turn, which is this ` +
          `device's limit of ${max} live \`claude\` processes — stop one and try again`,
      );
  }

  /**
   * End an idle child and wait for it to actually go. Closing stdin is enough for a well-behaved
   * `claude -p`, but the handle is kept (and escalated to SIGINT/SIGTERM/SIGKILL) so a child that
   * ignores EOF cannot outlive the daemon.
   */
  private async retire(live: LiveSession, max: number): Promise<void> {
    const proc = live.proc;
    if (!proc) return;
    live.proc = null;
    this.draining.add(proc);
    this.logger.log('info', 'ending idle claude process to stay under the pool limit', {
      sessionId: live.summary.sessionId,
      max,
    });
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      proc.once('exit', done);
      proc.end();
      const timer = setTimeout(() => {
        void proc.stop().finally(done);
      }, this.opts.retireGraceMs ?? 1500);
      timer.unref();
    });
    this.draining.delete(proc);
  }

  private spawn(
    live: LiveSession,
    session: { kind: 'new'; id: string } | { kind: 'resume'; id: string },
  ): void {
    live.lastActivityMs = Date.now();
    const env = this.opts.env ?? process.env;
    const settingSources =
      this.opts.env?.PAGR_CLAUDE_SETTING_SOURCES ?? process.env.PAGR_CLAUDE_SETTING_SOURCES;
    const sealed = sealedModeEnabled(env);
    const proc = new ClaudeProcess({
      command: this.opts.claudeCommand ?? ['claude'],
      cwd: live.projectPath,
      // PAGR_DAEMON_SOCK is deliberately NOT passed down. These children answer permission prompts
      // over their own stdio, never over the daemon's IPC socket, so handing a cloud-started agent
      // the socket path only gave it a lead. It is not a boundary — the socket sits at a
      // well-known path and is uid-checked, so anything running as this user can still find it.
      env: this.env({ PAGR_SESSION_ID: live.summary.sessionId, PAGR_DAEMON_SOCK: undefined }),
      session,
      readOnly: live.readOnly,
      ...(settingSources ? { settingSources } : {}),
      sealed,
      logger: this.logger,
    });
    live.proc = proc;
    proc.on('event', (ev) => this.onEvent(live, proc, ev));
    proc.on('record', (rec) => this.onRecord(live, proc, rec));
    proc.on('exit', ({ code, signal }) => {
      if (live.proc !== proc) return; // superseded or stopped
      live.proc = null;
      this.cancelApprovalsFor(live.summary.sessionId, 'canceled');
      if (live.activeTurn) {
        live.activeTurn = false;
        this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
        this.sessionEvent(
          live,
          'failed',
          `Claude Code exited (code ${code}, signal ${signal}) ${clip(proc.lastStderr, 300)}`,
        );
      }
    });
    proc.start();
  }

  /**
   * One `system` frame saying where a channel follow-up has got to.
   *
   * The state lives in `meta.delivery`, which the protocol already carries, so nothing about the
   * frame shape is new. The phone uses it to move a message from "sending" to "in that terminal"
   * without the bridge ever having to claim the turn was interrupted.
   */
  private deliveryFrame(
    at: { sessionId: string; projectId: string },
    state: 'queued' | 'picked_up' | 'delivered',
    followupId?: string,
    text?: string,
  ): void {
    this.emit({
      kind: 'frame',
      sessionId: at.sessionId,
      projectId: at.projectId,
      body: { kind: 'system', subtype: `followup_${state}`, text: text ?? DELIVERY_TEXT[state] },
      meta: { source: 'stdio', delivery: { state, ...(followupId ? { followupId } : {}) } },
      ...(followupId ? { providerRecordId: `${followupId}:${state}` } : {}),
    });
  }

  /** Registered project a session belongs to, as far as this adapter knows. */
  private locationOf(sessionId: string): ChannelTarget | null {
    const live = this.sessions.get(sessionId);
    if (live) return { cwd: live.projectPath, projectId: live.summary.projectId };
    const p = this.map.get(sessionId);
    return p ? { cwd: p.projectPath, projectId: p.projectId } : null;
  }

  private sendTurn(live: LiveSession, instruction: string, images: string[]): void {
    if (!live.proc?.alive) throw new Error('claude process not running');
    const text = withImages(instruction, images);
    live.activeTurn = true;
    live.lastText = '';
    live.proc.sendUser(text);
    this.setStatus(live, 'working', { activeTurn: true, taskSummary: clip(instruction, 500) });
  }

  private onEvent(live: LiveSession, proc: ClaudeProcess, ev: StreamEvent): void {
    if (live.proc !== proc) return;
    switch (ev.type) {
      case 'init':
        if (ev.sessionId !== live.claudeSessionId) {
          live.claudeSessionId = ev.sessionId;
          this.map.update(live.summary.sessionId, { claudeSessionId: ev.sessionId });
        }
        this.sessionEvent(live, 'started', 'Claude Code session started', ev.sessionId);
        return;
      case 'assistant_text':
        live.lastText = ev.text;
        this.sessionEvent(live, 'agent_message', clip(ev.text, 500));
        return;
      case 'tool_use':
        this.sessionEvent(
          live,
          'progress',
          clip(previewForTool(ev.name, ev.input, live.projectPath), 300),
          ev.toolUseId,
        );
        return;
      case 'tool_result':
        if (ev.isError)
          this.sessionEvent(live, 'progress', `Tool error: ${clip(ev.content, 200)}`, ev.toolUseId);
        return;
      case 'permission_request':
        this.onPermissionRequest(live, ev);
        return;
      case 'permission_cancel': {
        for (const p of [...this.pending.values()]) {
          if (p.requestId !== ev.requestId) continue;
          clearTimeout(p.timer);
          this.pending.delete(p.approvalId);
          this.emit({
            kind: 'approval_resolved_locally',
            approvalId: p.approvalId,
            resolution: 'canceled',
          });
        }
        // `control_cancel_request` is Claude withdrawing the prompt — it is already unwinding the
        // tool use itself, so nothing is written back here, exactly as for an approval.
        for (const p of [...this.pendingQuestions.values()]) {
          if (p.requestId !== ev.requestId) continue;
          clearTimeout(p.timer);
          this.pendingQuestions.delete(p.providerRequestId);
          this.emit({
            kind: 'question_resolved_locally',
            sessionId: p.sessionId,
            providerRequestId: p.providerRequestId,
            resolution: 'canceled',
            reason: 'canceled',
          });
        }
        if (!this.hasPendingFor(live.summary.sessionId)) this.setStatus(live, 'working');
        return;
      }
      case 'result': {
        live.activeTurn = false;
        this.cancelApprovalsFor(live.summary.sessionId, 'canceled');
        const text = ev.text || live.lastText;
        if (ev.ok) {
          this.setStatus(live, 'completed', { activeTurn: false });
          this.sessionEvent(live, 'completed', text || 'Turn completed');
          void this.deliverQueued(live);
        } else {
          this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
          this.sessionEvent(live, 'failed', `${ev.subtype}: ${text || 'Turn failed'}`);
        }
        return;
      }
      default:
        return;
    }
  }

  // ---------- frames (MOB-033) ----------

  /**
   * Every content block of a line, as a transcript frame.
   *
   * This runs ALONGSIDE `onEvent`, not instead of it: the clipped `session.event` summaries are
   * what a v1 gateway and the iMessage thread get, and they keep flowing exactly as before. What
   * changes is that a phone on v2 also gets the thing itself — the thinking, every tool call in a
   * message rather than the first, the output, the patch — sealed, in order, one frame each.
   */
  private onRecord(live: LiveSession, proc: ClaudeProcess, rec: StreamRecord): void {
    if (live.proc !== proc) return;
    if (rec.type === 'assistant_blocks') this.onAssistantBlocks(live, rec);
    else if (rec.type === 'user_blocks') {
      this.noteExternalAnswers(rec);
      this.onUserBlocks(live, rec);
    }
  }

  /**
   * A tool's result arriving for a prompt Pagr never answered means somebody answered it in the
   * terminal — Claude only runs the tool (or reports it refused) once the permission is settled.
   * The entry is consumed as `answeredElsewhere` so the phone dismisses its card rather than
   * timing out on a question that no longer exists.
   */
  private noteExternalAnswers(rec: Extract<StreamRecord, { type: 'user_blocks' }>): void {
    for (const b of rec.blocks) {
      if (b.type !== 'tool_result') continue;
      // The same reasoning for a question: `AskUserQuestion` produces its `tool_result` only once
      // the permission request has been answered, so one arriving for a prompt we are still
      // holding means the person answered it in their terminal.
      for (const p of [...this.pendingQuestions.values()]) {
        if (p.toolUseId !== b.toolUseId) continue;
        clearTimeout(p.timer);
        this.pendingQuestions.delete(p.providerRequestId);
        this.emit({
          kind: 'question_resolved_locally',
          sessionId: p.sessionId,
          providerRequestId: p.providerRequestId,
          resolution: 'answered',
          source: 'terminal',
          answeredElsewhere: true,
        });
        const live = this.sessions.get(p.sessionId);
        if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
      }
      for (const p of [...this.pending.values()]) {
        if (p.toolUseId !== b.toolUseId) continue;
        clearTimeout(p.timer);
        this.pending.delete(p.approvalId);
        this.emit({
          kind: 'approval_resolved_locally',
          approvalId: p.approvalId,
          resolution: b.isError ? 'denied' : 'allowed',
          source: 'terminal',
          answeredElsewhere: true,
        });
        const live = this.sessions.get(p.sessionId);
        if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
      }
    }
  }

  private onAssistantBlocks(
    live: LiveSession,
    rec: Extract<StreamRecord, { type: 'assistant_blocks' }>,
  ): void {
    // A message that calls no tool is the end of the turn: Claude only stops when it has nothing
    // left to run. `result` confirms it a moment later, but by then the frame has gone, so this
    // is the only point at which the last word of a turn is still identifiable as such.
    const endsTurn = !rec.blocks.some((b) => b.type === 'tool_use');
    rec.blocks.forEach((b, i) => {
      switch (b.type) {
        case 'thinking':
          if (!b.text.trim()) return;
          this.frame(live, { kind: 'thinking', text: b.text }, {}, blockId(rec.uuid, i), rec.at);
          return;
        case 'text':
          if (!b.text.trim()) return;
          this.frame(
            live,
            { kind: 'assistant', text: b.text },
            {},
            blockId(rec.uuid, i),
            rec.at,
            // Only the last text block of a final message: a model that wrote three paragraphs
            // is one message in the thread, not three.
            endsTurn && i === lastTextBlock(rec.blocks),
          );
          return;
        case 'tool_use':
          this.rememberToolCall(live, b.toolUseId, { name: b.name, input: b.input });
          this.frame(
            live,
            {
              kind: 'tool_call',
              toolCallId: b.toolUseId,
              toolName: b.name,
              toolKind: mapToolKind(b.name),
              title: previewForTool(b.name, b.input, live.projectPath),
              input: b.input,
            },
            // The call's own id is the thread every frame about it hangs from: its result, the
            // command output, the patch. The phone groups on `parentFrameId` alone.
            { parentFrameId: b.toolUseId, actionType: actionTypeForTool(b.name) },
            b.toolUseId,
            rec.at,
          );
          return;
        default:
          this.noteUnknownBlock(b.blockType);
      }
    });
  }

  private onUserBlocks(
    live: LiveSession,
    rec: Extract<StreamRecord, { type: 'user_blocks' }>,
  ): void {
    const results = rec.blocks.filter((b) => b.type === 'tool_result');
    // `tool_use_result` describes THE tool call the line carries. On a line with two results there
    // is no way to say which one it belongs to, so it belongs to neither.
    const sidecar = results.length === 1 ? asToolUseResult(rec.toolUseResult) : null;
    for (const b of rec.blocks) {
      if (b.type === 'other') {
        this.noteUnknownBlock(b.blockType);
        continue;
      }
      if (b.type !== 'tool_result') continue;
      this.frame(
        live,
        { kind: 'tool_result', toolCallId: b.toolUseId, content: b.content, isError: b.isError },
        { parentFrameId: b.toolUseId, status: b.isError ? 'error' : 'ok' },
        `${b.toolUseId}:result`,
        rec.at,
      );
      const call = live.toolCalls.get(b.toolUseId);
      if (!call) continue;
      if (call.name === 'Bash') this.emitTerminal(live, b, call, sidecar, rec.at);
      else if (EDIT_TOOLS.has(call.name)) this.emitDiff(live, b.toolUseId, call, sidecar, rec.at);
    }
  }

  /** A Bash result, with its streams kept apart and a spilled body read back in full. */
  private emitTerminal(
    live: LiveSession,
    res: Extract<UserBlock, { type: 'tool_result' }>,
    call: ToolCallRecord,
    sidecar: ClaudeToolUseResult | null,
    at?: string,
  ): void {
    const spillPath = sidecar?.persistedOutputPath;
    const spilled =
      typeof spillPath === 'string'
        ? readPersistedOutput(spillPath, { home: this.claudeHome() })
        : null;
    const body = terminalBodyFor({
      command: typeof call.input.command === 'string' ? call.input.command : '',
      content: res.content,
      isError: res.isError,
      result: sidecar,
      spilled,
    });
    this.frame(
      live,
      body,
      {
        parentFrameId: res.toolUseId,
        status: body.interrupted ? 'interrupted' : res.isError ? 'error' : 'ok',
      },
      `${res.toolUseId}:terminal`,
      at,
    );
  }

  /**
   * A file change, from Claude's own patch.
   *
   * `--verbose` puts `tool_use_result` — `structuredPatch`, `originalFile`, the replacement
   * strings — straight onto the result line, so the usual case is synchronous and reads nothing.
   * When it is absent the same object is in the session's transcript a moment later; that read is
   * bounded, and what it cannot supply in time is sent as the bridge's own approximate diff.
   */
  private emitDiff(
    live: LiveSession,
    toolUseId: string,
    call: ToolCallRecord,
    sidecar: ClaudeToolUseResult | null,
    at?: string,
  ): void {
    const direct = diffBodyFor({ toolName: call.name, input: call.input, result: sidecar });
    if (direct && direct.approx !== true) {
      this.frame(live, direct, { parentFrameId: toolUseId }, `${toolUseId}:diff`, at);
      return;
    }
    void this.emitDiffFromTranscript(live, toolUseId, call, direct, at);
  }

  private async emitDiffFromTranscript(
    live: LiveSession,
    toolUseId: string,
    call: ToolCallRecord,
    fallback: Extract<FrameBody, { kind: 'diff' }> | null,
    at?: string,
  ): Promise<void> {
    let found: ClaudeToolUseResult | null = null;
    const waitMs = this.opts.transcriptLookupMs ?? 2000;
    if (waitMs > 0) {
      try {
        found = await new TranscriptResultLookup({
          home: this.claudeHome(),
          cwd: live.projectPath,
          claudeSessionId: live.claudeSessionId,
          timeoutMs: waitMs,
        }).find(toolUseId);
      } catch (err) {
        this.logger.log('warn', 'could not read the session transcript for a diff', {
          message: (err as Error).message,
        });
      }
    }
    const body =
      (found && diffBodyFor({ toolName: call.name, input: call.input, result: found })) ?? fallback;
    if (!body || this.shuttingDown) return;
    this.frame(live, body, { parentFrameId: toolUseId }, `${toolUseId}:diff`, at);
  }

  private frame(
    live: LiveSession,
    body: FrameBody,
    meta: Omit<Partial<JournalMeta>, 'source'> = {},
    providerRecordId?: string,
    at?: string,
    endsTurn = false,
  ): void {
    this.emit({
      kind: 'frame',
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      body,
      meta: { source: 'stdio', ...meta },
      ...(providerRecordId ? { providerRecordId } : {}),
      ...(at ? { at } : {}),
      ...(endsTurn ? { endsTurn: true } : {}),
    });
  }

  private rememberToolCall(live: LiveSession, id: string, call: ToolCallRecord): void {
    if (!id) return;
    live.toolCalls.set(id, call);
    while (live.toolCalls.size > MAX_REMEMBERED_TOOL_CALLS) {
      const oldest = live.toolCalls.keys().next();
      if (oldest.done) break;
      live.toolCalls.delete(oldest.value);
    }
  }

  /**
   * A content block this parser has no frame for. Logged the first time each type is seen and
   * never again: a new block type is news once, not on every message of every session.
   */
  private noteUnknownBlock(blockType: string): void {
    if (this.unknownBlockTypes.has(blockType)) return;
    this.unknownBlockTypes.add(blockType);
    this.logger.log('info', 'unrecognised Claude content block; no frame made for it', {
      blockType,
    });
  }

  /** `$HOME` as the spawned `claude` sees it — the root of `~/.claude/projects`. */
  private claudeHome(): string {
    return this.opts.env?.HOME ?? process.env.HOME ?? os.homedir();
  }

  private onPermissionRequest(
    live: LiveSession,
    ev: Extract<StreamEvent, { type: 'permission_request' }>,
  ): void {
    // `AskUserQuestion` rides the same `can_use_tool` request as every other tool, and that is
    // exactly the trap: an ordinary "allow" answers it with the original input, which Claude
    // reads as "The user did not answer the questions." and the turn ends without the person
    // ever seeing the question (spike MOB-044, run 2). It is a question, not an approval, and
    // it leaves here as one.
    if (ev.toolName === ASK_USER_QUESTION && this.onQuestionRequest(live, ev)) return;
    const approvalId = newApprovalId();
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    const timer = setTimeout(() => this.timeoutApproval(approvalId), timeoutMs);
    timer.unref();
    const providerRequestId = (ev.toolUseId ?? ev.requestId).slice(0, 200);
    const suggestions = ev.suggestions ?? [];
    this.pending.set(approvalId, {
      approvalId,
      requestId: ev.requestId,
      sessionId: live.summary.sessionId,
      providerRequestId,
      input: ev.input,
      suggestions,
      toolUseId: ev.toolUseId || null,
      timer,
    });
    const preview = previewForTool(ev.toolName, ev.input, live.projectPath);
    const command = typeof ev.input.command === 'string' ? ev.input.command : undefined;
    const url = typeof ev.input.url === 'string' ? ev.input.url : undefined;
    let hints: Hints;
    if (ev.toolName === 'Bash') {
      hints = hintsForCommand(command ?? '', live.projectPath, live.projectPath);
    } else {
      hints = hintsForFiles(filePathsOf(ev.input), live.projectPath);
      if (ev.toolName === 'WebFetch' || ev.toolName === 'WebSearch') hints.networkAccess = true;
    }
    this.setStatus(live, 'waiting_for_approval');
    this.emit({
      kind: 'approval_requested',
      approvalId,
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      providerRequestId,
      actionType: actionTypeForTool(ev.toolName),
      preview: clip(preview, 1500),
      hints,
      // "Allow always" is offered exactly when Claude handed us rules to persist with it.
      options: claudeApprovalOptions(suggestions.length > 0, this.opts.env ?? process.env),
      // Unredacted, for the device floor only. `preview` above is what leaves the Mac.
      local: {
        toolName: ev.toolName,
        projectPath: live.projectPath,
        cwd: live.projectPath,
        paths: filePathsOf(ev.input),
        ...(command !== undefined ? { command } : {}),
        ...(url !== undefined ? { url } : {}),
      },
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
  }

  /**
   * Relay an `AskUserQuestion` as a question. Returns false — and falls back to the ordinary
   * approval card — when the request carries nothing answerable, because a prompt with no
   * questions in it is a permission decision however it is labelled.
   */
  private onQuestionRequest(
    live: LiveSession,
    ev: Extract<StreamEvent, { type: 'permission_request' }>,
  ): boolean {
    const { questions } = questionBodyFor(ev.input);
    if (questions.length === 0) return false;
    const providerRequestId = (ev.toolUseId ?? ev.requestId).slice(0, 200);
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    const timer = setTimeout(() => this.timeoutQuestion(providerRequestId), timeoutMs);
    timer.unref();
    this.pendingQuestions.set(providerRequestId, {
      requestId: ev.requestId,
      sessionId: live.summary.sessionId,
      providerRequestId,
      input: ev.input,
      questions,
      toolUseId: ev.toolUseId || null,
      timer,
    });
    this.setStatus(live, 'waiting_for_user');
    this.emit({
      kind: 'question_asked',
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      providerRequestId,
      questions,
      // A session the bridge spawned owns its own stdin, so the answer has somewhere to go.
      answerable: true,
      // Claude's AskUserQuestion has no notion of a secret answer; Codex's `isSecret` does.
      secret: questions.map(() => false),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      // Not the bare tool_use id: the same assistant block already produced a `tool_call` frame
      // under it, and the journal would treat this as that frame arriving twice.
      providerRecordId: `${providerRequestId}#question`,
      meta: { source: 'stdio' },
    });
    return true;
  }

  /**
   * Answer the question by allowing its control request with the answers inside `updatedInput`.
   * One line, on the request id the question arrived on; there is no later opportunity.
   */
  async answerQuestion(input: {
    providerRequestId: string;
    answers: QuestionAnswer[];
  }): Promise<void> {
    const p = this.pendingQuestions.get(input.providerRequestId);
    if (!p) throw new Error(`unknown or expired question ${input.providerRequestId}`);
    const live = this.sessions.get(p.sessionId);
    if (!live?.proc?.alive) throw new Error('claude process not running');
    this.pendingQuestions.delete(input.providerRequestId);
    clearTimeout(p.timer);
    live.proc.answerPermission(p.requestId, {
      behavior: 'allow',
      updatedInput: askUserQuestionUpdatedInput(p.input, p.questions, input.answers),
    });
    if (!this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  /**
   * Nobody answered in time. A deny is the only honest ending: Claude is blocked on this request
   * and will sit there for as long as the process lives (spike MOB-044, run 1).
   */
  private timeoutQuestion(providerRequestId: string): void {
    const p = this.pendingQuestions.get(providerRequestId);
    if (!p) return;
    this.pendingQuestions.delete(providerRequestId);
    const live = this.sessions.get(p.sessionId);
    if (live?.proc?.alive)
      live.proc.answerPermission(p.requestId, {
        behavior: 'deny',
        message: 'No answer received from the user in time (Pagr)',
      });
    this.emit({
      kind: 'question_resolved_locally',
      sessionId: p.sessionId,
      providerRequestId,
      resolution: 'timed_out',
      reason: 'timed_out',
    });
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  /** Drop every question of a session without writing anything back (stop, exit, shutdown). */
  private cancelQuestionsFor(sessionId: string): void {
    for (const p of [...this.pendingQuestions.values()]) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pendingQuestions.delete(p.providerRequestId);
      this.emit({
        kind: 'question_resolved_locally',
        sessionId,
        providerRequestId: p.providerRequestId,
        resolution: 'canceled',
        reason: 'canceled',
      });
    }
  }

  private timeoutApproval(approvalId: string): void {
    const p = this.pending.get(approvalId);
    if (!p) return;
    this.pending.delete(approvalId);
    const live = this.sessions.get(p.sessionId);
    if (live?.proc?.alive) {
      live.proc.answerPermission(p.requestId, {
        behavior: 'deny',
        message: 'No decision received from the user in time (Pagr)',
      });
    }
    this.emit({ kind: 'approval_resolved_locally', approvalId, resolution: 'timed_out' });
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  private cancelApprovalsFor(sessionId: string, resolution: 'canceled'): void {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.emit({ kind: 'approval_resolved_locally', approvalId: p.approvalId, resolution });
    }
    this.cancelQuestionsFor(sessionId);
  }

  private hasPendingFor(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true;
    for (const p of this.pendingQuestions.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  private async deliverQueued(live: LiveSession): Promise<void> {
    const next = live.queued.shift();
    if (!next) return;
    try {
      if (!live.proc?.alive) {
        await this.reserveProcessSlot(live);
        this.spawn(live, { kind: 'resume', id: live.claudeSessionId });
      }
      this.sendTurn(live, next.instruction, next.images);
      this.sessionEvent(live, 'followup_delivered', clip(next.instruction, 500));
    } catch (err) {
      this.sessionEvent(live, 'failed', `Queued follow-up failed: ${(err as Error).message}`);
    }
  }

  private setStatus(
    live: LiveSession,
    status: SessionSummary['status'],
    patch: Partial<SessionSummary> = {},
  ): void {
    live.lastActivityMs = Date.now();
    live.summary = { ...live.summary, ...patch, status, updatedAt: now() };
    this.map.update(live.summary.sessionId, {
      lastStatus: status,
      updatedAt: live.summary.updatedAt,
    });
    this.emit({ kind: 'session', session: live.summary });
  }

  private sessionEvent(
    live: LiveSession,
    type: Extract<AdapterEvent, { kind: 'session_event' }>['type'],
    summary: string,
    providerEventId?: string,
  ): void {
    this.emit({
      kind: 'session_event',
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      type,
      summary: clip(summary, 2000),
      ...(providerEventId ? { providerEventId } : {}),
    });
  }

  private emit(e: AdapterEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.logger.log('error', 'listener threw', { message: (err as Error).message });
      }
    }
  }
}
