import { release } from 'node:os';
import type {
  AgentConnectionStatus,
  CommandBody,
  CommandPayload,
  DeviceEvent,
  EventPayload,
  Provider,
  SessionStatus,
  SessionSummary,
} from '@pagr/protocol';
import type { AdapterEvent, CodingAgentAdapter } from './adapters/types.js';
import {
  type ApprovalDecision,
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
import { makeEvent } from './events.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { type PublicPolicy, readPolicy, writePolicy } from './policy.js';
import { ProjectError, type ProjectRegistry } from './projects.js';
import type { SessionStore } from './sessions.js';

type AckPayload = EventPayload<'command.ack'>;

export interface ApprovalRequest extends Omit<PendingApprovalInput, 'onResolve' | 'assessment'> {
  /**
   * Unredacted local facts about the action (command, paths, cwd, project root). Classified here,
   * on the Mac, into the assessment the device floor judges a cloud `allow` against.
   */
  local?: LocalActionDetail;
  /** Resolved exactly once. `decision` is null for timeouts / provider-side / shutdown. */
  onDecision: (
    decision: ApprovalDecision | null,
    resolution: ApprovalResolution,
    source: ApprovalSource,
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

  constructor(private readonly o: DispatcherOptions) {
    this.logger = o.logger ?? silentLogger;
    this.guard = o.guard ?? SessionGuard.fromEnv();
    this.now = o.now ?? (() => new Date());
    this.leases = new AttachmentLeaseRegistry({
      dir: o.tmpDir,
      now: () => this.now(),
      ...(o.attachmentLeaseTtlMs ? { ttlMs: o.attachmentLeaseTtlMs } : {}),
    });
    this.policy = readPolicy(o.policyFile);
    this.floor = o.deviceFloor ?? DeviceFloor.fromFile(o.devicePolicyFile, o.env ?? process.env);
    this.approvals = new PendingApprovalRegistry({
      now: this.now,
      onResolveError: (approvalId, err) =>
        this.logger.warn('approval resolution failed', { approvalId, error: String(err) }),
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
    payload: EventPayload<T>,
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
        return this.sendInstruction(body.payload);
      case 'agent.stop_session': {
        const { adapter } = this.sessionAdapter(body.payload.sessionId);
        await adapter.stopSession(body.payload.sessionId);
        this.o.sessions.setStatus(body.payload.sessionId, 'stopped');
        return { sessionId: body.payload.sessionId };
      }
      case 'agent.get_status':
        return this.getStatus(body.payload.sessionId);
      case 'agent.respond_to_approval':
        return this.respondToApproval(body.payload);
      case 'settings.sync_public_policy': {
        this.policy = { ...body.payload };
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
    for (const adapter of this.o.adapters.values()) {
      try {
        for (const s of await adapter.listSessions()) sessions.push(s);
      } catch {
        // adapter may not support listing
      }
    }
    return {
      bridgeVersion: this.o.bridgeVersion,
      protocolVersion: 1,
      platform: 'darwin',
      osVersion: this.o.osVersion ?? release(),
      agents,
      projects: this.o.registry.summaries(),
      sessions,
    };
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
    const pending = p.decision === 'allow' ? this.approvals.get(p.approvalId) : null;
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
    const refusal = assessment ? this.floor.check(assessment) : null;
    const r = await this.approvals.respond(refusal ? { ...p, decision: 'deny' } : p);
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

  // ---------- approvals ----------

  get approvalTimeoutMs(): number {
    return this.policy.approvalTimeoutSeconds * 1000;
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
    const { onDecision, local, ...rest } = input;
    // Classified here, on the Mac, from what the provider asked for — before the cloud has been
    // told this prompt exists, and never from anything the cloud will later echo back.
    const assessment = classifyLocally({
      actionType: rest.actionType,
      preview: rest.preview,
      hints: rest.hints ?? {},
      ...(local ? { detail: local } : {}),
    });
    const record = this.approvals.register(
      {
        ...rest,
        assessment,
        onResolve: async (resolution, decision, source) => {
          try {
            await onDecision(decision, resolution, source);
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
            throw err;
          }
          this.send('approval.resolved_locally', { approvalId: record.approvalId, resolution });
        },
      },
      this.approvalTimeoutMs,
    );
    this.send('approval.requested', {
      approvalId: record.approvalId,
      sessionId: record.sessionId,
      projectId: record.projectId,
      provider: record.provider,
      providerRequestId: record.providerRequestId,
      actionType: record.actionType,
      preview: record.preview,
      previewHash: record.previewHash,
      hints: record.hints,
      expiresAt: record.expiresAt,
    });
    // `smartApprovalsTierA` (synced from the dashboard, persisted in `policy.json`) means "answer
    // the obviously-safe ones for me". Which ones are obvious is decided here, not by the cloud:
    // only an action this Mac classified as carrying no risk class at all, and which is not a
    // shell command. A shell line always waits for a person. The device policy can pin this off
    // locally regardless of what the dashboard says.
    if (this.policy.smartApprovalsTierA && this.floor.tierAAutoApprove && assessment.tierA) {
      this.logger.info('tier-A auto-approval', {
        approvalId: record.approvalId,
        actionType: record.actionType,
      });
      void this.approvals.decideLocally(record.approvalId, 'allow').catch((err) =>
        this.logger.warn('tier-A auto-approval failed', {
          approvalId: record.approvalId,
          error: String(err),
        }),
      );
    }
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
          expiresAt: e.expiresAt,
          onDecision: async (decision, _resolution, source) => {
            // The provider already knows when it resolved the request itself. Everything else —
            // the cloud's answer, a local timeout, and this device's own decision (tier A, or a
            // floor refusal turned into a deny) — has to reach the agent.
            if (source === 'provider' || source === 'shutdown') return;
            await adapter?.respondToApproval({
              approvalId: e.approvalId,
              providerRequestId: e.providerRequestId,
              decision: decision ?? 'deny',
            });
          },
        });
        return;
      }
      case 'approval_resolved_locally':
        // The provider already resolved it; do not call back into the adapter.
        await this.approvals.resolveLocally(e.approvalId, e.resolution).then((had) => {
          if (!had)
            this.send('approval.resolved_locally', {
              approvalId: e.approvalId,
              resolution: e.resolution,
            });
        });
        return;
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
