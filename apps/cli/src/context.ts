import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createSecretStore,
  type FetchFn,
  getPaths,
  LAUNCHCTL,
  type PagrPaths,
  resolvePagrHome,
  type SecretStore,
  sleepMs,
} from '@pagr/bridge-core';
import { CLI_VERSION } from './version.js';

// Single source of truth for the CLI version: `package.json`, never a literal. Re-exported here
// because every call site already imports its context from this module.
export { CLI_VERSION } from './version.js';

/** Synchronous exec used by doctor/launchctl checks. Throws on non-zero exit. */
export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number }) => string;

export interface CliContext {
  /** Resolved `PAGR_HOME` (default `~/.pagr`). */
  home: string;
  paths: PagrPaths;
  env: NodeJS.ProcessEnv;
  /**
   * The directory the person ran `pagr` in. A seam, not a convenience: commands that resolve a
   * project from where you are standing (`pagr handoff`) are otherwise untestable without
   * chdir-ing the whole test process.
   */
  cwd(): string;
  json: boolean;
  isTTY: boolean;
  /** Terminal width, for output that cannot wrap and stay useful (the pairing QR). */
  columns: number;
  /** Absolute path to the built `dist/bin.js`; used for the launch agent ProgramArguments. */
  binPath: string;
  bridgeVersion: string;
  out(line: string): void;
  err(line: string): void;
  exec: ExecFn;
  /** Long-running exec (e.g. `tail -f`): resolves when the child exits. */
  execStream(file: string, args: string[]): Promise<number>;
  /** Resolves false when no browser could be launched (SSH, headless, no handler). */
  openBrowser(url: string): Promise<boolean>;
  confirm(question: string): Promise<boolean>;
  /** Free-text answer to a question. Returns '' when there is no TTY to ask. */
  prompt(question: string): Promise<string>;
  /** Is launchd available on this machine? False in containers and on non-macOS. */
  hasLaunchctl(): boolean;
  /**
   * Register a Ctrl-C handler for the duration of a long command; returns a disposer.
   * Injected so tests can fire an interrupt deterministically.
   */
  onInterrupt(handler: () => void): () => void;
  secretStore(): Promise<SecretStore>;
  fetch?: FetchFn;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** TCP reachability probe (doctor). */
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  launchAgentsDir?: string;
  deviceName(): string;
  /** Seam for tests: the real `daemon run` never returns. */
  runDaemonForever?: (ctx: CliContext, opts: { mock: boolean }) => Promise<void>;
}

export type ContextOverrides = Partial<CliContext>;

const defaultExec: ExecFn = (file, args, opts) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts?.timeoutMs ?? 15_000,
  });

/**
 * Open a URL. `open`/`xdg-open` exiting non-zero (headless, no default browser, SSH) must be
 * reported, not swallowed — the user needs to be told to open the link themselves.
 */
function defaultOpenBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execFile(cmd, [url], { timeout: 10_000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/** A remote shell has no browser to open; auto-opening there just prints a scary error. */
export const isRemoteSession = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);

function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    }),
  );
}

function defaultPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(`${question} `, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

function defaultTcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function defaultExecStream(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

function defaultOnInterrupt(handler: () => void): () => void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export function defaultBinPath(): string {
  // dist/context.js → dist/bin.js (also correct when running from src via tsx: src/bin.ts)
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, here.endsWith('src') ? 'bin.ts' : 'bin.js');
}

export function createContext(overrides: ContextOverrides = {}): CliContext {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? resolvePagrHome(env);
  const ctx: CliContext = {
    home,
    paths: getPaths(home),
    env,
    cwd: () => process.cwd(),
    json: false,
    isTTY: Boolean(process.stderr.isTTY),
    columns: process.stdout.columns ?? 80,
    binPath: defaultBinPath(),
    bridgeVersion: CLI_VERSION,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    exec: defaultExec,
    execStream: defaultExecStream,
    openBrowser: defaultOpenBrowser,
    confirm: defaultConfirm,
    prompt: defaultPrompt,
    hasLaunchctl: () => existsSync(LAUNCHCTL),
    onInterrupt: defaultOnInterrupt,
    secretStore: () => createSecretStore({ home, env }),
    // Ref-ed on purpose: an unref-ed timer lets the process exit while a command is waiting
    // (mid-poll in `connect`, between gateway probes), which reads as a silent success.
    sleep: sleepMs,
    now: () => new Date(),
    tcpConnect: defaultTcpConnect,
    deviceName: () => hostname().replace(/\.local$/, ''),
    ...overrides,
  };
  // Keep paths consistent with a `--home` override applied later.
  ctx.paths = getPaths(ctx.home);
  return ctx;
}

/**
 * Re-derive home-dependent fields after `--home` is parsed. An injected `secretStore` is kept:
 * a test (or an embedder) that supplied its own store must not have it replaced by `--home`.
 */
export function withHome(
  ctx: CliContext,
  home: string,
  overrides: ContextOverrides = {},
): CliContext {
  const next = { ...ctx, home, paths: getPaths(home) };
  if (!overrides.secretStore) next.secretStore = () => createSecretStore({ home, env: ctx.env });
  return next;
}
