import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  CodingAgentAdapter,
  SendInstructionInput,
  SessionSummary,
  StartSessionInput,
} from '@pagr/bridge-core';
import { AppServerClient } from './app-server.js';
import { clip, type Hints, hintsForCommand, hintsForFiles } from './heuristics.js';
import { FileLogger } from './logger.js';
import {
  type AgentMessageDeltaNotification,
  type CommandExecutionRequestApprovalParams,
  type ErrorNotification,
  type FileChangeRequestApprovalParams,
  type GetAccountResponse,
  type ItemCompletedNotification,
  METHODS,
  NOTIFICATIONS,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type RpcId,
  type RpcNotification,
  type RpcRequest,
  SERVER_REQUESTS,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadStatusChangedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type TurnStartResponse,
  type TurnSteerResponse,
  type UserInput,
} from './protocol.js';
import { SessionMap } from './session-map.js';

export interface CodexAdapterOptions {
  /** PAGR_HOME; state + logs live here. */
  home: string;
  /** Base command for the Codex CLI, default `['codex']`. Tests pass `['node', fixture]`. */
  codexCommand?: string[];
  approvalTimeoutMs?: number;
  requestTimeoutMs?: number;
  bridgeVersion?: string;
  /** Restart delay after an unexpected app-server exit. */
  restartDelayMs?: number;
  /** Disable file logging (tests). */
  log?: boolean;
}

interface LiveSession {
  summary: SessionSummary;
  threadId: string;
  projectPath: string;
  activeTurnId: string | null;
  /** Thread has been started/resumed in the CURRENT app-server process. */
  loaded: boolean;
  agentBuffers: Map<string, string>;
  lastAgentMessage: string;
  queued: Array<{ instruction: string; images: string[] }>;
}

interface PendingApproval {
  approvalId: string;
  rpcId: RpcId;
  sessionId: string;
  providerRequestId: string;
  kind: 'command' | 'file' | 'permissions';
  timer: NodeJS.Timeout;
  requested: PermissionsRequestApprovalParams['permissions'] | null;
}

export const newApprovalId = (): string => `apr_${randomUUID().replace(/-/g, '')}`;
const now = () => new Date().toISOString();

const CAPABILITIES = {
  canStartSession: true,
  canResumeSession: true,
  canSteerActiveTurn: true,
  canReceiveLiveExternalMessages: false,
  canRelayApprovals: true,
  canStop: true,
  canAttachImages: true,
  canListSessions: true,
} as const;

const INSTALL_HINT = 'Install Codex: npm i -g @openai/codex, then run `codex login`';

/**
 * Codex adapter over the local `codex app-server` (stdio JSON-RPC). One app-server process is
 * shared by all sessions; each cloud session maps to one Codex thread.
 */
export class CodexAdapter implements CodingAgentAdapter {
  readonly provider = 'codex' as const;
  private readonly logger: FileLogger;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly byThread = new Map<string, string>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly map: SessionMap;
  private client: AppServerClient | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CodexAdapterOptions) {
    this.logger = new FileLogger(
      opts.log === false ? null : path.join(opts.home, 'logs', 'codex.log'),
    );
    this.map = new SessionMap(path.join(opts.home, 'codex-sessions.json'));
  }

  // ---------- public API ----------

  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  async probe(): Promise<AgentConnectionStatus> {
    const version = await this.codexVersion();
    if (!version) {
      return {
        provider: 'codex',
        mode: 'disabled',
        installed: false,
        authStatus: 'unknown',
        capabilities: { ...CAPABILITIES, canStartSession: false, canResumeSession: false },
        detail: INSTALL_HINT,
      };
    }
    let authStatus: AgentConnectionStatus['authStatus'] = 'unknown';
    let detail: string | undefined;
    try {
      const client = await this.ensureClient();
      const acct = await client.request<GetAccountResponse>(METHODS.accountRead, {});
      if (acct.account) authStatus = 'authenticated';
      else if (acct.requiresOpenaiAuth) {
        authStatus = 'unauthenticated';
        detail = 'Run `codex login` to sign in to Codex';
      }
    } catch (err) {
      detail = `Codex app-server unavailable: ${(err as Error).message}`;
    }
    const status: AgentConnectionStatus = {
      provider: 'codex',
      mode: 'app-server',
      installed: true,
      providerVersion: version,
      authStatus,
      capabilities: { ...CAPABILITIES },
    };
    if (detail) status.detail = detail;
    return status;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out = new Map<string, SessionSummary>();
    for (const [sid, p] of this.map.entries()) {
      out.set(sid, {
        sessionId: sid,
        projectId: p.projectId,
        provider: 'codex',
        status: this.sessions.has(sid) ? 'unknown' : 'idle',
        activeTurn: false,
        startedAt: p.startedAt,
        updatedAt: p.updatedAt,
        ...(p.displayName ? { displayName: p.displayName } : {}),
      });
    }
    for (const [sid, s] of this.sessions) out.set(sid, s.summary);
    return [...out.values()];
  }

  async getStatus(sessionId: string): Promise<SessionSummary | null> {
    const live = this.sessions.get(sessionId);
    if (live) return live.summary;
    const p = this.map.get(sessionId);
    if (!p) return null;
    return {
      sessionId,
      projectId: p.projectId,
      provider: 'codex',
      status: 'idle',
      activeTurn: false,
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      ...(p.displayName ? { displayName: p.displayName } : {}),
    };
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    const client = await this.ensureClient();
    const params: ThreadStartParams = {
      cwd: input.project.path,
      approvalPolicy: 'on-request',
      sandbox: input.readOnly ? 'read-only' : 'workspace-write',
    };
    const res = await client.request<ThreadStartResponse>(METHODS.threadStart, params);
    const threadId = res.thread.id;
    const ts = now();
    const summary: SessionSummary = {
      sessionId: input.sessionId,
      projectId: input.project.projectId,
      provider: 'codex',
      status: 'starting',
      activeTurn: false,
      startedAt: ts,
      updatedAt: ts,
      taskSummary: clip(input.instruction, 500),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    };
    const live: LiveSession = {
      summary,
      threadId,
      projectPath: input.project.path,
      activeTurnId: null,
      loaded: true,
      agentBuffers: new Map(),
      lastAgentMessage: '',
      queued: [],
    };
    this.sessions.set(input.sessionId, live);
    this.byThread.set(threadId, input.sessionId);
    this.map.set(input.sessionId, {
      threadId,
      projectId: input.project.projectId,
      projectPath: input.project.path,
      startedAt: ts,
      updatedAt: ts,
      lastStatus: 'starting',
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    this.emit({ kind: 'session', session: summary });
    await this.startTurn(live, input.instruction, input.localImagePaths);
    return live.summary;
  }

  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    const live = await this.requireLive(input.sessionId);
    const client = await this.ensureClient();
    if (live.activeTurnId) {
      if (input.mode === 'queue') {
        live.queued.push({ instruction: input.instruction, images: input.localImagePaths });
        this.sessionEvent(live, 'queued_followup', clip(input.instruction, 500));
        return { delivered: 'queued' };
      }
      await client.request<TurnSteerResponse>(METHODS.turnSteer, {
        threadId: live.threadId,
        input: buildInput(input.instruction, input.localImagePaths),
        expectedTurnId: live.activeTurnId,
      });
      this.sessionEvent(live, 'progress', `Steered: ${clip(input.instruction, 400)}`);
      return { delivered: 'steered' };
    }
    await this.startTurn(live, input.instruction, input.localImagePaths);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    live.queued = [];
    if (live.activeTurnId && this.client?.running) {
      try {
        await this.client.request(METHODS.turnInterrupt, {
          threadId: live.threadId,
          turnId: live.activeTurnId,
        });
        // turn/completed(interrupted) will finalize as 'stopped'.
        return;
      } catch (err) {
        this.logger.log('warn', 'turn/interrupt failed', { message: (err as Error).message });
      }
    }
    this.cancelApprovalsFor(sessionId);
    this.setStatus(live, 'stopped', { activeTurn: false, endedAt: now() });
    this.sessionEvent(live, 'stopped', 'Session stopped');
  }

  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
  }): Promise<void> {
    const p = this.pending.get(input.approvalId);
    if (!p) throw new Error(`unknown or expired approval ${input.approvalId}`);
    if (p.providerRequestId !== input.providerRequestId) {
      throw new Error('providerRequestId does not match retained approval request');
    }
    this.pending.delete(input.approvalId);
    clearTimeout(p.timer);
    this.answer(p, input.decision === 'allow' ? 'accept' : 'decline');
    this.emit({
      kind: 'approval_resolved_locally',
      approvalId: p.approvalId,
      resolution: input.decision === 'allow' ? 'allowed' : 'denied',
    });
    const live = this.sessions.get(p.sessionId);
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const p of [...this.pending.values()]) {
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.answer(p, 'decline');
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
    await this.client?.stop();
    this.client = null;
    this.logger.close();
  }

  // ---------- internals ----------

  private emit(e: AdapterEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.logger.log('error', 'listener threw', { message: (err as Error).message });
      }
    }
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

  private setStatus(
    live: LiveSession,
    status: SessionSummary['status'],
    patch: Partial<SessionSummary> = {},
  ): void {
    live.summary = { ...live.summary, ...patch, status, updatedAt: now() };
    this.map.update(live.summary.sessionId, {
      lastStatus: status,
      updatedAt: live.summary.updatedAt,
    });
    this.emit({ kind: 'session', session: live.summary });
  }

  private codexVersion(): Promise<string | null> {
    const [bin, ...rest] = this.opts.codexCommand ?? ['codex'];
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(bin, [...rest, '--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /(\d+\.\d+\.\d+)/.exec(stdout);
        resolve(m?.[1] ?? (stdout.trim() || null));
      });
    });
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client?.running) return this.client;
    if (this.shuttingDown) throw new Error('adapter is shut down');
    const [bin, ...rest] = this.opts.codexCommand ?? ['codex'];
    const client = new AppServerClient({
      command: [bin ?? 'codex', ...rest, 'app-server'],
      clientVersion: this.opts.bridgeVersion ?? '0.1.0',
      logger: this.logger,
      ...(this.opts.requestTimeoutMs ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}),
    });
    client.on('notification', (n) => this.onNotification(n));
    client.on('request', (r) => this.onServerRequest(r));
    client.on('exit', (info) => this.onExit(info.expected));
    this.client = client;
    await client.start();
    // Threads must be re-resumed in a fresh process.
    for (const s of this.sessions.values()) s.loaded = false;
    return client;
  }

  private onExit(expected: boolean): void {
    if (expected || this.shuttingDown) return;
    for (const live of this.sessions.values()) {
      if (live.activeTurnId) {
        live.activeTurnId = null;
        this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
        this.sessionEvent(live, 'failed', 'Codex app-server exited unexpectedly');
      }
      live.loaded = false;
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
    const delay = this.opts.restartDelayMs ?? 2000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureClient().catch((err) =>
        this.logger.log('error', 'app-server restart failed', { message: err.message }),
      );
    }, delay);
    this.restartTimer.unref();
  }

  private async requireLive(sessionId: string): Promise<LiveSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const p = this.map.get(sessionId);
    if (!p) throw new Error(`unknown session ${sessionId}`);
    const ts = now();
    const live: LiveSession = {
      summary: {
        sessionId,
        projectId: p.projectId,
        provider: 'codex',
        status: 'idle',
        activeTurn: false,
        startedAt: p.startedAt,
        updatedAt: ts,
        ...(p.displayName ? { displayName: p.displayName } : {}),
      },
      threadId: p.threadId,
      projectPath: p.projectPath,
      activeTurnId: null,
      loaded: false,
      agentBuffers: new Map(),
      lastAgentMessage: '',
      queued: [],
    };
    this.sessions.set(sessionId, live);
    this.byThread.set(p.threadId, sessionId);
    return live;
  }

  private async ensureLoaded(live: LiveSession): Promise<void> {
    const client = await this.ensureClient();
    if (live.loaded) return;
    const params: ThreadResumeParams = {
      threadId: live.threadId,
      cwd: live.projectPath,
      approvalPolicy: 'on-request',
    };
    await client.request(METHODS.threadResume, params);
    live.loaded = true;
  }

  private async startTurn(live: LiveSession, instruction: string, images: string[]): Promise<void> {
    await this.ensureLoaded(live);
    const client = await this.ensureClient();
    const res = await client.request<TurnStartResponse>(METHODS.turnStart, {
      threadId: live.threadId,
      input: buildInput(instruction, images),
    });
    live.activeTurnId = res.turn.id;
    live.lastAgentMessage = '';
    this.setStatus(live, 'working', { activeTurn: true, taskSummary: clip(instruction, 500) });
  }

  // ---- notifications ----

  private onNotification(n: RpcNotification): void {
    const p = (n.params ?? {}) as Record<string, unknown>;
    switch (n.method) {
      case NOTIFICATIONS.turnStarted: {
        const { threadId, turn } = p as unknown as TurnStartedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        live.activeTurnId = turn.id;
        if (live.summary.status !== 'working')
          this.setStatus(live, 'working', { activeTurn: true });
        this.sessionEvent(live, 'started', 'Turn started', turn.id);
        return;
      }
      case NOTIFICATIONS.agentMessageDelta: {
        const d = p as unknown as AgentMessageDeltaNotification;
        const live = this.liveByThread(d.threadId);
        if (!live) return;
        live.agentBuffers.set(d.itemId, (live.agentBuffers.get(d.itemId) ?? '') + d.delta);
        return;
      }
      case NOTIFICATIONS.itemStarted: {
        const { item, threadId } = p as unknown as ItemCompletedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        if (item.type === 'commandExecution' && 'command' in item) {
          this.sessionEvent(
            live,
            'progress',
            `Running: ${clip(String(item.command), 300)}`,
            item.id,
          );
        }
        return;
      }
      case NOTIFICATIONS.itemCompleted: {
        const { item, threadId } = p as unknown as ItemCompletedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        if (item.type === 'agentMessage') {
          const text =
            ('text' in item && typeof item.text === 'string' && item.text) ||
            live.agentBuffers.get(item.id) ||
            '';
          live.agentBuffers.delete(item.id);
          if (text.trim()) {
            live.lastAgentMessage = text;
            this.sessionEvent(live, 'agent_message', clip(text, 500), item.id);
          }
        } else if (item.type === 'fileChange' && 'changes' in item) {
          const files = (item.changes as Array<{ path: string }>).map((c) => c.path);
          this.sessionEvent(
            live,
            'progress',
            `Changed ${files.length} file(s): ${clip(files.join(', '), 300)}`,
            item.id,
          );
        }
        return;
      }
      case NOTIFICATIONS.turnCompleted: {
        const { threadId, turn } = p as unknown as TurnCompletedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        live.activeTurnId = null;
        this.cancelApprovalsFor(live.summary.sessionId);
        const final = live.lastAgentMessage || `Turn ${turn.status}`;
        if (turn.status === 'failed') {
          this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
          this.sessionEvent(live, 'failed', turn.error?.message ?? final, turn.id);
        } else if (turn.status === 'interrupted') {
          this.setStatus(live, 'stopped', { activeTurn: false, endedAt: now() });
          this.sessionEvent(live, 'stopped', final, turn.id);
        } else {
          this.setStatus(live, 'completed', { activeTurn: false });
          this.sessionEvent(live, 'completed', final, turn.id);
          this.deliverQueued(live);
        }
        return;
      }
      case NOTIFICATIONS.threadStatusChanged: {
        const { threadId, status } = p as unknown as ThreadStatusChangedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        if (status.type === 'active' && status.activeFlags.includes('waitingOnUserInput')) {
          this.setStatus(live, 'waiting_for_user');
          this.sessionEvent(live, 'needs_input', 'Codex is waiting for your input');
        }
        return;
      }
      case NOTIFICATIONS.error: {
        const e = p as unknown as ErrorNotification;
        const live = this.liveByThread(e.threadId);
        if (!live) return;
        this.logger.log('warn', 'turn error', { willRetry: e.willRetry, message: e.error.message });
        if (!e.willRetry)
          this.sessionEvent(live, 'progress', `Error: ${clip(e.error.message, 300)}`);
        return;
      }
      default:
        return;
    }
  }

  private deliverQueued(live: LiveSession): void {
    const next = live.queued.shift();
    if (!next) return;
    this.startTurn(live, next.instruction, next.images)
      .then(() => this.sessionEvent(live, 'followup_delivered', clip(next.instruction, 500)))
      .catch((err) => {
        this.logger.log('error', 'queued follow-up failed', { message: (err as Error).message });
        this.sessionEvent(live, 'failed', `Queued follow-up failed: ${(err as Error).message}`);
      });
  }

  private liveByThread(threadId: string): LiveSession | undefined {
    const sid = this.byThread.get(threadId) ?? this.map.findByThread(threadId);
    return sid ? this.sessions.get(sid) : undefined;
  }

  // ---- server → client approval requests ----

  private onServerRequest(r: RpcRequest): void {
    const client = this.client;
    if (!client) return;
    const params = (r.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const live = this.liveByThread(threadId);
    if (!live) {
      // Not one of ours (or unknown method): fail safe by declining.
      this.logger.log('warn', 'server request for unknown thread; declining', { method: r.method });
      if (r.method === SERVER_REQUESTS.permissionsApproval) {
        client.respond(r.id, {
          permissions: {},
          scope: 'turn',
        } satisfies PermissionsRequestApprovalResponse);
      } else if (
        r.method === SERVER_REQUESTS.commandApproval ||
        r.method === SERVER_REQUESTS.fileChangeApproval
      ) {
        client.respond(r.id, { decision: 'decline' });
      } else {
        client.respondError(r.id, -32601, 'unsupported request');
      }
      return;
    }

    let kind: PendingApproval['kind'];
    let actionType: Extract<AdapterEvent, { kind: 'approval_requested' }>['actionType'];
    let preview: string;
    let hints: Hints;
    let providerRequestId: string;
    let requested: PendingApproval['requested'] = null;
    switch (r.method) {
      case SERVER_REQUESTS.commandApproval: {
        const c = params as unknown as CommandExecutionRequestApprovalParams;
        kind = 'command';
        actionType = 'command_execution';
        preview = c.command ?? '(command)';
        if (c.reason) preview += `\n— ${c.reason}`;
        hints = hintsForCommand(c.command ?? '', c.cwd ?? undefined, live.projectPath);
        providerRequestId = c.approvalId ?? c.itemId;
        break;
      }
      case SERVER_REQUESTS.fileChangeApproval: {
        const f = params as unknown as FileChangeRequestApprovalParams;
        kind = 'file';
        actionType = 'file_change';
        const files = f.grantRoot ? [f.grantRoot] : [];
        preview = f.grantRoot
          ? `Write access requested under ${f.grantRoot}`
          : `Apply file changes${f.reason ? ` — ${f.reason}` : ''}`;
        hints = hintsForFiles(files, live.projectPath);
        providerRequestId = f.itemId;
        break;
      }
      case SERVER_REQUESTS.permissionsApproval: {
        const pr = params as unknown as PermissionsRequestApprovalParams;
        kind = 'permissions';
        actionType = 'permission';
        const wants: string[] = [];
        if (pr.permissions.network) wants.push('network access');
        if (pr.permissions.fileSystem) wants.push('extra file-system access');
        preview = `Codex requests ${wants.join(' and ') || 'additional permissions'}${
          pr.reason ? ` — ${pr.reason}` : ''
        }`;
        hints = {
          ...(pr.permissions.network ? { networkAccess: true } : {}),
          ...(pr.permissions.fileSystem ? { touchesOutsideProject: true } : {}),
        };
        providerRequestId = pr.itemId;
        requested = pr.permissions;
        break;
      }
      default:
        client.respondError(r.id, -32601, 'unsupported request');
        return;
    }

    const approvalId = newApprovalId();
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    const timer = setTimeout(() => this.timeoutApproval(approvalId), timeoutMs);
    timer.unref();
    const pending: PendingApproval = {
      approvalId,
      rpcId: r.id,
      sessionId: live.summary.sessionId,
      providerRequestId: providerRequestId.slice(0, 200),
      kind,
      timer,
      requested,
    };
    this.pending.set(approvalId, pending);
    this.setStatus(live, 'waiting_for_approval');
    this.emit({
      kind: 'approval_requested',
      approvalId,
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      providerRequestId: pending.providerRequestId,
      actionType,
      preview: clip(preview, 1500),
      hints,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
  }

  private answer(p: PendingApproval, decision: 'accept' | 'decline'): void {
    const client = this.client;
    if (!client?.running) return;
    if (p.kind === 'permissions') {
      const granted: PermissionsRequestApprovalResponse =
        decision === 'accept' && p.requested
          ? {
              permissions: {
                ...(p.requested.network ? { network: p.requested.network } : {}),
                ...(p.requested.fileSystem ? { fileSystem: p.requested.fileSystem } : {}),
              },
              scope: 'turn',
            }
          : { permissions: {}, scope: 'turn' };
      client.respond(p.rpcId, granted);
    } else {
      client.respond(p.rpcId, { decision });
    }
  }

  private timeoutApproval(approvalId: string): void {
    const p = this.pending.get(approvalId);
    if (!p) return;
    this.pending.delete(approvalId);
    this.answer(p, 'decline');
    this.emit({ kind: 'approval_resolved_locally', approvalId, resolution: 'timed_out' });
    const live = this.sessions.get(p.sessionId);
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  private hasPendingFor(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  private cancelApprovalsFor(sessionId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.answer(p, 'decline');
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
  }
}

export function buildInput(instruction: string, images: string[]): UserInput[] {
  const input: UserInput[] = [{ type: 'text', text: instruction, text_elements: [] }];
  for (const p of images) input.push({ type: 'localImage', path: p });
  return input;
}
