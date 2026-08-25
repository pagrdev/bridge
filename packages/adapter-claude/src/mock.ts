import { randomUUID } from 'node:crypto';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  CodingAgentAdapter,
  SendInstructionInput,
  SessionSummary,
  StartSessionInput,
} from '@pagr/bridge-core';

export interface MockClaudeOptions {
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
 * Process-free Claude stand-in (env `PAGR_MOCK_AGENTS=1`).
 * Scripted turn: started → progress "Reading auth module…" → (approval for a Write when the
 * instruction mentions "write") → completed "Auth flow implemented, 68 tests pass."
 * No steering: follow-ups during a turn are queued and delivered after completion.
 */
export class MockClaudeAdapter implements CodingAgentAdapter {
  readonly provider = 'claude' as const;
  private readonly sessions = new Map<string, MockSession>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly delay: number;
  private readonly approvalTimeoutMs: number;

  constructor(opts: MockClaudeOptions = {}) {
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
      provider: 'claude',
      mode: 'cli-hooks',
      installed: true,
      providerVersion: 'mock',
      authStatus: 'authenticated',
      capabilities: {
        canStartSession: true,
        canResumeSession: true,
        canSteerActiveTurn: false,
        canReceiveLiveExternalMessages: false,
        canRelayApprovals: true,
        canStop: true,
        canAttachImages: true,
        canListSessions: true,
      },
      detail: 'Mock Claude adapter (PAGR_MOCK_AGENTS=1)',
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
        provider: 'claude',
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
      s.queued.push(input.instruction);
      this.event(s, 'queued_followup', input.instruction);
      return { delivered: 'queued' };
    }
    this.runTurn(s, input.instruction);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const t of s.timers) clearTimeout(t);
    s.timers = [];
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
    this.finish(
      s,
      input.decision === 'allow'
        ? 'Auth flow implemented, 68 tests pass.'
        : 'Write denied; left auth.ts unchanged. 66 of 68 tests pass.',
    );
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) {
      for (const t of s.timers) clearTimeout(t);
      if (s.pendingApproval) clearTimeout(s.pendingApproval.timer);
    }
  }

  private runTurn(s: MockSession, instruction: string): void {
    s.summary = { ...s.summary, taskSummary: instruction.slice(0, 500) };
    this.setStatus(s, 'working', { activeTurn: true });
    this.event(s, 'started', 'Claude Code session started');
    this.after(s, this.delay / 3, () => this.event(s, 'progress', 'Reading auth module…'));
    if (/write/i.test(instruction)) {
      this.after(s, this.delay, () => this.requestApproval(s));
    } else {
      this.after(s, this.delay, () => this.finish(s, 'Auth flow implemented, 68 tests pass.'));
    }
  }

  private requestApproval(s: MockSession): void {
    const approvalId = newApprovalId();
    const providerRequestId = `toolu_mock${randomUUID().slice(0, 8)}`;
    const timer = setTimeout(() => {
      if (s.pendingApproval?.approvalId !== approvalId) return;
      s.pendingApproval = null;
      this.emit({ kind: 'approval_resolved_locally', approvalId, resolution: 'timed_out' });
      this.finish(s, 'Approval timed out; no files written.');
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
      actionType: 'file_change',
      preview: 'Write src/auth.ts',
      hints: {},
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
