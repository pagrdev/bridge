import {
  claudeHookState,
  claudeUserSettingsPath,
  type HookInstallReport,
  type HookRemovalReport,
  type HookState,
  installClaudeHook,
  uninstallClaudeHook,
} from '@pagr/bridge-adapter-claude';
import type { CliContext } from './context.js';
import { dim, ok, warn } from './output.js';

/**
 * The Claude Code `PermissionRequest` hook, from the CLI's side.
 *
 * This is the one place `pagr` writes to a file the user owns — `~/.claude/settings.json` — so
 * two rules apply to everything here:
 *
 *  - it prints exactly what it changed, and where the copy of the previous contents is;
 *  - it never fails the command it is part of. `pagr connect` pairing this Mac is the job;
 *    a settings file we could not parse is a message, not a failed pairing.
 *
 * The path comes from `ctx.env`, never from `os.homedir()`, so tests cannot reach a real
 * `~/.claude`.
 */
export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return claudeUserSettingsPath(env);
}

export type InstallOutcome = HookInstallReport['action'] | 'failed';

/**
 * Install the hook for every Claude Code session this person starts. Idempotent, and a no-op
 * report when it is already there.
 */
export function installHookForUser(
  ctx: CliContext,
  say: (line: string) => void,
  opts: { force?: boolean } = {},
): { action: InstallOutcome; report: HookInstallReport | null } {
  let report: HookInstallReport;
  try {
    report = installClaudeHook({
      pagrHome: ctx.home,
      settingsPath: claudeSettingsPath(ctx.env),
      ...(opts.force ? { force: true } : {}),
    });
  } catch (err) {
    say(
      warn(
        `could not read ${claudeSettingsPath(ctx.env)}, so I left it alone: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
    say(dim('  fix the JSON in that file and run `pagr daemon install` again to finish setup'));
    return { action: 'failed', report: null };
  }

  if (report.action === 'conflict') {
    say(
      warn(
        `you already have a Claude Code PermissionRequest hook (${report.conflict.join(', ')}), so I changed nothing`,
      ),
    );
    say(
      dim(
        '  two of them would race over who answers the prompt, and Claude Code documents no winner',
      ),
    );
    say(dim(`  to let Pagr relay prompts anyway: pagr claude hook-install --force`));
    return { action: 'conflict', report };
  }
  if (report.action === 'already-installed') return { action: 'already-installed', report };

  say(ok('Claude Code prompts will reach your phone'));
  for (const line of report.changes) say(dim(`  ${line}`));
  say(dim('  `pagr logout` and `pagr uninstall` take this entry back out'));
  return { action: 'installed', report };
}

/** Take the hook back out. Never throws; an unreadable settings file is reported and left alone. */
export function removeHookForUser(ctx: CliContext, say: (line: string) => void): HookRemovalReport {
  const report = uninstallClaudeHook({
    pagrHome: ctx.home,
    settingsPath: claudeSettingsPath(ctx.env),
  });
  if (report.problem) say(warn(report.problem));
  for (const line of report.changes) say(dim(`  ${line}`));
  return report;
}

/** What `pagr doctor` and `pagr status` read. */
export function hookState(ctx: CliContext): HookState {
  return claudeHookState({ pagrHome: ctx.home, settingsPath: claudeSettingsPath(ctx.env) });
}
