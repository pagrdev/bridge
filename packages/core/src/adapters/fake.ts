import type { AgentConnectionStatus, Provider, SessionSummary } from '@pagr/protocol';
import type {
  AdapterEvent,
  CodingAgentAdapter,
  SendInstructionInput,
  StartSessionInput,
} from './types.js';

/**
 * In-memory adapter for tests and `PAGR_MOCK_AGENTS=1` E2E. Records every call and lets a
 * test drive events with `push()`.
 */
export class FakeAdapter implements CodingAgentAdapter {
  readonly calls: Array<{ method: string; args: unknown }> = [];
  readonly sessions = new Map<string, SessionSummary>();
  private listeners = new Set<(e: AdapterEvent) => void>();
  canSteer = true;
  failNext: Error | null = null;
  now: () => Date = () => new Date();

  constructor(readonly provider: Provider = 'codex') {}

  private record(method: string, args: unknown) {
    this.calls.push({ method, args });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  push(e: AdapterEvent): void {
    for (const l of this.listeners) l(e);
  }

  async probe(): Promise<AgentConnectionStatus> {
    this.record('probe', undefined);
    return {
      provider: this.provider,
      mode: this.provider === 'codex' ? 'app-server' : 'cli-hooks',
      installed: true,
      providerVersion: '0.0.0-fake',
      authStatus: 'authenticated',
      capabilities: {
        canStartSession: true,
        canResumeSession: true,
        canSteerActiveTurn: this.canSteer,
        canReceiveLiveExternalMessages: this.canSteer,
        canRelayApprovals: true,
        canStop: true,
        canAttachImages: true,
        canListSessions: true,
      },
    };
  }
  async listSessions(): Promise<SessionSummary[]> {
    this.record('listSessions', undefined);
    return [...this.sessions.values()];
  }
  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    this.record('startSession', input);
    const at = this.now().toISOString();
    const s: SessionSummary = {
      sessionId: input.sessionId,
      projectId: input.project.projectId,
      provider: this.provider,
      status: 'working',
      activeTurn: true,
      startedAt: at,
      updatedAt: at,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    };
    this.sessions.set(s.sessionId, s);
    return s;
  }
  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    this.record('sendInstruction', input);
    const s = this.sessions.get(input.sessionId);
    if (input.mode === 'steer') return { delivered: 'steered' };
    if (s && !s.activeTurn) {
      this.sessions.set(input.sessionId, { ...s, status: 'working', activeTurn: true });
      return { delivered: 'new_turn' };
    }
    return { delivered: 'queued' };
  }
  async stopSession(sessionId: string): Promise<void> {
    this.record('stopSession', sessionId);
    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, status: 'stopped', activeTurn: false });
  }
  async getStatus(sessionId: string): Promise<SessionSummary | null> {
    this.record('getStatus', sessionId);
    return this.sessions.get(sessionId) ?? null;
  }
  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
  }): Promise<void> {
    this.record('respondToApproval', input);
  }
  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => this.listeners.delete(emit);
  }
  async shutdown(): Promise<void> {
    this.record('shutdown', undefined);
  }
}
