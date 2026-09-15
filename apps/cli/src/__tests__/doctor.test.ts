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
  paired: boolean;
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
    expect(await h.run(['doctor', '--json'])).toBe(EXIT.ok);
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

  it('reports the device approval floor, and says so loudly when it has been lifted', async () => {
    let r = await report(['--offline']);
    expect(check(r, 'device policy')?.status).toBe('ok');
    expect(check(r, 'device policy')?.detail).toContain('cannot run remote scripts');
    writeFileSync(
      getPaths(h.home).devicePolicyFile,
      JSON.stringify({ version: 1, allow: ['network', 'destructive'] }),
      { mode: 0o600 },
    );
    r = await report(['--offline']);
    // Not a fault — the user asked for it — but never invisible.
    expect(check(r, 'device policy')?.status).toBe('warn');
    expect(check(r, 'device policy')?.detail).toContain('network, destructive');
    expect(check(r, 'device policy')?.fix).toContain('device-policy.json');
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

  it('flags a plist whose Node was deleted by an upgrade', async () => {
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    // what an older install + `brew upgrade node` leaves behind
    writeFileSync(
      plist,
      readPlistWith(
        plist,
        join(h.home, 'bin', 'pagr-node'),
        '/opt/homebrew/Cellar/node/22.11.0/bin/node',
      ),
    );
    h.execImpl = () => 'loaded';
    const r = await report(['--offline']);
    expect(check(r, 'launch agent')?.status).toBe('warn');
    expect(check(r, 'launch agent')?.detail).toContain('Node upgrade');
    expect(check(r, 'launch agent')?.fix).toContain('pagr daemon install');
  });

  it('agent env: skipped until there is a launch agent to compare against', async () => {
    h.overrides.env = { ...h.overrides.env, ANTHROPIC_API_KEY: 'sk-ant-secret' };
    const r = await report(['--offline']);
    expect(check(r, 'agent env')?.status).toBe('skip');
  });

  it('agent env: names the variables the daemon will never see, never their values', async () => {
    await h.run(['daemon', 'install']);
    h.overrides.env = {
      ...h.overrides.env,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
    };
    h.execImpl = () => 'loaded';
    const r = await report(['--offline']);
    const c = check(r, 'agent env');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('ANTHROPIC_API_KEY');
    expect(c?.detail).toContain('OPENAI_API_KEY');
    expect(c?.detail).toContain('look signed out');
    expect(JSON.stringify(r)).not.toContain('sk-ant-secret');
    expect(JSON.stringify(r)).not.toContain('sk-openai-secret');
    expect(c?.fix).toContain('codex login');
    // a warning, never a failure: the bridge works, the agent just cannot authenticate
    expect(r.ok).toBe(true);
  });

  it('agent env: ok once the variable is actually in the launch agent', async () => {
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    writeFileSync(
      plist,
      readPlistWith(
        plist,
        '<key>PAGR_HOME</key>',
        '<key>ANTHROPIC_API_KEY</key>\n      <string>set-by-hand</string>\n      <key>PAGR_HOME</key>',
      ),
    );
    h.overrides.env = { ...h.overrides.env, ANTHROPIC_API_KEY: 'sk-ant-secret' };
    h.execImpl = () => 'loaded';
    const r = await report(['--offline']);
    expect(check(r, 'agent env')?.status).toBe('ok');
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
  it('exits 5 when something is genuinely broken, and points at --json for support', async () => {
    writeFileSync(getPaths(h.home).configFile, '{"deviceId":');
    expect(await h.run(['doctor', '--offline'])).toBe(EXIT.precondition);
    const out = plain(h.stdout);
    expect(out).toMatch(/✗ config\.json/);
    expect(out).toContain('pagr doctor --json');
  });

  it('a missing agent CLI is a warning, not a failure', async () => {
    h.execImpl = () => {
      throw new Error('ENOENT');
    };
    expect(await h.run(['doctor', '--offline'])).toBe(EXIT.ok);
    expect(check(await report(['--offline']), 'codex')?.status).toBe('warn');
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
    const r = await report();
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    h.stdout.length = 0;
    expect(await h.run(['doctor'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('all checks passed');
  });
});

const readPlistWith = (path: string, from: string, to: string): string =>
  readFileSync(path, 'utf8').replace(from, to);

/**
 * BR-24. `RELEASING.md` § "Post-release smoke on a clean machine" runs `pagr doctor` straight
 * after `npm install -g @pagr/cli`, before anything is paired. If that exits non-zero the release
 * check can never pass, and worse, every new user's first impression of the tool is a red report
 * about a machine that is in exactly the state it should be in.
 */
describe('doctor · a fresh, unpaired install', () => {
  /** No PAGR_API_URL: nothing has chosen a stack, because `pagr connect` has not run. */
  const unconfigured = () => {
    const { PAGR_API_URL: _drop, ...rest } = h.overrides.env ?? {};
    h.overrides.env = rest;
  };

  it('passes and says how to pair instead of failing', async () => {
    unconfigured();
    expect(await h.run(['doctor'])).toBe(EXIT.ok);
    const out = plain(h.stdout);
    expect(out).toContain('not paired yet — run `pagr connect`');
    expect(out).toContain('all checks passed');
    expect(out).not.toContain('check(s) failed');
  });

  it('reports `paired` as a warning carrying the next command', async () => {
    unconfigured();
    const c = check(await report(), 'paired');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('not paired yet');
    expect(c?.fix).toContain('pagr connect');
  });

  it('skips the network checks when no API URL has been configured', async () => {
    unconfigured();
    const r = await report();
    expect(check(r, 'api')?.status).toBe('skip');
    expect(check(r, 'api')?.detail).toContain('no API URL configured');
    expect(check(r, 'clock')?.status).toBe('skip');
    expect(check(r, 'gateway')?.status).toBe('skip');
    expect(r.failures).toBe(0);
  });

  it('treats a daemon that was never installed as a warning', async () => {
    unconfigured();
    const c = check(await report(), 'daemon');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('not installed yet');
    expect(c?.fix).toContain('pagr connect');
  });

  it('reports `paired: false` in --json so a smoke test can assert it', async () => {
    unconfigured();
    const r = await report();
    expect(r.paired).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('a running-but-unpaired daemon is a warning, not a broken gateway link', async () => {
    unconfigured();
    server = await fakeDaemon(h.home, {
      status: () => daemonStatus({ paired: false, transport: 'unpaired' }),
    });
    const r = await report();
    expect(check(r, 'gateway link')?.status).toBe('warn');
    expect(check(r, 'gateway link')?.detail).toContain('not paired yet');
    expect(r.failures).toBe(0);
  });
});

describe('doctor · genuine faults still fail on an unpaired machine', () => {
  it('a broken Keychain', async () => {
    h.store = failingKeychain('Keychain is locked (-25629)');
    expect(await h.run(['doctor', '--offline'])).toBe(EXIT.precondition);
  });

  it('an unparsable config.json', async () => {
    writeFileSync(getPaths(h.home).configFile, 'not json');
    expect(await h.run(['doctor', '--offline'])).toBe(EXIT.precondition);
  });

  it('a configured API URL that nothing answers', async () => {
    h.overrides.env = { ...h.overrides.env, PAGR_API_URL: 'http://127.0.0.1:1' };
    expect(await h.run(['doctor'])).toBe(EXIT.precondition);
    expect(check(await report(), 'api')?.status).toBe('fail');
  });

  it('a paired machine whose daemon does not answer', async () => {
    writeFileSync(
      getPaths(h.home).configFile,
      JSON.stringify({ deviceId: DEV, gatewayUrl: 'wss://gw.example' }),
      { mode: 0o600 },
    );
    const r = await report(['--offline']);
    expect(check(r, 'daemon')?.status).toBe('fail');
    expect(check(r, 'daemon')?.fix).toContain('pagr daemon install');
  });
});

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
