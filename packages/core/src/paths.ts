import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Filesystem layout under `~/.pagr/` (override with `PAGR_HOME`, used by tests).
 *
 *   config.json     deviceId / userId / gatewayUrl / server keys (no secrets)
 *   projects.json   local project registry (the ONLY place local paths live)
 *   sessions.json   sessionId → provider session mapping
 *   replay.json     best-effort persisted nonce cache
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
  socketPath: string;
  /** Text file holding the socket path actually in use (for hooks / CLI / adapters). */
  socketPathFile: string;
  tmpDir: string;
  logsDir: string;
  logFile: string;
  hooksDir: string;
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
    socketPath: chooseSocketPath(home),
    socketPathFile: join(home, 'run', 'daemon.sock.path'),
    tmpDir: join(home, 'tmp'),
    logsDir: join(home, 'logs'),
    logFile: join(home, 'logs', 'daemon.log'),
    hooksDir: join(home, 'hooks'),
  };
}

/** Create the layout with user-only permissions. Idempotent. */
export function ensurePaths(home: string = resolvePagrHome()): PagrPaths {
  const p = getPaths(home);
  const socketDir = join(p.socketPath, '..');
  for (const dir of [p.home, p.runDir, p.tmpDir, p.logsDir, p.hooksDir, socketDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir honours umask; enforce the mode we want regardless.
    try {
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }
  if (socketDir !== p.runDir) {
    const st = statSync(socketDir);
    if (st.uid !== (process.getuid?.() ?? st.uid))
      throw new Error(
        `${socketDir} is owned by another user; refusing to place the IPC socket there`,
      );
  }
  if (
    !existsSync(p.socketPathFile) ||
    readFileSync(p.socketPathFile, 'utf8').trim() !== p.socketPath
  )
    writeFileSync(p.socketPathFile, `${p.socketPath}\n`, { mode: 0o600 });
  return p;
}
