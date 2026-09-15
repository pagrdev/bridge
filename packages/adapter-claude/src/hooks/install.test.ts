import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeHookState,
  installClaudeHook,
  SETTINGS_BACKUP_SUFFIX,
  uninstallClaudeHook,
} from './install.js';
import { ClaudeSettingsUnreadableError } from './settings.js';

/**
 * The file-IO half: what actually happens to a real `settings.json` on disk.
 *
 * Every path here is inside a temp directory. Nothing in this file may reach the real
 * `~/.claude` — that is the user's own configuration and a test has no business in it.
 */
describe('installClaudeHook', () => {
  let root: string;
  let pagrHome: string;
  let settingsPath: string;
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-hook-io-')));
    pagrHome = path.join(root, 'pagr');
    settingsPath = path.join(root, 'claude', 'settings.json');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('copies the script, creates the settings file, and says exactly what it did', () => {
    const r = installClaudeHook({ pagrHome, settingsPath });
    expect(r.action).toBe('installed');
    expect(r.hookPath).toBe(path.join(pagrHome, 'hooks', 'permission.mjs'));
    expect(fs.readFileSync(r.hookPath, 'utf8')).toContain('PermissionRequest');
    expect(fs.statSync(r.hookPath).mode & 0o777).toBe(0o700);
    expect(read()).toEqual({
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: 'command', command: `node "${r.hookPath}"`, timeout: 600 }] },
        ],
      },
    });
    // "Never modify a file they own with no record": the report names the file and the entry.
    expect(r.changes.join('\n')).toContain(settingsPath);
    expect(r.changes.join('\n')).toContain('PermissionRequest');
  });

  it('keeps every other setting they had, and backs the file up before touching it', () => {
    const before = {
      model: 'claude-sonnet-4-5',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));
    const r = installClaudeHook({ pagrHome, settingsPath });
    expect(r.action).toBe('installed');
    expect(read()).toMatchObject(before);
    const backup = `${settingsPath}${SETTINGS_BACKUP_SUFFIX}`;
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(before);
    expect(r.backupPath).toBe(backup);
  });

  it('is idempotent and does not rewrite a file that is already correct', () => {
    installClaudeHook({ pagrHome, settingsPath });
    const mtime = fs.statSync(settingsPath).mtimeMs;
    const again = installClaudeHook({ pagrHome, settingsPath });
    expect(again.action).toBe('already-installed');
    expect(again.changes).toEqual([]);
    expect(again.backupPath).toBeNull();
    expect(fs.statSync(settingsPath).mtimeMs).toBe(mtime);
  });

  it('keeps the file mode they had', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}', { mode: 0o600 });
    fs.chmodSync(settingsPath, 0o600);
    installClaudeHook({ pagrHome, settingsPath });
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('stops at a PermissionRequest hook of their own instead of racing it', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const theirs = {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(theirs, null, 2));
    const r = installClaudeHook({ pagrHome, settingsPath });
    expect(r.action).toBe('conflict');
    expect(r.conflict).toEqual(['mine.sh']);
    expect(read()).toEqual(theirs);
    // The script is still copied — only the settings file is left alone.
    expect(fs.existsSync(r.hookPath)).toBe(true);
    expect(installClaudeHook({ pagrHome, settingsPath, force: true }).action).toBe('installed');
    expect(read().hooks.PermissionRequest).toHaveLength(2);
  });

  it('refuses to overwrite a settings file it cannot parse', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not json');
    expect(() => installClaudeHook({ pagrHome, settingsPath })).toThrow(
      ClaudeSettingsUnreadableError,
    );
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });
});

describe('uninstallClaudeHook', () => {
  let root: string;
  let pagrHome: string;
  let settingsPath: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-hook-io-')));
    pagrHome = path.join(root, 'pagr');
    settingsPath = path.join(root, 'claude', 'settings.json');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('round-trips against a file full of things it does not own', () => {
    const before = {
      model: 'claude-sonnet-4-5',
      env: { FOO: 'bar' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }],
      },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));
    installClaudeHook({ pagrHome, settingsPath, force: true });
    const r = uninstallClaudeHook({ pagrHome, settingsPath });
    expect(r.removed).toHaveLength(1);
    expect(r.scriptRemoved).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(before);
    expect(fs.existsSync(path.join(pagrHome, 'hooks', 'permission.mjs'))).toBe(false);
  });

  it('is a no-op, and never an error, when nothing of ours is there', () => {
    const r = uninstallClaudeHook({ pagrHome, settingsPath });
    expect(r.removed).toEqual([]);
    expect(r.changes).toEqual([]);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('leaves an unparsable settings file alone rather than failing an uninstall', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not json');
    const r = uninstallClaudeHook({ pagrHome, settingsPath });
    expect(r.removed).toEqual([]);
    expect(r.problem).toContain('settings');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });
});

describe('claudeHookState', () => {
  let root: string;
  let pagrHome: string;
  let settingsPath: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-hook-io-')));
    pagrHome = path.join(root, 'pagr');
    settingsPath = path.join(root, 'claude', 'settings.json');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports not-installed, installed, and a conflicting hook of their own', () => {
    expect(claudeHookState({ pagrHome, settingsPath })).toMatchObject({
      scriptInstalled: false,
      entryInstalled: false,
      conflict: [],
    });
    installClaudeHook({ pagrHome, settingsPath });
    expect(claudeHookState({ pagrHome, settingsPath })).toMatchObject({
      scriptInstalled: true,
      entryInstalled: true,
      conflict: [],
    });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
      }),
    );
    expect(claudeHookState({ pagrHome, settingsPath })).toMatchObject({
      entryInstalled: false,
      conflict: ['mine.sh'],
    });
  });

  it('reports an unreadable settings file as a problem, not as "not installed"', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'nonsense');
    const s = claudeHookState({ pagrHome, settingsPath });
    expect(s.entryInstalled).toBe(false);
    expect(s.problem).toBeTruthy();
  });
});
