import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Filesystem layout under `~/.pagr/` (override with `PAGR_HOME`, used by tests).
 *
 *   config.json     deviceId / userId / gatewayUrl / server keys (no secrets)
 *   projects.json   local project registry (the ONLY place local paths live)
 *   sessions.json   sessionId → provider session mapping
 *   replay.json     best-effort persisted nonce cache
 *   run/daemon.lock pid of the running daemon (O_EXCL; single-instance guard)
 *   run/daemon.sock local IPC socket (0600). If that path would exceed the 104-byte
 *                   `sun_path` limit (long PAGR_HOME), the socket lives in a short per-user
 *                   runtime dir instead and its location is written to run/daemon.sock.path.
 *   tmp/            downloaded attachments (0600, deleted after use)
 *   logs/           daemon.log
 */
export interface PagrPaths {
  home: string;
  configFile: string;
  projectsFile: string;
  sessionsFile: string;
  replayFile: string;
  policyFile: string;
  runDir: string;
  /** Single-instance lock holding the daemon pid. */
  lockFile: string;
  socketPath: string;
  /** Text file holding the socket path actually in use (for hooks / CLI / adapters). */
  socketPathFile: string;
  tmpDir: string;
  logsDir: string;
  logFile: string;
  hooksDir: string;
}

export type PagrHomeErrorCode =
  /** EACCES / EPERM: the directory exists but this user may not write it. */
  | 'permission'
  /** ENOSPC / EDQUOT: the disk (or quota) is full. */
  | 'no_space'
  /** EROFS: read-only filesystem. */
  | 'read_only'
  /** ENOTDIR: something on the path is a file. */
  | 'not_a_directory'
  /** The socket directory belongs to another user. */
  | 'foreign_owner'
  | 'io';

export class PagrHomeError extends Error {
  readonly hint: string | undefined;
  constructor(
    readonly code: PagrHomeErrorCode,
    readonly path: string,
    message: string,
    o: { hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'PagrHomeError';
    this.hint = o.hint;
    if (o.cause !== undefined) this.cause = o.cause;
  }
}

const HOME_HINTS: Record<PagrHomeErrorCode, string> = {
  permission:
    'fix the owner/permissions (`sudo chown -R "$(whoami)" <path> && chmod 700 <path>`), or point PAGR_HOME somewhere you own',
  no_space: 'free some disk space and run the command again',
  read_only: 'PAGR_HOME is on a read-only volume — set PAGR_HOME to a writable directory',
  not_a_directory: 'a file is sitting where pagr needs a directory — move or delete it',
  foreign_owner: 'another user owns that runtime directory — set TMPDIR or PAGR_HOME elsewhere',
  io: 'run `pagr doctor` for details',
};

function homeError(path: string, err: unknown, what: string): PagrHomeError {
  const code = (err as NodeJS.ErrnoException).code;
  const map: Record<string, PagrHomeErrorCode> = {
    EACCES: 'permission',
    EPERM: 'permission',
    ENOSPC: 'no_space',
    EDQUOT: 'no_space',
    EROFS: 'read_only',
    ENOTDIR: 'not_a_directory',
  };
  const mapped = (code && map[code]) || 'io';
  const raw = err instanceof Error ? err.message : String(err);
  return new PagrHomeError(mapped, path, `${what} ${path}: ${raw}`, {
    hint: HOME_HINTS[mapped].replace(/<path>/g, path),
    cause: err,
  });
}

export function resolvePagrHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAGR_HOME;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), '.pagr');
}

/**
 * macOS limits `sun_path` to 104 bytes (Linux 108); `net.listen` on a longer path silently
 * binds nothing and the daemon then died on `chmod`. Keep a margin for the NUL terminator.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Short, per-user, per-home socket path used when the in-home path is too long. */
export function shortSocketPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  const tag = createHash('sha256').update(home).digest('hex').slice(0, 8);
  const candidates = [join('/tmp', `pagr-${uid}`), join(env.TMPDIR || tmpdir(), `pagr-${uid}`)];
  for (const dir of candidates) {
    const p = join(dir, `${tag}.sock`);
    if (Buffer.byteLength(p) <= MAX_SOCKET_PATH_BYTES) return p;
  }
  return join(candidates[0] as string, `${tag}.sock`);
}

export function chooseSocketPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const preferred = join(home, 'run', 'daemon.sock');
  return Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES
    ? preferred
    : shortSocketPath(home, env);
}

/** True when the in-home socket path would be too long and the short fallback is in play. */
export const usesShortSocketFallback = (home: string): boolean =>
  Buffer.byteLength(join(home, 'run', 'daemon.sock')) > MAX_SOCKET_PATH_BYTES;

/**
 * Socket path clients should connect to: the recorded `run/daemon.sock.path` if the daemon
 * wrote one, else the default computed location.
 */
export function resolveSocketPath(home: string = resolvePagrHome()): string {
  try {
    const recorded = readFileSync(join(home, 'run', 'daemon.sock.path'), 'utf8').trim();
    if (recorded && isAbsolute(recorded)) return recorded;
  } catch {
    // not written yet
  }
  return chooseSocketPath(home);
}

export function getPaths(home: string = resolvePagrHome()): PagrPaths {
  return {
    home,
    configFile: join(home, 'config.json'),
    projectsFile: join(home, 'projects.json'),
    sessionsFile: join(home, 'sessions.json'),
    replayFile: join(home, 'replay.json'),
    policyFile: join(home, 'policy.json'),
    runDir: join(home, 'run'),
    lockFile: join(home, 'run', 'daemon.lock'),
    socketPath: chooseSocketPath(home),
    socketPathFile: join(home, 'run', 'daemon.sock.path'),
    tmpDir: join(home, 'tmp'),
    logsDir: join(home, 'logs'),
    logFile: join(home, 'logs', 'daemon.log'),
    hooksDir: join(home, 'hooks'),
  };
}

/**
 * Create the layout with user-only permissions. Idempotent. Every filesystem failure comes back
 * as a `PagrHomeError` carrying a fix, never a raw ENOSPC/EACCES stack.
 */
export function ensurePaths(home: string = resolvePagrHome()): PagrPaths {
  const p = getPaths(home);
  const socketDir = join(p.socketPath, '..');
  for (const dir of [p.home, p.runDir, p.tmpDir, p.logsDir, p.hooksDir, socketDir]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw homeError(dir, err, 'could not create');
    }
    // mkdir honours umask; enforce the mode we want regardless.
    try {
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }
  if (socketDir !== p.runDir) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(socketDir);
    } catch (err) {
      throw homeError(socketDir, err, 'could not inspect');
    }
    if (st.uid !== (process.getuid?.() ?? st.uid))
      throw new PagrHomeError(
        'foreign_owner',
        socketDir,
        `${socketDir} is owned by another user; refusing to place the IPC socket there`,
        { hint: HOME_HINTS.foreign_owner },
      );
  }
  try {
    if (
      !existsSync(p.socketPathFile) ||
      readFileSync(p.socketPathFile, 'utf8').trim() !== p.socketPath
    )
      writeFileSync(p.socketPathFile, `${p.socketPath}\n`, { mode: 0o600 });
  } catch (err) {
    throw homeError(p.socketPathFile, err, 'could not write');
  }
  return p;
}

/**
 * Actually write a file under `home` — the only honest way to know whether `pagr connect` can
 * persist anything. Catches a full disk, a read-only volume and a foreign owner alike.
 */
export function checkHomeWritable(
  home: string,
): { ok: true } | { ok: false; error: PagrHomeError } {
  const probe = join(home, `.write-probe.${process.pid}`);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(probe, 'ok', { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: homeError(home, err, 'cannot write to') };
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // nothing to clean up
    }
  }
}

export interface PermissionIssue {
  path: string;
  /** Octal string, e.g. `755`. */
  actual: string;
  expected: string;
  kind: 'dir' | 'file';
}

const EXPECTED_DIR_MODE = 0o700;
const EXPECTED_FILE_MODE = 0o600;

/**
 * Anything under PAGR_HOME group- or world-readable is a finding: `config.json` pins the
 * server keys and `projects.json` is the only place local paths live.
 */
export function auditPermissions(paths: PagrPaths): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  const check = (path: string, kind: 'dir' | 'file', expected: number) => {
    if (!existsSync(path)) return;
    let mode: number;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      return;
    }
    // Stricter than expected is fine; anything readable by group/other is not.
    if ((mode & ~expected) !== 0)
      issues.push({
        path,
        actual: mode.toString(8).padStart(3, '0'),
        expected: expected.toString(8).padStart(3, '0'),
        kind,
      });
  };
  for (const d of [paths.home, paths.runDir, paths.tmpDir, paths.logsDir, paths.hooksDir])
    check(d, 'dir', EXPECTED_DIR_MODE);
  for (const f of [
    paths.configFile,
    paths.projectsFile,
    paths.sessionsFile,
    paths.replayFile,
    paths.policyFile,
    paths.socketPathFile,
    join(paths.home, 'secrets.json'),
  ])
    check(f, 'file', EXPECTED_FILE_MODE);
  return issues;
}

/** Tighten every issue `auditPermissions` found. Returns the paths that were changed. */
export function repairPermissions(paths: PagrPaths): string[] {
  const fixed: string[] = [];
  for (const issue of auditPermissions(paths)) {
    try {
      chmodSync(issue.path, issue.kind === 'dir' ? EXPECTED_DIR_MODE : EXPECTED_FILE_MODE);
      fixed.push(issue.path);
    } catch {
      // reported by the audit on the next run
    }
  }
  return fixed;
}
