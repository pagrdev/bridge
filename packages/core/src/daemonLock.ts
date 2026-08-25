import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Single-instance guard: `run/daemon.lock` holds the pid of the running daemon. Created with
 * O_EXCL so two daemons on the same `PAGR_HOME` can never both think they own the device
 * identity (which otherwise flaps the gateway connection and loses commands). A lock whose
 * pid is dead is stale and reclaimed. Released only by its owner, never by a bystander.
 */
export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly home: string,
    readonly pid: number | undefined,
  ) {
    super(
      pid === undefined
        ? `another pagr daemon is already running for ${home}`
        : `another pagr daemon is already running for ${home} (pid ${pid})`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

export interface DaemonLock {
  readonly path: string;
  readonly pid: number;
  /** Unlink the lock if (and only if) it still records our pid. */
  release(): void;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid recorded in the lock file, or null when absent/unparsable. */
export function readDaemonLock(lockPath: string): { pid: number } | null {
  try {
    const n = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? { pid: n } : null;
  } catch {
    return null;
  }
}

export interface AcquireDaemonLockOptions {
  lockPath: string;
  /** Only used for the error message. */
  home: string;
  pid?: number;
  /** Test seam. */
  isAlive?: (pid: number) => boolean;
}

export function acquireDaemonLock(opts: AcquireDaemonLockOptions): DaemonLock {
  const pid = opts.pid ?? process.pid;
  const alive = opts.isAlive ?? isPidAlive;
  const { lockPath } = opts;
  const lock: DaemonLock = {
    path: lockPath,
    pid,
    release() {
      if (readDaemonLock(lockPath)?.pid !== pid) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone
      }
    },
  };
  // One retry: the first attempt may find a stale lock, which we reclaim and try again.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readDaemonLock(lockPath);
    if (held && alive(held.pid)) throw new DaemonAlreadyRunningError(opts.home, held.pid);
    // Stale: the pid is dead or the content is garbage. Reclaim it.
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new DaemonAlreadyRunningError(opts.home, readDaemonLock(lockPath)?.pid);
}
