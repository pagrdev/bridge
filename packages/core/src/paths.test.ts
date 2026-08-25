import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePaths, getPaths, resolvePagrHome, resolveSocketPath } from './paths.js';
import { useTempHome } from './testUtil.js';

describe('paths', () => {
  const t = useTempHome();

  it('honours PAGR_HOME override', () => {
    expect(resolvePagrHome({ PAGR_HOME: '/x/y' })).toBe('/x/y');
    expect(resolvePagrHome({})).toMatch(/\.pagr$/);
  });

  it('lays out files and creates 0700 dirs', () => {
    const home = join(t.home, 'pagr');
    const p = ensurePaths(home);
    expect(p.socketPath).toBe(join(home, 'run', 'daemon.sock'));
    expect(p.configFile).toBe(join(home, 'config.json'));
    for (const d of [p.home, p.runDir, p.tmpDir, p.logsDir]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(getPaths(home)).toEqual(p);
  });

  it('falls back to a short per-user runtime socket when PAGR_HOME is too long (item 14)', () => {
    const long = join(t.home, 'x'.repeat(120), 'pagr');
    const p = ensurePaths(long);
    expect(Buffer.byteLength(p.socketPath)).toBeLessThanOrEqual(100);
    expect(p.socketPath).not.toBe(join(long, 'run', 'daemon.sock'));
    expect(p.socketPath).toMatch(new RegExp(`/pagr-${process.getuid?.() ?? 0}/`));
    expect(statSync(join(p.socketPath, '..')).mode & 0o777).toBe(0o700);
    // the chosen path is recorded so hooks / CLI / adapters can find it
    expect(p.socketPathFile).toBe(join(long, 'run', 'daemon.sock.path'));
    expect(readFileSync(p.socketPathFile, 'utf8').trim()).toBe(p.socketPath);
    expect(resolveSocketPath(long)).toBe(p.socketPath);
    // two long homes never share a socket
    const other = ensurePaths(join(t.home, 'y'.repeat(120), 'pagr'));
    expect(other.socketPath).not.toBe(p.socketPath);
    // short homes keep the in-home socket and still record it
    const short = ensurePaths(join(t.home, 'pagr'));
    expect(short.socketPath).toBe(join(t.home, 'pagr', 'run', 'daemon.sock'));
    expect(existsSync(short.socketPathFile)).toBe(true);
    expect(resolveSocketPath(join(t.home, 'pagr'))).toBe(short.socketPath);
    // unknown home without a recorded file → default location
    expect(resolveSocketPath(join(t.home, 'never'))).toBe(
      join(t.home, 'never', 'run', 'daemon.sock'),
    );
  });
});
