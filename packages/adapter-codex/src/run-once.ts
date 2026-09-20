import type { RunOnceInput } from '@pagr/bridge-core';
import type { ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

/**
 * How a one-shot Codex run is started (spec §3, §5; `core/src/adapters/runOnce.ts`).
 *
 * The same way an ordinary session is: the repository as the thread's `cwd`, and Codex's own
 * `workspace-write` sandbox. A run is the same agent in the same checkout under the same
 * subscription as the session Pagr would have started there anyway, so nothing here tries to
 * fence it into a corner of the tree — the prompt says which file to write.
 *
 * One setting differs from `startSession`, and it is about nobody being attached rather than
 * about what the run may touch: `approvalPolicy: 'never'`. An ordinary session asks
 * `on-request` and the question reaches a phone; a run has no phone to reach, so an approval
 * request is a hang. `never` makes Codex refuse the action itself rather than ask — the answer
 * the bridge would have given anyway, since it cannot grant an approval on a person's behalf.
 * (`adapter.ts` also declines any request that reaches it for a run's thread, because `never` is
 * a policy and policies get re-read.)
 */

/** Codex's own name for "do not ask, refuse". */
export const RUN_ONCE_APPROVAL_POLICY = 'never' as const;

/** `thread/start` for a run. Its own thread, always: a run never joins a live one. */
export function runOnceThreadParams(input: Pick<RunOnceInput, 'cwd'>): ThreadStartParams {
  return {
    cwd: input.cwd,
    approvalPolicy: RUN_ONCE_APPROVAL_POLICY,
    sandbox: 'workspace-write',
  };
}

/** `turn/start` for a run: the prompt, once. */
export function runOnceTurnParams(
  threadId: string,
  input: Pick<RunOnceInput, 'prompt'>,
): TurnStartParams {
  const text: UserInput = { type: 'text', text: input.prompt, text_elements: [] };
  return { threadId, input: [text] };
}
