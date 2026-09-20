import { createHash, randomBytes } from 'node:crypto';
import type {
  InstructionDelivery,
  OneShotKind,
  Provider,
  SessionStatus,
  SessionSummaryV2,
} from '@pagr/protocol';
import type { JournalMeta } from '../journal.js';

/**
 * One bounded, headless agent run — the handoff writer and the cross-agent reviewer.
 *
 * It exists because two jobs in the handoff design (spec §3 and §5) need an agent to produce ONE
 * file from ONE prompt without a person having asked for a conversation:
 *
 *   - the receiver writes the handoff note from the sender's transcript, when the sender cannot
 *     be reached (`controlLevel !== 'full'`, or it already ended);
 *   - the reviewer reads a packet and writes a verdict.
 *
 * Otherwise a run is an ordinary agent run: the same binary, in the same repository, under the
 * same subscription, with the user's own settings loaded. It is not confined to a corner of the
 * tree, and there would be no point pretending otherwise — starting a full agent session in
 * someone's repository is the product, and one of these is strictly less than that.
 *
 * ## It is a session (HND-019)
 *
 * This file used to say the opposite. A run was registered nowhere: `listSessions` never returned
 * it, `getStatus` had never heard of it, and no `session` event was emitted for it. The reasoning
 * was "this is not a conversation you steer", and the implementation of that reasoning quietly
 * took away two other things nobody had argued against — **seeing** it and **stopping** it. A
 * reviewer that hung left a person waiting out a ten-minute timeout with nothing to look at and
 * nothing to press.
 *
 * Worse, the premise itself was wrong. There is no reason a person watching a review happen
 * cannot say "focus on the auth path" to it. Both agents accept more input mid-run, by the same
 * two mechanisms every Pagr session already uses:
 *
 *   - **Codex** — `turn/steer` against the live turn: `delivered: 'steered'`.
 *   - **Claude** — no live steering (ADR 0001); the text is queued and sent as the next turn the
 *     moment the current one ends, on the same process: `delivered: 'queued'`.
 *
 * So a run is now an ordinary session that Pagr started with a job in mind. It is listed, it has
 * a status, it emits `started` / `completed` / `failed` / `stopped`, it can be steered and it can
 * be stopped. Its `controlLevel` is `full` and its `origin` is `pagr`, because both are true. The
 * one thing that marks it out is {@link SessionSummaryV2.oneShot}, which says what job it is
 * doing so a phone can render "Claude is writing the handoff" rather than "a session".
 *
 * Three rules survive from the original design, and they are still the contract:
 *
 *   1. **Its own process, every time.** A run never borrows a live session — borrowing would
 *      inject a prompt into a conversation the person owns, and its output would land in their
 *      transcript as if they had asked for it.
 *   2. **No prompt ever reaches the phone, and no prompt is auto-approved.** There is no approval
 *      UI attached to a run, so an approval request is answered here: `deny`. Something has to
 *      answer it — a prompt nobody answers is a hang, and a hang inside a handoff is a switch
 *      that never happens — and `allow` is not available to us. Part of a run's prompt is text
 *      the cloud supplied (a review's one line of intent), so a run that granted its own
 *      approvals would hand a compromised cloud the tool call `deviceFloor.ts` exists to refuse.
 *      Writing files is arranged so it never raises a prompt in the first place
 *      (`adapter-claude`'s `acceptEdits`, Codex's `workspace-write`); what is left to deny is the
 *      network, a shell and anything outside the workspace, which is the same ceiling a session
 *      has. Steering does not change this: a steered run denies exactly what an unsteered one
 *      denies.
 *   3. **The timeout is an outcome, not an exception.** `timeoutMs` kills the process and the
 *      call resolves `{ outcome: 'timeout' }`, because every caller has something to say to the
 *      person about it ("Claude didn't finish the handoff in 90 s…") and nothing to say about a
 *      stack trace. `canceled` is the same shape, and it is what a person pressing stop produces.
 *
 * Frames a run produces are mirrored under the id below and carry the nesting marker, unchanged.
 */

// ---------- ids ----------

/** `run_` + 32 hex. Local to this Mac: it names a run, never anything the cloud stores. */
export function newRunId(): string {
  return `run_${randomBytes(16).toString('hex')}`;
}

/**
 * The `ses_…` id a run is listed and mirrored under.
 *
 * Derived from the run id so the same run always produces the same id (a retry that reuses the
 * run id groups with its first attempt), and minted the same way `syntheticSessionId` mints one
 * for a session the bridge did not spawn.
 *
 * It IS registered now: an adapter that has a live run lists it from `listSessions`, answers
 * `getStatus` for it, takes `sendInstruction` for it and stops it on `stopSession`. That is the
 * whole of HND-019 on this side.
 */
export function runOnceSessionId(provider: Provider, runId: string): string {
  const seed = `runOnce:${provider}:${runId}`;
  return `ses_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// ---------- the marker ----------

/**
 * Depth of a one-shot run in `meta.subagent`.
 *
 * The marker rides `FrameMeta.subagent` rather than a new field or a new `source` value, and
 * that is a deliberate choice worth writing down. `source` answers "where did the bridge READ
 * this" — stdio, the transcript, the app server, a backfill — and a run's frames really do come
 * off stdio and the app server, so overloading it would make the one honest field dishonest.
 * `subagent` already means "this frame came from an agent run nested inside the work, not from
 * the conversation the person is having", which is exactly what a run is. Depth 0 says the
 * nesting is the bridge's own, not a `Task` tool three levels down.
 *
 * HND-010b asked whether this overload should become a first-class `meta.oneShot`. The answer is
 * no, and HND-019 is why: the frame marker is about nesting, and "this session is a one-shot" is
 * now said once, on the session row, by {@link SessionSummaryV2.oneShot} — which carries this
 * same `runId`, so a client joins the frames to the row without a second marker on every frame.
 *
 * A phone that has never heard of handoffs renders it as a subagent, which is not wrong.
 */
export const RUN_ONCE_SUBAGENT_DEPTH = 0;

/** Frame metadata for a frame a `runOnce` produced. `source` stays what it has always been. */
export function runOnceFrameMeta(runId: string, source: JournalMeta['source']): JournalMeta {
  return { source, subagent: { id: runId, depth: RUN_ONCE_SUBAGENT_DEPTH } };
}

/** True for a frame a `runOnce` produced. The phone's "is this a handoff being written?" test. */
export function isRunOnceFrame(meta: JournalMeta): boolean {
  return (
    meta.subagent?.depth === RUN_ONCE_SUBAGENT_DEPTH && meta.subagent.id.startsWith('run_') === true
  );
}

/**
 * What the row says it is doing, in the words a person would use.
 *
 * Short because it is a session's `displayName` — it sits in a list beside "Fix the refund path",
 * and "Headless one-shot run (handoff)" is a sentence about our implementation, not about their
 * work.
 */
export function runOnceDisplayName(kind: OneShotKind): string {
  return kind === 'handoff' ? 'Writing the handoff' : 'Reviewing the diff';
}

// ---------- the call ----------

export interface RunOnceInput {
  /** The repository the run is about, and the run's working directory. Always a real directory. */
  cwd: string;
  /** The whole instruction. One turn to begin with; a steer can add more. */
  prompt: string;
  /** What this run is for. Decides the row's name and rides the session summary to the phone. */
  kind: OneShotKind;
  /** Kill the run after this long and resolve `timeout`. */
  timeoutMs: number;
  /** Cancels the run from outside (a switch that failed elsewhere, a shutting-down daemon). */
  signal?: AbortSignal | undefined;
  /** Reuse an id across a retry so both attempts group under one `ses_…`. Minted if absent. */
  runId?: string | undefined;
  /**
   * Which project the run belongs to.
   *
   * Frames are dropped when it is absent, exactly as a mirrored thread in an unregistered
   * directory is: a frame the cloud cannot route is a frame that stays here. The same is true of
   * the session row — a `SessionSummary` names a `proj_…` — so a run without one is not listed
   * to the cloud either. The run itself still happens.
   */
  projectId?: string | undefined;
}

/**
 * How a run ended.
 *
 * - `completed` — the agent finished its turn and said so. It says nothing about whether the
 *   file the caller wanted exists: the caller looks, because "the agent finished" and "the agent
 *   did the job" are different facts and only the caller knows what the job was.
 * - `timeout` — `timeoutMs` elapsed and the run was killed.
 * - `canceled` — someone stopped it: `agent.stop_session`, `pagr`, or a shutting-down daemon.
 * - `failed` — the agent errored, exited non-zero, or could not be started. `error` says which.
 */
export type RunOnceOutcome = 'completed' | 'timeout' | 'canceled' | 'failed';

/** The session status a finished run's row settles on. Terminal, and honest about which. */
export function runOnceFinalStatus(outcome: RunOnceOutcome): SessionStatus {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'canceled') return 'stopped';
  return 'failed';
}

export type RunOnceErrorCode =
  /** The agent could not be started at all (no binary, no app-server, adapter shut down). */
  | 'start_failed'
  /** The agent ran and reported a failure of its own (Claude `is_error`, Codex turn `failed`). */
  | 'agent_error'
  /** The process died before it finished the turn, or exited non-zero. */
  | 'exited'
  /** The agent answered in a shape this adapter cannot read. */
  | 'protocol_error';

export interface RunOnceError {
  code: RunOnceErrorCode;
  /** One line, safe to put in a text message. Never a stack. */
  message: string;
}

export interface RunOnceResult {
  runId: string;
  /** The id it was listed and its frames were mirrored under. */
  sessionId: string;
  outcome: RunOnceOutcome;
  /**
   * Everything the agent said, in order, joined by blank lines.
   *
   * The agent's words only — its assistant messages and its final result line. Not its tool
   * output, not its reasoning. Callers quote it back to the person when a run fails, so it is
   * the text a person can read.
   */
  output: string;
  /** Set when, and only when, `outcome` is `failed`. */
  error?: RunOnceError;
  /** The child's exit code, when there was a child and it exited. */
  exitCode?: number | null;
  durationMs: number;
}

// ---------- the registry ----------

/**
 * One live run, as the adapter that owns it can act on it.
 *
 * The two verbs are exactly the two an ordinary session has: say something to it, stop it. There
 * is no third — a run is not resumable, because the whole point of it is that it produces one
 * artefact and the caller is holding the promise.
 */
export interface LiveOneShot {
  runId: string;
  sessionId: string;
  provider: Provider;
  kind: OneShotKind;
  /** Absent when the run's directory is in no registered project. Such a run is not reported. */
  projectId: string | undefined;
  startedAt: string;
  updatedAt: string;
  status: SessionStatus;
  activeTurn: boolean;
  /** The last thing a person said to it, clipped. Absent until somebody steers it. */
  taskSummary?: string | undefined;
  /** Deliver an instruction. Reports how it actually landed, like every other session. */
  send(instruction: string, images: string[]): Promise<{ delivered: InstructionDelivery }>;
  /** Stop it. Resolves once the kill has been asked for; the run settles `canceled`. */
  stop(): Promise<void>;
}

/**
 * Every run an adapter currently has in flight, by the `ses_…` it is listed under.
 *
 * It lives here rather than in each adapter so the two adapters cannot drift on what a run's row
 * looks like — the summary an iPhone renders must not depend on which agent happens to be
 * writing the handoff.
 */
export class OneShotRegistry {
  private readonly bySession = new Map<string, LiveOneShot>();

  add(run: LiveOneShot): void {
    this.bySession.set(run.sessionId, run);
  }
  get(sessionId: string): LiveOneShot | null {
    return this.bySession.get(sessionId) ?? null;
  }
  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }
  remove(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
  list(): LiveOneShot[] {
    return [...this.bySession.values()];
  }
  /** Stop every live run. The daemon's shutdown, and an adapter's. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((r) => r.stop()));
  }
  /** The rows the cloud may be told about: a run in no registered project cannot be named. */
  summaries(): SessionSummaryV2[] {
    const out: SessionSummaryV2[] = [];
    for (const run of this.bySession.values()) {
      const s = oneShotSummary(run);
      if (s) out.push(s);
    }
    return out;
  }
}

/**
 * A run's session row.
 *
 * `controlLevel: 'full'` and `origin: 'pagr'` are not a convenience — they are the two facts.
 * Pagr started this process, holds it, can talk to it and can kill it, which is the definition of
 * `full`; and a run is not somebody's terminal, which is the definition of `pagr`. Answering
 * `mirror_only` would have been the tempting shorthand for "you cannot have a conversation with
 * it", and it would have been a lie in the one direction that matters: `mirror_only` is what a
 * Codex TUI thread is, and the reason THAT cannot be stopped is that its process belongs to a
 * terminal. This one's belongs to us.
 *
 * Null when the run has no registered project: a `SessionSummary` has to name a `proj_…`, and a
 * row the cloud cannot address is a row that stays on this Mac (the same rule frames follow).
 */
export function oneShotSummary(run: LiveOneShot): SessionSummaryV2 | null {
  if (!run.projectId) return null;
  return {
    sessionId: run.sessionId,
    projectId: run.projectId,
    provider: run.provider,
    status: run.status,
    displayName: runOnceDisplayName(run.kind),
    activeTurn: run.activeTurn,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    controlLevel: 'full',
    origin: 'pagr',
    projectStatus: 'registered',
    oneShot: { kind: run.kind, runId: run.runId },
    ...(run.taskSummary ? { taskSummary: run.taskSummary } : {}),
  };
}
