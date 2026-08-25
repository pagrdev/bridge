import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, IpcServer, MemorySecretStore } from '@pagr/bridge-core';
import type { ContextOverrides } from '../context.js';
import { run } from '../index.js';

export interface Harness {
  home: string;
  launchAgentsDir: string;
  stdout: string[];
  stderr: string[];
  execCalls: string[][];
  opened: string[];
  store: MemorySecretStore;
  overrides: ContextOverrides;
  /** Per-binary responder for `exec`; throw to simulate a missing binary. */
  execImpl: (file: string, args: string[]) => string;
  run(argv: string[]): Promise<number>;
  cleanup(): void;
}

export function harness(extra: ContextOverrides = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-cli-')));
  const home = join(root, 'pagr');
  const launchAgentsDir = join(root, 'LaunchAgents');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const h: Harness = {
    home,
    launchAgentsDir,
    stdout: [],
    stderr: [],
    execCalls: [],
    opened: [],
    store: new MemorySecretStore(),
    execImpl: () => '',
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
    openBrowser: async (u) => void h.opened.push(u),
    confirm: async () => true,
    secretStore: async () => h.store,
    sleep: async () => {},
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
