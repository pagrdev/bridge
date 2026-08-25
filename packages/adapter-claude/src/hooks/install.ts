import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the bundled hook script (works from src/ and dist/). */
export function bundledHookPath(): string {
  return fileURLToPath(new URL('./permission.mjs', import.meta.url));
}

/**
 * Copy the PermissionRequest hook to `${home}/hooks/permission.mjs` (0700). Returns its path.
 * Does NOT modify any Claude Code settings file; use `hookSettings()` to show the user what to add.
 */
export function installHooks(home: string): { hookPath: string } {
  const dir = path.join(home, 'hooks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, 'permission.mjs');
  fs.copyFileSync(bundledHookPath(), dest);
  fs.chmodSync(dest, 0o700);
  return { hookPath: dest };
}

/**
 * Settings fragment for `~/.claude/settings.json` or a project `.claude/settings.json`.
 * Timeout 600 s matches Claude Code's default; the hook itself gives up at 540 s and prints
 * nothing so the native prompt stays in control.
 */
export function hookSettings(hookPath: string): {
  hooks: {
    PermissionRequest: Array<{
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
} {
  return {
    hooks: {
      PermissionRequest: [
        { hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: 600 }] },
      ],
    },
  };
}
