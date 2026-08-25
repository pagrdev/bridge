import { randomUUID } from 'node:crypto';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  CodingAgentAdapter,
  SendInstructionInput,
  SessionSummary,
  StartSessionInput,
} from '@pagr/bridge-core';

export interface MockCodexOptions {
  /** Scale factor for scripted delays (1 = real-time: approval after 1.5 s). */
  delayMs?: number;
  approvalTimeoutMs?: number;
}

interface MockSession {
  summary: SessionSummary;
  timers: NodeJS.Timeout[];
  pendingApproval: { approvalId: string; providerRequestId: string; timer: NodeJS.Timeout } | null;
  queued: string[];
}

const now = () => new Date().toISOString();
const newApprovalId = () => `apr_${randomUUID().replace(/-/g, '')}`;

/**
 * Process-free Codex stand-in for E2E without Codex installed (env `PAGR_MOCK_AGENTS=1`).
 * Scripted turn: started → progress "Running tests…" → (approval for `npm run db:migrate` when the
 * instruction mentions "migrate") → completed "All 12 tests pass." Honours steer/queue/stop.
 */
export class MockCodexAdapter implements CodingAgentAdapter {
  readonly provider = 'codex' as const;
  private readonly sessions = new Map<string, MockSession>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly delay: number;
  private readonly approvalTimeoutMs: number;

  constructor(opts: MockCodexOptions = {}) {
    this.delay = opts.delayMs ?? 1500;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 600_000;
  }

  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  async probe(): Promise<AgentConnectionStatus> {
    return {
      provider: 'codex',
      mode: 'app-server',
      installed: true,
      providerVersion: 'mock',
      authStatus: 'authenticated',
      capabilities: {
        canStartSession: true,
        canResumeSession: true,
        canSteerActiveTurn: true,
        canReceiveLiveExternalMessages: false,
        canRelayApprovals: true,
        canStop: true,
        canAttachImages: true,
        canListSessions: true,
      },
      detail: 'Mock Codex adapter (PAGR_MOCK_AGENTS=1)',
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((s) => s.summary);
  }

  async getStatus(sessionId: string): Promise<SessionSummary | null> {
    return this.sessions.get(sessionId)?.summary ?? null;
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    const ts = now();
    const s: MockSession = {
      summary: {
        sessionId: input.sessionId,
        projectId: input.project.projectId,
        provider: 'codex',
        status: 'starting',
        activeTurn: false,
        startedAt: ts,
        updatedAt: ts,
        taskSummary: input.instruction.slice(0, 500),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      timers: [],
      pendingApproval: null,
      queued: [],
    };
    this.sessions.set(input.sessionId, s);
    this.emit({ kind: 'session', session: s.summary });
    this.runTurn(s, input.instruction);
    return s.summary;
  }

  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    const s = this.sessions.get(input.sessionId);
    if (!s) throw new Error(`unknown session ${input.sessionId}`);
    if (s.summary.activeTurn) {
      if (input.mode === 'queue') {
        s.queued.push(input.instruction);
        this.event(s, 'queued_followup', input.instruction);
        return { delivered: 'queued' };
      }
      this.event(s, 'progress', `Steered: ${input.instruction}`);
      return { delivered: 'steered' };
    }
    this.runTurn(s, input.instruction);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.clearTimers(s);
    if (s.pendingApproval) {
      clearTimeout(s.pendingApproval.timer);
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: s.pendingApproval.approvalId,
        resolution: 'canceled',
      });
      s.pendingApproval = null;
    }
    s.queued = [];
    this.setStatus(s, 'stopped', { activeTurn: false, endedAt: now() });
    this.event(s, 'stopped', 'Session stopped');
  }

  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
  }): Promise<void> {
    const s = [...this.sessions.values()].find(
      (x) => x.pendingApproval?.approvalId === input.approvalId,
    );
    if (!s?.pendingApproval) throw new Error(`unknown or expired approval ${input.approvalId}`);
    if (s.pendingApproval.providerRequestId !== input.providerRequestId) {
      throw new Error('providerRequestId does not match retained approval request');
    }
    clearTimeout(s.pendingApproval.timer);
    s.pendingApproval = null;
    this.emit({
      kind: 'approval_resolved_locally',
      approvalId: input.approvalId,
      resolution: input.decision === 'allow' ? 'allowed' : 'denied',
    });
    this.setStatus(s, 'working');
    if (input.decision === 'allow') {
      this.event(s, 'progress', 'Migration applied.');
      this.finish(s, 'All 12 tests pass.');
    } else {
      this.finish(s, 'Skipped migration; 11 of 12 tests pass (db test skipped).');
    }
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) {
      this.clearTimers(s);
      if (s.pendingApproval) clearTimeout(s.pendingApproval.timer);
    }
  }

  // ---- script ----

  private runTurn(s: MockSession, instruction: string): void {
    s.summary = { ...s.summary, taskSummary: instruction.slice(0, 500) };
    this.setStatus(s, 'working', { activeTurn: true });
    this.event(s, 'started', 'Turn started');
    this.after(s, this.delay / 3, () => this.event(s, 'progress', 'Running tests…'));
    if (/migrate/i.test(instruction)) {
      this.after(s, this.delay, () => this.requestApproval(s));
    } else {
      this.after(s, this.delay, () => this.finish(s, 'All 12 tests pass.'));
    }
  }

  private requestApproval(s: MockSession): void {
    const approvalId = newApprovalId();
    const providerRequestId = `mock-item-${randomUUID().slice(0, 8)}`;
    const timer = setTimeout(() => {
      if (s.pendingApproval?.approvalId !== approvalId) return;
      s.pendingApproval = null;
      this.emit({ kind: 'approval_resolved_locally', approvalId, resolution: 'timed_out' });
      this.finish(s, 'Approval timed out; migration skipped.');
    }, this.approvalTimeoutMs);
    timer.unref();
    s.pendingApproval = { approvalId, providerRequestId, timer };
    this.setStatus(s, 'waiting_for_approval');
    this.emit({
      kind: 'approval_requested',
      approvalId,
      sessionId: s.summary.sessionId,
      projectId: s.summary.projectId,
      providerRequestId,
      actionType: 'command_execution',
      preview: 'npm run db:migrate',
      hints: { productionHint: true },
      expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
    });
  }

  private finish(s: MockSession, message: string): void {
    this.after(s, this.delay / 3, () => {
      this.event(s, 'agent_message', message);
      this.setStatus(s, 'completed', { activeTurn: false });
      this.event(s, 'completed', message);
      const next = s.queued.shift();
      if (next) {
        this.event(s, 'followup_delivered', next);
        this.runTurn(s, next);
      }
    });
  }

  private after(s: MockSession, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      s.timers = s.timers.filter((x) => x !== t);
      fn();
    }, ms);
    s.timers.push(t);
  }

  private clearTimers(s: MockSession): void {
    for (const t of s.timers) clearTimeout(t);
    s.timers = [];
  }

  private setStatus(
    s: MockSession,
    status: SessionSummary['status'],
    patch: Partial<SessionSummary> = {},
  ): void {
    s.summary = { ...s.summary, ...patch, status, updatedAt: now() };
    this.emit({ kind: 'session', session: s.summary });
  }

  private event(
    s: MockSession,
    type: Extract<AdapterEvent, { kind: 'session_event' }>['type'],
    summary: string,
  ): void {
    this.emit({
      kind: 'session_event',
      sessionId: s.summary.sessionId,
      projectId: s.summary.projectId,
      type,
      summary,
    });
  }

  private emit(e: AdapterEvent): void {
    for (const l of this.listeners) l(e);
  }
}
