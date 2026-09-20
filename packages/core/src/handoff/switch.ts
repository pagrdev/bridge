import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { ControlLevel, HandoffState, RulesMigrationAction } from '@pagr/protocol';
import { commitAll, ensureExcluded, GitError, type GitOptions, isDirty, repoRoot } from '../git.js';
import {
  type CaptureOutcome,
  type CaptureProgress,
  captureFromSender,
  HANDOFF_EXCLUDE_PATTERN,
  handoffFilePath,
  type InstructionSender,
} from './capture.js';
import {
  type HandoffDoc,
  type HandoffProvider,
  type HandoffWriter,
  serialize,
  truncate,
} from './format.js';

/**
 * The switch itself: everything `session.handoff.capture` does on this Mac, in order.
 *
 * Capture is only the first step of it. Spec §4 walks the states `capturing → committing →
 * stopping`, and this module is the part of that walk the bridge owns:
 *
 *   1. `.pagr/` is excluded, before any agent is asked to write into the work tree;
 *   2. an agent writes the handoff file — the sender when Pagr can still talk to it, the
 *      receiver from the transcript otherwise (spec §3, {@link ReceiverCapture});
 *   3. the rules conversion gets its one hook point (a no-op until HND-041 wires HND-040 in);
 *   4. a dirty tree is committed as one WIP commit, hooks and `.gitignore` respected (ADR 0019
 *      decision 3);
 *   5. the commit is recorded in the file's own frontmatter, which is rewritten through
 *      `serialize` so the receiving agent reads a file that knows where the work went;
 *   6. the sender is stopped — before the receiver starts, and never for a session that is not
 *      the bridge's to stop.
 *
 * It lives next to `capture.ts` rather than inside the dispatcher because every one of those
 * steps has an outcome a person has to be told about, and a function that returns them is
 * testable against fakes in a way a method reaching for `this.o.adapters` is not. The dispatcher
 * supplies the adapter, the git runner and the event sink; this module makes the decisions.
 *
 * What it deliberately does NOT do: seal, journal, or emit anything. It reports what happened
 * through {@link HandoffUpdate} and returns the file; the sealed `handoff` frame and the
 * `handoff.updated` events are the dispatcher's, because they need the journal, the recipient
 * keys and the device id, none of which belong in a switch.
 */

// ---------------------------------------------------------------------------
// the seams
// ---------------------------------------------------------------------------

/** Why the sender did not write its own handoff, and the receiver is being asked instead. */
export type ReceiverFallbackReason =
  /** `controlLevel !== 'full'`: the session cannot be given an instruction at all (spec §3). */
  | 'control_level'
  /** The adapter refused the instruction — the session is finished, or not ours to drive. */
  | 'send_failed'
  /** The sender was asked and the file never arrived inside the bound. */
  | 'timeout';

export interface ReceiverCaptureInput {
  /** `hnd_` + 32 hex; names the file the receiver must write. */
  handoffId: string;
  /** The session being handed off FROM — the one whose transcript is being read. */
  sessionId: string;
  /** The work tree root. Already resolved, and `.pagr/` is already excluded. */
  repo: string;
  /** The agent that was doing the work. */
  from: HandoffProvider;
  /** The agent that will pick it up, and the one that writes the file on this path. */
  to: HandoffProvider;
  /** What the person said when they asked for the switch. */
  note?: string | undefined;
  /** Why this path is running. A receiver-written handoff is a reconstruction; the reason says
   *  which kind, which is what the phone is told. */
  because: ReceiverFallbackReason;
  onProgress?: ((event: CaptureProgress) => void) | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  git?: GitOptions | undefined;
}

/**
 * The receiver-writes path of spec §3, as a seam.
 *
 * TODO(HND-012): the real implementation lands in `capture.ts` as `captureFromReceiver` —
 * resolve the sender's transcript (Claude JSONL via `transcript/paths.ts`, Codex via
 * `thread/read` dumped under `PAGR_HOME/tmp`), `runOnce` the RECEIVING adapter over it with
 * `handoffWritePrompt({transcriptPath})`, and delete the dump afterwards. It is being written in
 * parallel with this module, so the switch calls it through this type and defaults to
 * {@link receiverNotAvailable}. Wiring it up is one argument at the dispatcher's call site.
 */
export type ReceiverCapture = (input: ReceiverCaptureInput) => Promise<CaptureOutcome>;

/**
 * The default receiver path: there isn't one yet.
 *
 * It refuses rather than throwing, and it refuses in the same shape a real capture does, so the
 * switch's fall-through is exercised by every test on this branch exactly as it will be when
 * HND-012 replaces it — the only thing that changes is which outcome comes back.
 */
export const receiverNotAvailable: ReceiverCapture = (input) =>
  Promise.resolve({
    outcome: 'refused',
    writer: 'receiver',
    path: null,
    reason: 'receiver_not_available',
    message: `${input.to} cannot write this handoff from ${input.from}'s transcript on this bridge yet (${input.because})`,
  });

export interface RulesMigrateHookInput {
  handoffId: string;
  /** The work tree root. */
  repo: string;
  from: HandoffProvider;
  to: HandoffProvider;
}

/** What the rules step decided. The shape of `rules.migrate`'s ack, minus the file names. */
export interface RulesMigrateHookOutcome {
  action: RulesMigrationAction;
  sourceFile?: string;
  targetFile?: string;
  lineCount?: number;
}

/**
 * The one place a switch may touch the receiver's rules files, as a seam.
 *
 * TODO(HND-041): wire `rules/convert.ts` (HND-040, merged) in here — `proposal()` for the text
 * the phone asks, then `write()` only after a "yes". Nothing is converted until then, and the
 * default below is why: ADR 0019 decision 6 says a rules file is never written without consent,
 * and a hook point that quietly did it before the consent step existed would be exactly the
 * thing that decision forbids. Until then the handoff's own "Rules in force" section carries the
 * constraints, which is the documented fallback (spec §6, last row).
 */
export type RulesMigrateHook = (input: RulesMigrateHookInput) => Promise<RulesMigrateHookOutcome>;

/** The no-op: the switch asks, nothing is proposed, nothing is written. */
export const rulesMigrationDeferred: RulesMigrateHook = () =>
  Promise.resolve({ action: 'skipped' });

/** Stop the sending session. Supplied by the dispatcher, which owns the adapter and the store. */
export type StopSender = () => Promise<void>;

// ---------------------------------------------------------------------------
// what the caller hears about
// ---------------------------------------------------------------------------

/**
 * One `handoff.updated` payload, minus the `handoffId` the caller already has.
 *
 * Only the states the BRIDGE actually enters are reported: `capturing`, `committing`, `stopping`,
 * and `failed`. `starting` and `running` belong to the cloud's next command (ADR 0019 decision 5
 * — each step is its own signed command), and announcing them from here would be this Mac
 * guessing about work it has not been asked to do yet.
 */
export interface HandoffUpdate {
  state: Extract<HandoffState, 'capturing' | 'committing' | 'stopping' | 'failed'>;
  summary?: string;
  writer?: HandoffWriter;
  wipCommit?: string;
  filesChanged?: number;
  truncated?: boolean;
  error?: string;
}

/** Why the stop was skipped instead of performed. Never a failure — the switch continues. */
export type StopSkipReason =
  /** A Codex TUI thread Pagr only mirrors: the terminal that owns it keeps running (spec §4). */
  | 'mirror_only'
  /** A read-only session. It cannot have dirtied the tree, so nothing needs it out of the way. */
  | 'read_only'
  /** The person's own terminal session. Pagr has no handle on that process and no business
   *  killing it (`Dispatcher.assertOurSession` says the same thing to `agent.stop_session`). */
  | 'not_controllable';

export type StopOutcome =
  | { stopped: true }
  | { stopped: false; reason: StopSkipReason; message: string };

/** What the ack carries: `HandoffCaptureResult` from the protocol, built here. */
export interface HandoffCaptureAck {
  writer: HandoffWriter;
  summary: string;
  /** Absent when the tree was already clean — the common case at the end of a turn. */
  wipCommit?: string;
  filesChanged: number;
  truncated: boolean;
}

/** Everything that went wrong loudly enough to stop the switch. */
export type HandoffFailure =
  /** `.pagr/` could not be added to `.git/info/exclude`; nothing may be written. */
  | 'not_excluded'
  /** The session's directory is not inside a git work tree. */
  | 'not_a_repo'
  /** Neither path produced a readable handoff file. */
  | 'no_handoff'
  /** A `pre-commit` / `commit-msg` hook rejected the WIP commit. `message` is the hook's. */
  | 'hook_failed'
  /** git refused the commit for any other reason. */
  | 'commit_failed'
  /** The handoff file could not be written: its directory, or the rewrite that stamps it. */
  | 'write_failed'
  /** The sender is still running and could not be stopped. Two agents, one tree: refuse. */
  | 'stop_failed';

export type HandoffCaptureRun =
  | {
      outcome: 'captured';
      result: HandoffCaptureAck;
      /** Absolute, for logs and `pagr handoff`. Never sent anywhere. */
      path: string;
      /** `.pagr/handoff/<id>.md` — the path that rides the sealed frame. */
      relativePath: string;
      /** The bytes as they are now on disk, frontmatter rewritten. What gets sealed. */
      text: string;
      doc: HandoffDoc;
      stop: StopOutcome;
      rules: RulesMigrateHookOutcome;
    }
  | {
      outcome: 'failed';
      reason: HandoffFailure;
      message: string;
      /** Where the file is, when there is one: it is kept, and the text says so (spec §9). */
      path: string | null;
      writer?: HandoffWriter;
      /** A commit that was already made before the step that failed. Still the user's work. */
      wipCommit?: string;
    };

export interface HandoffCaptureRunInput {
  handoffId: string;
  /** The session being handed off FROM. */
  sessionId: string;
  from: HandoffProvider;
  to: HandoffProvider;
  /** Any directory inside the sending session's repository; the work tree root is resolved. */
  repo: string;
  /** How much of the sending session Pagr may drive. Decides who writes, and whether we stop it. */
  controlLevel: ControlLevel;
  /** The session cannot write to the tree, so it cannot have dirtied it and need not be stopped. */
  readOnly?: boolean | undefined;
  /** The bridge did not start this session. It may be captured; it is never stopped. */
  adopted?: boolean | undefined;
  note?: string | undefined;
  /** The live sending session, for the sender-writes path. */
  sender: InstructionSender;
  stop: StopSender;
  /** Defaults to {@link receiverNotAvailable} until HND-012 lands. */
  captureFromReceiver?: ReceiverCapture | undefined;
  /** Defaults to {@link rulesMigrationDeferred} until HND-041 lands. */
  migrateRules?: RulesMigrateHook | undefined;
  /** Forwarded as `handoff.updated`. A throwing sink never fails a switch. */
  onUpdate?: ((update: HandoffUpdate) => void) | undefined;
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  git?: GitOptions | undefined;
}

// ---------------------------------------------------------------------------
// the WIP commit
// ---------------------------------------------------------------------------

/**
 * The commit message, spec §4 verbatim: `wip(pagr): handoff claude → codex`.
 *
 * It names both agents because it is the line the person will see in `git log` tomorrow when
 * they are working out where a commit they did not type came from.
 */
export const wipCommitMessage = (from: HandoffProvider, to: HandoffProvider): string =>
  `wip(pagr): handoff ${from} → ${to}`;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

/** First line only: a hook's complaint is what the phone shows, and the phone has one line. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export async function runHandoffCapture(input: HandoffCaptureRunInput): Promise<HandoffCaptureRun> {
  const git = input.git ?? {};
  const notify = (update: HandoffUpdate): void => {
    if (!input.onUpdate) return;
    try {
      input.onUpdate(update);
    } catch {
      // Losing one `handoff.updated` is survivable. Losing the handoff because the event sink
      // threw is not — the same rule `capture.ts` applies to its own progress callback.
    }
  };
  const fail = (
    reason: HandoffFailure,
    message: string,
    over: { path?: string | null; writer?: HandoffWriter; wipCommit?: string } = {},
  ): HandoffCaptureRun => {
    notify({
      state: 'failed',
      error: message.slice(0, 500),
      ...(over.writer ? { writer: over.writer } : {}),
    });
    return {
      outcome: 'failed',
      reason,
      message,
      path: over.path ?? null,
      ...(over.writer ? { writer: over.writer } : {}),
      ...(over.wipCommit ? { wipCommit: over.wipCommit } : {}),
    };
  };

  // ---- 1. exclude, then resolve the root ----
  //
  // Before anything else and before an agent is asked for a single byte: a file Pagr causes to
  // appear in someone's work tree must not be a file they commit by accident. `.git/info/exclude`,
  // never `.gitignore` (ADR 0019 decision 1). `captureFromSender` does this too and it is
  // idempotent — the receiver path needs it just as much, and neither is the one that runs.
  try {
    await ensureExcluded(input.repo, HANDOFF_EXCLUDE_PATTERN, git);
  } catch (e) {
    return fail('not_excluded', `could not exclude .pagr/ in ${input.repo}: ${errorMessage(e)}`);
  }
  let root: string;
  try {
    root = await repoRoot(input.repo, git);
  } catch (e) {
    return fail('not_a_repo', errorMessage(e));
  }

  // The directory, before either writer runs. The sender path needs it for `fs.watch` (a watch
  // on a directory that does not exist yet is the one case FSEvents is least reliable about),
  // and the receiver path needs somewhere to land its file the same way.
  const dir = dirname(handoffFilePath(root, input.handoffId));
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    return fail('write_failed', `could not create ${dir}: ${errorMessage(e)}`);
  }

  // ---- 2. get the file written ----
  const captured = await capture(input, root, notify);
  if (captured.outcome !== 'written') {
    return fail('no_handoff', captureFailureMessage(captured), {
      path: captured.path,
      writer: captured.writer,
    });
  }
  const writer = captured.writer;
  const summary = captured.summary;

  // ---- 3. the rules hook ----
  //
  // After the file (its "Rules in force" section is the fallback when nothing is converted) and
  // before the commit, so a conversion that DOES write a file later lands in the same WIP commit
  // as the rest of the work rather than as a stray untracked file the receiver inherits.
  let rules: RulesMigrateHookOutcome;
  try {
    rules = await (input.migrateRules ?? rulesMigrationDeferred)({
      handoffId: input.handoffId,
      repo: root,
      from: input.from,
      to: input.to,
    });
  } catch {
    // A rules conversion that fails is not a switch that fails: the handoff's own "Rules in
    // force" section is the documented fallback, and it is already on disk.
    rules = { action: 'skipped' };
  }

  // ---- 4. the WIP commit ----
  notify({ state: 'committing', summary, writer });
  let wipCommit: string | null = null;
  let filesChanged = 0;
  let dirtyBefore = false;
  try {
    dirtyBefore = await isDirty(root, git);
    if (dirtyBefore) {
      // Everything `git add -A` would take, the user's `.gitignore` respected, their hooks run,
      // nothing pushed (ADR 0019 decision 3). `commitAll` is the only thing here that can write
      // to the repository, and it is the only place in the bridge that spawns git.
      const commit = await commitAll(root, wipCommitMessage(input.from, input.to), git);
      wipCommit = commit.sha;
      filesChanged = commit.filesChanged;
    }
  } catch (e) {
    if (e instanceof GitError && e.code === 'hook_failed') {
      // Loudly, with the hook's own words: their `pre-commit` is their policy, and a switch that
      // swallowed it would be a switch that bypassed it (spec §9, "WIP commit fails (hook)").
      return fail(
        'hook_failed',
        firstLine(e.detail ?? e.message) || 'a git hook rejected the commit',
        {
          path: captured.path,
          writer,
        },
      );
    }
    return fail('commit_failed', errorMessage(e), { path: captured.path, writer });
  }

  // ---- 5. record the commit in the file the receiver will read ----
  const { doc, text } = stamp(captured.doc, { wipCommit, dirtyBefore, writer });
  try {
    await writeAtomically(captured.path, text);
  } catch (e) {
    return fail('write_failed', `could not rewrite ${captured.path}: ${errorMessage(e)}`, {
      path: captured.path,
      writer,
      ...(wipCommit ? { wipCommit } : {}),
    });
  }
  const truncated = doc.frontmatter.truncated === true;

  // ---- 6. stop the sender ----
  notify({
    state: 'stopping',
    summary,
    writer,
    filesChanged,
    truncated,
    ...(wipCommit ? { wipCommit } : {}),
  });
  const stopResult = await stopSender(input);
  if (stopResult.kind === 'failed') {
    return fail('stop_failed', stopResult.message, {
      path: captured.path,
      writer,
      ...(wipCommit ? { wipCommit } : {}),
    });
  }

  return {
    outcome: 'captured',
    result: {
      writer,
      summary,
      filesChanged,
      truncated,
      ...(wipCommit ? { wipCommit } : {}),
    },
    path: captured.path,
    relativePath: relative(root, captured.path),
    text,
    doc,
    stop: stopResult.stop,
    rules,
  };
}

// ---------------------------------------------------------------------------
// step 2: who writes
// ---------------------------------------------------------------------------

/**
 * Spec §3's table, as code: the sender writes when Pagr can talk to it, the receiver writes
 * otherwise — and the receiver ALSO writes when the sender was asked and did not deliver.
 *
 * Three sender outcomes fall through, and one does not. `control_level` never even tried;
 * `send_failed` means the adapter would not take the instruction, which is what a session that
 * has ended looks like from here; `timeout` is the case the feature exists for ("it hit its
 * limit overnight"). A `malformed` file does NOT fall through: the sender was asked twice, wrote
 * something unusable twice, and the honest answer is to say so rather than to spend a second
 * agent's turn on a session that is demonstrably not answering the question.
 */
async function capture(
  input: HandoffCaptureRunInput,
  root: string,
  notify: (u: HandoffUpdate) => void,
): Promise<CaptureOutcome> {
  const onProgress = (e: CaptureProgress): void => {
    if (e.phase === 'capturing') notify({ state: 'capturing', writer: e.writer });
  };

  let because: ReceiverFallbackReason = 'control_level';
  if (input.controlLevel === 'full') {
    const sent = await captureFromSender({
      handoffId: input.handoffId,
      sessionId: input.sessionId,
      repo: root,
      to: input.to,
      controlLevel: input.controlLevel,
      adapter: input.sender,
      onProgress,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.git !== undefined ? { git: input.git } : {}),
    });
    if (sent.outcome === 'written' || sent.outcome === 'malformed') return sent;
    if (sent.outcome === 'timeout') because = 'timeout';
    else if (sent.reason === 'control_level') because = 'control_level';
    else if (sent.reason === 'send_failed') because = 'send_failed';
    // `not_a_repo` / `not_excluded` are not about the sender at all: nothing can be written
    // anywhere, so a second agent would fail in exactly the same way.
    else return sent;
  }

  notify({ state: 'capturing', writer: 'receiver' });
  return (input.captureFromReceiver ?? receiverNotAvailable)({
    handoffId: input.handoffId,
    sessionId: input.sessionId,
    repo: root,
    from: input.from,
    to: input.to,
    because,
    onProgress,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.git !== undefined ? { git: input.git } : {}),
  });
}

/** One sentence for the phone about a capture that produced no file. */
function captureFailureMessage(outcome: CaptureOutcome): string {
  switch (outcome.outcome) {
    case 'timeout':
      return `no handoff file after ${Math.round(outcome.waitedMs / 1000)}s`;
    case 'malformed':
      return `the handoff file is not readable: ${outcome.problem.message}`;
    case 'refused':
      return outcome.message;
    default:
      return 'the handoff was not written';
  }
}

// ---------------------------------------------------------------------------
// step 5: the frontmatter rewrite
// ---------------------------------------------------------------------------

/**
 * Put the commit into the file, and the truth into the fields the agent guessed at.
 *
 * `wipCommit` is the point of the rewrite: the receiving agent (and the person, weeks later)
 * needs the file to say which commit holds the work it describes. `dirtyBefore` and `writer` are
 * corrected at the same time because the agent wrote them from what it believed — a sender
 * cannot know whether the tree was dirty at the moment of the switch, and a receiver
 * reconstructing from a transcript cannot know it wrote the file itself.
 *
 * `truncate` runs last so a body over the 64 KiB cap is cut here rather than at the seal, and
 * the file itself records `truncated: true`. The ack's `truncated` is read straight back off it.
 */
function stamp(
  doc: HandoffDoc,
  facts: { wipCommit: string | null; dirtyBefore: boolean; writer: HandoffWriter },
): { doc: HandoffDoc; text: string } {
  const stamped: HandoffDoc = {
    ...doc,
    frontmatter: {
      ...doc.frontmatter,
      writer: facts.writer,
      git: { ...doc.frontmatter.git, wipCommit: facts.wipCommit, dirtyBefore: facts.dirtyBefore },
    },
  };
  const capped = truncate(stamped).doc;
  return { doc: capped, text: serialize(capped) };
}

/**
 * Write through a temp file in the same directory, then rename.
 *
 * The same discipline `jsonFile.ts` uses, for the same reason: the receiving agent may be
 * reading this file the instant it is rewritten, and a half-written handoff is worse than an
 * un-stamped one. `rename` within a directory is atomic on every filesystem the daemon runs on.
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// step 6: stopping the sender
// ---------------------------------------------------------------------------

type StopStep = { kind: 'ok'; stop: StopOutcome } | { kind: 'failed'; message: string };

/**
 * Stop the session the work came from — or say why it was left alone.
 *
 * The rule the whole design rests on is that two write-capable agents never share one work tree,
 * which is why a sender that CAN be stopped and will not is a failed switch rather than a note:
 * the cloud's next step is `agent.start_session` on the same directory. A session Pagr never
 * started, only mirrors, or that cannot write at all is a different case entirely — spec §4 says
 * the switch skips the stop, texts that the terminal session keeps running, and continues.
 */
async function stopSender(input: HandoffCaptureRunInput): Promise<StopStep> {
  const skip = stopSkip(input);
  if (skip) return { kind: 'ok', stop: { stopped: false, ...skip } };
  try {
    await input.stop();
    return { kind: 'ok', stop: { stopped: true } };
  } catch (e) {
    const message = errorMessage(e);
    // Belt and braces: an adapter that refuses because the thread is somebody else's is the
    // documented skip, even when the control level we were handed said otherwise (a TUI can
    // attach to a thread between the capture and the stop).
    if (looksReadOnly(message))
      return { kind: 'ok', stop: { stopped: false, reason: 'mirror_only', message } };
    return { kind: 'failed', message: `could not stop ${input.from}: ${message}` };
  }
}

function stopSkip(
  input: HandoffCaptureRunInput,
): { reason: StopSkipReason; message: string } | null {
  if (input.controlLevel === 'mirror_only')
    return {
      reason: 'mirror_only',
      message: `${input.from}'s terminal session keeps running; Pagr only mirrors it`,
    };
  if (input.readOnly === true)
    return {
      reason: 'read_only',
      message: `${input.from}'s session is read-only, so it is not holding the work tree`,
    };
  if (input.adopted === true || input.controlLevel !== 'full')
    return {
      reason: 'not_controllable',
      message: `Pagr did not start ${input.from}'s session, so it is not Pagr's to stop`,
    };
  return null;
}

/** A stop refusal that means "this session belongs to a terminal", whoever phrased it. */
const looksReadOnly = (message: string): boolean =>
  /\bmirror(s|ed|ing)?\b|\bread-only\b|cannot steer or stop/i.test(message);
