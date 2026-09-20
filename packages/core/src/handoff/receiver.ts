import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunOnceInput, RunOnceResult } from '../adapters/runOnce.js';
import { ensureExcluded, type GitOptions, repoRoot } from '../git.js';
import { getPaths } from '../paths.js';
import {
  type CaptureOutcome,
  type CaptureProgress,
  type CaptureRefusal,
  HANDOFF_EXCLUDE_PATTERN,
  HANDOFF_POLL_INTERVAL_MS,
  handoffCaptureTimeoutMs,
  handoffFilePath,
} from './capture.js';
import { type HandoffProvider, type HandoffWriter, parse, summaryLine } from './format.js';
import { handoffWritePrompt } from './prompt.js';

/**
 * The receiver-writes half of a capture (spec §3, second row of the table).
 *
 * `capture.ts` handles the case where the agent that did the work is still there to be asked.
 * This file handles every other case, and they are the majority: a `claude` the person started
 * in their own terminal (`mirror_only`), a Codex TUI thread, a session that ended an hour ago,
 * and the fall-through when a `full` session was steered and never answered. In all of them the
 * context exists only as a transcript on this Mac, so the agent that is about to PICK UP the
 * work is spawned headless, pointed at that transcript, and asked to write the note itself.
 *
 * Three things shape the implementation:
 *
 *   - **The transcript never leaves the Mac.** It is not read into this process, not summarised,
 *     not sealed and not sent. A path is handed to a local agent, and that is all.
 *   - **A dump is temporary and is always deleted.** Claude's transcript is already a file, so
 *     nothing is created for it. Codex's lives inside the app-server, so `thread/read` is dumped
 *     to `PAGR_HOME/tmp/<handoffId>.ndjson` — and that file is removed in a `finally`, on the
 *     happy path, on a refusal, on a timeout and on a throw alike. A plaintext transcript left
 *     lying in a temp directory because a run failed is exactly the failure worth preventing.
 *   - **The answer is the same union the sender path returns.** {@link CaptureOutcome} with
 *     `writer: 'receiver'`, so the dispatcher (HND-013) commits, stops and seals without caring
 *     which path produced the file, and so a person is told what happened either way.
 *
 * Unlike `captureFromSender`, there is no `controlLevel` gate here. Every control level
 * can end up on this path — including `full`, which arrives after its own capture timed out —
 * so a gate would only be able to refuse a case the dispatcher had already decided.
 */

// ---------- the ports ----------

/**
 * The slice of an adapter the receiver path uses: one bounded headless run and nothing else.
 *
 * Structural rather than the whole `CodingAgentAdapter`, and deliberately not the adapter the
 * SENDER belongs to — the agent spawned here is the one the work is moving TO.
 */
export interface HeadlessRunner {
  runOnce(input: RunOnceInput): Promise<RunOnceResult>;
}

/** Which session's transcript is wanted, and what may be used to name a dump of it. */
export interface TranscriptRequest {
  /** Pagr's id for the sending session (`ses_…`). Used in messages, never as a file name. */
  sessionId: string;
  /** The agent's OWN id: Claude's session uuid, Codex's thread id. This is what finds the file. */
  providerSessionId: string;
  /** The handoff being captured. Names the temp dump, so a retry reuses one file. */
  handoffId: string;
  /** The sending session's working directory, when the caller knows it. */
  cwd?: string | undefined;
}

/**
 * A transcript, made readable at an absolute path.
 *
 * `temporary` is the whole contract around cleanup: true means this path exists only because
 * the capture asked for it, and {@link captureFromReceiver} deletes it when it is done.
 */
export interface ResolvedTranscript {
  /** Absolute path the receiving agent is told to read. */
  path: string;
  /** True when `path` was created for this capture and must be deleted afterwards. */
  temporary: boolean;
  /**
   * Where tool outputs too large for the transcript were spilled, when the provider has such a
   * place (Claude does). The agent is told it exists; it is not read here.
   */
  spillDir?: string | undefined;
}

/**
 * Find the sending session's transcript, or answer null.
 *
 * Null is not an error — "that session left nothing readable" is a sentence a person gets told
 * (spec §9: *"I can't find that session's transcript on the Mac…"*), so it is an outcome, not a
 * throw. A source that throws is treated the same way, with its message carried through.
 */
export type TranscriptSource = (req: TranscriptRequest) => Promise<ResolvedTranscript | null>;

// ---------- the call ----------

export interface CaptureFromReceiverInput {
  /** `hnd_` + 32 hex. Names the file, and the temp dump if one is made. */
  handoffId: string;
  /** The session being handed off FROM — the one whose transcript is read. */
  sessionId: string;
  /** That session's provider-side id: Claude's session uuid, Codex's thread id. */
  providerSessionId: string;
  /** Any directory inside the sending session's repository; the work tree root is resolved. */
  repo: string;
  /** The agent the work is moving to. It is also the agent that writes the note. */
  to: HandoffProvider;
  /** The RECEIVING adapter. `runOnce` absent is refused as `no_runner`, never worked around. */
  receiver: Partial<HeadlessRunner>;
  /** Where the sender's transcript comes from. See {@link claudeTranscriptSource}. */
  transcript: TranscriptSource;
  /** The sending session's working directory, if known; helps a source narrow its search. */
  cwd?: string | undefined;
  /** What the person said when they asked for the switch. */
  note?: string | undefined;
  /** Routes the run's mirrored frames. Absent means the frames stay on this Mac. */
  projectId?: string | undefined;
  /** Forwarded as `handoff.updated` by the caller. Never throws into this module's control flow. */
  onProgress?: ((event: CaptureProgress) => void) | undefined;
  /** Overrides `handoffCaptureTimeoutMs`. Bounds the headless run, not a watch. */
  timeoutMs?: number | undefined;
  /** How long to wait once more for a file the run should have left. */
  pollIntervalMs?: number | undefined;
  /** Where the timeout is read from when `timeoutMs` is absent. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Passed straight to `git.ts`. Tests substitute their own runner. */
  git?: GitOptions | undefined;
  /** Cancels the run from outside (a switch that failed elsewhere, a shutting-down daemon). */
  signal?: AbortSignal | undefined;
  /** Reuse an id across a retry so both attempts group under one `ses_…`. */
  runId?: string | undefined;
}

/**
 * What a receiver run may write: `.pagr/`, and nothing else in the tree.
 *
 * It is also, on the Codex side, exactly what the OS sandbox grants — the run's thread is
 * started in `<repo>/.pagr` (HND-015), so this glob and the kernel's boundary say the same
 * thing. On the Claude side it is a tool allow-list with every other prompt denied.
 */
export const RECEIVER_ALLOWED_WRITES = ['.pagr/**'] as const;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

/** A caller's progress callback must never be able to fail a capture. */
function notify(sink: ((e: CaptureProgress) => void) | undefined, event: CaptureProgress): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Same rule as the sender path: losing one `handoff.updated` is survivable.
  }
}

/**
 * The instruction the headless writer gets.
 *
 * `handoffWritePrompt` unchanged — the format has exactly one statement of itself and this path
 * does not get a second one. Two things are added: the work tree root, because a headless run's
 * working directory is not it (`repo`, HND-015), and the spill directory, PREPENDED rather than
 * appended, because the prompt's last line is "Write the file, then stop" and nothing should
 * come after it.
 */
export function receiverWritePrompt(input: {
  path: string;
  to: HandoffProvider;
  transcript: ResolvedTranscript;
  note?: string | undefined;
  /** The work tree root. Named in the prompt because the run's cwd may not be it (HND-015). */
  repo: string;
}): string {
  const prompt = handoffWritePrompt({
    path: input.path,
    to: input.to,
    note: input.note,
    transcriptPath: input.transcript.path,
    repo: input.repo,
  });
  if (!input.transcript.spillDir) return prompt;
  return [
    'Some tool outputs in the transcript below were too large to store inline and were spilled',
    'into separate files under:',
    '',
    `  ${input.transcript.spillDir}`,
    '',
    'Open one only when the transcript points at it by name.',
    '',
    prompt,
  ].join('\n');
}

/**
 * Spawn the receiving agent headless over the sender's transcript, and see what it wrote.
 *
 * The order of operations is the order of what can be refused for free. `repoRoot` and the
 * transcript lookup read; only once both have answered is anything written — `.git/info/exclude`
 * and the handoff directory — so a handoff that cannot happen leaves the user's repository
 * exactly as it was. (`captureFromSender` excludes first because by the time it knows anything,
 * a live agent is already holding an instruction to write into the tree.)
 */
export async function captureFromReceiver(
  input: CaptureFromReceiverInput,
): Promise<CaptureOutcome> {
  const writer: HandoffWriter = 'receiver';
  const onProgress = input.onProgress;

  const refuse = (reason: CaptureRefusal, message: string, path: string | null): CaptureOutcome => {
    notify(onProgress, { phase: 'failed', writer, path, reason, message });
    return { outcome: 'refused', writer, path, reason, message };
  };

  let root: string;
  try {
    root = await repoRoot(input.repo, input.git ?? {});
  } catch (e) {
    return refuse('not_a_repo', errorMessage(e), null);
  }
  const path = handoffFilePath(root, input.handoffId);

  let resolved: ResolvedTranscript | null;
  try {
    resolved = await input.transcript({
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      handoffId: input.handoffId,
      cwd: input.cwd,
    });
  } catch (e) {
    // A source that throws is a source that found nothing, with a reason worth keeping.
    return refuse(
      'no_transcript',
      `could not read a transcript for ${input.sessionId}: ${errorMessage(e)}`,
      path,
    );
  }
  if (!resolved) {
    return refuse(
      'no_transcript',
      `no transcript on this Mac for session ${input.sessionId}`,
      path,
    );
  }

  try {
    return await runReceiver({ ...input, root, path, writer, transcriptFile: resolved, refuse });
  } finally {
    // Unconditional, and before anything else can go wrong: a dumped transcript is plaintext
    // and belongs to nobody once the run is over.
    if (resolved.temporary) await rm(resolved.path, { force: true }).catch(() => undefined);
  }
}

async function runReceiver(
  o: CaptureFromReceiverInput & {
    root: string;
    path: string;
    writer: HandoffWriter;
    transcriptFile: ResolvedTranscript;
    refuse: (reason: CaptureRefusal, message: string, path: string | null) => CaptureOutcome;
  },
): Promise<CaptureOutcome> {
  const { root, path, writer, transcriptFile, refuse, onProgress } = o;

  const run = o.receiver.runOnce;
  if (!run) {
    return refuse(
      'no_runner',
      `the ${o.to} adapter cannot run headlessly, so it cannot write the handoff`,
      path,
    );
  }

  // The agent is about to write into the user's work tree; `.git/info/exclude` comes first.
  try {
    await ensureExcluded(root, HANDOFF_EXCLUDE_PATTERN, o.git ?? {});
  } catch (e) {
    return refuse('not_excluded', `could not exclude .pagr/ in ${root}: ${errorMessage(e)}`, path);
  }
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    return refuse('not_excluded', `could not create ${dirname(path)}: ${errorMessage(e)}`, path);
  }

  notify(onProgress, { phase: 'capturing', writer, path });

  const timeoutMs = o.timeoutMs ?? handoffCaptureTimeoutMs(o.env);
  const pollIntervalMs = o.pollIntervalMs ?? HANDOFF_POLL_INTERVAL_MS;

  let result: RunOnceResult;
  try {
    result = await run.call(o.receiver, {
      cwd: root,
      prompt: receiverWritePrompt({
        path,
        to: o.to,
        transcript: transcriptFile,
        note: o.note,
        repo: root,
      }),
      allowedWrites: [...RECEIVER_ALLOWED_WRITES],
      timeoutMs,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.runId ? { runId: o.runId } : {}),
      ...(o.projectId ? { projectId: o.projectId } : {}),
    });
  } catch (e) {
    // `runOnce` is specified to resolve rather than throw, but an adapter is a subprocess with
    // an owner, and a handoff must not die on somebody else's stack trace.
    return refuse('run_failed', errorMessage(e), path);
  }

  // The file is checked before the outcome is, and on purpose: an agent that wrote the note and
  // then kept talking until its timeout has done the job, and calling that a timeout would throw
  // away the very file the person is waiting for.
  const text = await readAfterRun(path, result.outcome === 'completed' ? pollIntervalMs : 0);

  if (text !== null) {
    const parsed = parse(text);
    if (parsed.ok) {
      const summary = summaryLine(parsed.doc);
      notify(onProgress, { phase: 'captured', writer, path, summary });
      return {
        outcome: 'written',
        writer,
        path,
        doc: parsed.doc,
        summary,
        problems: parsed.problems,
      };
    }
    notify(onProgress, {
      phase: 'failed',
      writer,
      path,
      reason: 'malformed',
      message: parsed.problem.message,
    });
    // `reAsked: false` always. There is no conversation to re-ask: the single re-ask of the
    // sender path is a steer into a live session, and this run is already over. A second
    // attempt is a second capture, and that is the dispatcher's decision to make, not this one's.
    return { outcome: 'malformed', writer, path, problem: parsed.problem, reAsked: false };
  }

  if (result.outcome === 'timeout') {
    notify(onProgress, {
      phase: 'failed',
      writer,
      path,
      reason: 'timeout',
      message: `${o.to} did not finish the handoff in ${Math.round(timeoutMs / 1000)}s`,
    });
    return { outcome: 'timeout', writer, path, waitedMs: timeoutMs };
  }
  if (result.outcome === 'canceled')
    return refuse('run_canceled', 'the handoff was called off', path);
  if (result.outcome === 'failed') {
    return refuse('run_failed', result.error?.message ?? `${o.to} failed to run`, path);
  }
  return refuse(
    'no_file',
    `${o.to} finished without writing ${path}${result.output ? `: ${firstLine(result.output)}` : ''}`,
    path,
  );
}

/** The agent's own words, clipped to the one line a text message can carry. */
function firstLine(output: string): string {
  const line = output.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Read the file the run should have left, with one grace period.
 *
 * A completed run has already flushed its write — but "already" is a claim about two processes
 * and a filesystem, and one extra look a second later costs a second only in the case that was
 * going to fail anyway.
 */
async function readAfterRun(path: string, graceMs: number): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    if (graceMs <= 0) return null;
  }
  await new Promise((r) => setTimeout(r, graceMs));
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------- Claude: the transcript is already a file ----------

/** How many project directories a lookup will look in before giving up. */
export const MAX_TRANSCRIPT_DIRS = 500;

export interface ClaudeTranscriptSourceOptions {
  /** `$HOME` holding `.claude`. Never defaulted: a test must not be able to read a real one. */
  home: string;
  /** Override {@link MAX_TRANSCRIPT_DIRS}. */
  maxDirs?: number | undefined;
}

/**
 * Claude Code writes the transcript itself, so this finds it rather than making one.
 *
 * It searches `~/.claude/projects/*` for `<session id>.jsonl` instead of computing the directory
 * name from a cwd, and that is not laziness. Claude's directory name is a lossy encoding of the
 * session's OWN working directory, which is not reliably the repository root a handoff resolved:
 * a session started in `packages/core`, a git worktree, or a path reached through a symlink all
 * produce a different directory for the same repo. The session id is unique across all of them,
 * so looking for it is both simpler and more often right. Newest directories first and a hard
 * budget, because `~/.claude/projects` on a working machine holds thousands of entries.
 *
 * A `.jsonl.superseded-…` variant counts, but only when the live file is nowhere: Claude leaves
 * one behind when it rewrites a transcript, and a stale copy of the conversation beats nothing
 * at all to hand off from.
 */
export function claudeTranscriptSource(o: ClaudeTranscriptSourceOptions): TranscriptSource {
  const maxDirs = o.maxDirs ?? MAX_TRANSCRIPT_DIRS;
  return async (req) => {
    const id = req.providerSessionId;
    // `path.join` with an id containing `..` would climb out of the projects directory. The ids
    // are Claude's own uuids, but this is a lookup keyed on a string that reached us from a
    // command, so it is checked rather than trusted.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) return null;
    const root = join(o.home, '.claude', 'projects');
    const dirs = projectDirsNewestFirst(root, maxDirs);

    for (const dir of dirs) {
      const file = join(dir, `${id}.jsonl`);
      if (nonEmptyFile(file)) return claudeResolved(dir, id, file);
    }
    // Only now, and only in the case that is about to be refused anyway: the expensive pass.
    for (const dir of dirs) {
      const superseded = readdirSafe(dir)
        .filter((n) => n.startsWith(`${id}.jsonl.superseded-`))
        .sort();
      const newest = superseded.at(-1);
      if (newest && nonEmptyFile(join(dir, newest))) {
        return claudeResolved(dir, id, join(dir, newest));
      }
    }
    return null;
  };
}

function claudeResolved(dir: string, id: string, file: string): ResolvedTranscript {
  // `spillDir` from `adapter-claude`'s `transcript/paths.ts`: `<project dir>/<id>/tool-results`.
  const spill = join(dir, id, 'tool-results');
  return {
    path: file,
    temporary: false,
    ...(isDir(spill) ? { spillDir: spill } : {}),
  };
}

function projectDirsNewestFirst(root: string, limit: number): string[] {
  const dirs: Array<{ dir: string; mtimeMs: number }> = [];
  for (const name of readdirSafe(root)) {
    // Claude's own notes, not a session's transcripts.
    if (name === 'memory') continue;
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (st.isDirectory()) dirs.push({ dir, mtimeMs: st.mtimeMs });
    } catch {
      // gone between the readdir and the stat
    }
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs.slice(0, limit).map((d) => d.dir);
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function nonEmptyFile(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- Codex: the transcript lives inside the app-server ----------

/** One turn of a `thread/read` response, as much of it as a dump needs to know. */
export interface CodexThreadTurn {
  id?: string | undefined;
  items?: unknown[] | undefined;
}

/** `thread/read`'s `thread`, structurally. The adapter owns the real type. */
export interface CodexThread {
  id?: string | undefined;
  turns?: CodexThreadTurn[] | undefined;
}

/**
 * `thread/read` for one thread. Supplied by the Codex adapter, because reading a thread means
 * talking to the app-server and `core` does not own that connection.
 */
export type CodexThreadReader = (threadId: string) => Promise<CodexThread | null | undefined>;

/** The version marker on the first line of a dump, so a reader knows what it has. */
export const CODEX_DUMP_FORMAT = 'pagr/codex-thread-1';

export interface CodexTranscriptSourceOptions {
  /** How the thread is read. */
  readThread: CodexThreadReader;
  /** `PAGR_HOME`. The dump lands in its `tmp/`, 0600, and is deleted after the run. */
  pagrHome: string;
}

/**
 * Codex keeps its threads inside the app-server, so there is no file to point an agent at —
 * `thread/read` is dumped to `PAGR_HOME/tmp/<handoffId>.ndjson` and the path handed over.
 *
 * NDJSON, one line per item, because that is the shape both agents already read transcripts in
 * and because a half-written line is recognisably half-written. The file is 0600 and
 * {@link captureFromReceiver} deletes it in a `finally` — success, refusal or throw.
 *
 * A thread with no items resolves to null rather than an empty file: "Codex has nothing to hand
 * off" is a sentence the person should get, not a transcript that says nothing.
 */
export function codexTranscriptSource(o: CodexTranscriptSourceOptions): TranscriptSource {
  return async (req) => {
    const thread = await o.readThread(req.providerSessionId);
    const turns = thread?.turns ?? [];
    const lines: string[] = [
      JSON.stringify({
        format: CODEX_DUMP_FORMAT,
        threadId: thread?.id ?? req.providerSessionId,
        turns: turns.length,
      }),
    ];
    let items = 0;
    for (const turn of turns) {
      const turnItems = turn.items ?? [];
      for (let i = 0; i < turnItems.length; i++) {
        lines.push(JSON.stringify({ turn: turn.id ?? null, index: i, item: turnItems[i] }));
        items++;
      }
    }
    if (items === 0) return null;

    const dir = getPaths(o.pagrHome).tmpDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = codexDumpPath(o.pagrHome, req.handoffId);
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    return { path: file, temporary: true };
  };
}

/** Where {@link codexTranscriptSource} puts its dump. One place, so the cleanup rule has one. */
export function codexDumpPath(pagrHome: string, handoffId: string): string {
  return join(getPaths(pagrHome).tmpDir, `${handoffId}.ndjson`);
}
