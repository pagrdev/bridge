import os from 'node:os';
import path from 'node:path';

/**
 * Editing `~/.claude/settings.json`.
 *
 * That file belongs to the user. Everything in this module is written so that two things stay
 * true no matter what is already in it:
 *
 *  1. We only ever add, re-point, or remove **one** entry — the `PermissionRequest` hook that
 *     runs `permission.mjs` out of `PAGR_HOME`. Every other key, every other hook event, and
 *     every other handler inside `PermissionRequest` is copied through untouched.
 *  2. We never silently displace a `PermissionRequest` hook they wrote themselves. Claude Code
 *     runs all matching hooks in parallel and documents no precedence between two decisions, so
 *     installing ours next to theirs is a race over who answers the prompt. When we find one, the
 *     install is refused and reported; `{ force: true }` is the only way past it.
 *
 * The functions here are pure: they take the parsed settings and return the settings that should
 * be written, so the file IO (and the "here is exactly what changed" report) lives in one place
 * in `install.ts` and every branch is testable without a home directory.
 */

/** Claude Code reads user-scope settings from here. `CLAUDE_CONFIG_DIR` moves the directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** The hook event Pagr registers for. Fires only when a permission decision is actually needed. */
export const PERMISSION_REQUEST_EVENT = 'PermissionRequest';

/**
 * Claude Code's default `command` hook timeout, and the most it will wait. The hook itself gives
 * up sooner (see `PAGR_HOOK_TIMEOUT_MS` in `permission.mjs`) and prints nothing, so a phone that
 * never answers ends in the ordinary terminal prompt rather than in a hook that was killed.
 */
export const HOOK_TIMEOUT_SECONDS = 600;

export interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

export type Settings = Record<string, unknown>;

/** The settings file exists but is not shaped like settings. We refuse to guess at it. */
export class ClaudeSettingsUnreadableError extends Error {
  constructor(readonly detail: string) {
    super(`this Claude Code settings file is not shaped like settings: ${detail}`);
    this.name = 'ClaudeSettingsUnreadableError';
  }
}

/**
 * `~/.claude/settings.json` — the **user** scope, which applies to every Claude Code session this
 * person starts: terminal, IDE extension, desktop app.
 *
 * `env` is a parameter and not `process.env` so tests can never reach the real `~/.claude`.
 */
export function claudeUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env[CLAUDE_CONFIG_DIR_ENV]?.trim();
  if (configDir) return path.join(configDir, 'settings.json');
  return path.join(env.HOME || os.homedir(), '.claude', 'settings.json');
}

/** The exact `command` string we write. Quoted, because a home directory may contain spaces. */
export function pagrHookCommand(hookPath: string): string {
  return `node ${JSON.stringify(hookPath)}`;
}

/** The one matcher group Pagr owns. No `matcher`, so it sees every tool that needs a decision. */
export function pagrHookGroup(hookPath: string): HookGroup {
  return {
    hooks: [{ type: 'command', command: pagrHookCommand(hookPath), timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/**
 * Is this hook command ours?
 *
 * Matched on the script path rather than on a marker key inside the JSON, because an unknown key
 * in a settings file makes Claude Code complain at the user about a setting they did not write.
 * The shape is `<something containing "pagr">/hooks/permission.mjs`, which covers the default
 * `~/.pagr` as well as a `PAGR_HOME` somewhere else — including the one a previous install used,
 * so moving `PAGR_HOME` re-points the entry instead of leaving a dead one behind.
 */
export function isPagrHookCommand(command: string, hookPath?: string): boolean {
  if (hookPath && command.includes(hookPath)) return true;
  return /pagr[^/\\]*[/\\]hooks[/\\]permission\.mjs/i.test(command);
}

export interface HookInstallPlan {
  /** The settings to write. Identical to the input when `changed` is false. */
  settings: Settings;
  /** Whether the file needs writing at all. */
  changed: boolean;
  /** Our entry was already there, pointing at this exact script. */
  alreadyInstalled: boolean;
  /** Commands of our own entries that pointed elsewhere and were re-pointed at `hookPath`. */
  rewrote: string[];
  /** `PermissionRequest` hook commands that belong to someone else. */
  conflict: string[];
}

function asSettings(existing: unknown, what: string): Settings {
  if (existing === null || existing === undefined) return {};
  if (typeof existing !== 'object' || Array.isArray(existing))
    throw new ClaudeSettingsUnreadableError(`${what} is ${describe(existing)}, expected an object`);
  return structuredClone(existing) as Settings;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

/** Read `hooks.PermissionRequest` as an array of groups, refusing anything else. */
function readGroups(settings: Settings): { hooks: Settings; groups: HookGroup[] } {
  const hooks = settings.hooks === undefined ? {} : asSettings(settings.hooks, '"hooks"');
  const raw = hooks[PERMISSION_REQUEST_EVENT];
  if (raw === undefined) return { hooks, groups: [] };
  if (!Array.isArray(raw))
    throw new ClaudeSettingsUnreadableError(
      `"hooks.${PERMISSION_REQUEST_EVENT}" is ${describe(raw)}, expected an array`,
    );
  return { hooks, groups: raw as HookGroup[] };
}

const handlersOf = (g: HookGroup): HookHandler[] => (Array.isArray(g?.hooks) ? g.hooks : []);
const commandOf = (h: HookHandler): string => (typeof h?.command === 'string' ? h.command : '');

/**
 * Work out what installing the hook would do to `existing`, without doing it. The returned
 * `settings` is a fresh object; the input is never mutated, so a write that fails leaves nothing
 * half-edited.
 */
export function planHookInstall(
  existing: unknown,
  hookPath: string,
  opts: { force?: boolean } = {},
): HookInstallPlan {
  const settings = asSettings(existing, 'the settings file');
  const { hooks, groups } = readGroups(settings);
  const want = pagrHookCommand(hookPath);

  const rewrote: string[] = [];
  const conflict: string[] = [];
  let alreadyInstalled = false;

  const next: HookGroup[] = [];
  for (const group of groups) {
    const handlers = handlersOf(group);
    const kept: HookHandler[] = [];
    for (const handler of handlers) {
      const cmd = commandOf(handler);
      if (!isPagrHookCommand(cmd, hookPath)) {
        if (cmd) conflict.push(cmd);
        kept.push(handler);
        continue;
      }
      if (cmd === want && !alreadyInstalled) {
        alreadyInstalled = true;
        kept.push(handler);
        continue;
      }
      // Ours, but pointing at another PAGR_HOME (or duplicated). Re-point the first, drop the rest.
      rewrote.push(cmd);
      if (!alreadyInstalled) {
        alreadyInstalled = true;
        kept.push({ ...handler, command: want, timeout: handler.timeout ?? HOOK_TIMEOUT_SECONDS });
      }
    }
    // A group we emptied out was entirely ours; a group with no handlers at all is theirs, kept.
    if (kept.length > 0 || handlers.length === 0) next.push({ ...group, hooks: kept });
  }

  if (conflict.length > 0 && !opts.force)
    return { settings: settings, changed: false, alreadyInstalled: false, rewrote: [], conflict };

  if (!alreadyInstalled) next.push(pagrHookGroup(hookPath));

  const changed = rewrote.length > 0 || !alreadyInstalled;
  if (!changed) return { settings, changed: false, alreadyInstalled: true, rewrote, conflict };
  settings.hooks = { ...hooks, [PERMISSION_REQUEST_EVENT]: next };
  return { settings, changed: true, alreadyInstalled: false, rewrote, conflict };
}

export interface HookRemovalPlan {
  settings: Settings;
  changed: boolean;
  /** Commands that were removed, so the user can be told exactly what left their file. */
  removed: string[];
}

/**
 * Work out what removing our hook would do. Only entries `isPagrHookCommand` claims are dropped;
 * a `PermissionRequest` array, and the `hooks` object, are removed only if we emptied them.
 */
export function planHookRemoval(existing: unknown, hookPath?: string): HookRemovalPlan {
  const settings = asSettings(existing, 'the settings file');
  const { hooks, groups } = readGroups(settings);
  const removed: string[] = [];

  const next: HookGroup[] = [];
  for (const group of groups) {
    const handlers = handlersOf(group);
    const kept = handlers.filter((h) => {
      const cmd = commandOf(h);
      if (!isPagrHookCommand(cmd, hookPath)) return true;
      removed.push(cmd);
      return false;
    });
    if (kept.length > 0 || handlers.length === 0) next.push({ ...group, hooks: kept });
  }
  if (removed.length === 0) return { settings, changed: false, removed };

  const nextHooks: Settings = { ...hooks };
  if (next.length > 0) nextHooks[PERMISSION_REQUEST_EVENT] = next;
  else delete nextHooks[PERMISSION_REQUEST_EVENT];
  if (Object.keys(nextHooks).length > 0) settings.hooks = nextHooks;
  else delete settings.hooks;
  return { settings, changed: true, removed };
}
