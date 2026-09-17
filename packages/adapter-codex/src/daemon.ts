import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppServerClient } from './app-server.js';
import { FileLogger } from './logger.js';

/**
 * Finding and attaching to Codex's shared app-server daemon.
 *
 * Everything here comes from the MOB-043 spike (`docs/spikes/2026-09-17-codex-daemon-attach.md`)
 * run against `codex-cli 0.149.1`:
 *
 *   - the control socket is `$CODEX_HOME/app-server-control/app-server-control.sock`;
 *   - it speaks WebSocket, not newline JSON (see `app-server.ts`);
 *   - `codex app-server daemon start` only works for the installer-managed standalone package, so
 *     the bridge NEVER starts one. It attaches to a daemon the user already runs, or it spawns
 *     its own private stdio child and says so.
 */

export const CONTROL_SOCKET_DIR = 'app-server-control';
export const CONTROL_SOCKET_FILE = 'app-server-control.sock';

/** The daemon client's own `initialize` timeout upstream (`app-server-daemon/src/client.rs`). */
export const DAEMON_PROBE_TIMEOUT_MS = 2000;

/** macOS `SUN_LEN`. A longer path cannot be connected to at all, so it is not worth probing. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 104;

/** What the adapter is talking to. Reported by `probe()` as `AgentConnectionStatus.mode`. */
export type CodexMode = 'app-server-daemon' | 'app-server-embedded';

/** `CODEX_HOME`, else `$HOME/.codex`. Never touches the filesystem. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CODEX_HOME?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME ?? os.homedir(), '.codex');
}

export function controlSocketPath(home: string): string {
  return path.join(home, CONTROL_SOCKET_DIR, CONTROL_SOCKET_FILE);
}

/** True when something is listening-shaped at that path: it exists and it is a socket. */
export function controlSocketPresent(socketPath: string): boolean {
  try {
    if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) return false;
    if (!existsSync(socketPath)) return false;
    return statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

export interface DaemonProbeResult {
  /** The daemon answered `initialize` within the timeout. */
  attached: boolean;
  socketPath: string;
  /** The home the daemon itself reports, which may differ from the one we looked in. */
  codexHome?: string;
  /** Parsed out of the `initialize` response's `userAgent`. */
  version?: string;
  /** Why we are not attached. `absent`: no socket. `probe_failed`: a socket that did not answer. */
  reason?: 'absent' | 'probe_failed';
  error?: string;
}

/** `codex-cli 0.149.1 (Mac OS …)` → `0.149.1`. */
export function versionFromUserAgent(userAgent: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(userAgent)?.[1];
}

export interface ProbeDaemonOptions {
  socketPath: string;
  clientVersion?: string;
  timeoutMs?: number;
  logger?: FileLogger;
}

/**
 * Connect, `initialize`, read the version and the home back, disconnect.
 *
 * Deliberately short-lived: a probe that stayed connected would be one more subscriber on a
 * daemon that broadcasts to all of them, and `pagr doctor` runs it on demand.
 */
export async function probeDaemon(opts: ProbeDaemonOptions): Promise<DaemonProbeResult> {
  const socketPath = opts.socketPath;
  if (!controlSocketPresent(socketPath)) return { attached: false, socketPath, reason: 'absent' };
  const logger = opts.logger ?? new FileLogger(null);
  const client = new AppServerClient({
    transport: { kind: 'daemon', socketPath },
    clientVersion: opts.clientVersion ?? '0.1.0',
    requestTimeoutMs: opts.timeoutMs ?? DAEMON_PROBE_TIMEOUT_MS,
    logger,
  });
  try {
    const res = await client.start();
    const out: DaemonProbeResult = { attached: true, socketPath, codexHome: res.codexHome };
    const version = versionFromUserAgent(res.userAgent);
    if (version) out.version = version;
    return out;
  } catch (err) {
    return {
      attached: false,
      socketPath,
      reason: 'probe_failed',
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    await client.stop().catch(() => {});
  }
}

/** The hint `pagr doctor` prints when there is no daemon to attach to. */
export const DAEMON_START_HINT =
  'run `codex app-server daemon start` (installer-managed builds only)';

export interface DoctorLine {
  name: 'codex daemon';
  status: 'ok' | 'warn';
  detail: string;
  fix?: string;
}

/**
 * One line, three states — attached, not running, embedded fallback.
 *
 * Never `fail`: a Mac with no Codex daemon is a correct Mac (the desktop app and the IDE
 * extensions do not use one either), and the bridge still works through its own child.
 */
export function daemonDoctorLine(p: DaemonProbeResult): DoctorLine {
  if (p.attached)
    return {
      name: 'codex daemon',
      status: 'ok',
      detail: `attached (${p.version ?? 'unknown version'})`,
    };
  if (p.reason === 'absent')
    return {
      name: 'codex daemon',
      status: 'warn',
      detail: `not running (${DAEMON_START_HINT})`,
      fix: 'terminal Codex threads are mirrored only while a shared daemon is running; without one Pagr uses its own app-server',
    };
  return {
    name: 'codex daemon',
    status: 'warn',
    detail: `embedded fallback — ${p.socketPath} did not answer${p.error ? `: ${p.error}` : ''}`,
    fix: 'check that the daemon is healthy with `codex app-server daemon version`',
  };
}
