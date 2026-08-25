import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  LaunchAgentError,
  launchAgentPlistPath,
  launchAgentStaleReason,
  readPlistFacts,
  renderPlist,
  uninstallLaunchAgent,
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
