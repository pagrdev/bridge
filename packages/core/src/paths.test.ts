import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditPermissions,
  checkHomeWritable,
  ensurePaths,
  getPaths,
  PagrHomeError,
  repairPermissions,
  resolvePagrHome,
  resolveSocketPath,
  usesShortSocketFallback,
} from './paths.js';
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

describe('paths · writability and permissions', () => {
  const t = useTempHome();

  it('checkHomeWritable proves it by writing, and cleans up after itself', () => {
    const home = join(t.home, 'pagr');
    expect(checkHomeWritable(home)).toEqual({ ok: true });
    expect(readdirSync(home)).toEqual([]);
  });

  it('an unwritable home is reported with a permission code and a fix', () => {
    const home = join(t.home, 'locked');
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o500);
    try {
      const r = checkHomeWritable(home);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(PagrHomeError);
        expect(r.error.code).toBe('permission');
        expect(r.error.hint).toContain('chmod 700');
      }
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it('a file where a directory belongs is reported, not crashed on', () => {
    const home = join(t.home, 'afile');
    writeFileSync(home, 'not a directory');
    const err = (() => {
      try {
        ensurePaths(home);
      } catch (e) {
        return e;
      }
    })() as PagrHomeError;
    expect(err).toBeInstanceOf(PagrHomeError);
    expect(['not_a_directory', 'io']).toContain(err.code);
    expect(err.hint).toBeTruthy();
  });

  it('auditPermissions flags anything group- or world-readable', () => {
    const home = join(t.home, 'pagr2');
    const p = ensurePaths(home);
    writeFileSync(p.configFile, '{}', { mode: 0o644 });
    chmodSync(p.logsDir, 0o755);
    const issues = auditPermissions(p);
    expect(issues.map((i) => i.path).sort()).toEqual([p.configFile, p.logsDir].sort());
    expect(issues.find((i) => i.path === p.configFile)).toMatchObject({
      actual: '644',
      expected: '600',
      kind: 'file',
    });
  });

  it('repairPermissions tightens exactly those paths and is then idempotent', () => {
    const home = join(t.home, 'pagr3');
    const p = ensurePaths(home);
    writeFileSync(p.configFile, '{}', { mode: 0o666 });
    expect(repairPermissions(p)).toEqual([p.configFile]);
    expect(statSync(p.configFile).mode & 0o777).toBe(0o600);
    expect(repairPermissions(p)).toEqual([]);
    expect(auditPermissions(p)).toEqual([]);
  });

  it('a stricter-than-required mode is not a finding', () => {
    const home = join(t.home, 'pagr4');
    const p = ensurePaths(home);
    writeFileSync(p.configFile, '{}', { mode: 0o400 });
    expect(auditPermissions(p)).toEqual([]);
  });

  it('usesShortSocketFallback matches what chooseSocketPath actually does', () => {
    const shortHome = join(t.home, 'p');
    const longHome = join(t.home, 'y'.repeat(120), 'pagr');
    expect(usesShortSocketFallback(shortHome)).toBe(false);
    expect(usesShortSocketFallback(longHome)).toBe(true);
    expect(ensurePaths(longHome).socketPath).not.toContain(longHome);
  });
});
