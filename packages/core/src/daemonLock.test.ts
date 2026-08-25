import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDaemonLock, DaemonAlreadyRunningError, readDaemonLock } from './daemonLock.js';
import { useTempHome } from './testUtil.js';

describe('daemon lock', () => {
  const t = useTempHome('pagr-lock-');
  const lockPath = () => join(t.home, 'daemon.lock');

  it('creates the lock with our pid and refuses a second holder while the pid is alive', () => {
    const lock = acquireDaemonLock({ lockPath: lockPath(), home: t.home });
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid));
    expect(readDaemonLock(lockPath())).toEqual({ pid: process.pid });
    let err: unknown;
    try {
      acquireDaemonLock({ lockPath: lockPath(), home: t.home, pid: process.pid + 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((err as Error).message).toBe(
      `another pagr daemon is already running for ${t.home} (pid ${process.pid})`,
    );
    expect((err as DaemonAlreadyRunningError).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('reclaims a stale lock whose pid is dead, or whose content is garbage', () => {
    writeFileSync(lockPath(), '999999\n');
    const lock = acquireDaemonLock({
      lockPath: lockPath(),
      home: t.home,
      isAlive: () => false,
    });
    expect(lock.pid).toBe(process.pid);
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid));
    lock.release();
    writeFileSync(lockPath(), 'not a pid');
    expect(readDaemonLock(lockPath())).toBeNull();
    const again = acquireDaemonLock({ lockPath: lockPath(), home: t.home });
    expect(readDaemonLock(lockPath())).toEqual({ pid: process.pid });
    again.release();
  });

  it('release() never unlinks a lock that is no longer ours', () => {
    const lock = acquireDaemonLock({ lockPath: lockPath(), home: t.home, pid: 4242 });
    writeFileSync(lockPath(), '5151\n'); // someone else took it over
    lock.release();
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe('5151');
  });
});
