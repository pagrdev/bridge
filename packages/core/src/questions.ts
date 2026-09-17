import type { Provider } from '@pagr/protocol';
import { newQuestionId } from './events.js';
import type { FrameQuestion } from './frames.js';

/**
 * A question the agent asked, held open until somebody answers it.
 *
 * This is `approvals.ts` for the other half of "the agent needs a person": an approval asks
 * whether one action may run, a question asks the person to *choose* — and the answer is fed back
 * to the model as the user's own words. That difference is the whole reason this is a separate
 * registry rather than an approval with extra fields: an approval that is merely allowed is a
 * correct answer, whereas a question that is merely allowed is Claude being told
 * "The user did not answer the questions." and ending the turn (spike MOB-044, run 2).
 */

export const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * Longest free-text answer relayed to the agent. `updatedInput` is trusted verbatim by Claude —
 * whatever is in it is fed to the model as what the user said — so the one thing the phone can
 * put there in its own words is length-capped here, at the boundary, not by the caller.
 */
export const MAX_QUESTION_FREE_TEXT = 2000;

/** How a pending question ended. */
export type QuestionResolution = 'answered' | 'timed_out' | 'canceled';

/**
 * Who ended it. Mirrors `ApprovalSource` and means the same things: the person on their phone
 * (`cloud`), the local timer, the provider withdrawing the request, the person answering in the
 * terminal, or shutdown.
 */
export type QuestionSource = 'cloud' | 'timeout' | 'provider' | 'shutdown' | 'terminal';

/** Sources that mean it was answered somewhere Pagr was not looking. */
export type ExternalQuestionSource = 'terminal' | 'provider';

/** One question's answer, by index. Labels never round-trip: the options came from the agent. */
export interface QuestionAnswer {
  questionIndex: number;
  optionIndexes: number[];
  freeText?: string;
}

export interface QuestionOutcome {
  /** True when the Mac (or another client of the same agent) answered it first. */
  answeredElsewhere: boolean;
  /** Short machine reason for the ending, for `question.answered`. */
  reason?: string;
}

export interface PendingQuestionInput {
  questionId?: string;
  sessionId: string;
  projectId: string;
  provider: Provider;
  providerRequestId: string;
  /** The questions as the phone will see them, already normalised by `questionBodyFor`. */
  questions: FrameQuestion[];
  /** False when only the Mac can answer it (a terminal dialog, a mirrored thread). */
  answerable: boolean;
  /** Why not, when `answerable` is false. */
  reason?: string;
  /** Per question: the answer must never be echoed back or stored in the clear. */
  secret?: boolean[];
  /** Provider-side deadline; the effective deadline is the sooner of this and the policy timeout. */
  expiresAt?: string;
  /** Invoked exactly once with the final resolution. `answers` is null on every non-answer. */
  onResolve: (
    resolution: QuestionResolution,
    answers: QuestionAnswer[] | null,
    source: QuestionSource,
    outcome: QuestionOutcome,
  ) => Promise<void> | void;
}

export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  projectId: string;
  provider: Provider;
  providerRequestId: string;
  questions: FrameQuestion[];
  answerable: boolean;
  reason?: string;
  secret: boolean[];
  /** Per question, derived from `questions` so the event and the validator cannot disagree. */
  multiSelect: boolean[];
  optionCount: number[];
  createdAt: string;
  expiresAt: string;
}

export type QuestionAnswerError =
  | 'unknown'
  | 'session_mismatch'
  | 'request_mismatch'
  | 'not_answerable'
  | 'invalid_answer';

/**
 * Single-use registry of questions waiting for a person. Same discipline as
 * `PendingApprovalRegistry`: bound to the session and the provider's request id, consumed by
 * exactly one path, and never answered by the bridge's own judgement.
 */
export class PendingQuestionRegistry {
  private readonly pending = new Map<
    string,
    { record: PendingQuestion; input: PendingQuestionInput; timer: NodeJS.Timeout }
  >();
  constructor(
    private readonly opts: {
      now?: () => Date;
      onTimeout?: (record: PendingQuestion) => void;
      idGen?: () => string;
      onResolveError?: (questionId: string, err: unknown) => void;
      /** Called after the pending set changes; the daemon holds keep-awake on it. */
      onChange?: () => void;
    } = {},
  ) {}

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  register(input: PendingQuestionInput, timeoutMs: number): PendingQuestion {
    const questionId = input.questionId ?? (this.opts.idGen ?? newQuestionId)();
    const created = this.now();
    let deadline = created.getTime() + timeoutMs;
    if (input.expiresAt) {
      const provider = Date.parse(input.expiresAt);
      if (!Number.isNaN(provider) && provider < deadline) deadline = provider;
    }
    const record: PendingQuestion = {
      questionId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      provider: input.provider,
      providerRequestId: input.providerRequestId,
      questions: input.questions,
      answerable: input.answerable,
      ...(input.reason ? { reason: input.reason } : {}),
      secret: input.questions.map((_, i) => input.secret?.[i] === true),
      multiSelect: input.questions.map((q) => q.multiSelect === true),
      optionCount: input.questions.map((q) => q.options.length),
      createdAt: created.toISOString(),
      expiresAt: new Date(deadline).toISOString(),
    };
    const timer = setTimeout(
      () =>
        void this.finish(questionId, 'timed_out', null, 'timeout', { reason: 'timed_out' }).catch(
          (err) => this.opts.onResolveError?.(questionId, err),
        ),
      Math.max(0, deadline - created.getTime()),
    );
    timer.unref();
    this.pending.set(questionId, { record, input, timer });
    this.opts.onChange?.();
    return record;
  }

  get(questionId: string): PendingQuestion | null {
    return this.pending.get(questionId)?.record ?? null;
  }

  list(): PendingQuestion[] {
    return [...this.pending.values()].map((p) => p.record);
  }

  /** The entry an adapter's own id names, so an adapter need not carry the `qst_` id around. */
  findByRequest(sessionId: string, providerRequestId: string): PendingQuestion | null {
    for (const { record } of this.pending.values())
      if (record.sessionId === sessionId && record.providerRequestId === providerRequestId)
        return record;
    return null;
  }

  /**
   * The person's answer, from the cloud. Verifies the binding and every index against the
   * questions this Mac retained — the phone sends positions, never text, so an answer that does
   * not fit the prompt it claims to answer is refused rather than trimmed into something the
   * model would read as the user's words.
   */
  async answer(input: {
    questionId: string;
    sessionId: string;
    providerRequestId: string;
    answers: QuestionAnswer[];
  }): Promise<{ ok: true } | { ok: false; error: QuestionAnswerError; message?: string }> {
    const entry = this.pending.get(input.questionId);
    if (!entry) return { ok: false, error: 'unknown' };
    const r = entry.record;
    if (r.sessionId !== input.sessionId) return { ok: false, error: 'session_mismatch' };
    if (r.providerRequestId !== input.providerRequestId)
      return { ok: false, error: 'request_mismatch' };
    if (!r.answerable)
      return {
        ok: false,
        error: 'not_answerable',
        ...(r.reason
          ? { message: `this question can only be answered on the Mac (${r.reason})` }
          : {}),
      };
    const bad = validateAnswers(r, input.answers);
    if (bad) return { ok: false, error: 'invalid_answer', message: bad };
    await this.finish(input.questionId, 'answered', input.answers, 'cloud');
    return { ok: true };
  }

  /** The provider withdrew the request (cancelled turn, process gone). */
  async resolveLocally(
    questionId: string,
    resolution: QuestionResolution = 'canceled',
    reason?: string,
  ): Promise<boolean> {
    if (!this.pending.has(questionId)) return false;
    await this.finish(questionId, resolution, null, 'provider', reason ? { reason } : {});
    return true;
  }

  /**
   * Somebody answered it where Pagr could not see it: in the terminal the agent runs in, or
   * through another client of the same agent. Nothing is relayed anywhere — the bridge only
   * observed the answer — and the phone dismisses its sheet instead of showing an error.
   */
  async resolveExternally(
    questionId: string,
    source: ExternalQuestionSource,
    resolution: QuestionResolution = 'answered',
  ): Promise<boolean> {
    if (!this.pending.has(questionId)) return false;
    await this.finish(questionId, resolution, null, source, {
      answeredElsewhere: true,
      reason: 'answered_elsewhere',
    });
    return true;
  }

  async cancelAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      try {
        await this.finish(id, 'canceled', null, 'shutdown', { reason: 'shutdown' });
      } catch (err) {
        this.opts.onResolveError?.(id, err);
      }
    }
  }

  private async finish(
    questionId: string,
    resolution: QuestionResolution,
    answers: QuestionAnswer[] | null,
    source: QuestionSource,
    outcome: Partial<QuestionOutcome> = {},
  ): Promise<void> {
    const entry = this.pending.get(questionId);
    if (!entry) return;
    this.pending.delete(questionId);
    clearTimeout(entry.timer);
    this.opts.onChange?.();
    if (source === 'timeout') this.opts.onTimeout?.(entry.record);
    await entry.input.onResolve(resolution, answers, source, {
      answeredElsewhere: false,
      ...outcome,
    });
  }
}

/** Why an answer does not fit the prompt it claims to answer, or null when it does. */
function validateAnswers(record: PendingQuestion, answers: QuestionAnswer[]): string | null {
  if (answers.length === 0) return 'no answers';
  const seen = new Set<number>();
  for (const a of answers) {
    const q = record.questions[a.questionIndex];
    if (!q) return `questionIndex ${a.questionIndex} is out of range`;
    if (seen.has(a.questionIndex)) return `questionIndex ${a.questionIndex} answered twice`;
    seen.add(a.questionIndex);
    for (const i of a.optionIndexes)
      if (i < 0 || i >= q.options.length)
        return `optionIndex ${i} is out of range for question ${a.questionIndex}`;
    if (new Set(a.optionIndexes).size !== a.optionIndexes.length)
      return `question ${a.questionIndex} chose the same option twice`;
    if (!q.multiSelect && a.optionIndexes.length > 1)
      return `question ${a.questionIndex} is single-select`;
    if (a.freeText !== undefined && a.freeText.length > MAX_QUESTION_FREE_TEXT)
      return `free text for question ${a.questionIndex} is longer than ${MAX_QUESTION_FREE_TEXT} characters`;
    if (a.optionIndexes.length === 0 && !a.freeText?.trim())
      return `question ${a.questionIndex} has no answer`;
  }
  return null;
}

// ---------- the frame body ----------

/**
 * The sealed `question` frame body, from whatever the provider handed us.
 *
 * One function for both agents because both describe a question the same way and the phone reads
 * exactly one shape: Claude's `AskUserQuestion` input is
 * `questions[{question, header, multiSelect, options[{label, description?, preview?}]}]`, and
 * Codex's `item/tool/requestUserInput` is the same list with per-question ids and no multi-select.
 * `preview` is kept when an option carries one — it is what the model offered to show the person,
 * and dropping it would make the phone's sheet poorer than the terminal's.
 *
 * Nothing here trusts its input: it is parsed off a provider's wire, and an entry that is not a
 * question is dropped rather than turned into an unanswerable prompt.
 */
export function questionBodyFor(input: unknown): { kind: 'question'; questions: FrameQuestion[] } {
  const raw = (input as { questions?: unknown } | null | undefined)?.questions;
  const list = Array.isArray(raw) ? raw : [];
  const questions: FrameQuestion[] = [];
  for (const entry of list.slice(0, 50)) {
    if (!entry || typeof entry !== 'object') continue;
    const q = entry as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: FrameQuestion['options'] = [];
    for (const o of rawOptions.slice(0, 200)) {
      if (!o || typeof o !== 'object') continue;
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== 'string' || !opt.label) continue;
      options.push({
        label: opt.label,
        ...(typeof opt.description === 'string' && opt.description
          ? { description: opt.description }
          : {}),
        ...(typeof opt.preview === 'string' && opt.preview ? { preview: opt.preview } : {}),
      });
    }
    questions.push({
      question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return { kind: 'question', questions };
}

// ---------- Claude's answer encoding ----------

/**
 * The `updatedInput` that answers a Claude `AskUserQuestion`, per spike MOB-044.
 *
 * Verified against Claude Code 2.1.220 (runs 3-5 of the spike):
 *  - `questions` must be the request's own array, passed back unchanged.
 *  - `answers` is keyed by the FULL `question` string. Keyed by `header` it fails silently —
 *    the CLI echoes the answers back and still reports "The user did not answer the questions."
 *  - the value is the chosen option's `label`.
 *  - free text goes in `response`, and Claude reports it as "The user responded: …".
 *
 * Multi-select is the one part the spike could not exercise: the Agent SDK docs say an array of
 * labels or a `", "`-joined string, and this joins them. The test that covers it is marked
 * spec-derived for exactly that reason.
 *
 * Indexes in, labels out: the phone sends positions and this resolves them against the retained
 * request, so nothing the cloud sends can put words in the user's mouth.
 */
export function askUserQuestionUpdatedInput(
  originalInput: unknown,
  questions: FrameQuestion[],
  answers: QuestionAnswer[],
): Record<string, unknown> {
  const raw = (originalInput as { questions?: unknown } | null | undefined)?.questions;
  const chosen: Record<string, string> = {};
  const responses: string[] = [];
  for (const a of answers) {
    const q = questions[a.questionIndex];
    if (!q) continue;
    const labels = a.optionIndexes
      .map((i) => q.options[i]?.label)
      .filter((l): l is string => typeof l === 'string' && l.length > 0);
    if (labels.length > 0) chosen[q.question] = labels.join(', ');
    const free = a.freeText?.slice(0, MAX_QUESTION_FREE_TEXT).trim();
    if (free) responses.push(free);
  }
  return {
    questions: Array.isArray(raw) ? raw : [],
    answers: chosen,
    ...(responses.length > 0 ? { response: responses.join('\n') } : {}),
  };
}
