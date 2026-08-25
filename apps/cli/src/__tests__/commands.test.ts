import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DaemonAlreadyRunningError,
  getPaths,
  type IpcServer,
  PRIVATE_KEY_SECRET,
} from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;
let repo = '';

const DEV = `dev_${'a'.repeat(32)}`;

beforeEach(() => {
  h = harness();
  repo = join(h.home, '..', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const out = () => plain(h.stdout);
const err = () => plain(h.stderr);

const status = (over: Record<string, unknown> = {}) => ({
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

describe('help is available for every command', () => {
  const commands = [
    ['connect'],
    ['status'],
    ['doctor'],
    ['projects'],
    ['project'],
    ['project', 'add'],
    ['project', 'remove'],
    ['sessions'],
    ['daemon'],
    ['daemon', 'run'],
    ['daemon', 'install'],
    ['daemon', 'uninstall'],
    ['daemon', 'status'],
    ['daemon', 'logs'],
    ['billing'],
    ['logout'],
    ['uninstall'],
  ];
  for (const argv of commands) {
    it(`pagr ${argv.join(' ')} --help`, async () => {
      h.stdout.length = 0;
      expect(await h.run([...argv, '--help'])).toBe(EXIT.ok);
      expect(out()).toContain('Usage:');
    });
  }

  it('an unknown command is a usage error, not a crash', async () => {
    expect(await h.run(['nope'])).toBe(EXIT.usage);
  });

  it('an unknown flag on a known command is a usage error', async () => {
    expect(await h.run(['status', '--bogus'])).toBe(EXIT.usage);
  });
});

describe('projects', () => {
  it('refuses a folder that does not exist', async () => {
    expect(await h.run(['project', 'add', join(h.home, '..', 'ghost')])).toBe(EXIT.precondition);
    expect(err()).toContain('does not exist');
  });

  it('refuses a non-git folder and names the escape hatch', async () => {
    const plainDir = join(h.home, '..', 'plain');
    mkdirSync(plainDir, { recursive: true });
    expect(await h.run(['project', 'add', plainDir])).toBe(EXIT.precondition);
    expect(err()).toContain('--allow-non-git');
    expect(await h.run(['project', 'add', plainDir, '--allow-non-git'])).toBe(EXIT.ok);
  });

  it('refuses a second registration of the same path', async () => {
    expect(await h.run(['project', 'add', repo])).toBe(EXIT.ok);
    expect(await h.run(['project', 'add', repo])).toBe(EXIT.precondition);
    expect(err()).toContain('already registered');
  });

  it('refuses a path inside PAGR_HOME', async () => {
    const inside = join(h.home, 'sneaky');
    mkdirSync(join(inside, '.git'), { recursive: true });
    expect(await h.run(['project', 'add', inside])).toBe(EXIT.precondition);
    expect(err()).toContain('refusing to register');
  });

  it('resolves a project by id, name or alias when removing', async () => {
    await h.run(['project', 'add', repo, '--name', 'Tonight', '--alias', 'tn,tonite']);
    expect(await h.run(['project', 'remove', 'TONITE'])).toBe(EXIT.ok);
    expect(await h.run(['project', 'remove', 'tn'])).toBe(EXIT.precondition);
    expect(err()).toContain('no project matches');
  });

  it('says something useful when there are no projects', async () => {
    expect(await h.run(['projects'])).toBe(EXIT.ok);
    expect(out()).toContain('pagr project add');
  });
});

describe('sessions', () => {
  it('exits 3 with an actionable hint when the daemon is down', async () => {
    expect(await h.run(['sessions'])).toBe(EXIT.daemonDown);
    expect(err()).toContain('pagr daemon install');
  });

  it('says "no sessions" rather than printing an empty table', async () => {
    server = await fakeDaemon(h.home, { status: () => status(), 'sessions.list': () => [] });
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    expect(out()).toContain('no sessions');
  });
});

describe('daemon', () => {
  it('refuses to install without launchd, and says what to do instead', async () => {
    h.launchctl = false;
    expect(await h.run(['daemon', 'install'])).toBe(EXIT.precondition);
    expect(err()).toContain('pagr daemon run');
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
  });

  it('reports a launchctl bootstrap failure with launchctl own words', async () => {
    h.execImpl = (_f, a) => {
      if (a[0] === 'bootstrap')
        throw Object.assign(new Error('x'), {
          stderr: 'Bootstrap failed: 125: Domain does not exist',
        });
      return '';
    };
    expect(await h.run(['daemon', 'install'])).toBe(EXIT.precondition);
    expect(err()).toContain('Domain does not exist');
  });

  it('rewrites a stale plist on re-install', async () => {
    h.overrides.binPath = '/opt/pagr/v1/bin.js';
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    expect(readFileSync(plist, 'utf8')).toContain('/opt/pagr/v1/bin.js');
    h.overrides.binPath = '/opt/pagr/v2/bin.js';
    await h.run(['daemon', 'install']);
    expect(readFileSync(plist, 'utf8')).toContain('/opt/pagr/v2/bin.js');
    expect(readFileSync(plist, 'utf8')).not.toContain('/opt/pagr/v1/bin.js');
  });

  it('surfaces the single-instance lock as exit 5 with the core message', async () => {
    h.overrides.runDaemonForever = async () => {
      throw new DaemonAlreadyRunningError(h.home, 777);
    };
    expect(await h.run(['daemon', 'run'])).toBe(EXIT.precondition);
    expect(err()).toContain(`already running for ${h.home} (pid 777)`);
    expect(err()).toContain('daemon stop');
  });

  it('refuses `logs --follow --json` rather than emitting a broken stream', async () => {
    const p = getPaths(h.home);
    mkdirSync(p.logsDir, { recursive: true });
    writeFileSync(p.logFile, 'x');
    expect(await h.run(['daemon', 'logs', '--follow', '--json'])).toBe(EXIT.usage);
  });

  it('stop is an alias for uninstall', async () => {
    await h.run(['daemon', 'install']);
    expect(await h.run(['daemon', 'stop'])).toBe(EXIT.ok);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
  });
});

describe('status', () => {
  it('surfaces a damaged config instead of quietly saying "not paired"', async () => {
    writeFileSync(getPaths(h.home).configFile, '{"deviceId":');
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(out()).toContain('not valid JSON');
  });

  it('prefers the running daemon over a damaged config file', async () => {
    writeFileSync(getPaths(h.home).configFile, '{"deviceId":');
    server = await fakeDaemon(h.home, { status: () => status() });
    h.stdout.length = 0;
    expect(await h.run(['--json', 'status'])).toBe(EXIT.ok);
    const j = lastJson(h) as { paired: boolean; deviceId: string; configProblem: string };
    expect(j.paired).toBe(true);
    expect(j.deviceId).toBe(DEV);
    expect(j.configProblem).toContain('not valid JSON');
  });
});

describe('logout and uninstall', () => {
  it('--purge also drops the project registry', async () => {
    const p = getPaths(h.home);
    writeFileSync(p.configFile, JSON.stringify({ deviceId: DEV }));
    await h.run(['project', 'add', repo]);
    expect(await h.run(['logout', '--purge'])).toBe(EXIT.ok);
    expect(existsSync(p.projectsFile)).toBe(false);
  });

  it('keeps projects by default and names the revocation page', async () => {
    const p = getPaths(h.home);
    writeFileSync(p.configFile, JSON.stringify({ deviceId: DEV }));
    await h.run(['project', 'add', repo]);
    await h.store.set(PRIVATE_KEY_SECRET, 'pem');
    h.stdout.length = 0;
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(existsSync(p.projectsFile)).toBe(true);
    expect(await h.store.get(PRIVATE_KEY_SECRET)).toBeNull();
    expect(out()).toContain('revoke');
    expect(h.execCalls.some((c) => c[1] === 'bootout')).toBe(true);
  });

  it('logout on a Mac that was never paired is still safe', async () => {
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(out()).toContain('no launch agent to remove');
  });

  it('uninstall aborts with exit 2 when not confirmed', async () => {
    h.overrides.confirm = async () => false;
    expect(await h.run(['uninstall'])).toBe(EXIT.usage);
    expect(existsSync(h.home)).toBe(true);
    expect(err()).toContain('--yes');
  });

  it('uninstall --yes removes the home directory', async () => {
    expect(await h.run(['uninstall', '--yes'])).toBe(EXIT.ok);
    expect(existsSync(h.home)).toBe(false);
  });
});

describe('billing never touches payment details', () => {
  it('only ever opens a dashboard URL', async () => {
    expect(await h.run(['billing', 'portal', '--web-url', 'https://app.test'])).toBe(EXIT.ok);
    expect(h.opened).toEqual(['https://app.test/app/billing?action=portal']);
  });

  it('--no-open prints the URL without launching anything', async () => {
    expect(await h.run(['billing', '--web-url', 'https://app.test', '--no-open'])).toBe(EXIT.ok);
    expect(h.opened).toEqual([]);
    expect(out()).toContain('https://app.test/app/billing');
  });

  it('says so when no browser could be opened', async () => {
    h.browserOpens = false;
    await h.run(['billing', '--web-url', 'https://app.test']);
    expect(out()).toContain('could not open a browser');
  });
});

describe('PAGR_HOME edge cases', () => {
  it('a long PAGR_HOME still gets a usable socket path', async () => {
    const longHome = join(h.home, '..', 'z'.repeat(120), 'pagr');
    h.stdout.length = 0;
    expect(await h.run(['--json', '--home', longHome, 'daemon', 'status'])).toBe(EXIT.ok);
    const j = lastJson(h) as { status: unknown };
    expect(j.status).toBeNull();
  });

  it('a home under an unwritable parent fails with exit 10, not a stack trace', async () => {
    const parent = join(h.home, '..', 'ro-parent');
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o500);
    try {
      expect(await h.run(['--home', join(parent, 'pagr'), 'daemon', 'install'])).toBe(EXIT.state);
      expect(err()).not.toContain('    at ');
      expect(err()).toContain('could not create');
      expect(err()).toContain('PAGR_HOME');
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it('an existing home with loose permissions is tightened rather than refused', async () => {
    chmodSync(h.home, 0o755);
    expect(await h.run(['daemon', 'install'])).toBe(EXIT.ok);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
  });
});
