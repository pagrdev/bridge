import { createHash, randomBytes } from 'node:crypto';
import type { Provider } from '@pagr/protocol';
import type { JournalMeta } from '../journal.js';

/**
 * One bounded, headless agent run — the handoff writer and the cross-agent reviewer.
 *
 * Not a session. A session is something a person talks to: it is listed by `listSessions`, it
 * can be steered, stopped and resumed, and its permission prompts reach a phone. A `runOnce` is
 * the opposite of all four. It exists because two jobs in the handoff design (spec §3 and §5)
 * need an agent to produce ONE file from ONE prompt with nobody watching:
 *
 *   - the receiver writes the handoff note from the sender's transcript, when the sender cannot
 *     be reached (`controlLevel !== 'full'`, or it already ended);
 *   - the reviewer reads a packet and writes a verdict.
 *
 * Otherwise a run is an ordinary agent run: the same binary, in the same repository, under the
 * same subscription, with the user's own settings loaded. It is not confined to a corner of the
 * tree, and there would be no point pretending otherwise — starting a full agent session in
 * someone's repository is the product, and one of these is strictly less than that. The prompt
 * says what to write and where, exactly as it does for any other run.
 *
 * Three rules follow from "nobody is watching", and they are the whole contract:
 *
 *   1. **Its own process, every time.** A run never borrows a live session — borrowing would
 *      inject a prompt into a conversation the person owns, and its output would land in their
 *      transcript as if they had asked for it.
 *   2. **No prompt ever reaches the phone, and no prompt is auto-approved.** There is no human
 *      attached, so an approval request is answered here: `deny`. Something has to answer it —
 *      a prompt nobody answers is a hang, and a hang inside a handoff is a switch that never
 *      happens — and `allow` is not available to us. Part of a run's prompt is text the cloud
 *      supplied (a review's one line of intent), so a run that granted its own approvals would
 *      hand a compromised cloud the tool call `deviceFloor.ts` exists to refuse. Writing files
 *      is arranged so it never raises a prompt in the first place (`adapter-claude`'s
 *      `acceptEdits`, Codex's `workspace-write`); what is left to deny is the network, a shell
 *      and anything outside the workspace, which is the same ceiling a session has.
 *   3. **The timeout is an outcome, not an exception.** `timeoutMs` kills the process and the
 *      call resolves `{ outcome: 'timeout' }`, because every caller has something to say to the
 *      person about it ("Claude didn't finish the handoff in 90 s…") and nothing to say about a
 *      stack trace.
 *
 * Frames a run produces ARE mirrored, so the phone can watch the handoff being written. They
 * carry the marker below, and the id they are mirrored under is never announced as a session.
 */

// ---------- ids ----------

/** `run_` + 32 hex. Local to this Mac: it names a run, never anything the cloud stores. */
export function newRunId(): string {
  return `run_${randomBytes(16).toString('hex')}`;
}

/**
 * The `ses_…` id a run's frames are mirrored under.
 *
 * Derived from the run id so the same run always produces the same id (a retry that reuses the
 * run id groups with its first attempt), and minted the same way `syntheticSessionId` mints one
 * for a session the bridge did not spawn — the journal and the frame contract both want a
 * `ses_…`, and refusing to give one would mean the phone could not show the run at all.
 *
 * It is NOT registered anywhere: `listSessions` never returns it, `getStatus` does not know it,
 * and no `session` event is ever emitted for it. That is what "not controllable" means here.
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

// ---------- the call ----------

export interface RunOnceInput {
  /** The repository the run is about, and the run's working directory. Always a real directory. */
  cwd: string;
  /** The whole instruction. One turn, no follow-ups. */
  prompt: string;
  /** Kill the run after this long and resolve `timeout`. */
  timeoutMs: number;
  /** Cancels the run from outside (a switch that failed elsewhere, a shutting-down daemon). */
  signal?: AbortSignal | undefined;
  /** Reuse an id across a retry so both attempts group under one `ses_…`. Minted if absent. */
  runId?: string | undefined;
  /**
   * Which project the frames belong to. Frames are dropped when it is absent, exactly as a
   * mirrored thread in an unregistered directory is: a frame the cloud cannot route is a frame
   * that stays here. The run itself still happens.
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
 * - `canceled` — the caller's `signal` aborted and the run was killed.
 * - `failed` — the agent errored, exited non-zero, or could not be started. `error` says which.
 */
export type RunOnceOutcome = 'completed' | 'timeout' | 'canceled' | 'failed';

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
  /** The id its frames were mirrored under. Never a controllable session. */
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
