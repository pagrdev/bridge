import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSettingsPath, installHookForUser, removeHookForUser } from '../claudeHook.js';
import { runChecks } from '../commands/doctor.js';
import { type CliContext, createContext } from '../context.js';
import { FakeApi, statusCompleted, statusPending } from './fakeApi.js';
import { type Harness, harness, plain } from './helpers.js';

/**
 * `pagr` writing to `~/.claude/settings.json`.
 *
 * The harness points `env.HOME` at a temp directory, so every path here is throwaway. A test that
 * reached the real `~/.claude` would be editing the developer's own Claude Code configuration.
 */
let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const ctx = (): CliContext => createContext(h.overrides);
const say = (line: string) => h.stdout.push(line);
const settingsFile = () => claudeSettingsPath(h.overrides.env ?? {});
const settings = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));
const seed = (value: unknown) => {
  mkdirSync(join(h.overrides.env?.HOME ?? '', '.claude'), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(value, null, 2));
};

describe('claudeSettingsPath', () => {
  it('is inside the HOME the context was given, never the real one', () => {
    expect(settingsFile()).toBe(join(h.overrides.env?.HOME ?? '', '.claude', 'settings.json'));
    expect(settingsFile().startsWith('/Users/')).toBe(false);
  });
});

describe('installHookForUser', () => {
  it('installs the hook and prints exactly what it changed', () => {
    const r = installHookForUser(ctx(), say);
    expect(r.action).toBe('installed');
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
    const printed = plain(h.stdout);
    expect(printed).toContain(settingsFile());
    expect(printed).toContain('PermissionRequest');
    // The reversal is named at the moment of the change, not buried in docs.
    expect(printed).toContain('pagr logout');
  });

  it('says nothing new the second time and leaves one entry', () => {
    installHookForUser(ctx(), say);
    h.stdout.length = 0;
    const again = installHookForUser(ctx(), say);
    expect(again.action).toBe('already-installed');
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
  });

  it('keeps their other settings and warns instead of racing their own hook', () => {
    seed({
      model: 'claude-sonnet-4-5',
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    });
    const r = installHookForUser(ctx(), say);
    expect(r.action).toBe('conflict');
    expect(settings()).toEqual({
      model: 'claude-sonnet-4-5',
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    });
    expect(plain(h.stdout)).toContain('mine.sh');
  });

  it('never fails the command it is part of when the settings file is broken', () => {
    seed('not-an-object');
    writeFileSync(settingsFile(), '{ broken');
    const r = installHookForUser(ctx(), say);
    expect(r.action).toBe('failed');
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ broken');
    expect(plain(h.stdout)).toContain('left it alone');
  });
});

describe('removeHookForUser', () => {
  it('undoes the install exactly, leaving everything else', () => {
    const before = {
      model: 'claude-sonnet-4-5',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }],
      },
    };
    seed(before);
    installHookForUser(ctx(), say, { force: true });
    expect(settings().hooks.PermissionRequest).toHaveLength(2);
    const r = removeHookForUser(ctx(), say);
    expect(r.removed).toHaveLength(1);
    expect(settings()).toEqual(before);
  });

  it('is quiet and successful when there is nothing of ours to remove', () => {
    const r = removeHookForUser(ctx(), say);
    expect(r.removed).toEqual([]);
    expect(existsSync(settingsFile())).toBe(false);
  });
});

describe('pagr commands that install and remove the hook', () => {
  it('`pagr connect` installs it as part of setting the Mac up', async () => {
    const api = await FakeApi.start({ status: [statusPending(), statusCompleted()] });
    try {
      expect(await h.run(['connect', '--api-url', api.url, '--wait', '0'])).toBe(0);
    } finally {
      await api.close();
    }
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
    expect(plain(h.stdout)).toContain('Claude Code prompts will reach your phone');
  });

  it('`pagr daemon install` installs it', async () => {
    expect(await h.run(['daemon', 'install'])).toBe(0);
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
  });

  it('`pagr logout` takes it back out and leaves their file otherwise intact', async () => {
    const before = { model: 'claude-sonnet-4-5', env: { A: 'b' } };
    seed(before);
    await h.run(['daemon', 'install']);
    expect(settings().hooks).toBeTruthy();
    expect(await h.run(['logout'])).toBe(0);
    expect(settings()).toEqual(before);
  });

  it('`pagr uninstall` takes it back out too', async () => {
    await h.run(['daemon', 'install']);
    expect(await h.run(['uninstall', '--yes'])).toBe(0);
    expect(settings()).toEqual({});
  });
});

describe('pagr doctor · claude hook', () => {
  const hookCheck = async () =>
    (await runChecks(ctx(), { offline: true })).find((c) => c.name === 'claude hook');

  it('warns with a fix line while the hook is not installed', async () => {
    const c = await hookCheck();
    expect(c?.status).toBe('warn');
    expect(c?.fix).toContain('pagr daemon install');
  });

  it('reports ok once it is installed, naming the settings file', async () => {
    installHookForUser(ctx(), () => {});
    const c = await hookCheck();
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain(settingsFile());
  });

  it('warns about a PermissionRequest hook of their own, with what to do', async () => {
    seed({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
    const c = await hookCheck();
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('mine.sh');
    expect(c?.fix).toBeTruthy();
  });
});
