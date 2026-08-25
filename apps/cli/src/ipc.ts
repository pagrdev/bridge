import type { DaemonStatus } from '@pagr/bridge-core';
import { IpcClient, IpcClientError, resolveSocketPath } from '@pagr/bridge-core';
import type { CliContext } from './context.js';

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
