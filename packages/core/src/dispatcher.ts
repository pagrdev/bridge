import { release } from 'node:os';
import { dirname } from 'node:path';
import {
  type AgentConnectionStatus,
  type ApprovalOption,
  type ApprovalOptionKind,
  type CommandBody,
  type CommandPayload,
  type ControlLevel,
  canonicalize,
  type DeviceEvent,
  type EventPayload,
  type ProjectSummary,
  type Provider,
  type RepoScanResult,
  type ReviewApplyResult,
  type ReviewStartResult,
  type RulesMigrateResult,
  type SealAad,
  type SessionStatus,
  type SessionSummary,
  type SessionSummaryV2,
} from '@pagr/protocol';
import { runOnceFrameMeta } from './adapters/runOnce.js';
import type { AdapterEvent, CodingAgentAdapter } from './adapters/types.js';
import {
  APPROVAL_OPTION_KINDS,
  allowAlwaysEnabled,
  decisionForOptionKind,
  defaultOptionId,
  isPersistentOptionKind,
} from './approvalOptions.js';
import {
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalResolution,
  type ApprovalSource,
  type PendingApproval,
  type PendingApprovalInput,
  PendingApprovalRegistry,
} from './approvals.js';
import { AttachmentLeaseRegistry } from './attachmentLease.js';
import { deleteAttachment, type FetchLike, fetchAttachment } from './attachments.js';
import {
  BackfillError,
  BackfillGuard,
  type BackfillRequest,
  type BackfillResult,
  BackfillService,
  type BackfillSource,
  type DiscoveredSession,
  type HistoryQuery,
  type ReplayFrame,
} from './backfill.js';
import { isLiveStatus, SessionGuard, type WorkspaceClaim } from './concurrency.js';
import { classifyLocally, DeviceFloor, type LocalActionDetail } from './deviceFloor.js';
import { type EventPayloadInput, makeEvent } from './events.js';
import { chunkFrame, type FrameBody, type FrameQuestion } from './frames.js';
import type { GitOptions } from './git.js';
import type { CaptureOutcome, CaptureRefusal } from './handoff/capture.js';
import {
  captureFromReceiver,
  claudeTranscriptSource,
  codexTranscriptSource,
  type TranscriptSource,
} from './handoff/receiver.js';
import {
  type HandoffCaptureAck,
  type HandoffFailure,
  type ReceiverCapture,
  runHandoffCapture,
} from './handoff/switch.js';
import { clip } from './heuristics.js';
import { type ChannelBridge, getChannelBridge } from './ipc.js';
import type { JournalEntry, JournalMeta, JournalStore, OutboxCursors } from './journal.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import type { MirrorProject } from './mirrorBridge.js';
import { PublicPolicy, readPolicy, writePolicy } from './policy.js';
import { ProjectError, type ProjectRegistry } from './projects.js';
import {
  type PendingQuestion,
  type PendingQuestionInput,
  PendingQuestionRegistry,
  type QuestionAnswer,
  type QuestionOutcome,
  type QuestionResolution,
  type QuestionSource,
  questionBodyFor,
} from './questions.js';
import { handleFor, RepoHandleCache, scanRepos } from './repoScan.js';
import {
  awaitReview,
  newAppliedSessionId,
  type PreparedReview,
  prepareReview,
  type ReviewRunner,
  ReviewStartError,
  reviewApplyInstruction,
} from './review/run.js';
import { migrateRules, toRulesMigrateResult } from './rules/migrate.js';
import { importRecipientKeys, type RecipientKeySet, sealFrame } from './seal.js';
import {
  isAdopted,
  isReportable,
  type SessionRecord,
  type SessionStore,
  UNREGISTERED_PROJECT,
} from './sessions.js';

/**
 * How an adopted session is labelled for the person looking at their phone. It has to be
 * distinguishable from a session Pagr started, because the two differ in what can be done with
 * them: this one's approvals can be answered, but it cannot be sent an instruction or stopped.
 */
export const ADOPTED_SESSION_NAME = 'Your own session';

/** How a session started by "fix it" is named on the phone, so it is not mistaken for the build. */
export const REVIEW_FIX_SESSION_NAME = 'Fixing review findings';

/**
 * How many finished reviews this daemon remembers, for the "fix it" that follows one.
 *
 * `review.apply` carries a review id and maybe a session id, never a project, so a review that
 * has fallen off this list and whose builder session is also gone cannot be acted on. Fifty is
 * far past the point where a person is still going to reply to a verdict, and the map holds two
 * short strings per entry.
 */
export const MAX_REMEMBERED_REVIEWS = 50;

type AckPayload = EventPayload<'command.ack'>;

// ---------- remote project pick (`repo.scan`, `project.register_handle`) ----------

/**
 * Off switch for the whole feature. Default ON: picking a repository from the phone is the point
 * of the pair of commands. `=0` removes both from this bridge — they ack `capability_unsupported`
 * and `repo_scan.v1` disappears from `device.hello`, so a cloud that respects capabilities stops
 * offering the button rather than hitting a wall.
 */
export const REMOTE_PROJECT_PICK_ENV = 'PAGR_REMOTE_PROJECT_PICK';

/**
 * Shortest gap between two accepted `repo.scan`s. A scan opens directories, so a command that can
 * be sent in a loop is a command that can be made to grind the disk; one every 30 seconds is far
 * more than a person tapping "add a project" needs.
 */
export const REPO_SCAN_MIN_INTERVAL_MS = 30_000;

/** What `pagr doctor` prints for the remote-pick line. */
export interface RemoteProjectPickStatus {
  enabled: boolean;
  /** Live handles held in memory right now. Never a path, and never written to disk. */
  handles: number;
}

/**
 * Most sessions the bridge will describe in a `device.hello`. The adapters already prune their
 * maps, but a hello is sent on every connect and the gateway only needs what is live or recent:
 * anything older is still resumable by id and is reported on demand by `agent.get_status`.
 */
export const MAX_HELLO_SESSIONS = 100;

/**
 * Byte ceiling for the hello payload, with headroom under the gateway's 256 KiB frame cap for the
 * event envelope and JSON escaping.
 */
export const MAX_HELLO_BYTES = 128 * 1024;

/**
 * Named capabilities a v2 `device.hello` may advertise.
 *
 * Every one of them is a FACT about this daemon as it is running right now, not a build-time
 * constant: a name appears here exactly when the thing behind it will actually work, so a cloud
 * that gates a button on one is never lying to the person holding the phone. The gating is
 * enumerated in `Dispatcher.helloCapabilities`.
 */
export const HELLO_CAPABILITIES = {
  /** Sealed transcript frames: a journal is wired up, so `session.frame` can be produced. */
  frames: 'frames.v1',
  /** The frames can actually be sealed: the daemon has (or can be handed) a recipient key set. */
  seal: 'seal.v1',
  /** `question.asked` / `agent.answer_question`: some adapter can write an answer back. */
  questions: 'questions.v1',
  /** The agent's own option list travels on `approval.requested` and `optionId` is honoured. */
  approvalOptions: 'approval_options.v1',
  /** `session.list_history` / `session.backfill`: a history source is wired up. */
  backfill: 'backfill.v1',
  /** `repo.scan` / `project.register_handle` (`PAGR_REMOTE_PROJECT_PICK`). */
  repoScan: 'repo_scan.v1',
  /** The Mac is held awake while Pagr has live work (`PAGR_KEEP_AWAKE`, macOS only). */
  keepAwake: 'keep_awake.v1',
  /** The Claude Code channel is registered, so a terminal session can be given a turn. */
  channel: 'channel.v1',
  /**
   * `session.handoff.capture` / `review.start` / `review.apply` / `rules.migrate`: this Mac has a
   * handoff engine, so a switch or a cross-agent review will actually run.
   *
   * Declared here with the rest of the vocabulary; it is advertised once the engine exists, on
   * the same terms as every other name in this object — a capability is a fact about the daemon
   * as it is running, never a build-time constant.
   */
  handoff: 'handoff.v1',
} as const;

/**
 * What `device.hello` v2 says about the Claude Code channel. Every field is a local fact the
 * daemon already holds; nothing here forks `claude` (a hello is sent on every connect).
 */
export interface HelloChannelStatus {
  /** The channel server file is present in this install. */
  serverInstalled: boolean;
  /** The daemon's `channel.*` IPC is on AND the server is installed, so `pagr claude` can attach. */
  registered: boolean;
  /** Claude sessions bound by session id right now. */
  boundSessions: number;
  /** Never `steered`: a channel line is surfaced to Claude at the next turn boundary. */
  mode: 'queued_next_turn' | 'off';
}

/** Longest iMessage line the bridge composes from an agent's final message. */
export const IMESSAGE_CLIP = 500;

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'stopped']);
const isTerminalStatus = (s: SessionStatus): boolean => TERMINAL_STATUSES.has(s);

const helloBytes = (hello: EventPayload<'device.hello'>): number =>
  Buffer.byteLength(JSON.stringify(hello), 'utf8');

/** Live sessions first, then the most recently updated: what a phone opening the app needs. */
export function rankHelloSessions<T extends SessionSummary>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const live = Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status));
    if (live !== 0) return live;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
}

export interface ApprovalRequest extends Omit<PendingApprovalInput, 'onResolve' | 'assessment'> {
  /**
   * Unredacted local facts about the action (command, paths, cwd, project root). Classified here,
   * on the Mac, into the assessment the device floor judges a cloud `allow` against.
   */
  local?: LocalActionDetail;
  /**
   * v2. The agent's own option list, forwarded to the phone as-is and kept on the pending record
   * — not so the bridge can answer on its own, but so an answer naming an option this prompt
   * never offered is refused instead of guessed at.
   */
  options?: ApprovalOption[];
  /** Resolved exactly once. `decision` is null for timeouts / provider-side / shutdown. */
  onDecision: (
    decision: ApprovalDecision | null,
    resolution: ApprovalResolution,
    source: ApprovalSource,
    outcome: ApprovalOutcome,
  ) => Promise<void> | void;
}
/**
 * A question an agent asked, on its way to the phone. Mirrors `ApprovalRequest`, minus everything
 * about risk: there is no device floor for a question, because a question runs nothing.
 */
export interface QuestionRequest extends Omit<PendingQuestionInput, 'onResolve'> {
  /** The provider's own id for the `question` frame, so the same ask is journaled once. */
  providerRecordId?: string;
  /** Frame metadata. Defaults to `{ source: 'stdio' }`. */
  meta?: JournalMeta;
  /** Resolved exactly once. `answers` is null on every ending that is not the person's answer. */
  onAnswer: (
    answers: QuestionAnswer[] | null,
    resolution: QuestionResolution,
    source: QuestionSource,
    outcome: QuestionOutcome,
  ) => Promise<void> | void;
}

type AckErrorCode = NonNullable<AckPayload['errorCode']>;

export class DispatchError extends Error {
  constructor(
    readonly code: AckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface DispatcherOptions {
  deviceId: string;
  adapters: Map<Provider, CodingAgentAdapter>;
  registry: ProjectRegistry;
  sessions: SessionStore;
  emit: (event: DeviceEvent) => void;
  tmpDir: string;
  bridgeVersion: string;
  policyFile?: string;
  /** `~/.pagr/device-policy.json` — the local approval floor. Never written by a command. */
  devicePolicyFile?: string;
  /** Environment the device floor reads `PAGR_DEVICE_FLOOR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pre-built floor; overrides `devicePolicyFile`/`env`. Tests use it. */
  deviceFloor?: DeviceFloor;
  fetch?: FetchLike;
  now?: () => Date;
  logger?: Logger;
  osVersion?: string;
  attachmentTimeoutMs?: number;
  /** Workspace + resource rules for concurrent sessions. Defaults to `SessionGuard.fromEnv()`. */
  guard?: SessionGuard;
  /** Backstop lifetime for a downloaded attachment whose turn never ends. Default one hour. */
  attachmentLeaseTtlMs?: number;
  /** Most sessions a `device.hello` may carry. Default `MAX_HELLO_SESSIONS`. */
  maxHelloSessions?: number;
  /** Byte ceiling for a `device.hello` payload. Default `MAX_HELLO_BYTES`. */
  maxHelloBytes?: number;
  /**
   * The phones this Mac currently seals frames for (`GatewayClient.recipientKeyIds()`), reported
   * in `device.hello` v2. Read at hello time, not at construction: the set arrives with
   * `auth.result` and changes live on `keys.updated`.
   */
  recipientKeyIds?: () => string[];
  /**
   * The protocol version in force on the current link (`GatewayClient.negotiatedVersion`). Read
   * at hello time, because it is a property of the connection, not of the daemon. Absent means 1,
   * and a v1 hello carries exactly the fields it carried before v2 existed.
   */
  negotiatedVersion?: () => number;
  /** Whether this Mac is actually being held awake (`KeepAwake` minus its opt-outs). */
  keepAwakeEnabled?: () => boolean;
  /** Live Claude channel facts for `device.hello` v2. Absent means "this bridge has no channel". */
  channelHello?: () => HelloChannelStatus;
  /**
   * Called whenever the set of pending approvals changes. The daemon uses it to hold the Mac
   * awake while somebody still has a prompt to answer; nothing in the dispatcher depends on it.
   */
  onApprovalsChange?: () => void;
  /**
   * Called whenever the set of pending questions changes. Separate from `onApprovalsChange` so the
   * Mac's keep-awake can say which kind of work is holding it open.
   */
  onQuestionsChange?: () => void;
  /**
   * Transcript frames. Absent on a bridge with no journal wired up (the CLI's one-shot
   * dispatchers, and tests that do not care), in which case `emitFrame` returns null rather than
   * throwing — a bridge that cannot journal must not pretend to have sent anything.
   */
  frames?: FrameChannel;
  /**
   * History and backfill (v2). Absent means the two commands ack `capability_unsupported`: a
   * bridge that cannot read a transcript must say so rather than answer "no history".
   */
  backfill?: BackfillChannel;
  /**
   * How `git.ts` — the one module allowed to spawn git — runs it, for both the handoff commands
   * and `review.start`. Absent in production, which is the point: the real runner is
   * `child_process.execFile` and nothing may replace it at run time. Tests substitute their own
   * so a switch or a review can be exercised without a repository on disk.
   */
  git?: GitOptions;
  /**
   * Claude Code channel bindings. Defaults to the process-wide bridge the daemon registers
   * `channel.*` on; injected in tests. Read for exactly one decision: whether an adopted session
   * can be given a turn (see `assertOurSession`).
   */
  channelBridge?: ChannelBridge;
  /** Bounds for `review.start`. Absent means the module's own defaults and the environment. */
  review?: ReviewChannel;
}

/** How long a review may take and how closely its report is watched for. Tests shorten all three. */
export interface ReviewChannel {
  /** Whole-review bound. Defaults to `reviewTimeoutMs(env)`. */
  timeoutMs?: number;
  /** Defaults to `REVIEW_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /** Defaults to `REVIEW_REREAD_GRACE_MS`. */
  reReadGraceMs?: number;
}

/** Everything `session.list_history` and `session.backfill` need that the dispatcher does not own. */
export interface BackfillChannel {
  /** `$HOME` holding `.claude`. Null or absent turns the Claude transcript source off. */
  claudeHome?: string | null;
  /** Codex, and anything later. The Claude transcripts are built into the service. */
  sources?: BackfillSource[];
  /** Replay a Claude transcript into frames. Supplied by the Claude adapter. */
  replayTranscript?: (session: DiscoveredSession) => Promise<ReplayFrame[] | null>;
  /** Which project a directory belongs to. Defaults to the daemon's mirror bridge. */
  projectFor?: (cwd: string) => MirrorProject | null;
  /** Hold the Mac awake for the duration of a backfill. Returns the release. */
  hold?: (reason: string) => () => void;
  /** Shared so `pagr sessions backfill` and a phone contend for the same single slot. */
  guard?: BackfillGuard;
}

/** Everything `emitFrame` needs that the dispatcher does not own. */
export interface FrameChannel {
  journal: JournalStore;
  cursors: OutboxCursors;
  /** The phones to seal for (`kid` → base64url X25519). Empty means journal-only. */
  recipientKeys: () => Record<string, string>;
  /** Protocol version in force on the current link. Frames are v2-only. */
  protocolVersion: () => number;
  /** Whether the account has iMessage linked; gates the plaintext `imessage` field. */
  imessageLinked?: () => boolean;
  /** Most frames one reconnect re-sends per session. Default `MAX_RESUME_FRAMES`. */
  maxResumeFrames?: number;
}

/**
 * Frames one reconnect re-sends per session before leaving the rest for the next one.
 *
 * A Mac that was offline for a fortnight has more backlog than a phone wants in one burst, and
 * the gateway's ack moves the cursor as each batch lands, so the next connection picks up exactly
 * where this one stopped. Anything older than the journal keeps is a `session.backfill`.
 */
export const MAX_RESUME_FRAMES = 500;

/** What `emitFrame` did. `emitted: false` is a normal outcome, not a failure. */
export interface EmitFrameResult {
  seq: number;
  emitted: boolean;
  /** Why the frame stayed on this Mac. */
  heldBack?: 'duplicate' | 'protocol_v1' | 'no_recipients';
}

/** Facts about a frame the caller owns; `seq` and the seal are the dispatcher's. */
export interface EmitFrameInput {
  projectId: string;
  provider: Provider;
  meta: JournalMeta;
  providerRecordId?: string;
  at?: string;
  imessage?: string;
  /**
   * This frame is the agent's last word of the turn — a message with nothing else to do after it.
   *
   * Both agents end a turn the same way: an assistant message that calls no tool. The adapters
   * say so here rather than the dispatcher guessing, and it is what decides which single frame of
   * a turn carries the plaintext `imessage` line. Anything else would put one line in the
   * iMessage thread per paragraph the model wrote.
   */
  endsTurn?: boolean;
}

/** How an agent is named in a line a person reads in their iMessage thread. */
export const agentName = (provider: Provider): string =>
  provider === 'claude' ? 'Claude' : 'Codex';

/**
 * The plaintext iMessage line for a question: who asked, and what they asked.
 *
 * The header when the agent gave one (it is the short form the model itself wrote for a narrow
 * column), otherwise the question text. Only the FIRST question of a multi-question ask: the
 * thread gets a nudge to open the app, not the whole sheet, and the options are never included
 * because answering happens on the phone where they are legible.
 */
export function questionImessageLine(q: {
  provider: Provider;
  questions: FrameQuestion[];
}): string {
  const first = q.questions[0];
  const text = (first?.header || first?.question || 'a question').trim();
  return clip(`${agentName(q.provider)} asked: ${text}`, IMESSAGE_CLIP);
}

/** One journaled frame the gateway has not acked, ready to go back on the wire. */
export interface ResumableFrame {
  sessionId: string;
  seq: number;
  event: DeviceEvent;
}

/**
 * Translates verified `CommandBody`s into adapter calls and adapter events into
 * `DeviceEvent`s. Every command produces exactly one `command.ack`.
 */
export class Dispatcher {
  readonly approvals: PendingApprovalRegistry;
  /** Questions the agents are blocked on, waiting for a person. */
  readonly questions: PendingQuestionRegistry;
  readonly guard: SessionGuard;
  /**
   * The device-side approval floor. Built once at construction from local files and the
   * environment: nothing the cloud sends can replace, widen or bypass it.
   */
  readonly floor: DeviceFloor;
  policy: PublicPolicy;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly capabilities = new Map<Provider, AgentConnectionStatus>();
  private readonly leases: AttachmentLeaseRegistry;
  /** handle → path for the repositories the last `repo.scan` found. In memory only. */
  private readonly repoHandles: RepoHandleCache;
  /** When the last accepted `repo.scan` started, for `REPO_SCAN_MIN_INTERVAL_MS`. */
  private lastRepoScanAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: DispatcherOptions) {
    this.logger = o.logger ?? silentLogger;
    this.guard = o.guard ?? SessionGuard.fromEnv();
    this.now = o.now ?? (() => new Date());
    this.leases = new AttachmentLeaseRegistry({
      dir: o.tmpDir,
      now: () => this.now(),
      ...(o.attachmentLeaseTtlMs ? { ttlMs: o.attachmentLeaseTtlMs } : {}),
    });
    this.repoHandles = new RepoHandleCache({ now: () => this.now() });
    this.policy = readPolicy(o.policyFile);
    this.floor = o.deviceFloor ?? DeviceFloor.fromFile(o.devicePolicyFile, o.env ?? process.env);
    this.approvals = new PendingApprovalRegistry({
      now: this.now,
      onResolveError: (approvalId, err) =>
        this.logger.warn('approval resolution failed', { approvalId, error: String(err) }),
      ...(o.onApprovalsChange ? { onChange: o.onApprovalsChange } : {}),
    });
    this.questions = new PendingQuestionRegistry({
      now: this.now,
      onResolveError: (questionId, err) =>
        this.logger.warn('question resolution failed', { questionId, error: String(err) }),
      ...(o.onQuestionsChange ? { onChange: o.onQuestionsChange } : {}),
    });
    for (const adapter of o.adapters.values()) {
      this.unsubscribes.push(
        adapter.subscribe((e) => {
          void this.onAdapterEvent(adapter.provider, e).catch((err) =>
            this.logger.warn('adapter event failed', {
              provider: adapter.provider,
              error: String(err),
            }),
          );
        }),
      );
    }
  }

  // ---------- events out ----------

  private send<T extends DeviceEvent['type']>(
    type: T,
    // The caller's shape: defaults the protocol supplies are not the emitter's to repeat.
    payload: EventPayloadInput<T>,
    inReplyTo?: string,
  ): DeviceEvent {
    const ev = makeEvent(this.o.deviceId, type, payload, {
      now: this.now,
      ...(inReplyTo ? { inReplyTo } : {}),
    });
    this.o.emit(ev);
    return ev;
  }

  ack(commandId: string, payload: Omit<AckPayload, 'commandId'>): DeviceEvent {
    return this.send('command.ack', { commandId, ...payload }, commandId);
  }

  // ---------- transcript frames (v2) ----------

  /**
   * Journal a frame, then seal and send it.
   *
   * The order is the whole point. `append` allocates the sequence number and puts the full body
   * on disk; only then is a capped, chunked copy sealed for the user's phones. A daemon killed
   * between the two loses nothing — the frame is on disk with `sent` still behind it, and the
   * next connection re-sends it from the journal.
   *
   * Three ordinary states end in `emitted: false` and are not failures: the provider handed us a
   * record we already have, the gateway speaks v1 and has never heard of `session.frame`, or no
   * phone key is pinned so nothing in the world could open the envelope. All three still journal,
   * because the journal is what a later backfill serves.
   */
  emitFrame(sessionId: string, body: FrameBody, input: EmitFrameInput): EmitFrameResult | null {
    const channel = this.o.frames;
    if (!channel) return null;
    const { seq, at, duplicate } = channel.journal.append(sessionId, body, {
      projectId: input.projectId,
      provider: input.provider,
      meta: input.meta,
      ...(input.providerRecordId ? { providerRecordId: input.providerRecordId } : {}),
      ...(input.at ? { at: input.at } : {}),
    });
    if (duplicate) return { seq, emitted: false, heldBack: 'duplicate' };

    const hold = this.frameHold();
    if (hold) {
      this.logger.debug('frame journaled but not sent', { sessionId, seq, reason: hold });
      return { seq, emitted: false, heldBack: hold };
    }
    const entry: JournalEntry = {
      sessionId,
      seq,
      at,
      kind: body.kind,
      projectId: input.projectId,
      provider: input.provider,
      ...(input.providerRecordId ? { providerRecordId: input.providerRecordId } : {}),
      meta: input.meta,
      body,
    };
    for (const event of this.frameEvents(
      entry,
      input.imessage ?? this.imessageLineFor(body, input),
    ))
      this.o.emit(event);
    channel.cursors.noteSent(sessionId, seq);
    return { seq, emitted: true };
  }

  /**
   * Stamp a summary with how far this Mac's journal for that session goes.
   *
   * It is the number the phone asks a `session.backfill` from, so it belongs on every summary the
   * bridge sends rather than only on the ones a mirror happens to build. Omitted when there is no
   * journal or nothing in it: `lastSeq: 0` would say "this session has a transcript and it is
   * empty", and absent says "this bridge is not telling you", which is the truth on v1.
   */
  private withLastSeq(s: SessionSummaryV2): SessionSummaryV2 {
    const channel = this.o.frames;
    if (!channel || s.lastSeq !== undefined) return s;
    let lastSeq = 0;
    try {
      lastSeq = channel.journal.lastSeq(s.sessionId);
    } catch {
      return s;
    }
    return lastSeq > 0 ? { ...s, lastSeq } : s;
  }

  /**
   * Offer an unregistered directory to the phone as a `project.register_handle` handle.
   *
   * Same handle, same cache and same hour-long life as the ones `repo.scan` mints — this is the
   * other way a folder gets offered: not "list my repositories" but "somebody is working in this
   * one right now, add it?". Returns null when remote project pick is off, in which case the
   * session is still reported and simply has nothing to tap.
   */
  offerRepoHandle(realPath: string): string | null {
    if (!this.remotePickEnabled()) return null;
    const handle = handleFor(realPath, this.o.registry.deviceSalt());
    this.repoHandles.put(handle, realPath);
    return handle;
  }

  /**
   * Journaled frames the gateway has not confirmed, oldest first — what a reconnect re-sends
   * before the in-memory ring, so the transcript arrives in order.
   */
  pendingFrames(): ResumableFrame[] {
    const channel = this.o.frames;
    if (!channel || this.frameHold()) return [];
    const limit = channel.maxResumeFrames ?? MAX_RESUME_FRAMES;
    const out: ResumableFrame[] = [];
    for (const { sessionId, fromSeq, toSeq } of channel.cursors.pending()) {
      const entries = channel.journal.read(sessionId, fromSeq, toSeq);
      const batch = entries.slice(0, limit);
      if (entries.length > batch.length)
        this.logger.info('resuming part of a session backlog; the rest follows next connection', {
          sessionId,
          resending: batch.length,
          remaining: entries.length - batch.length,
        });
      for (const entry of batch)
        for (const event of this.frameEvents(entry)) out.push({ sessionId, seq: entry.seq, event });
    }
    return out;
  }

  /** Record that a resumed frame has been handed to the socket. */
  noteFrameSent(sessionId: string, seq: number): void {
    this.o.frames?.cursors.noteSent(sessionId, seq);
  }

  /** Why frames may not go on the wire right now, or null when they may. */
  private frameHold(): 'protocol_v1' | 'no_recipients' | null {
    const channel = this.o.frames;
    if (!channel) return null;
    if (channel.protocolVersion() < 2) return 'protocol_v1';
    return this.recipients().length === 0 ? 'no_recipients' : null;
  }

  /** True when the account has an iMessage thread linked, so a plaintext line may be sent. */
  private imessageLinked(): boolean {
    return this.o.frames?.imessageLinked?.() === true;
  }

  /**
   * The plaintext line this frame contributes to the iMessage thread, or undefined.
   *
   * Only the agent's final message of a turn produces one, and only when a thread is linked: a
   * line here travels in the clear through the cloud's messaging path, so nothing composes one
   * speculatively "in case" the feature is switched on later. The gate is re-read on every frame,
   * which is what makes `settings.updated` take effect mid-connection.
   */
  private imessageLineFor(body: FrameBody, input: EmitFrameInput): string | undefined {
    if (!input.endsTurn || body.kind !== 'assistant' || !this.imessageLinked()) return undefined;
    const line = clip(body.text, IMESSAGE_CLIP);
    return line === '' ? undefined : line;
  }

  /** One `session.frame` event per sealed chunk. All of them carry the same `seq`. */
  private frameEvents(entry: JournalEntry, imessage?: string): DeviceEvent[] {
    const channel = this.o.frames;
    if (!channel) return [];
    const recipients = this.recipients();
    if (recipients.length === 0) return [];
    const plan = chunkFrame(entry.body);
    const events: DeviceEvent[] = [];
    for (const part of plan.parts) {
      const aad: SealAad = {
        sessionId: entry.sessionId,
        seq: entry.seq,
        kind: entry.kind,
        ...(part.chunk ? { chunk: part.chunk } : {}),
      };
      events.push(
        makeEvent(
          this.o.deviceId,
          'session.frame',
          {
            sessionId: entry.sessionId,
            projectId: entry.projectId,
            provider: entry.provider,
            seq: entry.seq,
            kind: entry.kind,
            at: entry.at,
            ...(entry.providerRecordId ? { providerRecordId: entry.providerRecordId } : {}),
            sealed: sealFrame(part.body, aad, recipients),
            meta: {
              ...entry.meta,
              bytes: plan.bytes,
              truncated: plan.truncated,
              ...(part.chunk ? { chunk: part.chunk } : {}),
            },
          },
          { now: this.now },
        ),
      );
    }
    // Only the first part carries the iMessage line: it is one message, not one per chunk.
    if (imessage && channel.imessageLinked?.() && events[0])
      (events[0].payload as Record<string, unknown>).imessage = imessage.slice(0, 1500);
    return events;
  }

  /**
   * Imported once per distinct key set rather than per frame: `importRecipientKeys` does a
   * fingerprint check and an X25519 parse per phone, and a busy session is hundreds of frames a
   * minute against a set that changes when somebody pairs a phone.
   */
  private recipientCacheKey = '\u0000';
  private recipientCache: RecipientKeySet = [];
  private recipients(): RecipientKeySet {
    const raw = this.o.frames?.recipientKeys() ?? {};
    const key = canonicalize(raw);
    if (key === this.recipientCacheKey) return this.recipientCache;
    this.recipientCacheKey = key;
    try {
      this.recipientCache = importRecipientKeys(raw);
    } catch (err) {
      // A set that does not import is a set nothing can be sealed for. Frames stay journaled.
      this.logger.error('pinned recipient keys are unusable; frames stay on this Mac', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.recipientCache = [];
    }
    return this.recipientCache;
  }

  // ---------- commands in ----------

  /** Run a verified command. Always returns (and has already emitted) the ack event. */
  async handle(body: CommandBody): Promise<DeviceEvent> {
    try {
      const result = await this.run(body);
      return this.ack(body.commandId, {
        status: 'completed',
        ...(result === undefined ? {} : { result }),
      });
    } catch (err) {
      const code: AckErrorCode =
        err instanceof DispatchError
          ? err.code
          : err instanceof ProjectError
            ? 'unknown_project'
            : 'provider_error';
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.logger.warn('command failed', {
        type: body.type,
        commandId: body.commandId,
        code,
        message,
      });
      return this.ack(body.commandId, { status: 'failed', errorCode: code, message });
    }
  }

  private async run(body: CommandBody): Promise<unknown> {
    switch (body.type) {
      case 'device.probe':
        return this.probe();
      case 'project.list':
        return { projects: this.o.registry.summaries() };
      case 'project.remove': {
        const { projectId } = body.payload;
        if (!this.o.registry.remove(projectId))
          throw new DispatchError('unknown_project', 'unknown project');
        this.send('project.removed', { projectId });
        return { projectId };
      }
      case 'agent.start_session':
        return this.startSession(body.payload);
      case 'agent.send_instruction':
        this.assertOurSession(body.payload.sessionId, 'send an instruction to', {
          channelBound: true,
        });
        return this.sendInstruction(body.payload);
      case 'agent.stop_session': {
        this.assertOurSession(body.payload.sessionId, 'stop');
        const { adapter } = this.sessionAdapter(body.payload.sessionId);
        await adapter.stopSession(body.payload.sessionId);
        this.o.sessions.setStatus(body.payload.sessionId, 'stopped');
        return { sessionId: body.payload.sessionId };
      }
      case 'agent.get_status':
        return this.getStatus(body.payload.sessionId);
      case 'agent.respond_to_approval':
        return this.respondToApproval(body.payload);
      case 'agent.answer_question':
        return this.answerQuestion(body.payload);
      case 'session.list_history':
        this.assertV2(body.version, 'session.list_history');
        return {
          sessions: await this.listHistory({
            sinceDays: body.payload.sinceDays,
            limit: body.payload.limit,
            ...(body.payload.provider ? { provider: body.payload.provider } : {}),
            ...(body.payload.projectId ? { projectId: body.payload.projectId } : {}),
          }),
        };
      case 'session.backfill':
        this.assertV2(body.version, 'session.backfill');
        return this.runBackfill({
          sessionId: body.payload.sessionId,
          fromSeq: body.payload.fromSeq,
          maxBytes: body.payload.maxBytes,
          ...(body.payload.toSeq !== undefined ? { toSeq: body.payload.toSeq } : {}),
        });
      case 'review.start':
        this.assertV2(body.version, 'review.start');
        return this.startReview(body.payload, body.commandId);
      case 'review.apply':
        this.assertV2(body.version, 'review.apply');
        return this.applyReview(body.payload);
      case 'session.handoff.capture':
        this.assertV2(body.version, 'session.handoff.capture');
        return this.handoffCapture(body.payload);
      case 'repo.scan':
        return this.scanRepositories();
      case 'project.register_handle':
        return this.registerRepoHandle(body.payload);
      case 'rules.migrate':
        this.assertV2(body.version, 'rules.migrate');
        return this.migrateRules(body.payload);
      case 'settings.sync_public_policy': {
        // Re-parsed rather than spread: a key the cloud sends that this bridge no longer honours
        // (`smartApprovalsTierA`) must not survive into `policy.json` looking like a live setting.
        this.policy = PublicPolicy.parse(body.payload);
        writePolicy(this.o.policyFile, this.policy);
        return this.policy;
      }
    }
  }

  async probe(): Promise<EventPayload<'device.hello'>> {
    const agents: AgentConnectionStatus[] = [];
    for (const adapter of this.o.adapters.values()) {
      try {
        const st = await adapter.probe();
        this.capabilities.set(adapter.provider, st);
        agents.push(st);
      } catch (err) {
        this.logger.warn('probe failed', { provider: adapter.provider, error: String(err) });
      }
    }
    const version = this.helloProtocolVersion();
    const v2 = version >= 2;
    const sessions: SessionSummaryV2[] = [];
    const seen = new Set<string>();
    for (const adapter of this.o.adapters.values()) {
      try {
        for (const s of await adapter.listSessions()) {
          if (seen.has(s.sessionId)) continue;
          seen.add(s.sessionId);
          sessions.push(this.authoritative(s));
        }
      } catch {
        // adapter may not support listing
      }
    }
    // Sessions the bridge did not start are not in any adapter's list — the adapter only knows
    // what it spawned — but they are real, and the phone has to be able to see one to answer its
    // prompts. Only those inside a registered project can be described: a `SessionSummary` names
    // a `proj_…` id. The `device.hello` ceiling below still applies to all of them together.
    for (const rec of this.o.sessions.list()) {
      if (!isAdopted(rec) || !isReportable(rec) || seen.has(rec.sessionId)) continue;
      seen.add(rec.sessionId);
      sessions.push({
        sessionId: rec.sessionId,
        projectId: rec.projectId,
        provider: rec.provider,
        status: rec.status,
        displayName: ADOPTED_SESSION_NAME,
        activeTurn: rec.status === 'waiting_for_approval',
        startedAt: rec.startedAt,
        updatedAt: rec.updatedAt,
      });
    }
    // v2 capabilities. Only facts: a name appears here exactly when the command behind it will
    // actually run on this Mac, so a cloud that gates a button on one is never lying to a user.
    //
    // On a v1 link this is the one name v1 ever carried, and the hello stays byte-identical to
    // what a pre-v2 gateway has always received — a gateway that answered 1 has told us it has
    // never heard of the rest, and a hello is not the place to find out how it copes.
    const capabilityNames = v2
      ? this.helloCapabilities()
      : this.remotePickEnabled()
        ? [HELLO_CAPABILITIES.repoScan]
        : [];
    const recipientKeyIds = [...(this.o.recipientKeyIds?.() ?? [])].sort();
    const ranked = rankHelloSessions(sessions).slice(
      0,
      this.o.maxHelloSessions ?? MAX_HELLO_SESSIONS,
    );
    const channel = v2 ? this.o.channelHello?.() : undefined;
    const lifted = this.floor.lifted;
    const hello: EventPayload<'device.hello'> = {
      bridgeVersion: this.o.bridgeVersion,
      // The NEGOTIATED version, not an offer: a hello is the first thing sent on a connection
      // whose version has already been settled by `auth.result`, so it reports what is in force.
      protocolVersion: version,
      platform: 'darwin',
      osVersion: this.o.osVersion ?? release(),
      agents,
      projects: this.o.registry.summaries(),
      sessions: v2 ? ranked.map((s) => this.helloSession(s)) : ranked,
      ...(capabilityNames.length > 0 ? { capabilities: capabilityNames } : {}),
      // v2. Always present on a v2 link, empty array and all: "nothing is lifted" is a fact the
      // app's Security screen states, and an absent field would read as "this bridge cannot say".
      ...(v2 ? { floor: { lifted } } : {}),
      ...(channel ? { channel } : {}),
      // v2, and omitted when empty: a hello with no phones in it says the same thing to a v2
      // gateway as it does to a v1 one that has never heard of the field.
      ...(recipientKeyIds.length > 0 ? { recipientKeyIds } : {}),
    };
    const dropped = sessions.length - hello.sessions.length;
    if (dropped > 0)
      this.logger.info('device.hello trimmed to the most relevant sessions', {
        reported: hello.sessions.length,
        omitted: dropped,
      });
    return this.fitHello(hello, sessions.length);
  }

  /** The version in force on this connection. 1 when nothing has negotiated anything. */
  private helloProtocolVersion(): 1 | 2 {
    return (this.o.negotiatedVersion?.() ?? 1) >= 2 ? 2 : 1;
  }

  /**
   * The capability names this daemon may honestly advertise, in a stable order.
   *
   * Each line is the same condition the command behind it is actually gated on elsewhere in this
   * file, so the two cannot drift: `backfill.v1` is `this.o.backfill`, which is what makes
   * `session.backfill` answer instead of `capability_unsupported`, and so on.
   */
  helloCapabilities(): string[] {
    const names: string[] = [];
    const frames = this.o.frames !== undefined;
    if (frames) names.push(HELLO_CAPABILITIES.frames);
    // Sealing needs both halves: something to seal (the journal) and somewhere to get the phone
    // keys from. A set that is merely empty right now still counts — the phones arrive with
    // `auth.result` and `keys.updated`, and `recipientKeyIds` says which are pinned this second.
    if (frames && this.o.recipientKeyIds !== undefined) names.push(HELLO_CAPABILITIES.seal);
    if ([...this.o.adapters.values()].some((a) => typeof a.answerQuestion === 'function'))
      names.push(HELLO_CAPABILITIES.questions);
    // Unconditional: the dispatcher forwards whatever options an adapter offers and refuses an
    // `optionId` the prompt never carried, for every provider and both directions.
    names.push(HELLO_CAPABILITIES.approvalOptions);
    if (this.o.backfill !== undefined) names.push(HELLO_CAPABILITIES.backfill);
    if (this.remotePickEnabled()) names.push(HELLO_CAPABILITIES.repoScan);
    if (this.o.keepAwakeEnabled?.() === true) names.push(HELLO_CAPABILITIES.keepAwake);
    if (this.o.channelHello?.().registered === true) names.push(HELLO_CAPABILITIES.channel);
    return names;
  }

  /**
   * A summary as v2 describes it: what Pagr may do with the session, who started it, whether its
   * directory is a project, how far this Mac's journal for it goes, and — for a session running
   * somewhere Pagr does not know about — the handle that turns the folder into a project.
   *
   * Anything the adapter already said is kept: a mirrored Codex thread and a mirrored Claude
   * session arrive here already carrying their control level and origin, and this Mac's
   * `sessions.json` knows nothing better about them than they do.
   */
  private helloSession(s: SessionSummaryV2): SessionSummaryV2 {
    const rec = this.o.sessions.get(s.sessionId);
    const adopted = rec ? isAdopted(rec) : false;
    const out: SessionSummaryV2 = { ...s };
    if (out.controlLevel === undefined)
      out.controlLevel = this.derivedControlLevel(s.sessionId, adopted);
    if (out.origin === undefined) out.origin = adopted ? 'terminal' : 'pagr';
    if (out.projectStatus === undefined)
      out.projectStatus = s.projectId === UNREGISTERED_PROJECT ? 'unregistered' : 'registered';
    if (out.repoHandle === undefined && out.projectStatus === 'unregistered' && rec?.cwd) {
      const handle = this.offerRepoHandle(rec.cwd);
      if (handle) out.repoHandle = handle;
    }
    return this.withLastSeq(out);
  }

  /**
   * How much of a session Pagr may drive, worked out from what this Mac knows about it.
   *
   * A session the bridge started is `full`. One it merely adopted is `approvals_only` — unless a
   * Pagr channel is bound to it (`pagr claude`), which is a documented way in and makes it `full`
   * again. An adapter that says otherwise about its own live session always wins; this is the
   * answer for the ones that do not (see `controlLevelFor`).
   */
  private derivedControlLevel(sessionId: string, adopted: boolean): ControlLevel {
    if (!adopted) return 'full';
    return this.channelBoundTo(sessionId) ? 'full' : 'approvals_only';
  }

  /**
   * A session's status as this Mac knows it. `sessions.json` is reconciled against the providers
   * at every daemon start, so a session it records as completed / failed / stopped is finished —
   * and a hello must never tell the cloud otherwise. The gateway upserts these summaries, so one
   * downgraded row is enough to make a dead session look resumable on the user's phone (BR-4).
   */
  private authoritative(summary: SessionSummaryV2): SessionSummaryV2 {
    const rec = this.o.sessions.get(summary.sessionId);
    if (!rec || !isTerminalStatus(rec.status) || isTerminalStatus(summary.status)) return summary;
    return { ...summary, status: rec.status, activeTurn: false, updatedAt: rec.updatedAt };
  }

  /**
   * Make an oversized hello impossible. The gateway caps an inbound frame at 256 KiB and closes
   * with 1009 on anything larger; since the hello is sent on every single connect, one that does
   * not fit is an endless reconnect loop that explains itself nowhere (BR-3). So: measure what
   * would go on the wire and shed sessions (then projects) until it fits, loudly.
   */
  private fitHello(
    hello: EventPayload<'device.hello'>,
    totalSessions: number,
  ): EventPayload<'device.hello'> {
    const limit = this.o.maxHelloBytes ?? MAX_HELLO_BYTES;
    let out = hello;
    let bytes = helloBytes(out);
    if (bytes <= limit) return out;
    while (bytes > limit && out.sessions.length > 0) {
      const keep = Math.floor(out.sessions.length / 2);
      out = { ...out, sessions: out.sessions.slice(0, keep) };
      bytes = helloBytes(out);
    }
    while (bytes > limit && out.projects.length > 0) {
      const keep = Math.floor(out.projects.length / 2);
      out = { ...out, projects: out.projects.slice(0, keep) };
      bytes = helloBytes(out);
    }
    this.logger.warn('device.hello was too large for the gateway frame cap and was trimmed', {
      bytes,
      limitBytes: limit,
      sessions: out.sessions.length,
      omittedSessions: totalSessions - out.sessions.length,
      projects: out.projects.length,
    });
    return out;
  }

  // ---------- history and backfill (v2) ----------

  /**
   * The service, built once.
   *
   * Once, because `BackfillGuard` is the single slot this Mac serialises backfills through: a new
   * service per command would be a new guard per command, which is no guard at all.
   */
  private backfillSvc: BackfillService | null = null;
  /** Live summaries for the current `listHistory`, refreshed from the adapters before each call. */
  private liveSummaries = new Map<string, SessionSummaryV2>();

  private backfillService(): BackfillService {
    const channel = this.o.backfill;
    if (!channel)
      throw new DispatchError(
        'capability_unsupported',
        'this bridge has no transcript history wired up',
      );
    if (this.backfillSvc) return this.backfillSvc;
    this.backfillSvc = new BackfillService({
      journal: this.frameChannel().journal,
      // The same sealing path a live frame takes, so a replayed frame is byte-identical to the
      // one the phone would have received at the time — only `meta.source` differs.
      seal: (entry) => this.frameEvents(entry),
      emit: (event) => this.o.emit(event),
      live: (sessionId) => this.liveSummaries.get(sessionId) ?? null,
      record: (sessionId) => this.o.sessions.get(sessionId),
      logger: this.logger,
      now: this.now,
      guard: channel.guard ?? new BackfillGuard(),
      onProgress: (p) =>
        this.send('session.event', {
          sessionId: p.sessionId,
          projectId: p.projectId,
          provider: p.provider,
          kind: 'progress',
          summary: `backfilled ${p.frames} frame(s) up to #${p.lastSeq}`,
          at: this.now().toISOString(),
        }),
      ...(channel.claudeHome !== undefined ? { claudeHome: channel.claudeHome } : {}),
      ...(channel.sources ? { sources: channel.sources } : {}),
      ...(channel.replayTranscript ? { replayTranscript: channel.replayTranscript } : {}),
      ...(channel.projectFor ? { projectFor: channel.projectFor } : {}),
      ...(channel.hold ? { hold: channel.hold } : {}),
    });
    return this.backfillSvc;
  }

  private frameChannel(): FrameChannel {
    if (!this.o.frames)
      throw new DispatchError(
        'capability_unsupported',
        'this bridge has no frame journal, so it has no history to serve',
      );
    return this.o.frames;
  }

  /**
   * Both commands are v2. A v1 link has never heard of `session.frame`, so answering a backfill on
   * one would journal work nobody could receive and report a frame count that never arrived.
   */
  private assertV2(version: number, what: string): void {
    if (version < 2) throw new DispatchError('not_negotiated', `${what} is a protocol v2 command`);
  }

  /**
   * Sessions this Mac can still produce frames for, live ones described by themselves.
   *
   * The adapters are asked first and their answers win: a session that is running right now knows
   * its own control level, and nothing read off a finished file could work it out.
   */
  async listHistory(q: HistoryQuery): Promise<SessionSummaryV2[]> {
    const svc = this.backfillService();
    this.liveSummaries = new Map();
    for (const adapter of this.o.adapters.values()) {
      try {
        // `authoritative` is typed on the v1 summary and returns the same object when it has
        // nothing to correct; spreading keeps the v2 fields it does not know about.
        for (const s of await adapter.listSessions())
          this.liveSummaries.set(
            s.sessionId,
            this.withLastSeq({ ...s, ...(this.authoritative(s) as SessionSummaryV2) }),
          );
      } catch {
        // An adapter that cannot list is not an error here: history is the fallback, not the
        // other way round, and the transcript on disk says what that session did anyway.
      }
    }
    return svc.listHistory(q);
  }

  /**
   * Replay journaled frames to the phone, building the journal from the provider's own record
   * first when this bridge never streamed the session.
   *
   * A second request while one is running is `rate_limited`, not a queue: a backfill competes with
   * live frames for the socket and the disk, and a phone that fired twice deserves a fast answer.
   */
  async runBackfill(p: BackfillRequest): Promise<BackfillResult> {
    const svc = this.backfillService();
    try {
      return await svc.backfill(p);
    } catch (err) {
      if (err instanceof BackfillError) throw new DispatchError(err.code, err.message);
      throw err;
    }
  }

  private adapterFor(provider: Provider): CodingAgentAdapter {
    const a = this.o.adapters.get(provider);
    if (!a) throw new DispatchError('capability_unsupported', `no adapter for ${provider}`);
    return a;
  }

  private sessionAdapter(sessionId: string) {
    const rec = this.o.sessions.get(sessionId);
    if (!rec) throw new DispatchError('unknown_session', 'unknown session');
    return { rec, adapter: this.adapterFor(rec.provider) };
  }

  /** A live Pagr channel bound to this exact session, i.e. a `pagr claude` terminal. */
  private channelBoundTo(sessionId: string): boolean {
    const bridge = this.o.channelBridge ?? getChannelBridge();
    const bound = bridge.bindingFor(sessionId);
    return Boolean(bound && bridge.isAttached(bound.cwd));
  }

  /**
   * Taking the turn in a session the bridge did not start.
   *
   * It cannot: the adapter only holds the sessions it spawned, so the instruction would reach an
   * adapter that has never heard of this one. Refusing here turns that into one sentence the
   * person can act on, and keeps the limit true on this side rather than only in the cloud.
   *
   * Two exceptions, both narrow. Answering a prompt this session raised is the entire point of
   * adopting it and goes through `respondToApproval`, which does not come through here. And a
   * session with a Pagr channel bound to it (`pagr claude`) CAN be given a follow-up: the channel
   * is a documented way in, and the text arrives as an ordinary user turn at the next turn
   * boundary. Stopping such a session is still refused — the `claude` process belongs to the
   * terminal it is running in, and Pagr has no handle on it to kill and no business killing it.
   */
  private assertOurSession(
    sessionId: string,
    what: string,
    opts: { channelBound?: boolean } = {},
  ): void {
    const rec = this.o.sessions.get(sessionId);
    if (!rec || !isAdopted(rec)) return;
    if (opts.channelBound && this.channelBoundTo(sessionId)) return;
    throw new DispatchError(
      'capability_unsupported',
      `this is one of your own ${rec.provider} sessions — Pagr did not start it, so it cannot ${what} it. Pagr can relay the prompts it raises; everything else belongs to the terminal it is running in.`,
    );
  }

  /**
   * Download the attachments, hand their paths to `fn`, and keep them on disk until the turn that
   * received them ends (see `AttachmentLeaseRegistry`). `fn` resolving means "the agent has been
   * given the turn", not "the agent has read the file", so the files must outlive this call.
   */
  private async withAttachments<T>(
    sessionId: string,
    refs: CommandPayload<'agent.start_session'>['attachments'],
    fn: (paths: string[]) => Promise<T>,
  ): Promise<T> {
    this.leases.sweep();
    const paths: string[] = [];
    let leaseId: string | undefined;
    try {
      for (const ref of refs) {
        try {
          const p = await fetchAttachment(ref, {
            tmpDir: this.o.tmpDir,
            now: this.now,
            ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
            ...(this.o.attachmentTimeoutMs ? { timeoutMs: this.o.attachmentTimeoutMs } : {}),
          });
          paths.push(p);
          this.send('attachment.consumed', { attachmentId: ref.attachmentId, ok: true });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.send('attachment.consumed', { attachmentId: ref.attachmentId, ok: false, error });
          throw new DispatchError('invalid_payload', `attachment ${ref.attachmentId}: ${error}`);
        }
      }
      // Leased before the adapter call, so an adapter that reports the turn finished while `fn` is
      // still unwinding frees these files rather than missing them.
      if (paths.length > 0) leaseId = this.leases.acquire(sessionId, paths);
      return await fn(paths);
    } catch (err) {
      // No turn ever took these files, so nothing will ever end one: free them now.
      if (leaseId !== undefined) this.leases.release(leaseId);
      else for (const p of paths) deleteAttachment(p);
      throw err;
    }
  }

  /** Backstop sweep for leases whose turn never reported an end. Called on the daemon's tick. */
  sweepAttachmentLeases(): number {
    return this.leases.sweep();
  }

  /** Files currently held for a session's turn. Exposed for tests and `pagr doctor`. */
  leasedAttachments(sessionId: string): string[] {
    return this.leases.pathsFor(sessionId);
  }

  /**
   * Turn boundaries, as reported by an adapter, drive attachment lifetime. Both adapters report
   * the end of a turn twice (status + session event); the registry ignores the second.
   */
  private noteTurnStatus(sessionId: string, status: SessionStatus, activeTurn?: boolean): void {
    if (status === 'stopped') this.leases.releaseSession(sessionId);
    else if (status === 'completed' || status === 'failed' || status === 'idle')
      this.leases.noteTurnEnded(sessionId);
    else if (activeTurn === true || status === 'working' || status === 'starting')
      this.leases.noteTurnStarted(sessionId);
  }

  /**
   * Every session that currently holds a process or a working tree, with the project root it
   * occupies. A session whose project has since been unregistered still holds a process, so it
   * keeps counting against the budget — but with a null path, so it cannot be used to refuse a
   * working tree the bridge can no longer name.
   */
  private liveClaims(): WorkspaceClaim[] {
    const out: WorkspaceClaim[] = [];
    for (const rec of this.o.sessions.list()) {
      if (!isLiveStatus(rec.status)) continue;
      let projectPath: string | null;
      try {
        projectPath = this.o.registry.resolve(rec.projectId).path;
      } catch {
        // The project was unregistered (or removed and re-added under a new id) while this
        // session ran. The path recorded when it started still names the tree it is writing to.
        projectPath = rec.projectPath ?? null;
      }
      out.push({
        sessionId: rec.sessionId,
        provider: rec.provider,
        projectId: rec.projectId,
        projectPath,
        writeCapable: rec.readOnly !== true,
      });
    }
    return out;
  }

  private async startSession(p: CommandPayload<'agent.start_session'>): Promise<SessionSummary> {
    const adapter = this.adapterFor(p.provider);
    const project = this.o.registry.resolve(p.projectId);
    // Refuse loudly and with a reason, rather than letting two agents race in one checkout or
    // forking `claude` until the Mac swaps. `capability_unsupported` is the ack code for "this
    // device will not do that", which is exactly what this is.
    const refusal = this.guard.check(
      {
        sessionId: p.sessionId,
        provider: p.provider,
        projectId: p.projectId,
        projectPath: project.path,
        writeCapable: !p.readOnly,
      },
      this.liveClaims(),
    );
    if (refusal) {
      this.logger.warn('refused to start session', {
        code: refusal.code,
        sessionId: p.sessionId,
        provider: p.provider,
      });
      throw new DispatchError('capability_unsupported', refusal.message);
    }
    // Claim the tree synchronously, before the first `await`. Commands are dispatched
    // fire-and-forget, so two `agent.start_session` for one project delivered in the same tick
    // would otherwise both see an empty set of live claims and both pass the check above.
    const reservedAt = this.now().toISOString();
    this.o.sessions.upsert({
      sessionId: p.sessionId,
      provider: p.provider,
      projectId: p.projectId,
      providerSessionId: p.sessionId,
      status: 'starting',
      readOnly: p.readOnly,
      projectPath: project.path,
      startedAt: reservedAt,
      updatedAt: reservedAt,
    });
    try {
      return await this.withAttachments(p.sessionId, p.attachments, async (localImagePaths) => {
        const summary = await adapter.startSession({
          sessionId: p.sessionId,
          project,
          instruction: p.instruction,
          localImagePaths,
          readOnly: p.readOnly,
          ...(p.displayName ? { displayName: p.displayName } : {}),
        });
        this.o.sessions.upsert({
          sessionId: summary.sessionId,
          provider: p.provider,
          projectId: p.projectId,
          providerSessionId: summary.sessionId,
          status: summary.status,
          readOnly: p.readOnly,
          projectPath: project.path,
          startedAt: summary.startedAt,
          updatedAt: summary.updatedAt,
        });
        this.send('session.updated', summary);
        return summary;
      });
    } catch (err) {
      // The reservation must not outlive a start that failed, or it would hold this tree and a
      // slot in the budget forever. Only a record still sitting at `starting` is ours to drop:
      // anything else means the adapter got far enough to report real progress.
      if (this.o.sessions.get(p.sessionId)?.status === 'starting')
        this.o.sessions.remove(p.sessionId);
      throw err;
    }
  }

  private async sendInstruction(p: CommandPayload<'agent.send_instruction'>) {
    const { rec, adapter } = this.sessionAdapter(p.sessionId);
    let mode = p.mode;
    if (mode === 'auto') {
      const caps = this.capabilities.get(rec.provider) ?? (await this.probeOne(adapter));
      const status = await adapter.getStatus(p.sessionId);
      mode = caps?.capabilities.canSteerActiveTurn && status?.activeTurn ? 'steer' : 'queue';
    }
    return this.withAttachments(p.sessionId, p.attachments, async (localImagePaths) => {
      const res = await adapter.sendInstruction({
        sessionId: p.sessionId,
        instruction: p.instruction,
        mode,
        localImagePaths,
      });
      if (res.delivered === 'queued') {
        this.send('session.event', {
          sessionId: p.sessionId,
          projectId: rec.projectId,
          provider: rec.provider,
          kind: 'queued_followup',
          summary: p.instruction.slice(0, 200),
          at: this.now().toISOString(),
        });
      }
      if (res.delivered === 'queued') {
        // Re-read: the record captured before the adapter call may already be stale.
        this.o.sessions.upsert({
          ...(this.o.sessions.get(p.sessionId) ?? rec),
          updatedAt: this.now().toISOString(),
        });
      } else {
        // A new turn (or steer) means the session is working again — even if the local record
        // said `completed`. But a fast provider can finish the whole turn before this line runs,
        // and stamping `working` over that would leave a session claiming to work forever. The
        // store is only written from here when the adapter has emitted nothing since the command
        // started (`upsert` always stores a fresh object, so identity is a reliable "unchanged").
        const at = this.now().toISOString();
        const live = await adapter.getStatus(p.sessionId);
        const cur = this.o.sessions.get(p.sessionId);
        const adapterSpoke = cur !== null && cur !== rec;
        const status = adapterSpoke ? cur.status : (live?.status ?? 'working');
        const activeTurn = adapterSpoke ? isLiveStatus(cur.status) : (live?.activeTurn ?? true);
        const updated = this.o.sessions.upsert({ ...(cur ?? rec), status, updatedAt: at });
        this.send('session.updated', {
          ...(live ?? {
            sessionId: updated.sessionId,
            projectId: updated.projectId,
            provider: updated.provider,
            startedAt: updated.startedAt,
          }),
          status,
          activeTurn,
          updatedAt: at,
        });
      }
      return { sessionId: p.sessionId, mode, delivered: res.delivered };
    });
  }

  private async probeOne(adapter: CodingAgentAdapter): Promise<AgentConnectionStatus | undefined> {
    try {
      const st = await adapter.probe();
      this.capabilities.set(adapter.provider, st);
      return st;
    } catch {
      return undefined;
    }
  }

  private async getStatus(sessionId: string | undefined): Promise<{ sessions: SessionSummary[] }> {
    if (sessionId) {
      const { adapter } = this.sessionAdapter(sessionId);
      const s = await adapter.getStatus(sessionId);
      if (!s) throw new DispatchError('unknown_session', 'provider no longer knows this session');
      this.o.sessions.setStatus(sessionId, s.status);
      return { sessions: [s] };
    }
    const out: SessionSummary[] = [];
    for (const rec of this.o.sessions.list()) {
      const adapter = this.o.adapters.get(rec.provider);
      if (!adapter) continue;
      try {
        const s = await adapter.getStatus(rec.sessionId);
        if (s) out.push(s);
      } catch {
        // skip
      }
    }
    return { sessions: out };
  }

  /**
   * The cloud's answer to a pending approval — and the one place a compromised cloud could
   * otherwise have turned "nine typed commands" into a remote shell.
   *
   * An `allow` is checked against the classification this Mac made when the provider raised the
   * prompt, before the cloud had been told anything about it. If the local classification puts the
   * action in a risk class the user has not lifted on this Mac, the approval is answered **deny**,
   * the agent is told, the phone is told why and how to opt in, and the command acks `failed`.
   * There is no path here that turns a refusal into a quieter allow.
   */
  private async respondToApproval(p: CommandPayload<'agent.respond_to_approval'>) {
    // Read before `respond` consumes the entry. `respond` still re-checks the binding, so a
    // mismatched request is reported as a mismatch rather than as a policy refusal.
    const entry = this.approvals.get(p.approvalId);
    const optionKind = entry && p.optionId ? this.checkOption(entry, p) : null;
    const pending = p.decision === 'allow' ? entry : null;
    // An entry with no stored classification is re-classified here rather than waved through:
    // a missing assessment must never be the reason a cloud `allow` succeeds.
    const assessment =
      pending &&
      (pending.assessment ??
        classifyLocally({
          actionType: pending.actionType,
          preview: pending.preview,
          hints: pending.hints,
        }));
    // A standing grant is judged harder than a one-off: see `DeviceFloor.check`.
    const persistent = optionKind !== null && isPersistentOptionKind(optionKind);
    const refusal = assessment ? this.floor.check(assessment, { persistent }) : null;
    const r = await this.approvals.respond(
      refusal ? { ...p, decision: 'deny', refusal: refusal.message } : p,
    );
    if (!r.ok) {
      const msg = {
        unknown: 'no pending approval (expired or already used)',
        session_mismatch: 'approval belongs to another session',
        request_mismatch: 'provider request id mismatch',
        preview_mismatch: 'preview hash mismatch',
      }[r.error];
      // An approval that timed out is not a session that vanished: `unknown_session` sent the
      // phone to "this session is gone" when the session was alive and only the prompt had lapsed.
      throw new DispatchError(r.error === 'unknown' ? 'unknown_approval' : 'invalid_payload', msg);
    }
    if (refusal && pending) {
      this.logger.warn('device policy refused a cloud approval', {
        approvalId: p.approvalId,
        sessionId: pending.sessionId,
        risks: refusal.risks.join(','),
        ...(p.optionId ? { optionId: p.optionId } : {}),
      });
      // The user must be able to see this happened without reading the daemon log.
      this.send('session.event', {
        sessionId: pending.sessionId,
        projectId: pending.projectId,
        provider: pending.provider,
        kind: 'needs_input',
        summary: refusal.message.slice(0, 2000),
        at: this.now().toISOString(),
      });
      throw new DispatchError('capability_unsupported', refusal.message);
    }
    return { approvalId: p.approvalId, decision: p.decision };
  }

  /**
   * The person's answer to a question the agent asked.
   *
   * Unlike an approval there is no device floor here and no preview hash: a question runs nothing,
   * and what binds the answer to the prompt is the pair of indexes — the phone sends positions,
   * this Mac resolves them against the questions it retained, and the agent is handed labels it
   * wrote itself. Text never round-trips.
   */
  private async answerQuestion(p: CommandPayload<'agent.answer_question'>) {
    const r = await this.questions.answer({
      questionId: p.questionId,
      sessionId: p.sessionId,
      providerRequestId: p.providerRequestId,
      answers: p.answers.map((a) => ({
        questionIndex: a.questionIndex,
        optionIndexes: a.optionIndexes,
        ...(a.freeText !== undefined ? { freeText: a.freeText } : {}),
      })),
    });
    if (!r.ok) {
      const message =
        r.message ??
        {
          unknown: 'no pending question (expired or already answered)',
          session_mismatch: 'question belongs to another session',
          request_mismatch: 'provider request id mismatch',
          not_answerable: 'this question can only be answered on the Mac',
          invalid_answer: 'the answer does not fit this question',
        }[r.error];
      // A question that lapsed is not a session that vanished, exactly as for approvals.
      if (r.error === 'unknown') throw new DispatchError('unknown_question', message);
      if (r.error === 'not_answerable') throw new DispatchError('capability_unsupported', message);
      throw new DispatchError('invalid_payload', message);
    }
    return { questionId: p.questionId };
  }

  /**
   * Validate a v2 answer's `optionId` against the prompt it claims to answer, and return the kind
   * it means. `decision` stays required on the wire (a v1 bridge has never heard of options), so
   * the two must agree: an `optionId: 'allow_always'` arriving with `decision: 'deny'` is a
   * malformed command, not an instruction to guess which half was meant.
   */
  private checkOption(
    record: PendingApproval,
    p: CommandPayload<'agent.respond_to_approval'>,
  ): ApprovalOptionKind {
    const optionId = p.optionId ?? '';
    const kind = this.optionKind(record, optionId);
    if (!kind)
      throw new DispatchError(
        'invalid_payload',
        `${optionId} is not an option this approval offered`,
      );
    if (kind === 'allow_always' && !allowAlwaysEnabled(this.env))
      throw new DispatchError(
        'capability_unsupported',
        'persistent approvals are switched off on this Mac (PAGR_ALLOW_ALWAYS=0)',
      );
    if (decisionForOptionKind(kind) !== p.decision)
      throw new DispatchError(
        'invalid_payload',
        `option ${optionId} does not agree with decision ${p.decision}`,
      );
    return kind;
  }

  // ---------- handoff (v2, `handoff.v1`) ----------

  /**
   * `session.handoff.capture`: write the handoff, commit the work, stop the sender, seal the file.
   *
   * The sequence itself lives in `handoff/switch.ts`, which is where it can be read and tested
   * against fakes; this method is the wiring — which session, which repository, which adapter,
   * where the events go, and what the phone is told when a step fails.
   *
   * Two things it deliberately does NOT do. It does not call `assertOurSession`: handing off a
   * session the person started in their own terminal is the case the feature exists for (spec
   * §3), and the parts of it Pagr cannot do — steering a session it does not own, stopping one
   * it did not start — are refused further down, individually, and reported rather than guessed
   * at. And it does not start the receiving agent: that is `agent.start_session`, a separate
   * signed command the cloud sends next (ADR 0019 decision 5).
   */
  private async handoffCapture(
    p: CommandPayload<'session.handoff.capture'>,
  ): Promise<HandoffCaptureAck> {
    const { rec, adapter } = this.sessionAdapter(p.sessionId);
    const run = await runHandoffCapture({
      handoffId: p.handoffId,
      sessionId: p.sessionId,
      from: rec.provider,
      to: p.to,
      repo: this.handoffRepo(rec),
      controlLevel: await this.controlLevelFor(rec, adapter),
      readOnly: rec.readOnly === true,
      adopted: isAdopted(rec),
      sender: adapter,
      stop: async () => {
        await adapter.stopSession(p.sessionId);
        this.o.sessions.setStatus(p.sessionId, 'stopped');
      },
      // Every state the bridge enters, as it enters it: the phone's running commentary is a
      // report of what happened, never an optimistic guess about what is about to.
      onUpdate: (u) => this.send('handoff.updated', { handoffId: p.handoffId, ...u }),
      // The other half of spec §3: a session Pagr cannot steer — and a sender that was steered
      // and never answered — falls through to the RECEIVING agent, which writes the note from
      // the sender's transcript. `receiverCapture` is the adapter between the switch's seam and
      // `handoff/receiver.ts`; everything it cannot supply is refused there, by name.
      captureFromReceiver: this.receiverCapture(rec),
      ...(p.note !== undefined ? { note: p.note } : {}),
      ...(this.o.env ? { env: this.o.env } : {}),
      ...(this.o.git ? { git: this.o.git } : {}),
    });

    if (run.outcome === 'failed') {
      this.logger.warn('handoff capture failed', {
        handoffId: p.handoffId,
        sessionId: p.sessionId,
        reason: run.reason,
        ...(run.wipCommit ? { wipCommit: run.wipCommit } : {}),
      });
      throw new DispatchError(HANDOFF_ACK_CODE[run.reason], run.message);
    }
    if (!run.stop.stopped)
      this.logger.info('the sending session was left running', {
        handoffId: p.handoffId,
        sessionId: p.sessionId,
        reason: run.stop.reason,
      });

    // The sealed copy, last: the phone gets the file only once it is final — stamped with the
    // commit it belongs to — so a `handoff` frame never shows a version of the note that
    // disagrees with the repository. A session outside every registered project cannot produce
    // one at all (a frame names a `proj_…`), and the file on disk is the whole handoff anyway.
    if (isReportable(rec))
      this.emitFrame(
        p.sessionId,
        {
          kind: 'handoff',
          handoffId: p.handoffId,
          path: run.relativePath,
          text: run.text,
        },
        {
          projectId: rec.projectId,
          provider: rec.provider,
          // Read off a file on this Mac that an agent wrote, which is what `transcript` means
          // here — not the live stdio stream, and not the app server.
          meta: { source: 'transcript' },
        },
      );
    else
      this.logger.info('handoff file kept local: the session is outside every project', {
        handoffId: p.handoffId,
        sessionId: p.sessionId,
      });

    return run.result;
  }

  /**
   * The receiver-writes path (HND-012), bound to this session and this Mac (HND-012a).
   *
   * `switch.ts` asks for a note about a session; `receiver.ts` needs three concrete things the
   * switch has no way to know — the agent's OWN id for that session, an adapter to run headless,
   * and somewhere to read the sending session's transcript. Resolving them is the dispatcher's
   * job, because all three are facts about this daemon's wiring, and doing it here is what keeps
   * the seam: neither module learns about `sessions.json`, the adapter map, or `$HOME`.
   *
   * Nothing in here throws. Every piece that can be missing is a sentence a person gets told
   * instead (spec §9), and each maps to the refusal the rest of the system already understands:
   *
   *   - no adapter registered for `to` → `receiver_not_available`;
   *   - no transcript source for `from` on this bridge → `receiver_not_available`;
   *   - no provider-side id for the sending session → `no_transcript`;
   *   - nothing readable at the other end of the source → `no_transcript` (`receiver.ts`);
   *   - the receiving adapter has no `runOnce` → `no_runner` (`receiver.ts`).
   *
   * The last two are deliberately left to `receiver.ts`: it is the module that knows whether the
   * transcript was there and whether the run could be started, and duplicating the checks here
   * would give a person two different sentences for one fact.
   */
  private receiverCapture(rec: SessionRecord): ReceiverCapture {
    const refuse = (reason: CaptureRefusal, message: string): CaptureOutcome => ({
      outcome: 'refused',
      writer: 'receiver',
      path: null,
      reason,
      message,
    });
    return async (input) => {
      // The RECEIVING adapter — the agent the work is moving to, not the one it came from. A
      // `runOnce` it does not have is `receiver.ts`'s refusal to make, so the adapter goes over
      // whole and only its absence is answered here.
      const receiver = this.o.adapters.get(input.to);
      if (!receiver)
        return refuse(
          'receiver_not_available',
          `there is no ${input.to} adapter on this Mac, so nothing can write this handoff from ${input.from}'s transcript`,
        );
      const transcript = this.transcriptSourceFor(input.from);
      if (!transcript)
        return refuse(
          'receiver_not_available',
          `this bridge cannot read a ${input.from} transcript on this Mac`,
        );
      const providerSessionId = providerSessionIdOf(rec);
      if (!providerSessionId)
        return refuse(
          'no_transcript',
          `Pagr never learned ${input.from}'s own id for this session, so there is no transcript to point ${input.to} at`,
        );
      return captureFromReceiver({
        handoffId: input.handoffId,
        sessionId: input.sessionId,
        providerSessionId,
        repo: input.repo,
        to: input.to,
        receiver,
        transcript,
        ...(rec.cwd ? { cwd: rec.cwd } : {}),
        ...(isReportable(rec) ? { projectId: rec.projectId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.git !== undefined ? { git: input.git } : {}),
      });
    };
  }

  /**
   * Where the SENDING agent's transcript is read from, per provider. Null means "not on this
   * bridge", which is a refusal rather than a silence.
   *
   * Claude's is already a file, so it is found: `~/.claude/projects/*` under the home the
   * project registry vets paths against — the one place this daemon states where the user's home
   * is, and the reason a test can point the whole lookup at a temporary directory instead of the
   * real one. Codex's lives in the app-server, so the adapter is asked for the thread and
   * `receiver.ts` dumps it under `PAGR_HOME/tmp` for the length of one run, then deletes it.
   */
  private transcriptSourceFor(from: Provider): TranscriptSource | null {
    if (from === 'claude') return claudeTranscriptSource({ home: this.o.registry.homeDirectory });
    const sender = this.o.adapters.get(from);
    const readThread = sender?.readThread?.bind(sender);
    if (!readThread) return null;
    // `tmpDir` is `<PAGR_HOME>/tmp`; the dump belongs in the same place downloaded attachments do.
    return codexTranscriptSource({ readThread, pagrHome: dirname(this.o.tmpDir) });
  }

  /**
   * The working tree a handoff is written into.
   *
   * The session's own directory first: a registered project can contain more than one repository
   * (and a session can be running in a subdirectory of one), and `git.ts` resolves the work tree
   * root from wherever it is pointed. The project path is the fallback for a session the bridge
   * started, and the registry is the last word when neither was recorded.
   */
  private handoffRepo(rec: SessionRecord): string {
    if (rec.cwd) return rec.cwd;
    if (rec.projectPath) return rec.projectPath;
    return this.o.registry.resolve(rec.projectId).path;
  }

  /**
   * How much of this session Pagr may drive, asked of the adapter first.
   *
   * A session that is running right now knows its own control level — a mirrored Codex TUI
   * thread reports `mirror_only`, and nothing in `sessions.json` could work that out — so the
   * adapter's answer wins and the local derivation is the fallback.
   */
  private async controlLevelFor(
    rec: SessionRecord,
    adapter: CodingAgentAdapter,
  ): Promise<ControlLevel> {
    try {
      const live = await adapter.getStatus(rec.sessionId);
      if (live?.controlLevel) return live.controlLevel;
    } catch {
      // An adapter that has never heard of this session is not an error here: it is exactly the
      // ended-session case, and the local record is what describes it.
    }
    return this.derivedControlLevel(rec.sessionId, isAdopted(rec));
  }

  // ---------- remote project pick ----------
  //
  // Self-contained on purpose: `repo.scan` and `project.register_handle` are the only pair of
  // commands that widen what the cloud can REACH, so everything that decides whether they run,
  // what they may see, and how often, lives here where it can be read in one sitting.

  /** `PAGR_REMOTE_PROJECT_PICK=0` turns both commands off; anything else (or unset) leaves them on. */
  private remotePickEnabled(): boolean {
    return (this.o.env ?? process.env)[REMOTE_PROJECT_PICK_ENV] !== '0';
  }

  /** On/off plus the number of live handles, for `pagr doctor`. Never the paths behind them. */
  remoteProjectPick(): RemoteProjectPickStatus {
    return { enabled: this.remotePickEnabled(), handles: this.repoHandles.size };
  }

  private assertRemotePick(): void {
    if (!this.remotePickEnabled())
      throw new DispatchError(
        'capability_unsupported',
        `remote project pick is off on this Mac (${REMOTE_PROJECT_PICK_ENV}=0)`,
      );
  }

  /**
   * List the git repositories under this Mac's conventional code folders as opaque handles.
   *
   * The payload is `{}` and stays `{}`: the cloud never supplies roots, because a root is a path,
   * and the whole guarantee is that no path travels in either direction. What comes back is a
   * folder name, the git remote's host/name if there is one, and a handle only this Mac can
   * resolve — see `repoScan.ts`.
   */
  private async scanRepositories(): Promise<RepoScanResult> {
    this.assertRemotePick();
    const at = this.now().getTime();
    if (at - this.lastRepoScanAt < REPO_SCAN_MIN_INTERVAL_MS)
      throw new DispatchError(
        'rate_limited',
        `a repository scan was run less than ${REPO_SCAN_MIN_INTERVAL_MS / 1000}s ago`,
      );
    // Stamped before the walk, not after: two scans arriving together must not both run.
    this.lastRepoScanAt = at;
    const res = await scanRepos({ registry: this.o.registry, cache: this.repoHandles });
    this.logger.info('repository scan', {
      repos: res.repos.length,
      roots: res.scannedRoots,
      truncated: res.truncated,
    });
    return { repos: res.repos, truncated: res.truncated };
  }

  /**
   * Turn a handle from the last scan into a registered project.
   *
   * The handle is resolved against this bridge's own in-memory cache, so the only folders that
   * can be registered this way are ones this Mac offered within the last hour. An unknown or
   * expired handle is `unknown_project` — the same answer a made-up `proj_…` gets, and for the
   * same reason: the cloud is not allowed to learn whether a folder it guessed at exists.
   */
  private registerRepoHandle(payload: CommandPayload<'project.register_handle'>): ProjectSummary {
    this.assertRemotePick();
    const path = this.repoHandles.get(payload.handle);
    if (!path)
      throw new DispatchError('unknown_project', 'that repository handle is unknown or expired');
    let ensured: ReturnType<ProjectRegistry['ensure']>;
    try {
      ensured = this.o.registry.ensure(path, {
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
      });
    } catch (err) {
      // A name the phone chose that is already taken is a bad argument, not a missing project.
      if (err instanceof ProjectError && err.code === 'duplicate')
        throw new DispatchError('invalid_payload', err.message);
      throw err;
    }
    // Every cached handle now carries a stale `registeredAs`, so the next scan is the truth.
    this.repoHandles.clear();
    const summary: ProjectSummary = {
      projectId: ensured.projectId,
      displayName: ensured.displayName,
      aliases: ensured.aliases,
      ...(ensured.repoHint ? { repoHint: ensured.repoHint } : {}),
    };
    if (ensured.created) this.send('project.registered', summary);
    return summary;
  }

  // ---------- rules migration (v2) ----------

  /**
   * `rules.migrate` — decide, and only with an explicit yes, perform the one rules conversion a
   * handoff may need (spec §6, ADR 0019 decision 6).
   *
   * Sent twice and signed twice. The first command carries `consent: false` and answers with the
   * proposal: the action, the two file names and the real line count, which is the number the
   * cloud quotes back to the person by text. The second carries `consent: true` and arrives only
   * after they said yes. A no, and a silence, are both simply the absence of that second command
   * — which is why nothing here has a timeout to get wrong, and why the ONLY code path that
   * writes into somebody's repository begins with a separately-signed command that says so.
   *
   * The project id is resolved locally, as every cloud-facing surface does: the cloud names an
   * id, never a directory, and an unknown one is `unknown_project`. The proposal and the write
   * both run against the repository root that id resolves to, and the file bodies stay on the Mac
   * — only the counts and the two known file names ride back on the ack.
   */
  private async migrateRules(
    payload: CommandPayload<'rules.migrate'>,
  ): Promise<RulesMigrateResult> {
    const project = this.o.registry.resolve(payload.projectId);
    const outcome = migrateRules({
      dir: project.path,
      from: payload.from,
      to: payload.to,
      consent: payload.consent,
      home: this.o.registry.homeDirectory,
      now: this.now,
      logger: this.logger,
      ...(payload.to === 'claude' ? { claudeVersion: await this.claudeVersion() } : {}),
    });
    return toRulesMigrateResult(outcome);
  }

  /**
   * The receiving Claude's version, for the one §6 row that turns on it: a Claude at or above
   * 2.1.277 reads `AGENTS.md` itself and needs no shim written for it.
   *
   * A probe that fails, or no Claude adapter at all, answers `undefined` — which the converter
   * reads as "old", and an old Claude gets the one-line import that works on every version. The
   * expensive mistake here is the other way round: guessing "new" would leave the receiver with
   * no rules and nothing on screen to say so.
   */
  private async claudeVersion(): Promise<string | undefined> {
    const adapter = this.o.adapters.get('claude');
    if (!adapter) return undefined;
    const caps = this.capabilities.get('claude') ?? (await this.probeOne(adapter));
    return caps?.providerVersion;
  }

  // ---------- approvals ----------

  get approvalTimeoutMs(): number {
    return this.policy.approvalTimeoutSeconds * 1000;
  }

  /** The daemon's own environment; the floor and the option switches read it, never the cloud. */
  private get env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  /** True when the link speaks v2, so a sealed frame is something a phone can actually open. */
  private frameProtocolV2(): boolean {
    const channel = this.o.frames;
    return channel !== undefined && channel.protocolVersion() >= 2;
  }

  /**
   * The kind behind an option id. The agent's own list wins; an id that is itself a kind is
   * accepted when the adapter published no list at all (a v1 adapter, or the hook path before it
   * learned to send suggestions), and anything else is not an option of this prompt.
   */
  private optionKind(record: PendingApproval, optionId: string): ApprovalOptionKind | null {
    const found = record.options.find((o) => o.optionId === optionId);
    if (found) return found.kind;
    if (record.options.length > 0) return null;
    return APPROVAL_OPTION_KINDS.includes(optionId as ApprovalOptionKind)
      ? (optionId as ApprovalOptionKind)
      : null;
  }

  /**
   * Register a pending approval (from an adapter or a hook over IPC), emit
   * `approval.requested`, and resolve `onDecision` exactly once.
   *
   * The relay to the agent runs BEFORE `approval.resolved_locally` is emitted. Announcing the
   * resolution first meant a relay that threw left the phone showing "approved" beside a `failed`
   * ack for the same prompt. The single-use guarantee is unaffected: the registry has already
   * consumed the entry by the time this runs, so a failed relay cannot be answered a second time.
   */
  requestApproval(input: ApprovalRequest): PendingApproval {
    const { onDecision, local, options: offered, ...rest } = input;
    // Classified here, on the Mac, from what the provider asked for — before the cloud has been
    // told this prompt exists, and never from anything the cloud will later echo back.
    const assessment = classifyLocally({
      actionType: rest.actionType,
      preview: rest.preview,
      hints: rest.hints ?? {},
      ...(local ? { detail: local } : {}),
    });
    // Last word on `PAGR_ALLOW_ALWAYS=0`: the adapters filter too, but this is the daemon's own
    // environment, so a persistent grant cannot reach a phone because one adapter forgot.
    const options = (offered ?? []).filter(
      (o) => o.kind !== 'allow_always' || allowAlwaysEnabled(this.env),
    );
    const record = this.approvals.register(
      {
        ...rest,
        assessment,
        options,
        onResolve: async (resolution, decision, source, outcome) => {
          const optionId = outcome.optionId ?? defaultOptionId(decision);
          try {
            await onDecision(decision, resolution, source, outcome);
          } catch (err) {
            const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
            this.logger.warn('approval relay failed', {
              approvalId: record.approvalId,
              sessionId: record.sessionId,
              resolution,
              message,
            });
            // One coherent failure, never an "approved" the agent never heard.
            this.send('session.event', {
              sessionId: record.sessionId,
              projectId: record.projectId,
              provider: record.provider,
              kind: 'failed',
              summary: `Could not deliver the approval decision to ${record.provider}: ${message}`,
              at: this.now().toISOString(),
            });
            if (source === 'cloud')
              this.send('approval.applied', {
                approvalId: record.approvalId,
                sessionId: record.sessionId,
                optionId,
                applied: false,
                error: message,
              });
            throw err;
          }
          const protocolSource = source === 'cloud' ? null : source;
          this.send('approval.resolved_locally', {
            approvalId: record.approvalId,
            resolution,
            ...(protocolSource ? { source: protocolSource } : {}),
            ...(outcome.answeredElsewhere ? { answeredElsewhere: true } : {}),
          });
          // `command.ack` says the bridge heard the tap; this says the agent was actually told.
          // A refusal by the device floor is reported here too — as `applied: false` with the
          // reason — because the phone's card must not sit on "sending" when nothing was carried.
          if (source === 'cloud' || outcome.answeredElsewhere)
            this.send('approval.applied', {
              approvalId: record.approvalId,
              sessionId: record.sessionId,
              optionId,
              applied: outcome.refusal === undefined,
              // What the agent was actually told, which is not always what was chosen: a
              // persistent grant the floor refused is relayed as a plain deny. The provider's own
              // enum value for it is the adapter's business (see adapter-codex/src/approvals.ts).
              appliedAs: outcome.refusal !== undefined ? 'deny' : (decision ?? 'deny'),
              ...(outcome.refusal !== undefined ? { error: outcome.refusal } : {}),
            });
        },
      },
      this.approvalTimeoutMs,
    );
    // v2: the preview travels sealed, in its own frame, and the plaintext copy on the event goes
    // away. A v1 gateway has never heard of frames, so it keeps getting the preview as before.
    const frame = this.frameProtocolV2()
      ? this.emitFrame(
          record.sessionId,
          { kind: 'approval_preview', preview: record.preview },
          {
            projectId: record.projectId,
            provider: record.provider,
            meta: { source: 'stdio', actionType: record.actionType },
          },
        )
      : null;
    const sealedPreview = frame?.emitted === true;
    this.send('approval.requested', {
      approvalId: record.approvalId,
      sessionId: record.sessionId,
      projectId: record.projectId,
      provider: record.provider,
      providerRequestId: record.providerRequestId,
      actionType: record.actionType,
      preview: sealedPreview ? '' : record.preview,
      previewHash: record.previewHash,
      hints: record.hints,
      expiresAt: record.expiresAt,
      // v2: the agent's own options travel with the request. A v1 cloud ignores the field and
      // answers with `decision` alone, which is why it is never the only thing we send.
      ...(options.length > 0 ? { options } : {}),
      ...(sealedPreview ? { frameSeq: frame.seq } : {}),
      // Plaintext, and only when a thread is linked. It is the same one-liner the iMessage thread
      // has always shown for a prompt — the preview — which is why sealing the preview for the
      // phone did not have to cost the thread its message.
      ...(this.imessageLinked()
        ? { imessage: clip(`${agentName(record.provider)}: ${record.preview}`, IMESSAGE_CLIP) }
        : {}),
    });
    // Nothing decides it here. The prompt now waits for the person — on their phone, or in the
    // terminal the agent is running in, whichever answers first. The bridge used to auto-approve
    // what it classified as zero-risk; that is deliberately gone (see `policy.ts`).
    return record;
  }

  // ---------- questions (v2) ----------

  /**
   * Register a question, seal it into a `question` frame, and announce it.
   *
   * The frame carries the words (the question text, the option labels, any preview the model
   * attached); `question.asked` carries only the shape the phone needs to lay the sheet out
   * before it has decrypted anything — how many options each question has, which take more than
   * one, which must never be echoed back.
   */
  requestQuestion(input: QuestionRequest): PendingQuestion {
    const { onAnswer, providerRecordId, meta, ...rest } = input;
    const record = this.questions.register(
      {
        ...rest,
        onResolve: async (resolution, answers, source, outcome) => {
          try {
            await onAnswer(answers, resolution, source, outcome);
          } catch (err) {
            const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
            this.logger.warn('question relay failed', {
              questionId: record.questionId,
              sessionId: record.sessionId,
              resolution,
              message,
            });
            // One coherent failure: the phone must not be told the agent got an answer it never
            // received, so `question.answered` is not sent on this path.
            this.send('session.event', {
              sessionId: record.sessionId,
              projectId: record.projectId,
              provider: record.provider,
              kind: 'failed',
              summary: `Could not deliver the answer to ${record.provider}: ${message}`,
              at: this.now().toISOString(),
            });
            throw err;
          }
          this.send('question.answered', {
            questionId: record.questionId,
            ...(outcome.answeredElsewhere ? { answeredElsewhere: true } : {}),
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
        },
      },
      this.approvalTimeoutMs,
    );
    // `seq` is required on the event because the words live in the frame. With no journal wired
    // up (a one-shot CLI dispatcher) or a v1 link there is no frame, and 0 says so honestly
    // rather than naming a sequence number nothing will ever serve.
    const frame = this.frameProtocolV2()
      ? this.emitFrame(record.sessionId, questionBodyFor({ questions: record.questions }), {
          projectId: record.projectId,
          provider: record.provider,
          meta: meta ?? { source: 'stdio' },
          ...(providerRecordId ? { providerRecordId } : {}),
        })
      : null;
    this.send('question.asked', {
      questionId: record.questionId,
      sessionId: record.sessionId,
      projectId: record.projectId,
      provider: record.provider,
      providerRequestId: record.providerRequestId,
      seq: frame?.seq ?? 0,
      meta: {
        answerable: record.answerable,
        ...(record.reason ? { reason: record.reason } : {}),
        multiSelect: record.multiSelect,
        optionCount: record.optionCount,
        secret: record.secret,
      },
      expiresAt: record.expiresAt,
      ...(this.imessageLinked() ? { imessage: questionImessageLine(record) } : {}),
    });
    return record;
  }

  // ---------- review (v2, `handoff.v1`) ----------

  /**
   * Reviews with a reviewer still running, and the reviews this daemon has run.
   *
   * Two maps because they answer different questions at different times. `reviewRuns` is what is
   * happening right now — it holds the abort handle, so a shutting-down daemon does not leave a
   * headless agent reading a repository nobody is waiting on. `reviewProjects` is memory: `fix
   * it` arrives minutes after the verdict, and `review.apply` carries no project, so without it
   * a review whose builder session has since ended could not be acted on at all.
   */
  private readonly reviewRuns = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private readonly reviewProjects = new Map<string, { projectId: string; reviewer: Provider }>();

  /**
   * Start a review and answer immediately with the id.
   *
   * The verdict is minutes away and arrives as `review.completed`, so everything that can fail
   * fast happens before the ack — the project resolves, the reviewer can actually be run
   * headlessly, the tree commits, the packet builds — and everything that has to wait happens
   * after it. A command that acked `completed` here means "this review is under way", which is
   * the only honest thing a fast ack can mean.
   */
  private async startReview(
    p: CommandPayload<'review.start'>,
    commandId: string,
  ): Promise<ReviewStartResult> {
    const project = this.o.registry.resolve(p.projectId);
    const adapter = this.adapterFor(p.reviewer);
    const runOnce = adapter.runOnce?.bind(adapter);
    if (!runOnce)
      throw new DispatchError(
        'capability_unsupported',
        `${p.reviewer} on this Mac cannot be run headlessly, so it cannot review anything`,
      );
    if (this.reviewRuns.has(p.reviewId))
      throw new DispatchError('rate_limited', `review ${p.reviewId} is already running`);

    let prepared: PreparedReview;
    try {
      prepared = await prepareReview({
        reviewId: p.reviewId,
        repo: project.path,
        range: p.range,
        intent: p.intent,
        reviewer: p.reviewer,
        ...(this.o.env ? { env: this.o.env } : {}),
        ...(this.o.git ? { git: this.o.git } : {}),
      });
    } catch (err) {
      if (err instanceof ReviewStartError)
        throw new DispatchError(
          err.reason === 'not_a_repo' ? 'capability_unsupported' : 'provider_error',
          err.message,
        );
      throw err;
    }

    this.rememberReview(p.reviewId, { projectId: p.projectId, reviewer: p.reviewer });
    const controller = new AbortController();
    const task = this.finishReview({
      prepared,
      reviewer: p.reviewer,
      projectId: p.projectId,
      runner: { runOnce },
      signal: controller.signal,
      commandId,
    })
      .finally(() => this.reviewRuns.delete(p.reviewId))
      // Nothing awaits this task until `settleReviews`, so it owns its own failures: an
      // unhandled rejection here would take the daemon down minutes after the ack said yes.
      .catch((err: unknown) =>
        this.logger.error('review task failed', {
          reviewId: p.reviewId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    this.reviewRuns.set(p.reviewId, { controller, task });
    return { reviewId: p.reviewId };
  }

  /** Wait for the report, then tell the phone — and put the report itself inside the seal. */
  private async finishReview(o: {
    prepared: PreparedReview;
    reviewer: Provider;
    projectId: string;
    runner: ReviewRunner;
    signal: AbortSignal;
    commandId: string;
  }): Promise<void> {
    const bounds = this.o.review ?? {};
    let outcome: Awaited<ReturnType<typeof awaitReview>>;
    try {
      outcome = await awaitReview({
        prepared: o.prepared,
        reviewer: o.reviewer,
        runner: o.runner,
        projectId: o.projectId,
        signal: o.signal,
        ...(this.o.env ? { env: this.o.env } : {}),
        ...(bounds.timeoutMs !== undefined ? { timeoutMs: bounds.timeoutMs } : {}),
        ...(bounds.pollIntervalMs !== undefined ? { pollIntervalMs: bounds.pollIntervalMs } : {}),
        ...(bounds.reReadGraceMs !== undefined ? { reReadGraceMs: bounds.reReadGraceMs } : {}),
      });
    } catch (err) {
      // `awaitReview` does not throw for anything the design anticipates, so this is a bug or a
      // dying process. Either way the person is owed the sentence, not a swallowed promise.
      this.logger.error('review failed', {
        reviewId: o.prepared.reviewId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (outcome.outcome === 'no_report') {
      this.logger.warn('review produced no report', {
        reviewId: outcome.reviewId,
        reviewer: o.reviewer,
        message: outcome.message,
      });
      this.send('session.event', {
        sessionId: outcome.sessionId,
        projectId: o.projectId,
        provider: o.reviewer,
        kind: 'failed',
        summary: outcome.message,
        at: this.now().toISOString(),
      });
      return;
    }

    this.send(
      'review.completed',
      {
        reviewId: outcome.reviewId,
        verdict: outcome.verdict,
        summary: outcome.summary,
        ...(outcome.note === undefined ? {} : { note: outcome.note }),
      },
      o.commandId,
    );
    // The findings themselves, sealed, under the run's own id. `transcript` is this enum's name
    // for "the bridge read this off the disk"; the report is a file an agent wrote, and a source
    // value a gateway has never heard of would fail its parse of the event.
    this.emitFrame(
      outcome.sessionId,
      {
        kind: 'review',
        reviewId: outcome.reviewId,
        verdict: outcome.verdict,
        summary: outcome.summary,
        text: outcome.text,
      },
      {
        projectId: o.projectId,
        provider: o.reviewer,
        meta: runOnceFrameMeta(outcome.runId, 'transcript'),
        providerRecordId: `review:${outcome.reviewId}`,
      },
    );
  }

  /** Remember a review, bounded. Old entries fall off the front; `fix it` is minutes, not days. */
  private rememberReview(reviewId: string, r: { projectId: string; reviewer: Provider }): void {
    this.reviewProjects.delete(reviewId);
    this.reviewProjects.set(reviewId, r);
    while (this.reviewProjects.size > MAX_REMEMBERED_REVIEWS) {
      const oldest = this.reviewProjects.keys().next();
      if (oldest.done) break;
      this.reviewProjects.delete(oldest.value);
    }
  }

  /**
   * "fix it" — send a finished review's findings to an agent that can act on them.
   *
   * Pagr relays a person's decision here; it never makes one. Nothing in this path reads the
   * report, summarises it, or decides which findings matter: the instruction names the file and
   * the agent that wrote the code reads it. A reviewer that finds three things and a builder
   * that quietly changes ten is a leak, not a loop (ADR 0019 decision 4, ADR 0017).
   *
   * Two branches, and the live one is preferred for a reason that is not performance: the
   * session that wrote the code still holds why it wrote it that way, and a fresh session
   * re-derives that from the diff — which is exactly the relitigation the handoff file exists to
   * prevent. A session that cannot take a turn (ended, adopted with no channel, a mirrored TUI
   * thread) gets a new one on the same tree instead of an instruction nobody will ever read —
   * and if something else is still writing that tree, `SessionGuard` refuses the start and says
   * so, because two agents in one checkout is the failure this whole feature exists to avoid.
   */
  private async applyReview(p: CommandPayload<'review.apply'>): Promise<ReviewApplyResult> {
    const instruction = reviewApplyInstruction(p.reviewId);
    const rec = p.sessionId ? this.o.sessions.get(p.sessionId) : null;

    if (rec) {
      const adapter = this.o.adapters.get(rec.provider);
      const live = adapter ? await adapter.getStatus(rec.sessionId).catch(() => null) : null;
      const status = live?.status ?? rec.status;
      if (adapter && isLiveStatus(status) && this.isFullyControllable(rec, live)) {
        const sent = await this.sendInstruction({
          sessionId: rec.sessionId,
          instruction,
          mode: 'auto',
          attachments: [],
        });
        return {
          reviewId: p.reviewId,
          sessionId: rec.sessionId,
          applied: 'instructed',
          delivered: sent.delivered,
        };
      }
    }

    const target = this.applyTarget(p.reviewId, rec);
    const sessionId = newAppliedSessionId();
    await this.startSession({
      provider: target.provider,
      projectId: target.projectId,
      instruction,
      sessionId,
      attachments: [],
      readOnly: false,
      displayName: REVIEW_FIX_SESSION_NAME,
      context: { reviewId: p.reviewId },
    });
    return { reviewId: p.reviewId, sessionId, applied: 'started' };
  }

  /**
   * Is this session one Pagr may give a turn to?
   *
   * The adapter's own answer wins when it has one — a mirrored Codex TUI thread knows it is
   * `mirror_only` and nothing here knows better. Otherwise it is the same rule `device.hello`
   * reports: a session Pagr started is `full`, and an adopted one is `full` only while a `pagr
   * claude` channel is bound to it.
   */
  private isFullyControllable(rec: SessionRecord, live: SessionSummaryV2 | null): boolean {
    if (live?.controlLevel !== undefined) return live.controlLevel === 'full';
    return !isAdopted(rec) || this.channelBoundTo(rec.sessionId);
  }

  /**
   * Which agent, in which project, gets a review's findings when no live session can take them.
   *
   * The builder's own session record first, because it names both. Then the review's own
   * project, with the agent chosen the way a person would: the last agent that worked in that
   * tree, or failing that the one that did not write the review — a cross-vendor review is the
   * normal case, and the reviewer marking its own homework is the one outcome to avoid.
   */
  private applyTarget(
    reviewId: string,
    rec: SessionRecord | null,
  ): { provider: Provider; projectId: string } {
    if (rec && rec.projectId !== UNREGISTERED_PROJECT)
      return { provider: rec.provider, projectId: rec.projectId };
    const review = this.reviewProjects.get(reviewId);
    if (!review)
      throw new DispatchError(
        'unknown_session',
        `this bridge does not know review ${reviewId}; send the session that wrote the code with it`,
      );
    return {
      provider: rec?.provider ?? this.builderProviderFor(review.projectId, review.reviewer),
      projectId: review.projectId,
    };
  }

  /** The agent that most recently worked in this project, else anyone but the reviewer. */
  private builderProviderFor(projectId: string, reviewer: Provider): Provider {
    let best: SessionRecord | null = null;
    for (const s of this.o.sessions.list()) {
      if (s.projectId !== projectId || s.readOnly === true) continue;
      if (!best || s.updatedAt > best.updatedAt) best = s;
    }
    if (best) return best.provider;
    for (const provider of this.o.adapters.keys()) if (provider !== reviewer) return provider;
    return reviewer;
  }

  /** Resolves when every running review has finished. For shutdown, and for tests. */
  async settleReviews(): Promise<void> {
    await Promise.allSettled([...this.reviewRuns.values()].map((r) => r.task));
  }

  // ---------- adapter events ----------

  private async onAdapterEvent(provider: Provider, e: AdapterEvent): Promise<void> {
    switch (e.kind) {
      case 'session': {
        const s = e.session;
        this.noteTurnStatus(s.sessionId, s.status, s.activeTurn);
        const rec = this.o.sessions.get(s.sessionId);
        const adopted = e.adopted ?? rec?.adopted;
        const cwd = e.localCwd ?? rec?.cwd;
        this.o.sessions.upsert({
          sessionId: s.sessionId,
          provider,
          projectId: s.projectId,
          providerSessionId: rec?.providerSessionId ?? s.sessionId,
          status: s.status,
          // Never widen a read-only session, or forget which tree it holds, on a status update.
          ...(rec?.readOnly !== undefined ? { readOnly: rec.readOnly } : {}),
          ...(rec?.projectPath !== undefined ? { projectPath: rec.projectPath } : {}),
          // Nor forget that Pagr did not start it: a status update that silently dropped
          // `adopted` would turn "your own terminal session" into one the cloud believes it may
          // steer, and `assertOurSession` would stop refusing.
          ...(adopted !== undefined ? { adopted, adoptedAt: rec?.adoptedAt ?? s.startedAt } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
        });
        this.send('session.updated', this.withLastSeq(s));
        return;
      }
      case 'session_event':
        if (e.type === 'started' || e.type === 'followup_delivered')
          this.leases.noteTurnStarted(e.sessionId);
        else if (e.type === 'stopped') this.leases.releaseSession(e.sessionId);
        else if (e.type === 'completed' || e.type === 'failed')
          this.leases.noteTurnEnded(e.sessionId);
        this.send('session.event', {
          sessionId: e.sessionId,
          projectId: e.projectId,
          provider,
          kind: e.type,
          summary: e.summary.slice(0, 2000),
          ...(e.providerEventId ? { providerEventId: e.providerEventId } : {}),
          at: this.now().toISOString(),
        });
        return;
      case 'frame':
        // The adapter said what happened; the journal says when and in what order, and the seal
        // says who may read it.
        this.emitFrame(e.sessionId, e.body, {
          projectId: e.projectId,
          provider,
          meta: e.meta,
          ...(e.providerRecordId ? { providerRecordId: e.providerRecordId } : {}),
          ...(e.at ? { at: e.at } : {}),
          ...(e.imessage ? { imessage: e.imessage } : {}),
          ...(e.endsTurn ? { endsTurn: true } : {}),
        });
        return;
      case 'approval_requested': {
        const adapter = this.o.adapters.get(provider);
        this.requestApproval({
          approvalId: e.approvalId,
          sessionId: e.sessionId,
          projectId: e.projectId,
          provider,
          providerRequestId: e.providerRequestId,
          actionType: e.actionType,
          preview: e.preview,
          hints: e.hints,
          ...(e.local ? { local: e.local } : {}),
          ...(e.options && e.options.length > 0 ? { options: e.options } : {}),
          expiresAt: e.expiresAt,
          onDecision: async (decision, _resolution, source, outcome) => {
            // The provider already knows when it resolved the request itself, and so does the
            // person who answered in the terminal. Everything else — the cloud's answer, a local
            // timeout, and a floor refusal turned into a deny — has to reach the agent.
            if (source === 'provider' || source === 'shutdown' || source === 'terminal') return;
            await adapter?.respondToApproval({
              approvalId: e.approvalId,
              providerRequestId: e.providerRequestId,
              decision: decision ?? 'deny',
              // A refused persistent grant is relayed as a plain deny: the option the person
              // chose is not the thing the agent is being told to do any more.
              ...(outcome.optionId && outcome.refusal === undefined
                ? { optionId: outcome.optionId }
                : {}),
            });
          },
        });
        return;
      }
      case 'question_asked': {
        const adapter = this.o.adapters.get(provider);
        this.requestQuestion({
          sessionId: e.sessionId,
          projectId: e.projectId,
          provider,
          providerRequestId: e.providerRequestId,
          questions: e.questions,
          answerable: e.answerable && typeof adapter?.answerQuestion === 'function',
          ...(e.reason
            ? { reason: e.reason }
            : adapter?.answerQuestion
              ? {}
              : { reason: 'not_supported' }),
          secret: e.secret,
          expiresAt: e.expiresAt,
          ...(e.providerRecordId ? { providerRecordId: e.providerRecordId } : {}),
          ...(e.meta ? { meta: e.meta } : {}),
          onAnswer: async (answers, _resolution, source) => {
            // Only the person's own answer is written back. A local timeout, a shutdown, or an
            // answer given in the terminal must leave the agent's prompt exactly as it found it —
            // the adapter owns the deny it writes on its own timer (see the Claude adapter), and
            // a mirrored thread's owner is the one sitting in front of it.
            if (source !== 'cloud' || !answers) return;
            await adapter?.answerQuestion?.({
              providerRequestId: e.providerRequestId,
              answers,
            });
          },
        });
        return;
      }
      case 'question_resolved_locally': {
        const record = this.questions.findByRequest(e.sessionId, e.providerRequestId);
        if (!record) return;
        const answeredElsewhere = e.answeredElsewhere === true;
        if (answeredElsewhere)
          await this.questions.resolveExternally(
            record.questionId,
            e.source ?? 'provider',
            e.resolution,
          );
        else
          await this.questions.resolveLocally(
            record.questionId,
            e.resolution,
            e.reason ?? e.resolution,
          );
        return;
      }
      case 'approval_resolved_locally': {
        // Somebody else already resolved it; do not call back into the adapter.
        const answeredElsewhere = e.answeredElsewhere === true;
        const had = answeredElsewhere
          ? await this.approvals.resolveExternally(
              e.approvalId,
              e.source ?? 'provider',
              e.resolution,
            )
          : await this.approvals.resolveLocally(e.approvalId, e.resolution);
        if (!had)
          this.send('approval.resolved_locally', {
            approvalId: e.approvalId,
            resolution: e.resolution,
            ...(e.source ? { source: e.source } : {}),
            ...(answeredElsewhere ? { answeredElsewhere: true } : {}),
          });
        return;
      }
    }
  }

  activeSessionCount(): number {
    return this.o.sessions.list().filter((s) => isLiveStatus(s.status)).length;
  }

  async shutdown(): Promise<void> {
    for (const u of this.unsubscribes) u();
    // A reviewer is a headless process reading the user's repository with nobody waiting on it;
    // it does not outlive the daemon that started it.
    for (const r of this.reviewRuns.values()) r.controller.abort();
    await this.settleReviews();
    // Every session ends with the daemon, so no agent is going to read these files again.
    this.leases.releaseAll();
    await this.approvals.cancelAll();
    await this.questions.cancelAll();
    for (const a of this.o.adapters.values()) {
      try {
        await a.shutdown();
      } catch (err) {
        this.logger.warn('adapter shutdown failed', { provider: a.provider, error: String(err) });
      }
    }
  }
}

/**
 * The agent's OWN id for a session — Claude's session uuid, Codex's thread id — or null.
 *
 * `SessionRecord.providerSessionId` is not always one. A session the bridge STARTED records
 * Pagr's own `ses_…` id there (`agent.start_session` mints the id and hands it to the adapter,
 * which keeps the mapping to the provider's id to itself), and an adopted session whose hook
 * never reported a provider id falls back to the same stand-in. Neither can find a transcript,
 * and the honest answer is "Pagr never learned it" rather than a search that was never going to
 * match — so the stand-in is recognised here and reported as the absence it is.
 */
function providerSessionIdOf(rec: SessionRecord): string | null {
  const id = rec.providerThreadId ?? rec.providerSessionId;
  if (!id || id === rec.sessionId) return null;
  return id;
}

/**
 * What a failed switch acks as.
 *
 * `provider_error` for everything that went wrong while doing the work, which is what it is —
 * the cloud shows `message`, and for a rejected commit that message is the user's own hook's
 * first line (spec §9). A directory that is not a git work tree is the one case that is not a
 * failure to try: this Mac will not hand off a tree it cannot commit, and saying so as
 * `capability_unsupported` is what stops the cloud from retrying it.
 */
const HANDOFF_ACK_CODE: Record<HandoffFailure, AckErrorCode> = {
  not_a_repo: 'capability_unsupported',
  not_excluded: 'provider_error',
  no_handoff: 'provider_error',
  hook_failed: 'provider_error',
  commit_failed: 'provider_error',
  write_failed: 'provider_error',
  stop_failed: 'provider_error',
};
