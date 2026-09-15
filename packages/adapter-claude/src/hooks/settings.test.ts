import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeSettingsUnreadableError,
  claudeUserSettingsPath,
  isPagrHookCommand,
  pagrHookGroup,
  planHookInstall,
  planHookRemoval,
} from './settings.js';

const HOOK = '/Users/jane/.pagr/hooks/permission.mjs';

/**
 * `~/.claude/settings.json` is the user's file. Everything here is about the two promises made
 * about it: we only ever add or remove one entry of our own, and we never silently displace a
 * decision-making hook they wrote themselves.
 */
describe('planHookInstall', () => {
  it('adds a PermissionRequest entry to an empty settings file', () => {
    const p = planHookInstall({}, HOOK);
    expect(p.changed).toBe(true);
    expect(p.alreadyInstalled).toBe(false);
    expect(p.conflict).toEqual([]);
    expect(p.settings).toEqual({ hooks: { PermissionRequest: [pagrHookGroup(HOOK)] } });
    const group = pagrHookGroup(HOOK).hooks[0];
    expect(group).toMatchObject({ type: 'command', timeout: 600 });
    expect(group?.command).toContain(HOOK);
  });

  it('treats a missing file (null/undefined) as empty rather than failing', () => {
    expect(planHookInstall(undefined, HOOK).settings).toEqual({
      hooks: { PermissionRequest: [pagrHookGroup(HOOK)] },
    });
    expect(planHookInstall(null, HOOK).changed).toBe(true);
  });

  it('merges into settings that already have unrelated keys and unrelated hooks', () => {
    const before = {
      model: 'claude-sonnet-4-5',
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
      },
    };
    const snapshot = structuredClone(before);
    const p = planHookInstall(before, HOOK);
    expect(p.changed).toBe(true);
    // The caller's object is never mutated: a failed write must not leave a half-edited object.
    expect(before).toEqual(snapshot);
    expect(p.settings).toMatchObject({
      model: 'claude-sonnet-4-5',
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: {
        SessionStart: snapshot.hooks.SessionStart,
        PreToolUse: snapshot.hooks.PreToolUse,
        PermissionRequest: [pagrHookGroup(HOOK)],
      },
    });
  });

  it('is idempotent: a second install changes nothing', () => {
    const once = planHookInstall({}, HOOK);
    const twice = planHookInstall(once.settings, HOOK);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyInstalled).toBe(true);
    expect(twice.settings).toEqual(once.settings);
    const thrice = planHookInstall(twice.settings, HOOK);
    expect(
      (thrice.settings as { hooks: { PermissionRequest: unknown[] } }).hooks.PermissionRequest,
    ).toHaveLength(1);
  });

  it('re-points an entry left behind by an older PAGR_HOME instead of adding a second one', () => {
    const stale = planHookInstall({}, '/Users/jane/old-pagr/hooks/permission.mjs').settings;
    const p = planHookInstall(stale, HOOK);
    expect(p.changed).toBe(true);
    expect(p.alreadyInstalled).toBe(false);
    expect(p.rewrote).toEqual([`node "/Users/jane/old-pagr/hooks/permission.mjs"`]);
    const groups = (p.settings as { hooks: { PermissionRequest: unknown[] } }).hooks
      .PermissionRequest;
    expect(groups).toEqual([pagrHookGroup(HOOK)]);
  });

  it('refuses to install beside a PermissionRequest hook they wrote themselves', () => {
    // Claude Code runs all matching hooks in parallel and documents no precedence between two
    // decisions, so adding ours next to theirs would be an undocumented race over who answers.
    const theirs = {
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: '~/bin/my-approver.sh' }] }],
      },
    };
    const p = planHookInstall(theirs, HOOK);
    expect(p.changed).toBe(false);
    expect(p.alreadyInstalled).toBe(false);
    expect(p.conflict).toEqual(['~/bin/my-approver.sh']);
    expect(p.settings).toEqual(theirs);
  });

  it('installs beside their hook only when explicitly forced', () => {
    const theirs = {
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: '~/bin/my-approver.sh' }] }],
      },
    };
    const p = planHookInstall(theirs, HOOK, { force: true });
    expect(p.changed).toBe(true);
    expect(p.conflict).toEqual(['~/bin/my-approver.sh']);
    const groups = (p.settings as { hooks: { PermissionRequest: unknown[] } }).hooks
      .PermissionRequest;
    // Theirs stays first and untouched; ours is appended.
    expect(groups).toEqual([theirs.hooks.PermissionRequest[0], pagrHookGroup(HOOK)]);
  });

  it('refuses to guess at a settings file that is not a JSON object', () => {
    expect(() => planHookInstall([1, 2, 3], HOOK)).toThrow(ClaudeSettingsUnreadableError);
    expect(() => planHookInstall('nope', HOOK)).toThrow(ClaudeSettingsUnreadableError);
    expect(() => planHookInstall({ hooks: 'nope' }, HOOK)).toThrow(ClaudeSettingsUnreadableError);
    expect(() => planHookInstall({ hooks: { PermissionRequest: {} } }, HOOK)).toThrow(
      ClaudeSettingsUnreadableError,
    );
  });
});

describe('planHookRemoval', () => {
  it('round-trips: install then remove leaves the file exactly as it was', () => {
    const before = {
      model: 'claude-sonnet-4-5',
      statusLine: { type: 'command', command: 'my-status' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command: '~/bin/my-approver.sh' }] }],
      },
    };
    const installed = planHookInstall(before, HOOK, { force: true }).settings;
    const removed = planHookRemoval(installed);
    expect(removed.changed).toBe(true);
    expect(removed.removed).toEqual([`node "${HOOK}"`]);
    expect(removed.settings).toEqual(before);
  });

  it('removes the hooks key entirely when ours was the only thing in it', () => {
    const installed = planHookInstall({ model: 'x' }, HOOK).settings;
    const removed = planHookRemoval(installed);
    expect(removed.settings).toEqual({ model: 'x' });
  });

  it('is a no-op on a settings file we never touched', () => {
    const theirs = {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] },
    };
    const r = planHookRemoval(theirs);
    expect(r.changed).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.settings).toEqual(theirs);
    expect(planHookRemoval({}).changed).toBe(false);
    expect(planHookRemoval(undefined).changed).toBe(false);
  });

  it('removes an entry from an older PAGR_HOME too', () => {
    const stale = planHookInstall({}, '/Users/jane/old-pagr/hooks/permission.mjs').settings;
    expect(planHookRemoval(stale).settings).toEqual({});
  });
});

describe('isPagrHookCommand', () => {
  it('recognises our entry by its script path, wherever PAGR_HOME is', () => {
    expect(isPagrHookCommand(`node "${HOOK}"`)).toBe(true);
    expect(isPagrHookCommand('node /Users/jane/.pagr/hooks/permission.mjs')).toBe(true);
    expect(isPagrHookCommand('node "/tmp/pagr-test-123/pagr/hooks/permission.mjs"')).toBe(true);
  });

  it('does not claim someone else’s hook', () => {
    expect(isPagrHookCommand('~/bin/my-approver.sh')).toBe(false);
    expect(isPagrHookCommand('node /Users/jane/dev/hooks/permission.mjs')).toBe(false);
    expect(isPagrHookCommand('node /Users/jane/.pagr/hooks/other.mjs')).toBe(false);
  });
});

describe('claudeUserSettingsPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-home-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is ~/.claude/settings.json, taking HOME from the environment handed in', () => {
    // Tests must never reach the real ~/.claude, so this has to be a seam, not `os.homedir()`.
    expect(claudeUserSettingsPath({ HOME: dir })).toBe(path.join(dir, '.claude', 'settings.json'));
  });

  it('honours CLAUDE_CONFIG_DIR, which moves the whole config directory', () => {
    expect(claudeUserSettingsPath({ HOME: dir, CLAUDE_CONFIG_DIR: `${dir}/cfg` })).toBe(
      path.join(dir, 'cfg', 'settings.json'),
    );
  });
});
