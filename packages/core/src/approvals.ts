import { createHash } from 'node:crypto';
import type { ApprovalOption, EventPayload, Provider } from '@pagr/protocol';
import type { LocalRiskAssessment } from './deviceFloor.js';
import { newApprovalId } from './events.js';

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalResolution = 'allowed' | 'denied' | 'timed_out' | 'canceled';
/**
 * Who ended the approval: the cloud's decision (which is the person answering on their phone),
 * the local timer, the provider itself, the person answering in the terminal, or shutdown.
 *
 * There is deliberately no "the bridge decided" source. A device-floor refusal is not one either:
 * it turns a cloud `allow` into a `deny` on the `cloud` path, because the floor never decides
 * what to ask — it only refuses to carry one particular answer.
 */
export type ApprovalSource = 'cloud' | 'timeout' | 'provider' | 'shutdown' | 'terminal';

/**
 * Sources that mean somebody answered the prompt somewhere Pagr was not looking — in the
 * terminal, or through another client of the same agent. The phone dismisses its card instead of
 * reporting an error, which is why this is a separate word from "the provider resolved it".
 */
export type ExternalApprovalSource = 'terminal' | 'provider';

/** Everything about the ending beyond "allowed or denied". */
export interface ApprovalOutcome {
  /** The exact option the person chose (v2), when the answer came with one. */
  optionId?: string;
  /** True when it was answered somewhere else while the phone was still showing it. */
  answeredElsewhere: boolean;
  /**
   * Set when the device floor refused to carry the answer. The agent is still told `deny`; this
   * is what says the deny was a refusal rather than the person's own choice.
   */
  refusal?: string;
}

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
  /**
   * What this Mac decided the action is, classified locally before the cloud was ever told about
   * it. The device floor judges a cloud `allow` against this, never against anything the cloud
   * echoes back.
   */
  assessment?: LocalRiskAssessment;
  /**
   * What the agent itself offered, in the agent's order. Empty for a v1 adapter that has never
   * heard of options; the cloud then answers with `decision` alone, exactly as before.
   */
  options?: ApprovalOption[];
  /** Invoked exactly once with the final resolution. */
  onResolve: (
    resolution: ApprovalResolution,
    decision: ApprovalDecision | null,
    source: ApprovalSource,
    outcome: ApprovalOutcome,
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
  /** Local classification; `null` only for entries registered before one could be computed. */
  assessment: LocalRiskAssessment | null;
  /** The agent's own options. Empty means "decision only" (v1). */
  options: ApprovalOption[];
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
 *
 * Note what this class cannot do: there is no method by which the bridge answers a pending
 * approval itself. An entry is consumed by `respond` (the person, via the cloud), by the timeout,
 * by the provider resolving it in the terminal, or by shutdown — never by a local judgement.
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
      /**
       * `onResolve` threw on a path with no caller to report to (a local timeout, shutdown).
       * The entry is consumed either way — an approval is never answerable twice.
       */
      onResolveError?: (approvalId: string, err: unknown) => void;
      /**
       * Called after the pending set changes (registered, or consumed by any path). "An approval
       * is waiting" is a reason to keep the Mac awake, and this is the one choke point for it.
       */
      onChange?: () => void;
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
      assessment: input.assessment ?? null,
      options: input.options ?? [],
      createdAt: created.toISOString(),
      expiresAt: new Date(deadline).toISOString(),
    };
    const timer = setTimeout(
      () =>
        void this.finish(approvalId, 'timed_out', null, 'timeout').catch((err) =>
          this.opts.onResolveError?.(approvalId, err),
        ),
      Math.max(0, deadline - created.getTime()),
    );
    timer.unref();
    this.pending.set(approvalId, { record, input, timer });
    this.opts.onChange?.();
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
    /** v2. The option the person chose; the caller has already checked it agrees with `decision`. */
    optionId?: string | undefined;
    /** Set by the device floor when it turned this answer into a deny. */
    refusal?: string | undefined;
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
      {
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.refusal ? { refusal: input.refusal } : {}),
      },
    );
    return { ok: true };
  }

  /** Provider resolved it on its own (turn interrupted, request cancelled…). */
  async resolveLocally(approvalId: string, resolution: ApprovalResolution): Promise<boolean> {
    if (!this.pending.has(approvalId)) return false;
    await this.finish(approvalId, resolution, null, 'provider');
    return true;
  }

  /**
   * Somebody answered it where Pagr could not see the button being pressed: in the terminal the
   * agent is running in, or through another client of the same agent. The bridge only ever
   * *observes* this — the tool ran, or came back refused — so no answer is relayed anywhere and
   * the phone is told `answeredElsewhere` rather than an error.
   *
   * Exposed for the Claude adapter (a `tool_result` arriving for a prompt we never answered) and
   * for the transcript tailer, which sees the same thing for a terminal session.
   */
  async resolveExternally(
    approvalId: string,
    source: ExternalApprovalSource,
    resolution: ApprovalResolution = 'allowed',
  ): Promise<boolean> {
    if (!this.pending.has(approvalId)) return false;
    await this.finish(approvalId, resolution, null, source, { answeredElsewhere: true });
    return true;
  }

  async cancelAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      // One entry whose relay throws must not leave the rest pending at shutdown.
      try {
        await this.finish(id, 'canceled', null, 'shutdown');
      } catch (err) {
        this.opts.onResolveError?.(id, err);
      }
    }
  }

  private async finish(
    approvalId: string,
    resolution: ApprovalResolution,
    decision: ApprovalDecision | null,
    source: ApprovalSource,
    outcome: Partial<ApprovalOutcome> = {},
  ): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);
    this.opts.onChange?.();
    if (source === 'timeout') this.opts.onTimeout?.(entry.record);
    await entry.input.onResolve(resolution, decision, source, {
      answeredElsewhere: false,
      ...outcome,
    });
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
