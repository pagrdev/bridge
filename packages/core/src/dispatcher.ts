import { release } from 'node:os';
import {
  type AgentConnectionStatus,
  type ApprovalOption,
  type ApprovalOptionKind,
  type CommandBody,
  type CommandPayload,
  canonicalize,
  type DeviceEvent,
  type EventPayload,
  type ProjectSummary,
  type Provider,
  type RepoScanResult,
  type SealAad,
  type SessionStatus,
  type SessionSummary,
} from '@pagr/protocol';
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
import { isLiveStatus, SessionGuard, type WorkspaceClaim } from './concurrency.js';
import { classifyLocally, DeviceFloor, type LocalActionDetail } from './deviceFloor.js';
import { type EventPayloadInput, makeEvent } from './events.js';
import { chunkFrame, type FrameBody } from './frames.js';
import type { JournalEntry, JournalMeta, JournalStore, OutboxCursors } from './journal.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { PublicPolicy, readPolicy, writePolicy } from './policy.js';
import { ProjectError, type ProjectRegistry } from './projects.js';
import { RepoHandleCache, scanRepos } from './repoScan.js';
import { importRecipientKeys, type RecipientKeySet, sealFrame } from './seal.js';
import { isAdopted, isReportable, type SessionStore } from './sessions.js';

/**
 * How an adopted session is labelled for the person looking at their phone. It has to be
 * distinguishable from a session Pagr started, because the two differ in what can be done with
 * them: this one's approvals can be answered, but it cannot be sent an instruction or stopped.
 */
export const ADOPTED_SESSION_NAME = 'Your own session';

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

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'stopped']);
const isTerminalStatus = (s: SessionStatus): boolean => TERMINAL_STATUSES.has(s);

const helloBytes = (hello: EventPayload<'device.hello'>): number =>
  Buffer.byteLength(JSON.stringify(hello), 'utf8');

/** Live sessions first, then the most recently updated: what a phone opening the app needs. */
export function rankHelloSessions(sessions: SessionSummary[]): SessionSummary[] {
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
   * Called whenever the set of pending approvals changes. The daemon uses it to hold the Mac
   * awake while somebody still has a prompt to answer; nothing in the dispatcher depends on it.
   */
  onApprovalsChange?: () => void;
  /**
   * Transcript frames. Absent on a bridge with no journal wired up (the CLI's one-shot
   * dispatchers, and tests that do not care), in which case `emitFrame` returns null rather than
   * throwing — a bridge that cannot journal must not pretend to have sent anything.
   */
  frames?: FrameChannel;
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
    for (const event of this.frameEvents(entry, input.imessage)) this.o.emit(event);
    channel.cursors.noteSent(sessionId, seq);
    return { seq, emitted: true };
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
        this.assertOurSession(body.payload.sessionId, 'send an instruction to');
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
      case 'repo.scan':
        return this.scanRepositories();
      case 'project.register_handle':
        return this.registerRepoHandle(body.payload);
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
    const sessions: SessionSummary[] = [];
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
    const capabilityNames = this.remotePickEnabled() ? ['repo_scan.v1'] : [];
    const recipientKeyIds = [...(this.o.recipientKeyIds?.() ?? [])].sort();
    const hello: EventPayload<'device.hello'> = {
      bridgeVersion: this.o.bridgeVersion,
      protocolVersion: 1,
      platform: 'darwin',
      osVersion: this.o.osVersion ?? release(),
      agents,
      projects: this.o.registry.summaries(),
      sessions: rankHelloSessions(sessions).slice(0, this.o.maxHelloSessions ?? MAX_HELLO_SESSIONS),
      ...(capabilityNames.length > 0 ? { capabilities: capabilityNames } : {}),
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

  /**
   * A session's status as this Mac knows it. `sessions.json` is reconciled against the providers
   * at every daemon start, so a session it records as completed / failed / stopped is finished —
   * and a hello must never tell the cloud otherwise. The gateway upserts these summaries, so one
   * downgraded row is enough to make a dead session look resumable on the user's phone (BR-4).
   */
  private authoritative(summary: SessionSummary): SessionSummary {
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

  /**
   * Taking the turn in a session the bridge did not start.
   *
   * It cannot: the adapter only holds the sessions it spawned, so the instruction would reach an
   * adapter that has never heard of this one. Refusing here turns that into one sentence the
   * person can act on, and keeps the limit true on this side rather than only in the cloud.
   *
   * Only the *turn* is refused. Answering a prompt this session raised is the entire point of
   * adopting it and goes through `respondToApproval`, which does not come through here.
   */
  private assertOurSession(sessionId: string, what: string): void {
    const rec = this.o.sessions.get(sessionId);
    if (rec && isAdopted(rec))
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
    });
    // Nothing decides it here. The prompt now waits for the person — on their phone, or in the
    // terminal the agent is running in, whichever answers first. The bridge used to auto-approve
    // what it classified as zero-risk; that is deliberately gone (see `policy.ts`).
    return record;
  }

  // ---------- adapter events ----------

  private async onAdapterEvent(provider: Provider, e: AdapterEvent): Promise<void> {
    switch (e.kind) {
      case 'session': {
        const s = e.session;
        this.noteTurnStatus(s.sessionId, s.status, s.activeTurn);
        const rec = this.o.sessions.get(s.sessionId);
        this.o.sessions.upsert({
          sessionId: s.sessionId,
          provider,
          projectId: s.projectId,
          providerSessionId: rec?.providerSessionId ?? s.sessionId,
          status: s.status,
          // Never widen a read-only session, or forget which tree it holds, on a status update.
          ...(rec?.readOnly !== undefined ? { readOnly: rec.readOnly } : {}),
          ...(rec?.projectPath !== undefined ? { projectPath: rec.projectPath } : {}),
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
        });
        this.send('session.updated', s);
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
      case 'question_asked':
        // B7 (MOB-036) owns the question registry and the `question.asked` event; the adapters
        // already produce the event so that wiring is a dispatcher change and nothing else.
        this.logger.debug('agent asked a question', {
          sessionId: e.sessionId,
          answerable: e.answerable,
          questions: e.questions.length,
        });
        return;
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
    // Every session ends with the daemon, so no agent is going to read these files again.
    this.leases.releaseAll();
    await this.approvals.cancelAll();
    for (const a of this.o.adapters.values()) {
      try {
        await a.shutdown();
      } catch (err) {
        this.logger.warn('adapter shutdown failed', { provider: a.provider, error: String(err) });
      }
    }
  }
}
