import { resolve } from 'node:path';
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
 * Four settings, and each is load bearing:
 *
 *   - `cwd: <repo>/.pagr` — **the working directory is the sandbox**, and this is the whole of
 *     HND-015. Codex's `workspace-write` always grants the thread's own `cwd` on top of
 *     `writableRoots` (`SandboxPolicy::get_writable_roots_with_cwd` upstream: "always include
 *     defaults: cwd, /tmp …"), so a run started at the repository root could write anywhere in
 *     the repository whatever roots it was handed. Starting it inside `.pagr` makes the widest
 *     thing the sandbox grants the directory Pagr owns. Source files are outside it, so a
 *     reviewer that decides to fix what it found is refused by the kernel and not by its prompt.
 *   - `approvalPolicy: 'never'` — the run has no human attached, so an approval request is a
 *     hang. `never` makes Codex refuse the action itself instead of asking, which is the answer
 *     the bridge would have given anyway. (It is belt and braces: `adapter.ts` also declines any
 *     approval that reaches it for a run's thread, because `never` is a policy and policies get
 *     re-read.)
 *   - `sandbox: 'workspace-write'` plus `writableRoots` — the mode has to be `workspace-write`
 *     or the handoff file cannot be written at all; `read-only` has no writable-roots variant.
 *     The roots stay relative to the REPOSITORY (`<repo>/.pagr/review/<id>`, not the cwd), which
 *     is what keeps `allowedWrites` meaning the same thing on both adapters.
 *   - `networkAccess: false`, and /tmp and `$TMPDIR` excluded. A handoff writer reads a
 *     transcript and writes a note; it has no business on the network, and a scratch file in
 *     /tmp is a write nobody asked for.
 *
 * What this still does NOT do is narrow writes to `allowedWrites` alone. The cwd is granted
 * whole, so a run allowed `.pagr/review/<id>/**` can in fact write anywhere under `.pagr` — one
 * review could overwrite another's report, and a handoff writer could overwrite an old note.
 * That is a directory Pagr created, excluded from git and never read back as instructions, and
 * narrowing it further would mean a cwd per run in a directory the caller has to create first.
 * The boundary that matters — nothing in the repository, nothing in your home, nothing in a
 * sibling checkout, no network — is the kernel's.
 *
 * Reads are deliberately NOT narrowed with it. `workspace-write` grants full-disk read
 * (`has_full_disk_read_access()` is unconditionally true upstream; the seatbelt profile gets a
 * bare `(allow file-read*)`), so a reviewer whose cwd is `.pagr` still opens any file in the
 * repository it wants to look at. It loses nothing but the ability to change one.
 */

/** The directory a run is started in, under the repository. Pagr's own; git-excluded. */
export const RUN_ONCE_SANDBOX_DIR = '.pagr';

/** Codex's own name for "do not ask, refuse". */
export const RUN_ONCE_APPROVAL_POLICY = 'never' as const;

/**
 * Where the thread is started: `<repo>/.pagr`, never the repository root.
 *
 * The one function that decides what a `workspace-write` run may reach, because the cwd IS the
 * workspace. `adapter.ts` creates it before `thread/start`; a Codex thread cannot be started in
 * a directory that does not exist.
 */
export function runOnceSandboxCwd(cwd: string): string {
  return resolve(cwd, RUN_ONCE_SANDBOX_DIR);
}

/**
 * Every directory a run may write, in the order the sandbox composes them: the thread's cwd
 * first, then the declared roots.
 *
 * Exported because "what can this run write?" is a question about the pair, never about either
 * half — reading `writableRoots` alone is exactly the mistake HND-015 is about.
 */
export function runOnceWritableRoots(input: Pick<RunOnceInput, 'cwd' | 'allowedWrites'>): string[] {
  return [runOnceSandboxCwd(input.cwd), ...writableRootsFor(input.cwd, input.allowedWrites)];
}

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
  /** `<repo>/.pagr`. The caller must create it before starting the thread. */
  sandboxCwd: string;
  writableRoots: string[];
} {
  const sandboxConfig = runOnceSandboxConfig(input.cwd, input.allowedWrites);
  const sandboxCwd = runOnceSandboxCwd(input.cwd);
  return {
    params: {
      cwd: sandboxCwd,
      approvalPolicy: RUN_ONCE_APPROVAL_POLICY,
      sandbox: 'workspace-write',
      config: { sandbox_workspace_write: sandboxConfig },
    },
    sandboxCwd,
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
