import { existsSync, rmSync } from 'node:fs';
import { deleteIdentity, readConfig, uninstallLaunchAgent } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, socketPath } from '../ipc.js';
import { bold, dim, ok, printJson, warn } from '../output.js';
import { resolveWebUrl } from '../urls.js';

export async function runLogout(ctx: CliContext, opts: { purge?: boolean }): Promise<void> {
  const config = readConfig(ctx.paths.configFile);
  const removedAgent = uninstallLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  const store = await ctx.secretStore();
  await deleteIdentity(store);
  const removed: string[] = [];
  const files = [ctx.paths.configFile, ctx.paths.sessionsFile, ctx.paths.replayFile];
  if (opts.purge) files.push(ctx.paths.projectsFile, ctx.paths.policyFile);
  for (const f of files) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  // Only clear a stale socket: a daemon still answering (e.g. a foreground `daemon run`) keeps it.
  const sock = socketPath(ctx);
  if (existsSync(sock) && !(await daemonStatus(ctx))) rmSync(sock, { force: true });
  if (ctx.json) {
    printJson(ctx, {
      deviceId: config.deviceId ?? null,
      launchAgentRemoved: removedAgent,
      removed,
    });
    return;
  }
  ctx.out(
    ok(removedAgent ? 'daemon stopped and launch agent removed' : 'no launch agent to remove'),
  );
  ctx.out(ok(`device private key deleted from ${store.kind}`));
  ctx.out(
    ok(
      opts.purge
        ? 'config and projects removed'
        : `config removed ${dim('(projects kept; use --purge to drop them)')}`,
    ),
  );
  if (config.deviceId) {
    ctx.out('');
    ctx.out(
      warn(
        `also revoke ${bold(config.deviceId)} from the dashboard: ${resolveWebUrl(ctx.env, config)}/app/devices`,
      ),
    );
  }
}

export async function runUninstall(ctx: CliContext, opts: { yes?: boolean }): Promise<void> {
  if (!opts.yes) {
    const okToGo = await ctx.confirm(
      `Remove the pagr daemon, device key and everything under ${ctx.home}?`,
    );
    if (!okToGo) throw new CliError('aborted', EXIT.usage, 'pass --yes to skip the prompt');
  }
  await runLogout(ctx, { purge: true });
  if (existsSync(ctx.home)) rmSync(ctx.home, { recursive: true, force: true });
  if (ctx.json) {
    printJson(ctx, { removed: ctx.home });
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
    .action((opts: { purge?: boolean }) => runLogout(getCtx(), opts));
  program
    .command('uninstall')
    .description('logout, remove the launch agent and delete ~/.pagr')
    .option('-y, --yes', 'do not ask for confirmation')
    .action((opts: { yes?: boolean }) => runUninstall(getCtx(), opts));
}
