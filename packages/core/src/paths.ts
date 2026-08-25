import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Filesystem layout under `~/.pagr/` (override with `PAGR_HOME`, used by tests).
 *
 *   config.json     deviceId / userId / gatewayUrl / server keys (no secrets)
 *   projects.json   local project registry (the ONLY place local paths live)
 *   sessions.json   sessionId → provider session mapping
 *   replay.json     best-effort persisted nonce cache
 *   run/daemon.sock local IPC socket (0600)
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

export function getPaths(home: string = resolvePagrHome()): PagrPaths {
  return {
    home,
    configFile: join(home, 'config.json'),
    projectsFile: join(home, 'projects.json'),
    sessionsFile: join(home, 'sessions.json'),
    replayFile: join(home, 'replay.json'),
    policyFile: join(home, 'policy.json'),
    runDir: join(home, 'run'),
    socketPath: join(home, 'run', 'daemon.sock'),
    tmpDir: join(home, 'tmp'),
    logsDir: join(home, 'logs'),
    logFile: join(home, 'logs', 'daemon.log'),
    hooksDir: join(home, 'hooks'),
  };
}

/** Create the layout with user-only permissions. Idempotent. */
export function ensurePaths(home: string = resolvePagrHome()): PagrPaths {
  const p = getPaths(home);
  for (const dir of [p.home, p.runDir, p.tmpDir, p.logsDir, p.hooksDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir honours umask; enforce the mode we want regardless.
    try {
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }
  return p;
}
