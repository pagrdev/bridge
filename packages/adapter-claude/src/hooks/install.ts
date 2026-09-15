import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeSettingsUnreadableError,
  claudeUserSettingsPath,
  HOOK_TIMEOUT_SECONDS,
  type HookGroup,
  isPagrHookCommand,
  PERMISSION_REQUEST_EVENT,
  pagrHookCommand,
  planHookInstall,
  planHookRemoval,
  type Settings,
} from './settings.js';

/** Absolute path of the bundled hook script (works from src/ and dist/). */
export function bundledHookPath(): string {
  return fileURLToPath(new URL('./permission.mjs', import.meta.url));
}

/** Where the installed copy of the hook script lives, given a `PAGR_HOME`. */
export function installedHookPath(pagrHome: string): string {
  return path.join(pagrHome, 'hooks', 'permission.mjs');
}

/**
 * Copy the PermissionRequest hook to `${home}/hooks/permission.mjs` (0700). Returns its path.
 * Does NOT modify any Claude Code settings file; `installClaudeHook` does that.
 */
export function installHooks(home: string): { hookPath: string } {
  const dir = path.join(home, 'hooks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = installedHookPath(home);
  fs.copyFileSync(bundledHookPath(), dest);
  fs.chmodSync(dest, 0o700);
  return { hookPath: dest };
}

/**
 * Settings fragment for `~/.claude/settings.json` or a project `.claude/settings.json`.
 * Timeout 600 s is Claude Code's own default for a `command` hook; the hook itself gives up at
 * 540 s and prints nothing so the native prompt stays in control.
 */
export function hookSettings(hookPath: string): {
  hooks: { [PERMISSION_REQUEST_EVENT]: HookGroup[] };
} {
  return {
    hooks: {
      [PERMISSION_REQUEST_EVENT]: [
        {
          hooks: [
            { type: 'command', command: pagrHookCommand(hookPath), timeout: HOOK_TIMEOUT_SECONDS },
          ],
        },
      ],
    },
  };
}

/** A copy of the settings file is kept here before we ever write to it. */
export const SETTINGS_BACKUP_SUFFIX = '.pagr.bak';

export interface HookPaths {
  /** `PAGR_HOME`; the hook script is copied under it. */
  pagrHome: string;
  /** Defaults to `~/.claude/settings.json`; always passed explicitly by the CLI and by tests. */
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HookInstallReport {
  hookPath: string;
  settingsPath: string;
  /**
   * `installed` — we added (or re-pointed) our entry; `already-installed` — nothing to do;
   * `conflict` — they have a PermissionRequest hook of their own and we did not touch the file.
   */
  action: 'installed' | 'already-installed' | 'conflict';
  /** PermissionRequest hook commands that are theirs, not ours. */
  conflict: string[];
  /** Where the previous contents were saved, when we wrote. */
  backupPath: string | null;
  /** One line per change, for printing. Empty when nothing was written. */
  changes: string[];
}

function settingsFile(o: HookPaths): string {
  return o.settingsPath ?? claudeUserSettingsPath(o.env ?? process.env);
}

/** Parse the settings file. Missing is `{}`; unparsable throws rather than being overwritten. */
function readSettings(file: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new ClaudeSettingsUnreadableError(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Write settings, keeping the mode the file already had (Claude Code creates it 0644). */
function writeSettings(file: string, settings: Settings): void {
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pagr.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function backup(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}${SETTINGS_BACKUP_SUFFIX}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Install the PermissionRequest hook at user scope, idempotently.
 *
 * At user scope (`~/.claude/settings.json`) the hook applies to every Claude Code session this
 * person starts — terminal, IDE extension, desktop app — and it fires only when a permission
 * decision is actually needed. If their own settings auto-approve something, Claude Code never
 * raises a decision and the hook never runs.
 *
 * The script is always copied (it is inside `PAGR_HOME`, which is ours). The settings file is
 * only written when there is something to change, and never when they already have a
 * `PermissionRequest` hook of their own, unless `force` says otherwise.
 */
export function installClaudeHook(o: HookPaths & { force?: boolean }): HookInstallReport {
  const settingsPath = settingsFile(o);
  const { hookPath } = installHooks(o.pagrHome);
  const before = readSettings(settingsPath);
  const plan = planHookInstall(before, hookPath, { force: o.force ?? false });

  if (plan.conflict.length > 0 && !o.force)
    return {
      hookPath,
      settingsPath,
      action: 'conflict',
      conflict: plan.conflict,
      backupPath: null,
      changes: [],
    };
  if (!plan.changed)
    return {
      hookPath,
      settingsPath,
      action: 'already-installed',
      conflict: plan.conflict,
      backupPath: null,
      changes: [],
    };

  const backupPath = backup(settingsPath);
  writeSettings(settingsPath, plan.settings);
  const changes = [
    ...plan.rewrote.map(
      (cmd) =>
        `${settingsPath}: re-pointed a previous Pagr ${PERMISSION_REQUEST_EVENT} hook (was ${cmd})`,
    ),
    ...(plan.rewrote.length === 0
      ? [
          `${settingsPath}: added one ${PERMISSION_REQUEST_EVENT} hook running ${pagrHookCommand(hookPath)}`,
        ]
      : []),
    ...(backupPath ? [`${backupPath}: a copy of the file as it was before this change`] : []),
  ];
  return {
    hookPath,
    settingsPath,
    action: 'installed',
    conflict: plan.conflict,
    backupPath,
    changes,
  };
}

export interface HookRemovalReport {
  hookPath: string;
  settingsPath: string;
  /** Hook commands taken out of their settings file. */
  removed: string[];
  scriptRemoved: boolean;
  backupPath: string | null;
  changes: string[];
  /** Set when the settings file could not be read; it was left exactly as it was. */
  problem?: string;
}

/**
 * Take our entry back out and delete the copied script. Everything else in the file is left
 * alone, including a `PermissionRequest` hook of their own.
 *
 * An unreadable settings file is reported, not thrown: `pagr logout` must still finish.
 */
export function uninstallClaudeHook(o: HookPaths): HookRemovalReport {
  const settingsPath = settingsFile(o);
  const hookPath = installedHookPath(o.pagrHome);
  const hadScript = fs.existsSync(hookPath);
  fs.rmSync(hookPath, { force: true });
  const scriptRemoved = hadScript && !fs.existsSync(hookPath);

  let before: Settings;
  try {
    before = readSettings(settingsPath);
  } catch (err) {
    return {
      hookPath,
      settingsPath,
      removed: [],
      scriptRemoved,
      backupPath: null,
      changes: [],
      problem: `${settingsPath} could not be read, so it was left untouched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let plan: ReturnType<typeof planHookRemoval>;
  try {
    plan = planHookRemoval(before, hookPath);
  } catch (err) {
    return {
      hookPath,
      settingsPath,
      removed: [],
      scriptRemoved,
      backupPath: null,
      changes: [],
      problem: `${settingsPath} could not be read, so it was left untouched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!plan.changed)
    return { hookPath, settingsPath, removed: [], scriptRemoved, backupPath: null, changes: [] };

  const backupPath = backup(settingsPath);
  writeSettings(settingsPath, plan.settings);
  return {
    hookPath,
    settingsPath,
    removed: plan.removed,
    scriptRemoved,
    backupPath,
    changes: [
      ...plan.removed.map((cmd) => `${settingsPath}: removed the Pagr hook entry (${cmd})`),
      ...(backupPath ? [`${backupPath}: a copy of the file as it was before this change`] : []),
    ],
  };
}

export interface HookState {
  hookPath: string;
  settingsPath: string;
  /** The script is present under `PAGR_HOME`. */
  scriptInstalled: boolean;
  /** Their user settings run it. */
  entryInstalled: boolean;
  /** PermissionRequest hooks of their own, if any. */
  conflict: string[];
  /** Set when the settings file could not be read. */
  problem?: string;
}

/** What `pagr doctor` reports. Never throws: an unreadable file is a `problem`, not a crash. */
export function claudeHookState(o: HookPaths): HookState {
  const settingsPath = settingsFile(o);
  const hookPath = installedHookPath(o.pagrHome);
  const scriptInstalled = fs.existsSync(hookPath);
  let settings: Settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    return {
      hookPath,
      settingsPath,
      scriptInstalled,
      entryInstalled: false,
      conflict: [],
      problem: err instanceof Error ? err.message : String(err),
    };
  }
  const hooks = settings.hooks;
  const groups =
    hooks && typeof hooks === 'object' && !Array.isArray(hooks)
      ? (hooks as Settings)[PERMISSION_REQUEST_EVENT]
      : undefined;
  if (groups !== undefined && !Array.isArray(groups))
    return {
      hookPath,
      settingsPath,
      scriptInstalled,
      entryInstalled: false,
      conflict: [],
      problem: `${settingsPath}: "hooks.${PERMISSION_REQUEST_EVENT}" is not an array`,
    };
  const commands = (Array.isArray(groups) ? (groups as HookGroup[]) : [])
    .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
    .map((h) => (typeof h?.command === 'string' ? h.command : ''))
    .filter(Boolean);
  const wanted = pagrHookCommand(hookPath);
  return {
    hookPath,
    settingsPath,
    scriptInstalled,
    entryInstalled: commands.includes(wanted),
    conflict: commands.filter((c) => !isPagrHookCommand(c, hookPath)),
  };
}
