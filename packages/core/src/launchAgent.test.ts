import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_EXIT,
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  LaunchAgentError,
  launchAgentPlistPath,
  launchAgentStaleReason,
  nodeLauncherPath,
  readPlistFacts,
  renderNodeLauncher,
  renderPlist,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
  writeNodeLauncher,
} from './launchAgent.js';
import { useTempHome } from './testUtil.js';

const opts = (home: string, over: Record<string, unknown> = {}) => ({
  programArguments: [process.execPath, join(home, 'bin.js'), 'daemon', 'run'],
  logsDir: join(home, 'logs'),
  launchAgentsDir: join(home, 'LaunchAgents'),
  env: { PAGR_HOME: home, PATH: '/usr/bin' },
  uid: 501,
  hasLaunchctl: () => true,
  ...over,
});

describe('launch agent · plist', () => {
  const t = useTempHome('pagr-agent-');

  it('escapes XML in every value it interpolates', () => {
    const xml = renderPlist(
      opts(t.home, { programArguments: ['/bin/node', '/a & b/<x>.js'], env: { A: '"q"' } }),
    );
    expect(xml).toContain('/a &amp; b/&lt;x&gt;.js');
    expect(xml).toContain('&quot;q&quot;');
    expect(xml).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
  });

  it('round-trips through readPlistFacts', () => {
    mkdirSync(join(t.home, 'LaunchAgents'), { recursive: true });
    const plist = launchAgentPlistPath(join(t.home, 'LaunchAgents'));
    writeFileSync(plist, renderPlist(opts(t.home)));
    const facts = readPlistFacts(plist);
    expect(facts?.programArguments).toEqual([
      process.execPath,
      join(t.home, 'bin.js'),
      'daemon',
      'run',
    ]);
    expect(facts?.env.PAGR_HOME).toBe(t.home);
  });

  it('returns null for a plist that is not there', () => {
    expect(readPlistFacts(join(t.home, 'nope.plist'))).toBeNull();
  });
});

describe('launch agent · staleness', () => {
  const t = useTempHome('pagr-agent-');
  const write = (o: Record<string, unknown> = {}) => {
    mkdirSync(join(t.home, 'LaunchAgents'), { recursive: true });
    const plist = launchAgentPlistPath(join(t.home, 'LaunchAgents'));
    writeFileSync(plist, renderPlist(opts(t.home, o)));
    return plist;
  };

  it('is not stale when it matches what we would write now', () => {
    writeFileSync(join(t.home, 'bin.js'), '');
    const plist = write();
    expect(
      launchAgentStaleReason(plist, {
        programArguments: [process.execPath, join(t.home, 'bin.js'), 'daemon', 'run'],
        env: { PAGR_HOME: t.home },
      }),
    ).toBeNull();
  });

  it('spots a plist that runs a binary which no longer exists', () => {
    const plist = write({
      programArguments: [process.execPath, '/gone/old/pagr.js', 'daemon', 'run'],
    });
    expect(launchAgentStaleReason(plist, { programArguments: [] })).toMatch(/no longer exists/);
  });

  it('spots a plist pointing at a different PAGR_HOME', () => {
    writeFileSync(join(t.home, 'bin.js'), '');
    const plist = write();
    expect(
      launchAgentStaleReason(plist, {
        programArguments: [process.execPath, join(t.home, 'bin.js'), 'daemon', 'run'],
        env: { PAGR_HOME: '/somewhere/else' },
      }),
    ).toMatch(/points at PAGR_HOME/);
  });

  it('spots different ProgramArguments', () => {
    writeFileSync(join(t.home, 'bin.js'), '');
    const plist = write();
    expect(
      launchAgentStaleReason(plist, {
        programArguments: [process.execPath, join(t.home, 'bin.js'), 'daemon', 'run', '--mock'],
        env: { PAGR_HOME: t.home },
      }),
    ).toMatch(/ProgramArguments differ/);
  });
});

describe('launch agent · install', () => {
  const t = useTempHome('pagr-agent-');

  it('writes the plist, boots out any old job and bootstraps the new one', () => {
    const calls: string[][] = [];
    const plist = installLaunchAgent(
      opts(t.home, { exec: (f: string, a: string[]) => void calls.push([f, ...a]) }),
    );
    expect(readFileSync(plist, 'utf8')).toContain('daemon');
    expect(calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap']);
    expect(calls[1]?.[2]).toBe('gui/501');
  });

  it('refuses clearly when launchctl is missing', () => {
    const err = (() => {
      try {
        installLaunchAgent(opts(t.home, { hasLaunchctl: () => false }));
      } catch (e) {
        return e;
      }
    })() as LaunchAgentError;
    expect(err).toBeInstanceOf(LaunchAgentError);
    expect(err.code).toBe('no_launchctl');
    expect(err.hint).toMatch(/pagr daemon run/);
  });

  it('surfaces launchctl bootstrap failures with launchctl own words', () => {
    const err = (() => {
      try {
        installLaunchAgent(
          opts(t.home, {
            exec: (_f: string, a: string[]) => {
              if (a[0] === 'bootstrap')
                throw Object.assign(new Error('x'), { stderr: 'Bootstrap failed: 5: I/O error' });
            },
          }),
        );
      } catch (e) {
        return e;
      }
    })() as LaunchAgentError;
    expect(err.code).toBe('bootstrap');
    expect(err.detail).toContain('Bootstrap failed: 5');
    expect(err.hint).toMatch(/launchd\.err\.log/);
  });

  it('kickstarts a job that is already bootstrapped instead of failing', () => {
    const calls: string[] = [];
    const plist = installLaunchAgent(
      opts(t.home, {
        exec: (_f: string, a: string[]) => {
          calls.push(a.join(' '));
          if (a[0] === 'bootstrap')
            throw Object.assign(new Error('x'), {
              stderr: 'Load failed: 37: Operation already in progress',
            });
        },
      }),
    );
    expect(plist).toContain(LAUNCH_AGENT_LABEL);
    expect(calls.some((c) => c.startsWith('kickstart -k'))).toBe(true);
  });

  it('reports a plist that cannot be written', () => {
    const dir = join(t.home, 'ro');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'LaunchAgents'), { recursive: true });
    chmodSync(join(dir, 'LaunchAgents'), 0o500);
    try {
      const err = (() => {
        try {
          installLaunchAgent(
            opts(t.home, { launchAgentsDir: join(dir, 'LaunchAgents'), exec: () => {} }),
          );
        } catch (e) {
          return e;
        }
      })() as LaunchAgentError;
      expect(err.code).toBe('plist_write');
      expect(err.hint).toMatch(/LaunchAgents/);
    } finally {
      chmodSync(join(dir, 'LaunchAgents'), 0o700);
    }
  });
});

describe('launch agent · restart policy', () => {
  const t = useTempHome('pagr-agent-');

  it('does not restart the daemon after a non-zero exit, and backs off between restarts', () => {
    const xml = renderPlist(opts(t.home));
    // A plain `<key>KeepAlive</key><true/>` is what made launchd relaunch a daemon that could
    // not start every ~10 seconds forever, re-raising a Keychain dialog on each attempt.
    expect(xml).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>/);
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>Crashed<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  it('honours a custom throttle interval', () => {
    expect(renderPlist(opts(t.home, { throttleIntervalSeconds: 90 }))).toContain(
      '<integer>90</integer>',
    );
  });

  it('the exit-code contract the daemon must follow is a shared constant', () => {
    expect(DAEMON_EXIT).toEqual({ ok: 0, unrecoverable: 78 });
  });
});

describe('launch agent · node launcher', () => {
  const t = useTempHome('pagr-agent-');

  it('is a valid shell script that never hard-codes one Node as the only option', () => {
    const file = writeNodeLauncher(t.home, '/opt/homebrew/Cellar/node/22.11.0/bin/node');
    expect(file).toBe(nodeLauncherPath(t.home));
    const text = readFileSync(file, 'utf8');
    execFileSync('/bin/sh', ['-n', file]); // throws if the generated script does not parse
    // The version-qualified path the installer happened to run under is a LAST resort, after
    // $PAGR_NODE, the PATH and the stable absolute locations.
    expect(text.indexOf('command -v node')).toBeLessThan(
      text.indexOf('/opt/homebrew/Cellar/node/22.11.0/bin/node'),
    );
    expect(text).toContain('/opt/homebrew/bin/node');
    expect(text).toContain(`exit ${DAEMON_EXIT.unrecoverable}`);
    expect(statSync(file).mode & 0o777).toBe(0o700);
  });

  it('execs the Node it is pointed at, passing the arguments through', () => {
    const file = writeNodeLauncher(t.home, process.execPath);
    const out = execFileSync(file, ['-e', 'process.stdout.write("hi:" + process.argv[1])'], {
      encoding: 'utf8',
      env: { ...process.env, PAGR_NODE: process.execPath },
    });
    expect(out).toContain('hi:');
  });

  it('works with no fallback at all', () => {
    expect(() => execFileSync('/bin/sh', ['-c', ':'])).not.toThrow();
    const text = renderNodeLauncher();
    expect(text).toContain('#!/bin/sh');
    expect(text).not.toContain('undefined');
  });

  it('a plist whose interpreter was deleted by a Node upgrade is reported stale', () => {
    writeFileSync(join(t.home, 'bin.js'), '');
    mkdirSync(join(t.home, 'LaunchAgents'), { recursive: true });
    const plist = launchAgentPlistPath(join(t.home, 'LaunchAgents'));
    writeFileSync(
      plist,
      renderPlist(
        opts(t.home, {
          // exactly what `brew upgrade node` leaves behind in an older plist
          programArguments: [
            '/opt/homebrew/Cellar/node/22.11.0/bin/node',
            join(t.home, 'bin.js'),
            'daemon',
            'run',
          ],
        }),
      ),
    );
    expect(launchAgentStaleReason(plist, { programArguments: [] })).toMatch(
      /no longer exists \(a Node upgrade/,
    );
  });
});

describe('launch agent · start and stop', () => {
  const t = useTempHome('pagr-agent-');
  const dir = () => join(t.home, 'LaunchAgents');

  it('stop unloads the job but KEEPS the plist, so it comes back at login', () => {
    const calls: string[][] = [];
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    const result = stopLaunchAgent({
      launchAgentsDir: dir(),
      uid: 501,
      exec: (f, a) => void calls.push([f, ...a]),
    });
    expect(result).toBe('stopped');
    expect(calls).toEqual([['/bin/launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`]]);
    expect(existsSync(launchAgentPlistPath(dir()))).toBe(true);
  });

  it('stopping something that is not loaded is not an error', () => {
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    expect(
      stopLaunchAgent({
        launchAgentsDir: dir(),
        uid: 501,
        exec: () => {
          throw Object.assign(new Error('x'), { stderr: 'Boot-out failed: 3: No such process' });
        },
      }),
    ).toBe('not_loaded');
    expect(existsSync(launchAgentPlistPath(dir()))).toBe(true);
  });

  it('stop says so when nothing is installed', () => {
    expect(stopLaunchAgent({ launchAgentsDir: dir(), uid: 501, exec: () => {} })).toBe(
      'not_installed',
    );
  });

  it('stop surfaces a real launchctl refusal instead of pretending it worked', () => {
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    const err = (() => {
      try {
        stopLaunchAgent({
          launchAgentsDir: dir(),
          uid: 501,
          exec: () => {
            throw Object.assign(new Error('x'), { stderr: 'Boot-out failed: 9: Bad file' });
          },
        });
      } catch (e) {
        return e;
      }
    })() as LaunchAgentError;
    expect(err.code).toBe('bootout');
    expect(err.detail).toContain('Bad file');
  });

  it('start bootstraps the installed plist without rewriting it', () => {
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    const before = readFileSync(launchAgentPlistPath(dir()), 'utf8');
    const calls: string[][] = [];
    expect(
      startLaunchAgent({
        launchAgentsDir: dir(),
        uid: 501,
        exec: (f, a) => void calls.push([f, ...a]),
      }),
    ).toBe('started');
    expect(calls[0]?.[1]).toBe('bootstrap');
    expect(readFileSync(launchAgentPlistPath(dir()), 'utf8')).toBe(before);
  });

  it('start kickstarts a job that is already loaded', () => {
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    const calls: string[] = [];
    expect(
      startLaunchAgent({
        launchAgentsDir: dir(),
        uid: 501,
        exec: (_f, a) => {
          calls.push(a.join(' '));
          if (a[0] === 'bootstrap')
            throw Object.assign(new Error('x'), { stderr: 'Load failed: 37: already loaded' });
        },
      }),
    ).toBe('restarted');
    expect(calls.some((c) => c.startsWith('kickstart'))).toBe(true);
  });

  it('start refuses clearly when there is no launch agent to start', () => {
    const err = (() => {
      try {
        startLaunchAgent({ launchAgentsDir: dir(), uid: 501, exec: () => {} });
      } catch (e) {
        return e;
      }
    })() as LaunchAgentError;
    expect(err.code).toBe('not_installed');
    expect(err.hint).toMatch(/pagr daemon install/);
  });
});

describe('launch agent · uninstall', () => {
  const t = useTempHome('pagr-agent-');

  it('returns false when there was nothing installed, true after an install', () => {
    const exec = () => {};
    const dir = join(t.home, 'LaunchAgents');
    expect(uninstallLaunchAgent({ launchAgentsDir: dir, uid: 501, exec })).toBe(false);
    installLaunchAgent(opts(t.home, { exec }));
    expect(uninstallLaunchAgent({ launchAgentsDir: dir, uid: 501, exec })).toBe(true);
  });

  it('still removes the plist when bootout fails (nothing loaded)', () => {
    const dir = join(t.home, 'LaunchAgents');
    installLaunchAgent(opts(t.home, { exec: () => {} }));
    expect(
      uninstallLaunchAgent({
        launchAgentsDir: dir,
        uid: 501,
        exec: () => {
          throw new Error('Could not find service');
        },
      }),
    ).toBe(true);
  });
});
