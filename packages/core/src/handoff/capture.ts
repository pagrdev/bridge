import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ControlLevel } from '@pagr/protocol';
import type { SendInstructionInput } from '../adapters/types.js';
import { ensureExcluded, type GitOptions, repoRoot } from '../git.js';
import {
  HANDOFF_DIR,
  type HandoffDoc,
  type HandoffProblem,
  type HandoffProvider,
  type HandoffWriter,
  parse,
  summaryLine,
} from './format.js';
import { handoffWritePrompt } from './prompt.js';

/**
 * Capturing a handoff: getting the file at `<repo>/.pagr/handoff/<id>.md` onto the disk.
 *
 * Spec §3 gives two ways to get it there, and the table there is the authority on which runs:
 *
 *   - **sender writes** — `controlLevel: 'full'`. The session that has the context is still
 *     alive and Pagr can talk to it, so it is steered into writing its own handoff. That is
 *     {@link captureFromSender}, and it is what this file holds.
 *   - **receiver writes** — everything else (`approvals_only`, `mirror_only`, `none`, or the
 *     session has ended), and the fall-through when the sender path times out. The receiving
 *     agent is spawned headless over the sender's transcript. That is `captureFromReceiver`,
 *     in `receiver.ts`; the types both paths answer with live here.
 *
 * Both paths answer with the same {@link CaptureOutcome}, and neither decides which of them
 * runs — that dispatch belongs to `session.handoff.capture` in the dispatcher, which is also
 * where the WIP commit, the stop and the sealed frame happen. This module writes nothing to the
 * repository itself: it asks an agent to, and watches.
 *
 * Nothing here throws for a case the design anticipates. A session that cannot be instructed, a
 * file that never appears and a file that appears malformed are all outcomes a person needs to
 * be told about in a text message, not stack traces.
 */

/** What `sendInstruction` reports back: how the instruction actually reached the session. */
export type InstructionDelivery = 'steered' | 'queued' | 'new_turn';

/**
 * The slice of `CodingAgentAdapter` a capture uses.
 *
 * Structural rather than the whole adapter, because the only thing the sender path does to a
 * live session is talk to it — it never starts, stops or inspects one.
 */
export interface InstructionSender {
  sendInstruction(input: SendInstructionInput): Promise<{ delivered: InstructionDelivery }>;
}

/** Why a capture could not even be attempted. Each one is a sentence the phone can be told. */
export type CaptureRefusal =
  /** The session is not `full` — spec §3 routes it to the receiver-writes path instead. */
  | 'control_level'
  /** `.pagr/` could not be added to `.git/info/exclude`, so nothing may be written. */
  | 'not_excluded'
  /** The directory is not inside a git work tree, so there is no `<repo>/.pagr` to write to. */
  | 'not_a_repo'
  /** The adapter refused the instruction: the session is gone, finished, or not ours. */
  | 'send_failed'
  /**
   * Receiver path: the sending session left no transcript this Mac can read, so there is
   * nothing for the receiving agent to reconstruct the handoff from (spec §9, row 2).
   */
  | 'no_transcript'
  /**
   * Receiver path: the receiving adapter has no `runOnce`, so it cannot be spawned headless.
   * An adapter without one is still a good adapter — it just cannot be the writer.
   */
  | 'no_runner'
  /** Receiver path: the headless agent could not be started, or reported a failure of its own. */
  | 'run_failed'
  /** Receiver path: the caller's `AbortSignal` fired and the run was killed. */
  | 'run_canceled'
  /** Receiver path: the run finished, said it was done, and left no file at the path. */
  | 'no_file'
  /**
   * The receiver-writes path was asked for and this bridge has no way to run it for this pair.
   *
   * The dispatcher wires `captureFromReceiver` in (HND-012a), so this is no longer "not built
   * yet". It is now the two honest gaps that are properties of the MAC rather than of the
   * session: no adapter registered for the receiving agent, and no way to read the sending
   * agent's transcript here at all (a Codex sender on a bridge whose Codex adapter cannot reach
   * the app-server). A caller that supplies no receiver path — a one-shot CLI dispatcher, a test
   * — gets it too, from `switch.ts`'s `receiverNotAvailable` default.
   *
   * What it is NOT: a receiving adapter that has no `runOnce` is `no_runner`, and a session that
   * left nothing readable is `no_transcript`. Both are about this session, and both are refused
   * by `receiver.ts` where the fact is actually known.
   */
  | 'receiver_not_available';
/**
 * The end of a capture, whichever path ran it.
 *
 * `writer` is on every variant, including the failures, because "Codex could not reconstruct it
 * from the transcript" and "Claude never wrote it" are different things to tell someone.
 */
export type CaptureOutcome =
  /** The file is on disk and parses. `doc.frontmatter` is still the agent's — nothing rewrote it. */
  | {
      outcome: 'written';
      writer: HandoffWriter;
      path: string;
      doc: HandoffDoc;
      /** The `# Goal` line: the one part of the handoff the cloud is allowed to see in the clear. */
      summary: string;
      /** Non-fatal findings from `validate` (no `← next`, two of them, an empty goal). */
      problems: HandoffProblem[];
      delivery?: InstructionDelivery;
    }
  /** The bound elapsed with no readable file. The caller falls through to the other path. */
  | {
      outcome: 'timeout';
      writer: HandoffWriter;
      path: string;
      waitedMs: number;
      delivery?: InstructionDelivery;
    }
  /** A file appeared, was rejected, was asked for again once, and is still not a handoff. */
  | {
      outcome: 'malformed';
      writer: HandoffWriter;
      path: string;
      problem: HandoffProblem;
      /** False only when the re-ask itself could not be delivered. */
      reAsked: boolean;
      delivery?: InstructionDelivery;
    }
  /**
   * No handoff file, and no point retrying this path. `reason` names which of the ways it
   * could not happen — the sender was never asked, or the receiver never produced anything.
   */
  | {
      outcome: 'refused';
      writer: HandoffWriter;
      path: string | null;
      reason: CaptureRefusal;
      message: string;
    };

/**
 * Progress a caller forwards as `handoff.updated`.
 *
 * A phase, not a `HandoffState`: the protocol's states cover the whole switch (committing,
 * stopping, starting) and a capture is one step of it. The dispatcher owns that mapping, which
 * is also what keeps this module from importing the transport to emit an event itself.
 */
export type CaptureProgress =
  /**
   * The writing agent has the prompt and the file is being waited for. `delivery` says how the
   * instruction reached a live session, and is absent on the receiver path, where a headless
   * run was started rather than a conversation interrupted.
   */
  | {
      phase: 'capturing';
      writer: HandoffWriter;
      path: string;
      delivery?: InstructionDelivery | undefined;
    }
  /** A file arrived and was not a handoff. The agent has been given the format once more. */
  | { phase: 'reasked'; writer: HandoffWriter; path: string; problem: HandoffProblem }
  /** The file is on disk and parses. `summary` is the line the phone receives. */
  | { phase: 'captured'; writer: HandoffWriter; path: string; summary: string }
  /** The capture is over and there is no file. `reason` matches the outcome that follows. */
  | {
      phase: 'failed';
      writer: HandoffWriter;
      path: string | null;
      reason: 'timeout' | 'malformed' | CaptureRefusal;
      message: string;
    };

export interface CaptureFromSenderInput {
  /** `hnd_` + 32 hex. Names the file, and nothing else about it is trusted here. */
  handoffId: string;
  /** The session being handed off FROM. */
  sessionId: string;
  /** Any directory inside the sending session's repository; the work tree root is resolved. */
  repo: string;
  /** The agent the work is moving to, for the prompt's wording. */
  to: HandoffProvider;
  /** How much of this session Pagr may drive. Only `full` runs this path (spec §3). */
  controlLevel: ControlLevel;
  /** The live session's adapter. */
  adapter: InstructionSender;
  /** What the person said when they asked for the switch. */
  note?: string | undefined;
  /** Forwarded as `handoff.updated` by the caller. Never throws into this module's control flow. */
  onProgress?: ((event: CaptureProgress) => void) | undefined;
  /** Overrides {@link handoffCaptureTimeoutMs}. */
  timeoutMs?: number | undefined;
  /** Overrides {@link HANDOFF_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number | undefined;
  /** Where the timeout is read from when `timeoutMs` is absent. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Passed straight to `git.ts`. Tests substitute their own runner. */
  git?: GitOptions | undefined;
}

/**
 * How long the sender gets to write its own handoff before the switch falls through to the
 * receiver-writes path (spec §3). Ninety seconds is not a guess about typing speed: a steered
 * agent finishes its current tool call first, and a `pnpm test` it had already started is the
 * thing being waited on.
 */
export const HANDOFF_CAPTURE_TIMEOUT_MS = 90_000;

/** Env override, read by {@link handoffCaptureTimeoutMs}. */
export const HANDOFF_CAPTURE_TIMEOUT_ENV = 'PAGR_HANDOFF_CAPTURE_TIMEOUT_MS';

/**
 * The poll that actually does the work. See the comment in {@link waitForHandoff} — `fs.watch`
 * is the optimisation, this is the mechanism.
 */
export const HANDOFF_POLL_INTERVAL_MS = 1_000;

/** The one pattern the bridge ever excludes, and it excludes it before writing anything. */
export const HANDOFF_EXCLUDE_PATTERN = '.pagr/';

/** Capture bound from the environment; unset or unparseable falls back to the default. */
export function handoffCaptureTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HANDOFF_CAPTURE_TIMEOUT_ENV];
  if (raw === undefined) return HANDOFF_CAPTURE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HANDOFF_CAPTURE_TIMEOUT_MS;
}

/** The file a handoff writes to, under the work tree root. */
export function handoffFilePath(repoRootDir: string, handoffId: string): string {
  return join(repoRootDir, HANDOFF_DIR, `${handoffId}.md`);
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

/** A caller's progress callback must never be able to fail a capture. */
function notify(sink: ((e: CaptureProgress) => void) | undefined, event: CaptureProgress): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // The caller's problem, not the capture's. Losing one `handoff.updated` is survivable;
    // losing the handoff because the phone was unreachable is not.
  }
}

type WaitResult =
  | { kind: 'parsed'; doc: HandoffDoc; problems: HandoffProblem[] }
  | { kind: 'timeout' }
  | { kind: 'malformed'; problem: HandoffProblem; reAsked: boolean };

interface WaitOptions {
  file: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** Ask the agent for the file again, once, after a malformed one. Resolves false if it could
   *  not be delivered — the capture then ends malformed immediately rather than waiting it out. */
  reAsk: (problem: HandoffProblem) => Promise<boolean>;
}

/**
 * Wait for a parseable handoff file, or run out of time.
 *
 * **Both a watch and a poll, deliberately, and the poll is the mechanism.** `fs.watch` on macOS
 * is backed by FSEvents, and FSEvents is a best-effort notifier, not a guarantee: it coalesces
 * and drops events under pressure, it says nothing useful on network and some virtualised
 * volumes, it can report a change without naming the file (`filename` is nullable, which is why
 * a null one is treated as "check anyway"), and a directory created moments before the watch is
 * registered is exactly the case where it is least trustworthy. Measured on a quiet Mac it does
 * fire for a new file in a fresh directory almost every time — but "almost every time" is not
 * something to hang a person's unsaved work on, so the one-second poll is what this function is
 * actually built around, and the watch is a latency optimisation that turns a worst case of one
 * second into a few milliseconds when it happens to work.
 *
 * The poll is also what makes a partially-written file safe. An agent's `Write` is not atomic,
 * so a read can land mid-write and produce bytes that are not a handoff. Rather than burning
 * the single re-ask on that, bytes that do not parse must stay unchanged for a whole poll
 * interval before the file is called malformed.
 */
function waitForHandoff(opts: WaitOptions): Promise<WaitResult> {
  const { file, timeoutMs, pollIntervalMs, reAsk } = opts;
  const dir = dirname(file);
  const name = basename(file);

  return new Promise<WaitResult>((resolve) => {
    let watcher: FSWatcher | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    let checking = false;
    /** Bad bytes, and when they were first seen: they must stop changing before we believe them. */
    let pending: { text: string; at: number } | null = null;
    /** Bad bytes we have already rejected out loud; re-reading them says nothing new. */
    let rejected: { text: string; problem: HandoffProblem } | null = null;
    let reAsked = false;

    const finish = (result: WaitResult): void => {
      if (done) return;
      done = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };

    const check = async (): Promise<void> => {
      if (done || checking) return;
      checking = true;
      try {
        let text: string;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          return; // not there yet, or not readable yet
        }
        if (done) return;
        if (rejected && text === rejected.text) return; // not rewritten yet
        const result = parse(text);
        if (result.ok) {
          finish({ kind: 'parsed', doc: result.doc, problems: result.problems });
          return;
        }
        if (pending?.text !== text) {
          // Might still be being written. Note the bytes and the time, and look again.
          pending = { text, at: Date.now() };
          return;
        }
        // Unchanged for a whole poll interval, so this is the agent's finished answer rather
        // than a half-written file. Time, not a second reading: `fs.watch` can deliver two
        // events for one write, and a count would spend the single re-ask on that.
        if (Date.now() - pending.at < pollIntervalMs) return;
        if (reAsked) {
          finish({ kind: 'malformed', problem: result.problem, reAsked: true });
          return;
        }
        reAsked = true;
        rejected = { text, problem: result.problem };
        pending = null;
        const delivered = await reAsk(result.problem);
        if (!delivered) finish({ kind: 'malformed', problem: result.problem, reAsked: false });
      } finally {
        checking = false;
      }
    };

    try {
      watcher = watch(dir, (_event, changed) => {
        if (changed === null || changed === name) void check();
      });
      // An unwatchable directory is not a failed capture: the poll covers it.
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }

    poll = setInterval(() => void check(), pollIntervalMs);
    deadline = setTimeout(() => {
      // A file we rejected is more useful to report than silence: the person is told their agent
      // wrote something unusable, rather than that nothing happened.
      if (rejected) finish({ kind: 'malformed', problem: rejected.problem, reAsked });
      else finish({ kind: 'timeout' });
    }, timeoutMs);

    void check(); // it may already be there from an earlier attempt
  });
}

/**
 * Steer a live session into writing its own handoff, and wait for the file.
 *
 * The sender-writes path of spec §3, and only that path: `controlLevel` other than `full` is
 * refused here rather than redirected, because choosing between the two paths is the
 * dispatcher's job and a module that quietly did it itself would make the choice untestable.
 */
export async function captureFromSender(input: CaptureFromSenderInput): Promise<CaptureOutcome> {
  const writer: HandoffWriter = 'sender';
  const onProgress = input.onProgress;

  const refuse = (reason: CaptureRefusal, message: string, path: string | null): CaptureOutcome => {
    notify(onProgress, { phase: 'failed', writer, path, reason, message });
    return { outcome: 'refused', writer, path, reason, message };
  };

  if (input.controlLevel !== 'full') {
    return refuse(
      'control_level',
      `session ${input.sessionId} is ${input.controlLevel}, not full; it cannot be told to write its own handoff`,
      null,
    );
  }

  // Before anything else, and before the path is even resolved: the agent is about to write a
  // file into the user's work tree, and the one thing they must never do is commit it by
  // accident. `.git/info/exclude`, never `.gitignore` — see `ensureExcluded`.
  try {
    await ensureExcluded(input.repo, HANDOFF_EXCLUDE_PATTERN, input.git ?? {});
  } catch (e) {
    return refuse(
      'not_excluded',
      `could not exclude .pagr/ in ${input.repo}: ${errorMessage(e)}`,
      null,
    );
  }

  let root: string;
  try {
    root = await repoRoot(input.repo, input.git ?? {});
  } catch (e) {
    return refuse('not_a_repo', errorMessage(e), null);
  }

  const path = handoffFilePath(root, input.handoffId);
  // The agent would create this itself, but `fs.watch` needs a directory that already exists,
  // and a directory created before the watch is registered is one less race to lose.
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    return refuse('not_excluded', `could not create ${dirname(path)}: ${errorMessage(e)}`, path);
  }

  const prompt = handoffWritePrompt({ path, to: input.to, note: input.note });

  let delivery: InstructionDelivery;
  try {
    // `steer` where the adapter supports it: Codex interrupts the current turn, Claude queues
    // the message unless a channel is bound to the session. A `queued` delivery is not a
    // failure — it means the agent finishes what it is doing first, which is why the bound is
    // ninety seconds and not five.
    const sent = await input.adapter.sendInstruction({
      sessionId: input.sessionId,
      instruction: prompt,
      mode: 'steer',
      localImagePaths: [],
    });
    delivery = sent.delivered;
  } catch (e) {
    return refuse('send_failed', errorMessage(e), path);
  }

  notify(onProgress, { phase: 'capturing', writer, path, delivery });

  const timeoutMs = input.timeoutMs ?? handoffCaptureTimeoutMs(input.env);
  const pollIntervalMs = input.pollIntervalMs ?? HANDOFF_POLL_INTERVAL_MS;

  const result = await waitForHandoff({
    file: path,
    timeoutMs,
    pollIntervalMs,
    reAsk: async (problem) => {
      notify(onProgress, { phase: 'reasked', writer, path, problem });
      try {
        await input.adapter.sendInstruction({
          sessionId: input.sessionId,
          instruction: reAskPrompt({ path, to: input.to, note: input.note, problem }),
          mode: 'steer',
          localImagePaths: [],
        });
        return true;
      } catch {
        return false;
      }
    },
  });

  if (result.kind === 'parsed') {
    const summary = summaryLine(result.doc);
    notify(onProgress, { phase: 'captured', writer, path, summary });
    return {
      outcome: 'written',
      writer,
      path,
      doc: result.doc,
      summary,
      problems: result.problems,
      delivery,
    };
  }

  if (result.kind === 'malformed') {
    notify(onProgress, {
      phase: 'failed',
      writer,
      path,
      reason: 'malformed',
      message: result.problem.message,
    });
    return {
      outcome: 'malformed',
      writer,
      path,
      problem: result.problem,
      reAsked: result.reAsked,
      delivery,
    };
  }

  notify(onProgress, {
    phase: 'failed',
    writer,
    path,
    reason: 'timeout',
    message: `no handoff file after ${Math.round(timeoutMs / 1000)}s`,
  });
  return { outcome: 'timeout', writer, path, waitedMs: timeoutMs, delivery };
}

/**
 * The one re-ask. Says what was wrong with the file it wrote, then restates the whole format —
 * an agent that got the shape wrong is not helped by a correction it has to reconstruct the
 * original instruction from, and this may well be arriving many tool calls after that one.
 */
export function reAskPrompt(input: {
  path: string;
  to: HandoffProvider;
  note?: string | undefined;
  problem: HandoffProblem;
}): string {
  return [
    `The file you wrote at ${input.path} is not a valid handoff: ${input.problem.message}.`,
    input.problem.hint,
    '',
    'Overwrite it with a correct one. Here is the format again, in full.',
    '',
    handoffWritePrompt({ path: input.path, to: input.to, note: input.note }),
  ].join('\n');
}
