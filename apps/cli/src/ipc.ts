import type { DaemonStatus } from '@pagr/bridge-core';
import { IpcClient, IpcClientError, resolveSocketPath } from '@pagr/bridge-core';
import type { CliContext } from './context.js';
import { CliError, daemonDownError, EXIT } from './errors.js';

/** The socket the daemon actually bound (`run/daemon.sock.path`), falling back to the default. */
export const socketPath = (ctx: CliContext): string => resolveSocketPath(ctx.home);

/** Returns the daemon status, or null when the socket is not reachable. */
export async function daemonStatus(ctx: CliContext): Promise<DaemonStatus | null> {
  try {
    return await new IpcClient(socketPath(ctx)).call<DaemonStatus>('status', undefined, 3000);
  } catch (err) {
    if (err instanceof IpcClientError && ['connect', 'closed', 'timeout'].includes(err.code))
      return null;
    throw err;
  }
}

export const ipc = (ctx: CliContext): IpcClient => new IpcClient(socketPath(ctx));

/**
 * IPC error code → exit code, for the commands that drive the daemon's dispatcher (`pagr
 * handoff`, `pagr review`).
 *
 * The contract a script reads: something this Mac REFUSED (the directory is not a repository,
 * the agent is not signed in, another agent already holds the tree, the repository has no
 * commit to compare against) exits 5, while something that was attempted and FAILED (the agent
 * never wrote its file, a pre-commit hook rejected the WIP commit, the sender would not stop)
 * exits 1, and something the person typed wrong exits 2. They are different problems with
 * different fixes, and a script must be able to tell them apart without reading English.
 */
export const EXIT_FOR_CODE: Record<string, number> = {
  capability_unsupported: EXIT.precondition,
  unknown_session: EXIT.precondition,
  unknown_project: EXIT.precondition,
  not_negotiated: EXIT.precondition,
  rate_limited: EXIT.precondition,
  // `pagr review`, from `ReviewRangeError`: there is nothing sensible to point a reviewer at.
  not_a_repo: EXIT.precondition,
  no_commits: EXIT.precondition,
  root_commit: EXIT.precondition,
  // The range was the person's to type, so a bad one is usage — as is any payload we built wrong.
  bad_range: EXIT.usage,
  invalid_payload: EXIT.usage,
  // The work was attempted and did not produce what it promised.
  no_report: EXIT.error,
  provider_error: EXIT.error,
  // Somebody stopped it. Still a non-zero exit — the command did not produce the verdict it was
  // asked for — but it reuses `error` rather than taking a sixth code, because `EXIT_CODES` is
  // asserted to be exactly six in the web CLI reference (see HND-034b).
  canceled: EXIT.error,
};

/** Any IPC failure, as the CliError the exit-code contract describes. */
export function fromIpc(err: unknown, hint?: string): CliError {
  if (!(err instanceof IpcClientError)) return new CliError(String(err), EXIT.error);
  if (err.code === 'connect') return daemonDownError();
  return new CliError(err.message, EXIT_FOR_CODE[err.code] ?? EXIT.error, {
    code: err.code,
    ...(hint ? { hint } : {}),
  });
}
