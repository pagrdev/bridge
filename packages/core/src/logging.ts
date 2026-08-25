import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Absolute path of the JSON log file. Omit to log to stderr only. */
  file?: string;
  /** Minimum level written. Default `info`. */
  level?: LogLevel;
  /** Write to stderr as well as the file. Default true. */
  stderr?: boolean;
  /** Home directory to redact from strings. Default `os.homedir()`. */
  home?: string;
  /** Injectable clock. */
  now?: () => Date;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Replace occurrences of the user's home directory with `~` in any string, recursively. */
export function redactPaths<T>(value: T, home: string = homedir()): T {
  if (!home) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(home).join('~');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Minimal JSON-lines logger. The bridge emits NO telemetry: the only things that leave the
 * machine are the protocol events in `@pagr/protocol`. This logger writes locally only.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = LEVELS[opts.level ?? 'info'];
  const toStderr = opts.stderr ?? true;
  const home = opts.home ?? homedir();
  const now = opts.now ?? (() => new Date());
  if (opts.file) mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });

  const write = (lvl: LogLevel, msg: string, fields: Record<string, unknown>) => {
    if (LEVELS[lvl] < level) return;
    const line = JSON.stringify(
      redactPaths({ t: now().toISOString(), level: lvl, msg, ...fields }, home),
    );
    if (opts.file) {
      try {
        appendFileSync(opts.file, `${line}\n`, { mode: 0o600 });
      } catch {
        // never crash on logging
      }
    }
    if (toStderr) process.stderr.write(`${line}\n`);
  };

  const make = (base: Record<string, unknown>): Logger => ({
    debug: (m, f) => write('debug', m, { ...base, ...f }),
    info: (m, f) => write('info', m, { ...base, ...f }),
    warn: (m, f) => write('warn', m, { ...base, ...f }),
    error: (m, f) => write('error', m, { ...base, ...f }),
    child: (f) => make({ ...base, ...f }),
  });
  return make({});
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
