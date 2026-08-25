import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPaths,
  IpcServer,
  KeyringSecretStore,
  MemorySecretStore,
  type SecretStore,
} from '@pagr/bridge-core';
import type { ContextOverrides } from '../context.js';
import { run } from '../index.js';

export interface Harness {
  home: string;
  launchAgentsDir: string;
  stdout: string[];
  stderr: string[];
  execCalls: string[][];
  opened: string[];
  store: SecretStore;
  overrides: ContextOverrides;
  /** Per-binary responder for `exec`; throw to simulate a missing binary. */
  execImpl: (file: string, args: string[]) => string;
  /** Make `openBrowser` report failure (headless / no default browser). */
  browserOpens: boolean;
  /** Make `/bin/launchctl` look absent. */
  launchctl: boolean;
  /** Fire every registered Ctrl-C handler. */
  interrupt(): void;
  /** Milliseconds the injected clock advances on every `sleep()`. */
  clockStepMs: number;
  /** The injected clock's current value. */
  nowMs: number;
  run(argv: string[]): Promise<number>;
  cleanup(): void;
}

export function harness(extra: ContextOverrides = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-cli-')));
  const home = join(root, 'pagr');
  const launchAgentsDir = join(root, 'LaunchAgents');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const interruptHandlers = new Set<() => void>();
  const h: Harness = {
    home,
    launchAgentsDir,
    stdout: [],
    stderr: [],
    execCalls: [],
    opened: [],
    store: new MemorySecretStore(),
    execImpl: () => '',
    browserOpens: true,
    launchctl: true,
    clockStepMs: 1000,
    nowMs: Date.parse('2026-08-25T12:00:00.000Z'),
    interrupt: () => {
      for (const fn of [...interruptHandlers]) fn();
    },
    overrides: {},
    run: (argv) => run(argv, h.overrides),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  h.overrides = {
    home,
    env: { HOME: root, PATH: '/usr/bin' },
    isTTY: false,
    binPath: '/opt/pagr/dist/bin.js',
    launchAgentsDir,
    out: (l) => h.stdout.push(l),
    err: (l) => h.stderr.push(l),
    exec: (file, args) => {
      h.execCalls.push([file, ...args]);
      return h.execImpl(file, args);
    },
    execStream: async () => 0,
    openBrowser: async (u) => {
      h.opened.push(u);
      return h.browserOpens;
    },
    confirm: async () => true,
    hasLaunchctl: () => h.launchctl,
    onInterrupt: (fn) => {
      interruptHandlers.add(fn);
      return () => interruptHandlers.delete(fn);
    },
    secretStore: async () => h.store,
    // A virtual clock: `sleep` is instant but time still moves, so poll deadlines are reachable
    // in a millisecond of real time and no test can spin.
    sleep: async (ms) => {
      h.nowMs += Math.max(ms, h.clockStepMs);
    },
    now: () => new Date(h.nowMs),
    tcpConnect: async () => true,
    deviceName: () => 'test-mac',
    runDaemonForever: async () => {},
    ...extra,
  };
  return h;
}

/** Fake daemon: an IpcServer on the harness socket path with canned methods. */
export async function fakeDaemon(
  home: string,
  methods: Record<string, (p: unknown) => unknown>,
): Promise<IpcServer> {
  const paths = getPaths(home);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const server = new IpcServer({ socketPath: paths.socketPath });
  for (const [k, v] of Object.entries(methods)) server.registerMethod(k, v);
  await server.listen();
  return server;
}

export const plain = (lines: string[]) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
  lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

export const lastJson = (h: Harness): unknown => JSON.parse(h.stdout.join('\n'));

/** Parse the JSON error document `--json` writes to stdout. */
export const errJson = (h: Harness): { ok: false; error: Record<string, unknown> } =>
  JSON.parse(h.stdout.join('\n')) as { ok: false; error: Record<string, unknown> };

/**
 * A real `KeyringSecretStore` over a native Entry that throws the given macOS message — so the
 * production classification path (not a shortcut) is what the test exercises.
 */
export function failingKeychain(message: string): SecretStore {
  class FailingEntry {
    constructor(
      readonly service: string,
      readonly user: string,
    ) {}
    getPassword(): string | null {
      throw new Error(message);
    }
    setPassword(): void {
      throw new Error(message);
    }
    deleteCredential(): boolean {
      throw new Error(message);
    }
  }
  return new KeyringSecretStore(FailingEntry);
}
