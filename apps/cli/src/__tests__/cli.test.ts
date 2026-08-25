import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcServer } from '@pagr/bridge-core';
import {
  DaemonAlreadyRunningError,
  getPaths,
  IpcClientError,
  PRIVATE_KEY_SECRET,
} from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const DEV = `dev_${'a'.repeat(32)}`;
const USR = `usr_${'b'.repeat(32)}`;
const status = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: USR,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 1,
  sessions: 2,
  pendingApprovals: 0,
  socketPath: 'x',
  pid: 4242,
  startedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

describe('parsing', () => {
  it('prints help and exits 0', async () => {
    expect(await h.run(['--help'])).toBe(EXIT.ok);
    const out = plain(h.stdout);
    for (const c of [
      'connect',
      'status',
      'doctor',
      'projects',
      'project',
      'sessions',
      'daemon',
      'billing',
      'logout',
      'uninstall',
    ])
      expect(out).toContain(c);
  });
  it('unknown command → usage exit code', async () => {
    expect(await h.run(['nope'])).toBe(EXIT.usage);
  });
  it('--home overrides the pagr home', async () => {
    const other = join(h.home, '..', 'other');
    expect(await h.run(['--home', other, '--json', 'status'])).toBe(EXIT.ok);
    expect((lastJson(h) as { home: string }).home).toBe(other);
  });
});

describe('status', () => {
  it('falls back to config when the daemon is down', async () => {
    writeFileSync(
      getPaths(h.home).configFile,
      JSON.stringify({ deviceId: DEV, userId: USR, deviceName: 'mac' }),
    );
    h.execImpl = (f) => {
      if (f === 'codex') return 'codex-cli 0.40.0';
      throw new Error('ENOENT');
    };
    expect(await h.run(['status'])).toBe(EXIT.ok);
    const out = plain(h.stdout);
    expect(out).toContain('dev_aaaaaaaa…');
    expect(out).toContain('daemon not running');
    expect(out).toContain('codex-cli 0.40.0');
    expect(out).toMatch(/claude\s+✗ not found/);
  });
  it('reads from the daemon over IPC and supports --json', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['--json', 'status'])).toBe(EXIT.ok);
    const j = lastJson(h) as { daemon: { pid: number; transport: string }; sessions: number };
    expect(j.daemon).toMatchObject({ running: true, pid: 4242, transport: 'connected' });
    expect(j.sessions).toBe(2);
  });
});

describe('projects', () => {
  it('add/list/remove directly on the registry when the daemon is down', async () => {
    const repo = join(h.home, '..', 'repo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await h.run(['project', 'add', repo, '--name', 'Tonight', '--alias', 'tn,tonite'])).toBe(
      EXIT.ok,
    );
    expect(plain(h.stdout)).toMatch(/proj_[0-9a-f]{32}/);
    expect(plain(h.stdout)).toContain('next connect');
    h.stdout.length = 0;
    expect(await h.run(['--json', 'projects'])).toBe(EXIT.ok);
    const list = lastJson(h) as Array<{ displayName: string; aliases: string[] }>;
    expect(list[0]).toMatchObject({ displayName: 'Tonight', aliases: ['tn', 'tonite'] });
    h.stdout.length = 0;
    expect(await h.run(['project', 'remove', 'tn'])).toBe(EXIT.ok);
    h.stdout.length = 0;
    await h.run(['--json', 'projects']);
    expect(lastJson(h)).toEqual([]);
  });
  it('non-git folder → precondition error with hint', async () => {
    const dir = join(h.home, '..', 'plain');
    (await import('node:fs')).mkdirSync(dir, { recursive: true });
    expect(await h.run(['project', 'add', dir])).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain('--allow-non-git');
  });
  it('goes through IPC when the daemon is running', async () => {
    const calls: string[] = [];
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'projects.list': () => [
        { projectId: 'proj_1', displayName: 'A', aliases: ['a'], path: '/x' },
      ],
      'projects.add': (p) => {
        calls.push(JSON.stringify(p));
        return { projectId: 'proj_2', displayName: 'B', aliases: [], path: '/y' };
      },
      'projects.remove': (p) => {
        calls.push(`rm ${JSON.stringify(p)}`);
        return p;
      },
    });
    expect(await h.run(['project', 'add', '/y', '--name', 'B'])).toBe(EXIT.ok);
    expect(calls[0]).toBe(JSON.stringify({ path: '/y', displayName: 'B' }));
    expect(await h.run(['project', 'remove', 'a'])).toBe(EXIT.ok);
    expect(calls[1]).toBe('rm {"projectId":"proj_1"}');
    h.stdout.length = 0;
    expect(await h.run(['projects'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('proj_1');
  });
});

describe('sessions', () => {
  it('errors when the daemon is down', async () => {
    expect(await h.run(['sessions'])).toBe(EXIT.daemonDown);
  });
  it('lists via IPC', async () => {
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'sessions.list': () => [
        {
          sessionId: 'ses_1',
          provider: 'codex',
          projectId: 'proj_1',
          providerSessionId: 'x',
          status: 'working',
          startedAt: 't',
          updatedAt: 't',
        },
      ],
    });
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('ses_1');
    h.stdout.length = 0;
    await h.run(['--json', 'sessions']);
    expect((lastJson(h) as unknown[]).length).toBe(1);
  });
});

describe('daemon', () => {
  it('install writes the plist and status reports it', async () => {
    expect(await h.run(['daemon', 'install'])).toBe(EXIT.ok);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(true);
    h.execImpl = (_f, a) => {
      if (a[0] === 'print') return 'loaded';
      return '';
    };
    h.stdout.length = 0;
    expect(await h.run(['--json', 'daemon', 'status'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({ installed: true, loaded: true, running: false });
    expect(await h.run(['daemon', 'uninstall'])).toBe(EXIT.ok);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
  });
  it('logs prints the tail of daemon.log', async () => {
    const p = getPaths(h.home);
    (await import('node:fs')).mkdirSync(p.logsDir, { recursive: true });
    writeFileSync(p.logFile, ['a', 'b', 'c'].join('\n'));
    expect(await h.run(['daemon', 'logs', '-n', '2'])).toBe(EXIT.ok);
    expect(h.stdout).toEqual(['b', 'c']);
  });
  it('run honours PAGR_MOCK_AGENTS through the injected seam', async () => {
    let seen: boolean | undefined;
    h.overrides.env = { ...h.overrides.env, PAGR_MOCK_AGENTS: '1' };
    h.overrides.runDaemonForever = async (_c, o) => {
      seen = o.mock;
    };
    expect(await h.run(['daemon', 'run'])).toBe(EXIT.ok);
    expect(seen).toBe(true);
  });
  it('run surfaces "already running" from core as exit 5 with the core message', async () => {
    h.overrides.runDaemonForever = async () => {
      throw new DaemonAlreadyRunningError(h.home, 777);
    };
    expect(await h.run(['daemon', 'run'])).toBe(EXIT.precondition);
    const err = plain(h.stderr);
    expect(err).toContain(`another pagr daemon is already running for ${h.home} (pid 777)`);
    expect(err).toContain('daemon stop');
  });
  it('status reports the pid from the lock file even when the socket is unreachable', async () => {
    const p = getPaths(h.home);
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.lockFile, `${process.pid}\n`);
    expect(await h.run(['--json', 'daemon', 'status'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({ running: false, lockPid: process.pid });
    h.stdout.length = 0;
    expect(await h.run(['daemon', 'status'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain(`lock held by pid ${process.pid}`);
    // a live daemon: lock pid is reported alongside the IPC status
    server = await fakeDaemon(h.home, { status: () => status({ pid: process.pid }) });
    h.stdout.length = 0;
    expect(await h.run(['--json', 'daemon', 'status'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({ running: true, lockPid: process.pid });
  });
});

describe('billing', () => {
  it('opens the dashboard billing page, never touching cards', async () => {
    expect(await h.run(['billing', 'upgrade', '--web-url', 'https://app.test'])).toBe(EXIT.ok);
    expect(h.opened).toEqual(['https://app.test/app/billing?action=upgrade']);
  });
  it('derives web url from api url in config', async () => {
    writeFileSync(getPaths(h.home).configFile, JSON.stringify({ apiUrl: 'https://api.pagr.dev' }));
    await h.run(['--json', 'billing']);
    expect(lastJson(h)).toEqual({ action: 'status', url: 'https://app.pagr.dev/app/billing' });
  });
});

describe('logout / uninstall', () => {
  it('logout removes key + config, keeps projects, mentions revocation', async () => {
    const p = getPaths(h.home);
    writeFileSync(p.configFile, JSON.stringify({ deviceId: DEV }));
    writeFileSync(p.projectsFile, '{}');
    await h.store.set(PRIVATE_KEY_SECRET, 'pem');
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(await h.store.get(PRIVATE_KEY_SECRET)).toBeNull();
    expect(existsSync(p.configFile)).toBe(false);
    expect(existsSync(p.projectsFile)).toBe(true);
    expect(plain(h.stdout)).toContain('revoke');
    expect(h.execCalls.some((c) => c[1] === 'bootout')).toBe(true);
  });
  it('uninstall --yes removes the home directory', async () => {
    expect(await h.run(['uninstall', '--yes'])).toBe(EXIT.ok);
    expect(existsSync(h.home)).toBe(false);
  });
  it('uninstall aborts when not confirmed', async () => {
    h.overrides.confirm = async () => false;
    expect(await h.run(['uninstall'])).toBe(EXIT.usage);
    expect(existsSync(h.home)).toBe(true);
  });
});

describe('errors', () => {
  it('IPC method errors surface as messages', async () => {
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'projects.list': () => {
        throw new IpcClientError('boom', 'kaboom');
      },
    });
    expect(await h.run(['projects'])).toBe(EXIT.error);
    expect(plain(h.stderr)).toContain('kaboom');
  });
});
