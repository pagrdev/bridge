import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  CodingAgentAdapter,
  SendInstructionInput,
  SessionSummary,
  StartSessionInput,
} from '@pagr/bridge-core';
import { ClaudeProcess } from './claude-process.js';
import { clip, type Hints, hintsForCommand, hintsForFiles } from './heuristics.js';
import { FileLogger } from './logger.js';
import { SessionMap } from './session-map.js';
import { actionTypeForTool, filePathsOf, previewForTool, type StreamEvent } from './stream-json.js';

export interface ClaudeAdapterOptions {
  home: string;
  /** Base command, default `['claude']`. Tests pass `['node', fixture]`. */
  claudeCommand?: string[];
  approvalTimeoutMs?: number;
  /** Extra env for spawned processes (tests). */
  env?: NodeJS.ProcessEnv;
  log?: boolean;
}

interface LiveSession {
  summary: SessionSummary;
  claudeSessionId: string;
  projectPath: string;
  proc: ClaudeProcess | null;
  activeTurn: boolean;
  lastText: string;
  queued: Array<{ instruction: string; images: string[] }>;
}

interface PendingApproval {
  approvalId: string;
  requestId: string;
  sessionId: string;
  providerRequestId: string;
  input: Record<string, unknown>;
  timer: NodeJS.Timeout;
}

export const newApprovalId = (): string => `apr_${randomUUID().replace(/-/g, '')}`;
const now = () => new Date().toISOString();

const CAPABILITIES = {
  canStartSession: true,
  canResumeSession: true,
  /** Live steering of an in-flight turn is not faked (ADR 0001); instructions are queued. */
  canSteerActiveTurn: false,
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
export class ClaudeAdapter implements CodingAgentAdapter {
  readonly provider = 'claude' as const;
  private readonly logger: FileLogger;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly map: SessionMap;
  private shuttingDown = false;

  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.logger = new FileLogger(
      opts.log === false ? null : path.join(opts.home, 'logs', 'claude.log'),
    );
    this.map = new SessionMap(path.join(opts.home, 'claude-sessions.json'));
  }

  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  async probe(): Promise<AgentConnectionStatus> {
    const version = await this.run(['--version']);
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
    const ver = /(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? version.trim();
    let authStatus: AgentConnectionStatus['authStatus'] = 'unknown';
    // `claude auth status` prints JSON incl. `loggedIn` (exit 0 logged in, 1 if not).
    // We read ONLY the boolean; email/org fields are discarded and never logged.
    const auth = await this.run(['auth', 'status'], true);
    if (auth !== null) {
      try {
        const j = JSON.parse(auth) as { loggedIn?: boolean };
        if (typeof j.loggedIn === 'boolean')
          authStatus = j.loggedIn ? 'authenticated' : 'unauthenticated';
      } catch {
        /* older CLI without JSON output */
      }
    }
    if (authStatus === 'unknown') {
      // Presence-only inference; contents are never read.
      const home = os.homedir();
      const hasCreds =
        fs.existsSync(path.join(home, '.claude', '.credentials.json')) ||
        fs.existsSync(path.join(home, '.claude.json'));
      authStatus = hasCreds ? 'authenticated' : 'unauthenticated';
    }
    const status: AgentConnectionStatus = {
      provider: 'claude',
      mode: 'cli-hooks',
      installed: true,
      providerVersion: ver,
      authStatus,
      capabilities: { ...CAPABILITIES },
    };
    if (authStatus !== 'authenticated') status.detail = 'Run `claude` once and sign in';
    return status;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out = new Map<string, SessionSummary>();
    for (const [sid, p] of this.map.entries()) {
      out.set(sid, {
        sessionId: sid,
        projectId: p.projectId,
        provider: 'claude',
        status: 'idle',
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
      provider: 'claude',
      status: 'idle',
      activeTurn: false,
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      ...(p.displayName ? { displayName: p.displayName } : {}),
    };
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    if (this.shuttingDown) throw new Error('adapter is shut down');
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
      proc: null,
      activeTurn: false,
      lastText: '',
      queued: [],
    };
    this.sessions.set(input.sessionId, live);
    this.map.set(input.sessionId, {
      claudeSessionId,
      projectId: input.project.projectId,
      projectPath: input.project.path,
      startedAt: ts,
      updatedAt: ts,
      lastStatus: 'starting',
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    this.emit({ kind: 'session', session: live.summary });
    this.spawn(live, { kind: 'new', id: claudeSessionId }, input.readOnly);
    this.sendTurn(live, input.instruction, input.localImagePaths);
    return live.summary;
  }

  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    const live = this.requireLive(input.sessionId);
    if (live.activeTurn && live.proc?.alive) {
      // No live steering without Channels: queue and deliver after `result` (ADR 0001).
      live.queued.push({ instruction: input.instruction, images: input.localImagePaths });
      this.sessionEvent(live, 'queued_followup', clip(input.instruction, 500));
      return { delivered: 'queued' };
    }
    if (!live.proc?.alive) this.spawn(live, { kind: 'resume', id: live.claudeSessionId }, false);
    this.sendTurn(live, input.instruction, input.localImagePaths);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
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
  }): Promise<void> {
    const p = this.pending.get(input.approvalId);
    if (!p) throw new Error(`unknown or expired approval ${input.approvalId}`);
    if (p.providerRequestId !== input.providerRequestId) {
      throw new Error('providerRequestId does not match retained approval request');
    }
    this.pending.delete(input.approvalId);
    clearTimeout(p.timer);
    const live = this.sessions.get(p.sessionId);
    if (live?.proc?.alive) {
      live.proc.answerPermission(
        p.requestId,
        input.decision === 'allow'
          ? { behavior: 'allow', updatedInput: p.input }
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

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...(this.opts.env ?? {}), ...extra };
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
      proc: null,
      activeTurn: false,
      lastText: '',
      queued: [],
    };
    this.sessions.set(sessionId, live);
    return live;
  }

  private spawn(
    live: LiveSession,
    session: { kind: 'new'; id: string } | { kind: 'resume'; id: string },
    readOnly: boolean,
  ): void {
    const proc = new ClaudeProcess({
      command: this.opts.claudeCommand ?? ['claude'],
      cwd: live.projectPath,
      env: this.env({
        PAGR_SESSION_ID: live.summary.sessionId,
        PAGR_DAEMON_SOCK:
          process.env.PAGR_DAEMON_SOCK ?? path.join(this.opts.home, 'run', 'daemon.sock'),
      }),
      session,
      readOnly,
      logger: this.logger,
    });
    live.proc = proc;
    proc.on('event', (ev) => this.onEvent(live, proc, ev));
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

  private sendTurn(live: LiveSession, instruction: string, images: string[]): void {
    if (!live.proc?.alive) throw new Error('claude process not running');
    const text = images.length
      ? `${images.map((p) => `See screenshot at ${p}`).join('\n')}\n\n${instruction}`
      : instruction;
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
          clip(previewForTool(ev.name, ev.input), 300),
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
          this.deliverQueued(live);
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

  private onPermissionRequest(
    live: LiveSession,
    ev: Extract<StreamEvent, { type: 'permission_request' }>,
  ): void {
    const approvalId = newApprovalId();
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    const timer = setTimeout(() => this.timeoutApproval(approvalId), timeoutMs);
    timer.unref();
    const providerRequestId = (ev.toolUseId ?? ev.requestId).slice(0, 200);
    this.pending.set(approvalId, {
      approvalId,
      requestId: ev.requestId,
      sessionId: live.summary.sessionId,
      providerRequestId,
      input: ev.input,
      timer,
    });
    const preview = previewForTool(ev.toolName, ev.input);
    let hints: Hints;
    if (ev.toolName === 'Bash') {
      const cmd = typeof ev.input.command === 'string' ? ev.input.command : '';
      hints = hintsForCommand(cmd, live.projectPath, live.projectPath);
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
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
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
  }

  private hasPendingFor(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  private deliverQueued(live: LiveSession): void {
    const next = live.queued.shift();
    if (!next) return;
    try {
      if (!live.proc?.alive) this.spawn(live, { kind: 'resume', id: live.claudeSessionId }, false);
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
