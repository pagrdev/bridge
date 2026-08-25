import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPaths, type IpcServer, PRIVATE_KEY_SECRET } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { FakeApi } from './fakeApi.js';
import { failingKeychain, fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;
let api: FakeApi | null = null;

const DEV = `dev_${'a'.repeat(32)}`;

beforeEach(async () => {
  h = harness();
  api = await FakeApi.start();
  h.overrides.env = { ...h.overrides.env, PAGR_API_URL: api.url };
});
afterEach(async () => {
  await server?.close();
  await api?.close();
  server = null;
  api = null;
  h.cleanup();
});

interface Report {
  ok: boolean;
  home: string;
  failures: number;
  warnings: number;
  checks: Array<{ name: string; status: string; detail: string; fix?: string }>;
}

async function report(args: string[] = []): Promise<Report> {
  h.stdout.length = 0;
  await h.run(['doctor', '--json', ...args]);
  return lastJson(h) as Report;
}

const check = (r: Report, name: string) => r.checks.find((c) => c.name === name);

const daemonStatus = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: `usr_${'b'.repeat(32)}`,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 1,
  sessions: 0,
  pendingApprovals: 0,
  socketPath: 'x',
  pid: 4242,
  startedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

describe('doctor · flags', () => {
  it('accepts `pagr doctor --json`, not only `pagr --json doctor`', async () => {
    expect(await h.run(['doctor', '--json'])).toBe(EXIT.precondition);
    expect(() => lastJson(h)).not.toThrow();
  });

  it('accepts `pagr doctor --home <dir>`', async () => {
    const other = join(h.home, '..', 'elsewhere');
    h.stdout.length = 0;
    await h.run(['doctor', '--json', '--home', other]);
    expect((lastJson(h) as Report).home).toBe(other);
  });

  it('--offline skips the network checks instead of failing them', async () => {
    const r = await report(['--offline']);
    for (const name of ['api', 'clock', 'gateway']) expect(check(r, name)?.status).toBe('skip');
  });
});

describe('doctor · state files', () => {
  it('names a corrupt config.json instead of reporting "not paired"', async () => {
    writeFileSync(getPaths(h.home).configFile, '{"deviceId":');
    const r = await report(['--offline']);
    expect(check(r, 'config.json')?.status).toBe('fail');
    expect(check(r, 'config.json')?.detail).toContain('not valid JSON');
    expect(check(r, 'config.json')?.fix).toContain('pagr connect');
  });

  it('names a config.json of the wrong shape', async () => {
    writeFileSync(getPaths(h.home).configFile, JSON.stringify({ gatewayUrl: 'nope' }));
    const r = await report(['--offline']);
    expect(check(r, 'config.json')?.status).toBe('fail');
    expect(check(r, 'config.json')?.detail).toContain('not a valid pagr config');
  });

  it('names a corrupt projects.json', async () => {
    writeFileSync(getPaths(h.home).projectsFile, 'not json at all');
    const r = await report(['--offline']);
    expect(check(r, 'projects.json')?.status).toBe('fail');
  });

  it('flags loose permissions and --fix repairs them', async () => {
    writeFileSync(getPaths(h.home).configFile, '{}', { mode: 0o644 });
    let r = await report(['--offline']);
    expect(check(r, 'permissions')?.status).toBe('warn');
    expect(check(r, 'permissions')?.detail).toContain('644');
    r = await report(['--offline', '--fix']);
    expect(check(r, 'permissions')?.status).toBe('ok');
    r = await report(['--offline']);
    expect(check(r, 'permissions')?.status).toBe('ok');
  });

  it('reports an unwritable home rather than silently working around it', async () => {
    const ro = join(h.home, '..', 'ro-home');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    try {
      h.stdout.length = 0;
      await h.run(['doctor', '--json', '--offline', '--home', ro]);
      const r = lastJson(h) as Report;
      expect(check(r, 'pagr home')?.status).toBe('fail');
      expect(check(r, 'pagr home')?.fix).toBeTruthy();
    } finally {
      chmodSync(ro, 0o700);
      rmSync(ro, { recursive: true, force: true });
    }
  });
});

describe('doctor · secret store', () => {
  it('round-trips the store and reports a locked Keychain as a failure', async () => {
    h.store = failingKeychain('Keychain is locked (-25629)');
    const r = await report(['--offline']);
    expect(check(r, 'secret store')?.status).toBe('fail');
    expect(check(r, 'secret store')?.fix).toContain('unlock your login Keychain');
    expect(check(r, 'device key')?.status).toBe('skip');
  });

  it('spots a config that claims a device but has no private key', async () => {
    writeFileSync(getPaths(h.home).configFile, JSON.stringify({ deviceId: DEV }));
    const r = await report(['--offline']);
    expect(check(r, 'device key')?.status).toBe('fail');
    expect(check(r, 'device key')?.fix).toContain('--force');
  });

  it('is happy once the key is present', async () => {
    await h.store.set(PRIVATE_KEY_SECRET, 'pem');
    const r = await report(['--offline']);
    expect(check(r, 'device key')?.status).toBe('ok');
  });
});

describe('doctor · api and clock', () => {
  it('reports the API as reachable when it answers', async () => {
    const r = await report();
    expect(check(r, 'api')?.status).toBe('ok');
  });

  it('reports the API as unreachable when nothing answers', async () => {
    h.overrides.env = { ...h.overrides.env, PAGR_API_URL: 'http://127.0.0.1:1' };
    const r = await report();
    expect(check(r, 'api')?.status).toBe('fail');
    expect(check(r, 'api')?.fix).toContain('PAGR_API_URL');
  });

  it('fails the clock check on a large skew and explains why it matters', async () => {
    await api?.close();
    api = await FakeApi.start({
      health: { json: { ok: true }, headers: { date: new Date(h.nowMs - 3600_000).toUTCString() } },
    });
    h.overrides.env = { ...h.overrides.env, PAGR_API_URL: api.url };
    const r = await report();
    expect(check(r, 'clock')?.status).toBe('fail');
    expect(check(r, 'clock')?.detail).toContain('ahead of the server');
    expect(check(r, 'clock')?.fix).toContain('Date & Time');
  });
});

describe('doctor · daemon, socket and launchd', () => {
  it('reports the gateway link separately from TCP reachability', async () => {
    writeFileSync(
      getPaths(h.home).configFile,
      JSON.stringify({ deviceId: DEV, gatewayUrl: 'wss://gw.example' }),
    );
    server = await fakeDaemon(h.home, { status: () => daemonStatus({ transport: 'connecting' }) });
    const r = await report(['--offline']);
    expect(check(r, 'daemon')?.status).toBe('ok');
    expect(check(r, 'gateway link')?.status).toBe('fail');
    expect(check(r, 'gateway link')?.fix).toContain('daemon logs');
  });

  it('tells a blocked bridge to update', async () => {
    server = await fakeDaemon(h.home, { status: () => daemonStatus({ transport: 'blocked' }) });
    const r = await report(['--offline']);
    expect(check(r, 'gateway link')?.fix).toContain('@pagr/cli@latest');
  });

  it('mentions the lock file when the socket does not answer', async () => {
    const p = getPaths(h.home);
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.lockFile, `${process.pid}\n`);
    const r = await report(['--offline']);
    expect(check(r, 'daemon')?.detail).toContain(`lock file holds pid ${process.pid}`);
  });

  it('explains the short-socket fallback for a long PAGR_HOME', async () => {
    const longHome = join(h.home, '..', 'x'.repeat(120), 'pagr');
    h.stdout.length = 0;
    await h.run(['doctor', '--json', '--offline', '--home', longHome]);
    const r = lastJson(h) as Report;
    expect(check(r, 'socket path')?.status).toBe('ok');
    expect(check(r, 'socket path')?.detail).toContain('short fallback');
  });

  it('warns when launchd is not available at all', async () => {
    h.launchctl = false;
    const r = await report(['--offline']);
    expect(check(r, 'launchd')?.status).toBe('warn');
    expect(check(r, 'launchd')?.fix).toContain('pagr daemon run');
    expect(check(r, 'launch agent')).toBeUndefined();
  });

  it('flags a stale plist left by an older install', async () => {
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    writeFileSync(plist, readPlistWith(plist, '/opt/pagr/dist/bin.js', '/nonexistent/old/bin.js'));
    h.execImpl = () => 'loaded';
    const r = await report(['--offline']);
    expect(check(r, 'launch agent')?.status).toBe('warn');
    expect(check(r, 'launch agent')?.detail).toContain('no longer exists');
  });

  it('flags an installed-but-not-loaded agent', async () => {
    h.overrides.binPath = process.execPath; // a plist that is current, just not loaded
    await h.run(['daemon', 'install']);
    h.execImpl = () => {
      throw new Error('could not find service');
    };
    const r = await report(['--offline']);
    expect(check(r, 'launch agent')?.status).toBe('fail');
    expect(check(r, 'launch agent')?.fix).toContain('pagr daemon install');
  });
});

describe('doctor · exit codes and summary', () => {
  it('exits 5 when anything failed, and points at --json for support', async () => {
    h.execImpl = () => {
      throw new Error('ENOENT');
    };
    expect(await h.run(['doctor', '--offline'])).toBe(EXIT.precondition);
    const out = plain(h.stdout);
    expect(out).toMatch(/✗ paired/);
    expect(out).toContain('pagr doctor --json');
  });

  it('exits 0 when only warnings remain and says how many', async () => {
    const p = getPaths(h.home);
    writeFileSync(p.configFile, JSON.stringify({ deviceId: DEV, gatewayUrl: 'wss://gw.example' }), {
      mode: 0o600,
    });
    await h.store.set(PRIVATE_KEY_SECRET, 'pem');
    server = await fakeDaemon(h.home, { status: () => daemonStatus() });
    await h.run(['daemon', 'install']);
    h.execImpl = (f) => (f === '/bin/launchctl' ? 'loaded' : '1.0.0');
    h.nowMs = Date.now(); // agree with the fake API's Date header
    const r = await report();
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    h.stdout.length = 0;
    expect(await h.run(['doctor'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('all checks passed');
  });
});

const readPlistWith = (path: string, from: string, to: string): string =>
  readFileSync(path, 'utf8').replace(from, to);

describe('doctor · Claude Code live steering', () => {
  it('says follow-ups are queued when channel mode is off', async () => {
    server = await fakeDaemon(h.home, {
      status: () => daemonStatus(),
      'channel.status': () => ({ enabled: false, attachedProjects: [], canSteerLive: false }),
    });
    const r = await report(['--offline']);
    expect(check(r, 'live steering')?.status).toBe('skip');
    expect(check(r, 'live steering')?.detail).toContain('queued, not steered');
  });

  it('warns when the flag is on but nothing is attached', async () => {
    server = await fakeDaemon(h.home, {
      status: () => daemonStatus(),
      'channel.status': () => ({ enabled: true, attachedProjects: [], canSteerLive: false }),
    });
    const r = await report(['--offline']);
    const c = check(r, 'live steering');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('QUEUED');
    expect(c?.fix).toContain('--dangerously-load-development-channels');
  });

  it('reports live steering as available only when a channel is attached', async () => {
    server = await fakeDaemon(h.home, {
      status: () => daemonStatus(),
      'channel.status': () => ({
        enabled: true,
        attachedProjects: ['/code/app'],
        canSteerLive: true,
      }),
    });
    const r = await report(['--offline']);
    expect(check(r, 'live steering')?.status).toBe('ok');
    expect(check(r, 'live steering')?.detail).toContain('can steer live');
  });

  it('skips the check entirely when the daemon is down', async () => {
    const r = await report(['--offline']);
    expect(check(r, 'live steering')?.status).toBe('skip');
    expect(check(r, 'live steering')?.detail).toContain('daemon not running');
  });

  it('reports whether this project has the channel server in .mcp.json', async () => {
    const project = join(h.home, '..', 'proj');
    mkdirSync(project, { recursive: true });
    h.overrides.env = { ...h.overrides.env, PAGR_DOCTOR_PROJECT: project };
    let r = await report(['--offline']);
    expect(check(r, 'claude channel')?.status).toBe('skip');
    expect(check(r, 'claude channel')?.fix).toContain('channel-setup');

    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { pagr: { command: 'node', args: ['/s.mjs'] } } }),
    );
    r = await report(['--offline']);
    expect(check(r, 'claude channel')?.status).toBe('ok');
  });

  it('names a broken .mcp.json instead of pretending it is absent', async () => {
    const project = join(h.home, '..', 'proj2');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.mcp.json'), '{ not json');
    h.overrides.env = { ...h.overrides.env, PAGR_DOCTOR_PROJECT: project };
    const r = await report(['--offline']);
    expect(check(r, 'claude channel')?.detail).toContain('invalid JSON');
  });
});
