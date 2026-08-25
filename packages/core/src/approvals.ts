import { createHash } from 'node:crypto';
import type { EventPayload, Provider } from '@pagr/protocol';
import { newApprovalId } from './events.js';

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalResolution = 'allowed' | 'denied' | 'timed_out' | 'canceled';
/** Who ended the approval: the cloud's decision, the local timer, the provider itself, or shutdown. */
export type ApprovalSource = 'cloud' | 'timeout' | 'provider' | 'shutdown';

export interface PendingApprovalInput {
  approvalId?: string;
  sessionId: string;
  projectId: string;
  provider: Provider;
  providerRequestId: string;
  actionType: EventPayload<'approval.requested'>['actionType'];
  preview: string;
  hints?: Partial<EventPayload<'approval.requested'>['hints']>;
  /** Provider-side deadline; the effective deadline is the sooner of this and policy timeout. */
  expiresAt?: string;
  /** Invoked exactly once with the final resolution. */
  onResolve: (
    resolution: ApprovalResolution,
    decision: ApprovalDecision | null,
    source: ApprovalSource,
  ) => Promise<void> | void;
}

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  projectId: string;
  provider: Provider;
  providerRequestId: string;
  actionType: PendingApprovalInput['actionType'];
  preview: string;
  previewHash: string;
  hints: EventPayload<'approval.requested'>['hints'];
  createdAt: string;
  expiresAt: string;
}

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export type ApprovalRespondError =
  | 'unknown'
  | 'session_mismatch'
  | 'request_mismatch'
  | 'preview_mismatch';

/**
 * Single-use registry of pending provider approvals. Each entry is bound to the session,
 * provider request id and a hash of the exact preview the user was shown. Times out
 * locally (→ `timed_out`, provider told `deny`).
 */
export class PendingApprovalRegistry {
  private readonly pending = new Map<
    string,
    { record: PendingApproval; input: PendingApprovalInput; timer: NodeJS.Timeout }
  >();
  constructor(
    private readonly opts: {
      now?: () => Date;
      onTimeout?: (record: PendingApproval) => void;
      idGen?: () => string;
    } = {},
  ) {}

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  register(input: PendingApprovalInput, timeoutMs: number): PendingApproval {
    const approvalId = input.approvalId ?? (this.opts.idGen ?? newApprovalId)();
    const created = this.now();
    let deadline = created.getTime() + timeoutMs;
    if (input.expiresAt) {
      const provider = Date.parse(input.expiresAt);
      if (!Number.isNaN(provider) && provider < deadline) deadline = provider;
    }
    const hints: PendingApproval['hints'] = {
      touchesOutsideProject: false,
      networkAccess: false,
      destructive: false,
      gitPush: false,
      packageInstall: false,
      secretsTouch: false,
      productionHint: false,
      ...stripUndefined(input.hints ?? {}),
    };
    const record: PendingApproval = {
      approvalId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      provider: input.provider,
      providerRequestId: input.providerRequestId,
      actionType: input.actionType,
      preview: input.preview.slice(0, 1500),
      previewHash: sha256Hex(input.preview.slice(0, 1500)),
      hints,
      createdAt: created.toISOString(),
      expiresAt: new Date(deadline).toISOString(),
    };
    const timer = setTimeout(
      () => void this.finish(approvalId, 'timed_out', null, 'timeout'),
      Math.max(0, deadline - created.getTime()),
    );
    timer.unref();
    this.pending.set(approvalId, { record, input, timer });
    return record;
  }

  get(approvalId: string): PendingApproval | null {
    return this.pending.get(approvalId)?.record ?? null;
  }
  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.record);
  }

  /** Cloud decision. Verifies binding, consumes the entry (single-use). */
  async respond(input: {
    approvalId: string;
    sessionId: string;
    providerRequestId: string;
    previewHash: string;
    decision: ApprovalDecision;
  }): Promise<{ ok: true } | { ok: false; error: ApprovalRespondError }> {
    const entry = this.pending.get(input.approvalId);
    if (!entry) return { ok: false, error: 'unknown' };
    const r = entry.record;
    if (r.sessionId !== input.sessionId) return { ok: false, error: 'session_mismatch' };
    if (r.providerRequestId !== input.providerRequestId)
      return { ok: false, error: 'request_mismatch' };
    if (r.previewHash !== input.previewHash) return { ok: false, error: 'preview_mismatch' };
    await this.finish(
      input.approvalId,
      input.decision === 'allow' ? 'allowed' : 'denied',
      input.decision,
      'cloud',
    );
    return { ok: true };
  }

  /** Provider resolved it on its own (user answered in the terminal, turn interrupted…). */
  async resolveLocally(approvalId: string, resolution: ApprovalResolution): Promise<boolean> {
    if (!this.pending.has(approvalId)) return false;
    await this.finish(approvalId, resolution, null, 'provider');
    return true;
  }

  async cancelAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.finish(id, 'canceled', null, 'shutdown');
  }

  private async finish(
    approvalId: string,
    resolution: ApprovalResolution,
    decision: ApprovalDecision | null,
    source: ApprovalSource,
  ): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);
    if (source === 'timeout') this.opts.onTimeout?.(entry.record);
    await entry.input.onResolve(resolution, decision, source);
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
