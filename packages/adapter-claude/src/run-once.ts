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
 * It is the same `ClaudeProcess` every session uses, started the same way: the repository as its
 * cwd, the user's own setting sources, the same flags. A run is the same agent in the same
 * checkout under the same subscription as the session Pagr would have started there anyway, so
 * nothing here narrows what it may touch — the prompt says which file to write, exactly as it
 * does for any other run.
 *
 * What "nobody is watching" changes is two things, and both are about interactivity:
 *
 *   - `--permission-mode acceptEdits`, so the one file the run exists to write is written
 *     without raising a prompt. A session gets `default` because a person is there to answer;
 *     a run would just stall on the first `Write`.
 *   - every prompt that IS raised — `Bash`, the network, anything outside the workspace — is
 *     auto-denied on the spot, because there is no human to ask and `allow` is not ours to give.
 *     A run's prompt carries text the cloud supplied (a review's one line of intent), so a run
 *     that approved its own tool calls would hand a compromised cloud exactly the action
 *     `core/src/deviceFloor.ts` exists to refuse. Denying costs the run a shell it does not need
 *     and leaves it the same ceiling a session has.
 */

/** What a denied prompt tells the model, so it reports the refusal rather than retrying forever. */
export const RUN_ONCE_DENY_MESSAGE =
  'This is an automated one-shot run with no user attached, so there is nobody who can approve this. Writing the file you were asked for needs no approval. Do not ask again — say what you could not do and stop.';

/** SIGINT → SIGTERM grace for a run being killed. Short: nobody is waiting on its last words. */
const KILL_GRACE_MS = 1000;

export interface ClaudeRunOnceOptions {
  input: RunOnceInput;
  /** Base command, as the adapter resolved it (`['claude']`, or the fixture in tests). */
  command: string[];
  /** The child's environment, already built by the adapter. */
  env: NodeJS.ProcessEnv;
  /** `PAGR_CLAUDE_SETTING_SOURCES`, as a session gets it. */
  settingSources?: string | undefined;
  /** `PAGR_CLAUDE_SEALED`, as a session gets it. A run is sealed when a session would be. */
  sealed?: boolean | undefined;
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
    // Not `readOnly` — the whole point is one file.
    readOnly: false,
    // The only flag a run does not share with a session: nobody is here to accept an edit.
    permissionMode: 'acceptEdits',
    ...(o.settingSources ? { settingSources: o.settingSources } : {}),
    sealed: o.sealed ?? false,
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
            text: `Refused ${ev.toolName}: this run is headless, so there is nobody to approve it.`,
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
