import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deleteIdentity, readConfig, uninstallLaunchAgent } from '@pagr/bridge-core';
import type { Command } from 'commander';
import { removeHookForUser } from '../claudeHook.js';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, socketPath } from '../ipc.js';
import { bold, dim, ok, printJson, warn } from '../output.js';
import { tryResolveWebUrl } from '../urls.js';
import { removeChannelRegistration } from './claudeChannel.js';

export interface LogoutResult {
  deviceId: string | null;
  launchAgentRemoved: boolean;
  storeKind: string;
  removed: string[];
  revokeUrl: string | null;
  /** Hook entries taken back out of `~/.claude/settings.json`. */
  claudeHookRemoved: string[];
  /** Whether the user-scope Claude Code channel registration was removed with it. */
  claudeChannelRemoved: boolean;
}

/**
 * Everything protocol v2 added under `~/.pagr` that a logout must take with it.
 *
 * The journal is the reason this list exists: it holds plaintext copies of your own sessions —
 * what you typed and what the agent said — so a pairing that is being torn down must not leave
 * them behind. `tailer-state.json` records how far each Claude transcript was read, which is
 * meaningless without the journal it fed. `replay.json` is the anti-replay nonce set for a device
 * key that has just been deleted. `config.json` carries `recipientKeys`, the phones this Mac was
 * sealing to, and goes with the rest of the pairing.
 *
 * `~/.claude` and `~/.codex` are NOT in it and never will be: they are the agents' own files.
 */
export const V2_LOGOUT_PATHS = ['journal', 'tailer-state.json', 'replay.json'] as const;

/**
 * Tear down the local half of a pairing. `report: false` lets `uninstall` reuse it without
 * printing a second document — `--json` must emit exactly one.
 */
export async function runLogout(
  ctx: CliContext,
  opts: { purge?: boolean; report?: boolean },
): Promise<LogoutResult> {
  const report = opts.report !== false;
  const config = readConfig(ctx.paths.configFile);
  const removedAgent = uninstallLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  const store = await ctx.secretStore();
  await deleteIdentity(store);
  // Their Claude Code settings are not ours to leave edited. Only our own entry goes; a
  // PermissionRequest hook they wrote themselves, and every other key, stays exactly as it is.
  const hook = removeHookForUser(ctx, (l) => {
    if (report && !ctx.json) ctx.out(l);
  });
  // The channel server points at a daemon this Mac no longer has a pairing for; leaving it
  // registered would have every `pagr claude` spawn a process that can only fail.
  const channelRemoved = removeChannelRegistration(ctx);
  const removed: string[] = [];
  const files = [
    ctx.paths.configFile, // pairing, pinned server keys AND the pinned `recipientKeys`
    ctx.paths.sessionsFile,
    ctx.paths.replayFile,
    join(ctx.home, 'tailer-state.json'),
  ];
  if (opts.purge) files.push(ctx.paths.projectsFile, ctx.paths.policyFile);
  for (const f of files) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  // The journal is plaintext transcript, so it goes whole — directory and all — rather than being
  // left for a retention sweep that will never run again on an unpaired Mac.
  if (existsSync(ctx.paths.journalDir)) {
    rmSync(ctx.paths.journalDir, { recursive: true, force: true });
    removed.push(ctx.paths.journalDir);
  }
  // Only clear a stale socket: a daemon still answering (e.g. a foreground `daemon run`) keeps it.
  const sock = socketPath(ctx);
  if (existsSync(sock) && !(await daemonStatus(ctx))) rmSync(sock, { force: true });
  const revokeBase = tryResolveWebUrl(ctx.env, config);
  const result: LogoutResult = {
    deviceId: config.deviceId ?? null,
    launchAgentRemoved: removedAgent,
    storeKind: store.kind,
    removed,
    // A courtesy link, not the job: a Mac that was never pointed at a deployment still logs out.
    revokeUrl: revokeBase && config.deviceId ? `${revokeBase}/app/devices` : null,
    claudeHookRemoved: hook.removed,
    claudeChannelRemoved: channelRemoved,
  };
  if (!report) return result;
  if (ctx.json) {
    printJson(ctx, result);
    return result;
  }
  ctx.out(
    ok(removedAgent ? 'daemon stopped and launch agent removed' : 'no launch agent to remove'),
  );
  ctx.out(ok(`device private key deleted from ${store.kind}`));
  ctx.out(
    hook.removed.length > 0
      ? ok(`Pagr's Claude Code hook removed from ${hook.settingsPath}`)
      : dim('no Pagr hook was in your Claude Code settings'),
  );
  ctx.out(
    ok(
      opts.purge
        ? 'config and projects removed'
        : `config removed ${dim('(projects kept; use --purge to drop them)')}`,
    ),
  );
  ctx.out(ok('session journals, transcript cursors and pinned phone keys removed'));
  // Logging out only clears this Mac. The device is still registered on the account until it is
  // revoked, so say so even when we cannot work out the dashboard's URL to link to.
  if (config.deviceId) {
    ctx.out('');
    ctx.out(
      warn(
        result.revokeUrl
          ? `also revoke ${bold(config.deviceId)} from the dashboard: ${result.revokeUrl}`
          : `also revoke ${bold(config.deviceId)} from your Pagr dashboard, under Devices`,
      ),
    );
  }
  return result;
}

export async function runUninstall(ctx: CliContext, opts: { yes?: boolean }): Promise<void> {
  if (!opts.yes) {
    const okToGo = await ctx.confirm(
      `Remove the pagr daemon, device key and everything under ${ctx.home}?`,
    );
    if (!okToGo)
      throw new CliError('aborted', EXIT.usage, {
        code: 'aborted',
        hint: 'pass --yes to skip the prompt',
      });
  }
  const logout = await runLogout(ctx, { purge: true, report: !ctx.json });
  if (existsSync(ctx.home)) rmSync(ctx.home, { recursive: true, force: true });
  if (ctx.json) {
    printJson(ctx, { removed: ctx.home, logout });
    return;
  }
  ctx.out(ok(`removed ${ctx.home}`));
  ctx.out(dim('  finish with `npm uninstall -g @pagr/cli`'));
}

export function registerLogout(program: Command, getCtx: () => CliContext): void {
  program
    .command('logout')
    .description('stop the daemon, delete the device key and pairing config')
    .option('--purge', 'also remove the project registry')
    .action(async (opts: { purge?: boolean }) => void (await runLogout(getCtx(), opts)));
  program
    .command('uninstall')
    .description('logout, remove the launch agent and delete ~/.pagr')
    .option('-y, --yes', 'do not ask for confirmation')
    .action((opts: { yes?: boolean }) => runUninstall(getCtx(), opts));
}
