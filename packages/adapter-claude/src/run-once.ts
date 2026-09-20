import { randomUUID } from 'node:crypto';
import type {
  FrameBody,
  JournalMeta,
  RunOnceError,
  RunOnceInput,
  RunOnceResult,
} from '@pagr/bridge-core';
import { newRunId, runOnceFrameMeta, runOnceSessionId } from '@pagr/bridge-core';
import { ClaudeProcess } from './claude-process.js';
import { clip } from './heuristics.js';
import type { FileLogger } from './logger.js';

/**
 * `claude -p`, once, with nobody watching — the handoff writer and the reviewer (spec §3, §5).
 *
 * It is the same `ClaudeProcess` every session uses, which is the point: one spawner, one set of
 * flags, one place where the argv of a `claude` child is decided. What a one-shot run adds is
 * three constraints a conversation does not want:
 *
 *   - `--allowedTools`, so reading, a handful of read-only git commands and a write under the
 *     caller's globs happen with no prompt at all;
 *   - every OTHER prompt auto-denied, instantly, because no human is attached to answer one and
 *     an unanswered prompt is a handoff that hangs until its timeout;
 *   - sealed settings (`PAGR_CLAUDE_SEALED`), because the rationale for honouring a repo's own
 *     `.claude/settings.json` — "a session the bridge starts should behave like the one they
 *     start themselves" — assumes a person is there to see what it does. Nobody is. A checked-out
 *     `permissions.allow: ["Bash(*)"]` would otherwise turn this run into a shell.
 *
 * The bridge does not check the tree afterwards to see what was written. A write that has
 * happened has happened; the refusal has to come from inside the agent, or it is not a refusal.
 */

/** Tools a run may use to LOOK at the repo. No `Bash`: see `RUN_ONCE_GIT_RULES`. */
export const RUN_ONCE_READ_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead'] as const;

/**
 * The git a handoff or a review needs, and nothing else.
 *
 * Read-only commands only. The WIP commit is the bridge's own (`core/src/git.ts`, HND-003): it
 * has to fail loudly through a typed error when a pre-commit hook rejects it, which is not
 * something a model running `git commit` in a Bash tool can be relied on to report.
 *
 * Each rule is a prefix rule (`git log:*`), so `git log --oneline -20` is allowed and
 * `git log; rm -rf ~` is not — Claude Code refuses a prefix rule match on a command line that
 * chains, and anything it does not match raises a prompt that this run denies.
 */
export const RUN_ONCE_GIT_RULES = [
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)',
] as const;

/**
 * The `--allowedTools` list for a run that may write under `allowedWrites`.
 *
 * `Write`, `Edit` and `MultiEdit` are each scoped to the same globs: a handoff file is usually
 * created once, but a re-ask (the file came back malformed) edits the one that is already there.
 * `MultiEdit` is not a tool name current Claude Code knows; a stale allow rule costs nothing and
 * an install that still has it would otherwise prompt.
 */
export function runOnceAllowedTools(allowedWrites: string[]): string[] {
  const writes = allowedWrites.flatMap((glob) => [
    `Write(${glob})`,
    `Edit(${glob})`,
    `MultiEdit(${glob})`,
  ]);
  return [...RUN_ONCE_READ_TOOLS, ...RUN_ONCE_GIT_RULES, ...writes];
}

/** What a denied prompt tells the model, so it reports the refusal rather than retrying forever. */
export const RUN_ONCE_DENY_MESSAGE =
  'This is an automated one-shot run with no user attached. Only the writes it was started with are permitted; everything else is denied. Do not ask again — say what you could not do and stop.';

/** SIGINT → SIGTERM grace for a run being killed. Short: nobody is waiting on its last words. */
const KILL_GRACE_MS = 1000;

export interface ClaudeRunOnceOptions {
  input: RunOnceInput;
  /** Base command, as the adapter resolved it (`['claude']`, or the fixture in tests). */
  command: string[];
  /** The child's environment, already built by the adapter. */
  env: NodeJS.ProcessEnv;
  logger: FileLogger;
  /** One frame the run produced. The adapter decides what to do with it. */
  onFrame?: (f: { body: FrameBody; meta: JournalMeta; endsTurn?: boolean }) => void;
}

export async function runClaudeOnce(o: ClaudeRunOnceOptions): Promise<RunOnceResult> {
  const { input } = o;
  const runId = input.runId ?? newRunId();
  const sessionId = runOnceSessionId('claude', runId);
  const startedMs = Date.now();
  const meta = runOnceFrameMeta(runId, 'stdio');
  const allowedTools = runOnceAllowedTools(input.allowedWrites);
  const said: string[] = [];
  let sawInit = false;
  let settled = false;
  let denials = 0;
  /**
   * Set the instant a kill starts, and read by the exit handler.
   *
   * Killing a run ends its process, and an ending process is exactly what `exit` reports as a
   * failure. Without this, every timeout raced its own SIGINT and came back as
   * `failed: claude exited (code 0)` — the outcome the caller most needs to tell apart.
   */
  let killing: 'timeout' | 'canceled' | null = null;

  const proc = new ClaudeProcess({
    command: o.command,
    cwd: input.cwd,
    env: o.env,
    // Its own session id, always. A run never resumes anything: resuming would mean writing a
    // handoff into the transcript of a conversation somebody else owns.
    session: { kind: 'new', id: randomUUID() },
    // Not `readOnly` — the whole point is one file. `--allowedTools` is what bounds it.
    readOnly: false,
    sealed: true,
    allowedTools,
    logger: o.logger,
  });

  const frame = (body: FrameBody, endsTurn = false): void => {
    o.onFrame?.({ body, meta, ...(endsTurn ? { endsTurn: true } : {}) });
  };

  return await new Promise<RunOnceResult>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => void end('canceled');

    const done = (
      outcome: RunOnceResult['outcome'],
      extra: { error?: RunOnceError; exitCode?: number | null } = {},
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      o.logger.log('info', 'one-shot claude run finished', {
        runId,
        outcome,
        denials,
        durationMs: Date.now() - startedMs,
      });
      frame(
        {
          kind: 'system',
          subtype: `run_once_${outcome}`,
          text: outcomeText(outcome, extra.error),
        },
        true,
      );
      resolve({
        runId,
        sessionId,
        outcome,
        output: said.join('\n\n'),
        ...extra,
        durationMs: Date.now() - startedMs,
      });
    };

    /** Kill first, answer second: a killed run must leave no `claude` behind. */
    const end = async (outcome: 'timeout' | 'canceled'): Promise<void> => {
      if (settled || killing) return;
      killing = outcome;
      try {
        proc.end();
        await proc.stop(KILL_GRACE_MS);
      } catch (err) {
        o.logger.log('warn', 'killing a one-shot claude run failed', {
          runId,
          message: (err as Error).message,
        });
      }
      done(outcome);
    };

    proc.on('event', (ev) => {
      switch (ev.type) {
        case 'init':
          sawInit = true;
          return;
        case 'assistant_text': {
          if (!ev.text.trim()) return;
          said.push(ev.text);
          frame({ kind: 'assistant', text: ev.text });
          return;
        }
        case 'permission_request': {
          // No phone, no person, no prompt. Denied here and never emitted as an approval event,
          // so nothing downstream can decide to relay it.
          denials += 1;
          o.logger.log('info', 'one-shot run denied a permission prompt', {
            runId,
            tool: ev.toolName,
          });
          try {
            proc.answerPermission(ev.requestId, {
              behavior: 'deny',
              message: RUN_ONCE_DENY_MESSAGE,
            });
          } catch (err) {
            o.logger.log('warn', 'could not answer a one-shot permission prompt', {
              runId,
              message: (err as Error).message,
            });
          }
          frame({
            kind: 'system',
            subtype: 'run_once_denied',
            text: `Refused ${ev.toolName}: this run may only write ${
              input.allowedWrites.join(', ') || 'nothing'
            }.`,
          });
          return;
        }
        case 'result': {
          // A SIGINT ends the current turn and the agent answers with a `result` of its own.
          // That is the kill working, not the run finishing: the outcome was decided when the
          // kill started.
          if (killing) return;
          if (ev.text.trim()) said.push(ev.text);
          if (ev.ok) done('completed');
          else
            done('failed', {
              error: { code: 'agent_error', message: clip(ev.text || ev.subtype, 300) },
            });
          // Nothing more is coming; let the child exit on EOF rather than signalling it.
          proc.end();
          return;
        }
        default:
          return;
      }
    });

    proc.on('exit', ({ code }) => {
      if (settled) return;
      if (killing) {
        done(killing);
        return;
      }
      const stderr = clip(proc.lastStderr, 300);
      done('failed', {
        error: sawInit
          ? { code: 'exited', message: `claude exited (code ${code}) ${stderr}`.trim() }
          : {
              code: 'start_failed',
              message: `claude did not start (code ${code}) ${stderr}`.trim(),
            },
        exitCode: code,
      });
    });

    try {
      proc.start();
    } catch (err) {
      done('failed', {
        error: { code: 'start_failed', message: (err as Error).message },
      });
      return;
    }

    frame({
      kind: 'system',
      subtype: 'run_once_started',
      text: `Claude Code is running headless in ${input.cwd}.`,
    });

    if (input.signal?.aborted) {
      void end('canceled');
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => void end('timeout'), input.timeoutMs);
    timer.unref();

    try {
      proc.sendUser(input.prompt);
    } catch (err) {
      done('failed', { error: { code: 'start_failed', message: (err as Error).message } });
    }
  });
}

function outcomeText(outcome: RunOnceResult['outcome'], error?: RunOnceError): string {
  switch (outcome) {
    case 'completed':
      return 'Headless run finished.';
    case 'timeout':
      return 'Headless run timed out and was stopped.';
    case 'canceled':
      return 'Headless run was canceled.';
    default:
      return `Headless run failed: ${error?.message ?? 'unknown error'}`;
  }
}
