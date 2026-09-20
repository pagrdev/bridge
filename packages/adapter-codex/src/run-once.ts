import type { RunOnceInput } from '@pagr/bridge-core';
import { writableRootsFor } from '@pagr/bridge-core';
import type {
  SandboxPolicy,
  SandboxWorkspaceWriteConfig,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from './protocol.js';

/**
 * How a one-shot Codex run is bounded (spec §3, §5; `core/src/adapters/runOnce.ts`).
 *
 * Three settings, and each is load bearing:
 *
 *   - `approvalPolicy: 'never'` — the run has no human attached, so an approval request is a
 *     hang. `never` makes Codex refuse the action itself instead of asking, which is the answer
 *     the bridge would have given anyway. (It is belt and braces: `adapter.ts` also declines any
 *     approval that reaches it for a run's thread, because `never` is a policy and policies get
 *     re-read.)
 *   - `sandbox: 'workspace-write'` plus `writableRoots` — the mode has to be `workspace-write`
 *     or the handoff file cannot be written at all; `read-only` has no writable-roots variant.
 *   - `networkAccess: false`, and /tmp and `$TMPDIR` excluded. A handoff writer reads a
 *     transcript and writes a note; it has no business on the network, and a scratch file in
 *     /tmp is a write nobody asked for.
 *
 * What this does NOT do is narrow writes to `allowedWrites` alone. Codex's `workspace-write`
 * grants the thread's `cwd` as well as `writableRoots` — the roots ADD to the workspace, they do
 * not replace it — so a run started at the repository root may write anywhere in that repository
 * whatever roots it is given. What the sandbox does stop is everything outside: the user's home,
 * a sibling checkout, /tmp. Claude's side of this (`adapter-claude/src/run-once.ts`) is bounded
 * by path rules and really is limited to the globs. The asymmetry is real and is the reason the
 * handoff engine treats a written file's CONTENT as the thing to check, never the tree.
 */

/** Codex's own name for "do not ask, refuse". */
export const RUN_ONCE_APPROVAL_POLICY = 'never' as const;

/** The policy, spelled for `turn/start`. */
export function runOnceSandboxPolicy(cwd: string, allowedWrites: string[]): SandboxPolicy {
  return {
    type: 'workspaceWrite',
    writableRoots: writableRootsFor(cwd, allowedWrites),
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

/** The same policy, spelled for `thread/start`'s config overrides. */
export function runOnceSandboxConfig(
  cwd: string,
  allowedWrites: string[],
): SandboxWorkspaceWriteConfig {
  return {
    writable_roots: writableRootsFor(cwd, allowedWrites),
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true,
  };
}

/** `thread/start` for a run. Its own thread, always: a run never joins a live one. */
export function runOnceThreadParams(input: Pick<RunOnceInput, 'cwd' | 'allowedWrites'>): {
  params: ThreadStartParams;
  writableRoots: string[];
} {
  const sandboxConfig = runOnceSandboxConfig(input.cwd, input.allowedWrites);
  return {
    params: {
      cwd: input.cwd,
      approvalPolicy: RUN_ONCE_APPROVAL_POLICY,
      sandbox: 'workspace-write',
      config: { sandbox_workspace_write: sandboxConfig },
    },
    writableRoots: sandboxConfig.writable_roots,
  };
}

/** `turn/start` for a run: the prompt, once, with the policy restated. */
export function runOnceTurnParams(
  threadId: string,
  input: Pick<RunOnceInput, 'cwd' | 'prompt' | 'allowedWrites'>,
): TurnStartParams {
  const text: UserInput = { type: 'text', text: input.prompt, text_elements: [] };
  return {
    threadId,
    input: [text],
    sandboxPolicy: runOnceSandboxPolicy(input.cwd, input.allowedWrites),
  };
}
