import { execFile, execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createSecretStore,
  type FetchFn,
  getPaths,
  type PagrPaths,
  resolvePagrHome,
  type SecretStore,
} from '@pagr/bridge-core';

export const CLI_VERSION = '0.1.0';

/** Synchronous exec used by doctor/launchctl checks. Throws on non-zero exit. */
export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number }) => string;

export interface CliContext {
  /** Resolved `PAGR_HOME` (default `~/.pagr`). */
  home: string;
  paths: PagrPaths;
  env: NodeJS.ProcessEnv;
  json: boolean;
  isTTY: boolean;
  /** Absolute path to the built `dist/bin.js`; used for the launch agent ProgramArguments. */
  binPath: string;
  bridgeVersion: string;
  out(line: string): void;
  err(line: string): void;
  exec: ExecFn;
  /** Long-running exec (e.g. `tail -f`): resolves when the child exits. */
  execStream(file: string, args: string[]): Promise<number>;
  openBrowser(url: string): Promise<void>;
  confirm(question: string): Promise<boolean>;
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

function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [url], () => resolve());
  });
}

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
    json: false,
    isTTY: Boolean(process.stderr.isTTY),
    binPath: defaultBinPath(),
    bridgeVersion: CLI_VERSION,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    exec: defaultExec,
    execStream: defaultExecStream,
    openBrowser: defaultOpenBrowser,
    confirm: defaultConfirm,
    secretStore: () => createSecretStore({ home, env }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    tcpConnect: defaultTcpConnect,
    deviceName: () => hostname().replace(/\.local$/, ''),
    ...overrides,
  };
  // Keep paths consistent with a `--home` override applied later.
  ctx.paths = getPaths(ctx.home);
  return ctx;
}

/** Re-derive home-dependent fields after `--home` is parsed. */
export function withHome(ctx: CliContext, home: string): CliContext {
  const next = { ...ctx, home, paths: getPaths(home) };
  next.secretStore = () => createSecretStore({ home, env: ctx.env });
  return next;
}
