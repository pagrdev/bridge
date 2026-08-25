import type { DaemonStatus } from '@pagr/bridge-core';
import { IpcClient, IpcClientError } from '@pagr/bridge-core';
import type { CliContext } from './context.js';

/** Returns the daemon status, or null when the socket is not reachable. */
export async function daemonStatus(ctx: CliContext): Promise<DaemonStatus | null> {
  try {
    return await new IpcClient(ctx.paths.socketPath).call<DaemonStatus>('status', undefined, 3000);
  } catch (err) {
    if (err instanceof IpcClientError && ['connect', 'closed', 'timeout'].includes(err.code))
      return null;
    throw err;
  }
}

export const ipc = (ctx: CliContext): IpcClient => new IpcClient(ctx.paths.socketPath);
