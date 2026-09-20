import type {
  AgentConnectionStatus,
  InstructionDelivery,
  OneShotKind,
  Provider,
  SessionSummary,
} from '@pagr/protocol';
import type { LiveOneShot, RunOnceInput, RunOnceOutcome } from './runOnce.js';
import {
  OneShotRegistry,
  oneShotSummary,
  runOnceFinalStatus,
  runOnceSessionId,
} from './runOnce.js';
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
  /**
   * Headless runs this fake has in flight, exactly as a real adapter keeps them (HND-019).
   *
   * A test registers one with {@link trackOneShot} from inside whatever `runOnce` it injected,
   * and from then on the run is listed, answered by `getStatus`, steerable and stoppable through
   * the ordinary session methods — which is the behaviour under test.
   */
  readonly oneShotRuns = new OneShotRegistry();
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
  oneShots(): LiveOneShot[] {
    return this.oneShotRuns.list();
  }

  /**
   * Register a headless run, the way `runClaudeOnce` and the Codex adapter do.
   *
   * Returns the handle the test drives it with: `finish` settles it the way the agent would, and
   * `stopped` says whether somebody stopped it first.
   */
  trackOneShot(
    input: Pick<RunOnceInput, 'kind' | 'cwd' | 'projectId'> & { runId: string },
    o: {
      onStop: () => void;
      /** What a steer reports. Defaults to `steered`, which is what Codex does. */
      delivery?: InstructionDelivery;
    },
  ): { sessionId: string; finish: (outcome: RunOnceOutcome) => void } {
    const sessionId = runOnceSessionId(this.provider, input.runId);
    const at = this.now().toISOString();
    const row: LiveOneShot = {
      runId: input.runId,
      sessionId,
      provider: this.provider,
      kind: input.kind as OneShotKind,
      projectId: input.projectId,
      startedAt: at,
      updatedAt: at,
      status: 'working',
      activeTurn: true,
      send: async (instruction) => {
        this.record('oneShotSend', { sessionId, instruction });
        row.taskSummary = instruction;
        this.publishOneShot(row);
        return { delivered: o.delivery ?? 'steered' };
      },
      stop: async () => {
        this.record('oneShotStop', sessionId);
        o.onStop();
      },
    };
    this.oneShotRuns.add(row);
    this.publishOneShot(row);
    if (input.projectId)
      this.push({
        kind: 'session_event',
        sessionId,
        projectId: input.projectId,
        type: 'started',
        summary: `working on the ${row.kind}`,
      });
    return {
      sessionId,
      finish: (outcome) => {
        this.oneShotRuns.remove(sessionId);
        row.status = runOnceFinalStatus(outcome);
        row.activeTurn = false;
        row.updatedAt = this.now().toISOString();
        this.publishOneShot(row);
        if (input.projectId)
          this.push({
            kind: 'session_event',
            sessionId,
            projectId: input.projectId,
            type:
              outcome === 'completed' ? 'completed' : outcome === 'canceled' ? 'stopped' : 'failed',
            summary: `run ${outcome}`,
          });
      },
    };
  }

  private publishOneShot(row: LiveOneShot): void {
    const summary = oneShotSummary(row);
    if (summary) this.push({ kind: 'session', session: summary });
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.record('listSessions', undefined);
    const out = new Map<string, SessionSummary>([...this.sessions]);
    for (const s of this.oneShotRuns.summaries()) out.set(s.sessionId, s);
    return [...out.values()];
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
    const run = this.oneShotRuns.get(input.sessionId);
    if (run) return run.send(input.instruction, input.localImagePaths);
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
    const run = this.oneShotRuns.get(sessionId);
    if (run) {
      await run.stop();
      return;
    }
    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, status: 'stopped', activeTurn: false });
  }
  async getStatus(sessionId: string): Promise<SessionSummary | null> {
    this.record('getStatus', sessionId);
    const run = this.oneShotRuns.get(sessionId);
    if (run) return oneShotSummary(run);
    return this.sessions.get(sessionId) ?? null;
  }
  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
  }): Promise<void> {
    this.record('respondToApproval', input);
  }
  async answerQuestion(input: {
    providerRequestId: string;
    answers: Array<{ questionIndex: number; optionIndexes: number[]; freeText?: string }>;
  }): Promise<void> {
    this.record('answerQuestion', input);
  }
  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => this.listeners.delete(emit);
  }
  async shutdown(): Promise<void> {
    this.record('shutdown', undefined);
  }
}
