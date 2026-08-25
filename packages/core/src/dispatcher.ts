import { release } from 'node:os';
import type {
  AgentConnectionStatus,
  CommandBody,
  CommandPayload,
  DeviceEvent,
  EventPayload,
  Provider,
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
import { deleteAttachment, type FetchLike, fetchAttachment } from './attachments.js';
import { isLiveStatus, SessionGuard, type WorkspaceClaim } from './concurrency.js';
import { makeEvent } from './events.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { type PublicPolicy, readPolicy, writePolicy } from './policy.js';
import { ProjectError, type ProjectRegistry } from './projects.js';
import type { SessionStore } from './sessions.js';

type AckPayload = EventPayload<'command.ack'>;

export interface ApprovalRequest extends Omit<PendingApprovalInput, 'onResolve'> {
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
  fetch?: FetchLike;
  now?: () => Date;
  logger?: Logger;
  osVersion?: string;
  attachmentTimeoutMs?: number;
  /** Workspace + resource rules for concurrent sessions. Defaults to `SessionGuard.fromEnv()`. */
  guard?: SessionGuard;
}

/**
 * Translates verified `CommandBody`s into adapter calls and adapter events into
 * `DeviceEvent`s. Every command produces exactly one `command.ack`.
 */
export class Dispatcher {
  readonly approvals: PendingApprovalRegistry;
  readonly guard: SessionGuard;
  policy: PublicPolicy;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly capabilities = new Map<Provider, AgentConnectionStatus>();

  constructor(private readonly o: DispatcherOptions) {
    this.logger = o.logger ?? silentLogger;
    this.guard = o.guard ?? SessionGuard.fromEnv();
    this.now = o.now ?? (() => new Date());
    this.policy = readPolicy(o.policyFile);
    this.approvals = new PendingApprovalRegistry({ now: this.now });
    for (const adapter of o.adapters.values()) {
      this.unsubscribes.push(
        adapter.subscribe((e) => void this.onAdapterEvent(adapter.provider, e)),
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

  private async withAttachments<T>(
    refs: CommandPayload<'agent.start_session'>['attachments'],
    fn: (paths: string[]) => Promise<T>,
  ): Promise<T> {
    const paths: string[] = [];
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
      return await fn(paths);
    } finally {
      for (const p of paths) deleteAttachment(p);
    }
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
      return await this.withAttachments(p.attachments, async (localImagePaths) => {
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
    return this.withAttachments(p.attachments, async (localImagePaths) => {
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

  private async respondToApproval(p: CommandPayload<'agent.respond_to_approval'>) {
    const r = await this.approvals.respond(p);
    if (!r.ok) {
      const msg = {
        unknown: 'no pending approval (expired or already used)',
        session_mismatch: 'approval belongs to another session',
        request_mismatch: 'provider request id mismatch',
        preview_mismatch: 'preview hash mismatch',
      }[r.error];
      throw new DispatchError(r.error === 'unknown' ? 'unknown_session' : 'invalid_payload', msg);
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
   */
  requestApproval(input: ApprovalRequest): PendingApproval {
    const { onDecision, ...rest } = input;
    const record = this.approvals.register(
      {
        ...rest,
        onResolve: async (resolution, decision, source) => {
          this.send('approval.resolved_locally', { approvalId: record.approvalId, resolution });
          await onDecision(decision, resolution, source);
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
    return record;
  }

  // ---------- adapter events ----------

  private async onAdapterEvent(provider: Provider, e: AdapterEvent): Promise<void> {
    switch (e.kind) {
      case 'session': {
        const s = e.session;
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
          expiresAt: e.expiresAt,
          onDecision: async (decision, _resolution, source) => {
            // The provider already knows when it resolved the request itself. Cloud decisions and
            // local timeouts (reported as an explicit deny) must be relayed.
            if (source !== 'cloud' && source !== 'timeout') return;
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
