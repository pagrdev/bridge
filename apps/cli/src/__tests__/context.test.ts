import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPaths, sleepMs } from '@pagr/bridge-core';
import { describe, expect, it } from 'vitest';
import { createContext, defaultBinPath, isRemoteSession, withHome } from '../context.js';

describe('context · the sleep must keep the process alive', () => {
  /**
   * Regression guard. With an unref-ed timer, Node drains the loop while `connect` waits
   * between polls: it prints the pairing code and then exits 0 without a word. Node excludes
   * unref-ed timers from `getActiveResourcesInfo()`, so this asserts the ref directly.
   */
  const activeTimeouts = () =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  it('core sleepMs holds the event loop open', async () => {
    const before = activeTimeouts();
    const p = sleepMs(20);
    expect(activeTimeouts()).toBeGreaterThan(before);
    await p;
  });

  it('the CLI context sleep holds the event loop open', async () => {
    const before = activeTimeouts();
    const p = createContext({ env: {} }).sleep(20);
    expect(activeTimeouts()).toBeGreaterThan(before);
    await p;
  });
});

describe('context · defaults', () => {
  it('resolves PAGR_HOME from the environment', () => {
    expect(createContext({ env: { PAGR_HOME: '/x/y' } }).home).toBe('/x/y');
    expect(createContext({ env: { PAGR_HOME: '/x/y' } }).paths.configFile).toBe('/x/y/config.json');
  });

  it('detects a remote shell so it does not try to open a browser there', () => {
    expect(isRemoteSession({})).toBe(false);
    expect(isRemoteSession({ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 9' })).toBe(true);
    expect(isRemoteSession({ SSH_TTY: '/dev/pts/0' })).toBe(true);
    expect(isRemoteSession({ SSH_CLIENT: '1.2.3.4 1 2' })).toBe(true);
  });

  it('points the launch agent at a bin path that exists in this checkout', () => {
    const bin = defaultBinPath();
    expect(bin).toMatch(/bin\.(ts|js)$/);
    expect(existsSync(bin)).toBe(true);
  });

  it('knows whether launchd is available on this machine', () => {
    expect(typeof createContext({ env: {} }).hasLaunchctl()).toBe('boolean');
  });

  it('withHome re-derives paths but keeps an injected secret store', async () => {
    const injected = {
      kind: 'memory' as const,
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    };
    const base = createContext({ env: {}, home: '/a', secretStore: async () => injected });
    const moved = withHome(base, '/b', { secretStore: async () => injected });
    expect(moved.home).toBe('/b');
    expect(moved.paths).toEqual(getPaths('/b'));
    expect(await moved.secretStore()).toBe(injected);
  });

  it('withHome installs a real secret store when none was injected', () => {
    const base = createContext({ env: {}, home: '/a' });
    expect(withHome(base, join('/b')).paths.projectsFile).toBe('/b/projects.json');
  });

  it('onInterrupt registers and cleanly removes its handlers', () => {
    const ctx = createContext({ env: {} });
    const before = process.listenerCount('SIGINT');
    const dispose = ctx.onInterrupt(() => {});
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
