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
    ['daemon', 'start'],
    ['daemon', 'stop'],
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

  it('stop stops the daemon and LEAVES the launch agent installed', async () => {
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    h.execCalls.length = 0;
    h.stdout.length = 0;
    expect(await h.run(['daemon', 'stop'])).toBe(EXIT.ok);
    // `stop` used to be an alias for `uninstall`: "stopping" the daemon deleted the launch agent
    // and nothing ever started again at login.
    expect(existsSync(plist)).toBe(true);
    const uid = process.getuid?.() ?? 501;
    expect(h.execCalls).toEqual([['/bin/launchctl', 'bootout', `gui/${uid}/dev.pagr.bridge`]]);
    expect(out()).toContain('still installed');
  });

  it('stop then start brings it back without rewriting the plist', async () => {
    await h.run(['daemon', 'install']);
    const plist = join(h.launchAgentsDir, 'dev.pagr.bridge.plist');
    const before = readFileSync(plist, 'utf8');
    expect(await h.run(['daemon', 'stop'])).toBe(EXIT.ok);
    h.execCalls.length = 0;
    expect(await h.run(['daemon', 'start'])).toBe(EXIT.ok);
    expect(h.execCalls[0]).toEqual([
      '/bin/launchctl',
      'bootstrap',
      `gui/${process.getuid?.() ?? 501}`,
      plist,
    ]);
    expect(readFileSync(plist, 'utf8')).toBe(before);
  });

  it('start without an install says what to run instead', async () => {
    expect(await h.run(['daemon', 'start'])).toBe(EXIT.precondition);
    expect(err()).toContain('pagr daemon install');
  });

  it('start and stop say what to do when there is no launchd at all', async () => {
    await h.run(['daemon', 'install']);
    h.launchctl = false;
    expect(await h.run(['daemon', 'stop'])).toBe(EXIT.precondition);
    expect(err()).toContain('pagr daemon run');
    expect(await h.run(['daemon', 'start'])).toBe(EXIT.precondition);
    expect(err()).toContain('pagr daemon run');
  });

  it('stop on a machine with no launch agent is not an error', async () => {
    expect(await h.run(['daemon', 'stop'])).toBe(EXIT.ok);
    expect(out()).toContain('no launch agent installed');
  });

  it('uninstall says what it is about to remove, and removes it', async () => {
    await h.run(['daemon', 'install']);
    h.stdout.length = 0;
    expect(await h.run(['daemon', 'uninstall'])).toBe(EXIT.ok);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
    const text = out();
    expect(text).toContain('removing the launch agent');
    expect(text).toContain('will NOT start at login');
    expect(text).toContain('pagr daemon install');
  });

  it('the plist runs a launcher that resolves node at launch time, not a baked node path', async () => {
    await h.run(['daemon', 'install']);
    const plist = readFileSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'), 'utf8');
    const launcher = join(h.home, 'bin', 'pagr-node');
    expect(plist).toContain(`<string>${launcher}</string>`);
    expect(plist).not.toContain(process.execPath);
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain('command -v node');
  });

  it('daemon install warns when the agents are authenticated only in this shell', async () => {
    h.overrides.env = { ...h.overrides.env, ANTHROPIC_API_KEY: 'sk-ant-secret' };
    expect(await h.run(['daemon', 'install'])).toBe(EXIT.ok);
    const text = `${out()}\n${err()}`;
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('set in this shell but not for the daemon');
    // never the value
    expect(text).not.toContain('sk-ant-secret');
    expect(readFileSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'), 'utf8')).not.toContain(
      'sk-ant-secret',
    );
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

describe('pagr projects at scale', () => {
  const mkrepo = (name: string, remote?: string) => {
    const dir = join(h.home, '..', name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    if (remote)
      writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
    return dir;
  };

  it('shows name, aliases, path and id for every project', async () => {
    await h.run(['project', 'add', mkrepo('alpha', 'git@github.com:acme/alpha-svc.git')]);
    await h.run(['project', 'add', mkrepo('beta')]);
    h.stdout.length = 0;
    expect(await h.run(['projects'])).toBe(EXIT.ok);
    const text = out();
    expect(text).toContain('NAME');
    expect(text).toContain('ALIASES');
    expect(text).toContain('LIVE');
    expect(text).toContain('alpha-svc');
    expect(text).toContain('2 project(s)');
  });

  it('marks projects with a live session when the daemon is up', async () => {
    await h.run(['project', 'add', repo, '--name', 'Widgets']);
    const listed = JSON.parse(readFileSync(getPaths(h.home).projectsFile, 'utf8')) as Record<
      string,
      { projectId: string }
    >;
    const projectId = Object.values(listed)[0]?.projectId as string;
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'projects.list': () => Object.values(listed),
      'sessions.list': () => [
        {
          sessionId: `ses_${'1'.repeat(32)}`,
          provider: 'codex',
          projectId,
          providerSessionId: 'thr',
          status: 'working',
          startedAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
        {
          sessionId: `ses_${'2'.repeat(32)}`,
          provider: 'claude',
          projectId,
          providerSessionId: 'c',
          status: 'completed',
          startedAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });
    h.stdout.length = 0;
    expect(await h.run(['projects'])).toBe(EXIT.ok);
    expect(out()).toContain('codex:working');
    // a completed session is not "live" and must not be shown as such
    expect(out()).not.toContain('claude:completed');
  });

  it('--json includes the live sessions per project', async () => {
    await h.run(['project', 'add', repo]);
    h.stdout.length = 0;
    expect(await h.run(['projects', '--json'])).toBe(EXIT.ok);
    const doc = lastJson(h) as Array<{ displayName: string; sessions: unknown[] }>;
    expect(doc[0]?.sessions).toEqual([]);
  });

  it('refuses an explicit --name that already refers to another project', async () => {
    await h.run(['project', 'add', mkrepo('one'), '--name', 'Widgets']);
    expect(await h.run(['project', 'add', mkrepo('two'), '--name', 'widgets'])).toBe(
      EXIT.precondition,
    );
    expect(err()).toContain('already refers to Widgets');
  });

  it('auto-qualifies an inferred name instead of registering two of the same', async () => {
    mkdirSync(join(h.home, '..', 'x', 'app', '.git'), { recursive: true });
    mkdirSync(join(h.home, '..', 'y', 'app', '.git'), { recursive: true });
    await h.run(['project', 'add', join(h.home, '..', 'x', 'app')]);
    h.stdout.length = 0;
    expect(await h.run(['project', 'add', join(h.home, '..', 'y', 'app')])).toBe(EXIT.ok);
    expect(out()).toContain('y/app');
    expect(out()).toContain('was taken');
  });
});

describe('pagr sessions --reconcile', () => {
  it('reports what it cleared', async () => {
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'sessions.reconcile': () => [
        {
          sessionId: `ses_${'1'.repeat(32)}`,
          provider: 'codex',
          projectId: `proj_${'a'.repeat(32)}`,
          status: 'stopped',
          outcome: 'terminated',
          reason: 'the daemon restarted and the provider no longer knows this session',
        },
      ],
    });
    expect(await h.run(['sessions', '--reconcile'])).toBe(EXIT.ok);
    expect(out()).toContain('terminated');
    expect(out()).toContain('no longer knows');
  });

  it('says so when there is nothing to clear', async () => {
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'sessions.reconcile': () => [],
    });
    expect(await h.run(['sessions', '--reconcile'])).toBe(EXIT.ok);
    expect(out()).toContain('nothing to reconcile');
  });

  it('shows the project name and a live count in the plain listing', async () => {
    const projectId = `proj_${'a'.repeat(32)}`;
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'projects.list': () => [
        {
          projectId,
          path: '/x',
          displayName: 'Widgets',
          aliases: [],
          allowNonGit: false,
          addedAt: '',
        },
      ],
      'sessions.list': () => [
        {
          sessionId: `ses_${'1'.repeat(32)}`,
          provider: 'codex',
          projectId,
          providerSessionId: 't',
          status: 'working',
          startedAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    expect(out()).toContain('Widgets');
    expect(out()).toContain('1 session(s), 1 live');
  });
});
