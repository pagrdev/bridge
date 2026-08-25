import {
  ensurePaths,
  installLaunchAgent,
  loadOrCreateIdentity,
  PairingError,
  persistPairing,
  pollPairing,
  readConfig,
  startPairing,
  updateConfig,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { bold, cyan, dim, ok, printJson, spinner, warn } from '../output.js';
import { resolveApiUrl } from '../urls.js';

export interface ConnectOptions {
  apiUrl?: string;
  gatewayUrl?: string;
  name?: string;
  daemon: boolean;
  force?: boolean;
  open: boolean;
}

export async function runConnect(ctx: CliContext, opts: ConnectOptions): Promise<void> {
  const paths = ensurePaths(ctx.home);
  const existing = readConfig(paths.configFile);
  if (existing.deviceId && !opts.force) {
    ctx.out(
      warn(`already paired as ${bold(existing.deviceId)} (${existing.deviceName ?? 'this Mac'})`),
    );
    ctx.out(dim('  re-pair with `pagr connect --force`, or `pagr logout` first'));
    return;
  }

  const apiUrl = resolveApiUrl(ctx.env, opts.apiUrl, existing);
  const deviceName = opts.name?.trim() || ctx.deviceName();
  const store = await ctx.secretStore();
  const identity = await loadOrCreateIdentity(store);
  ctx.out(
    ok(
      `device key ready ${dim(`(${store.kind}; public key ${identity.publicKeyRaw.slice(0, 12)}…)`)}`,
    ),
  );

  let started: Awaited<ReturnType<typeof startPairing>>;
  try {
    started = await startPairing({
      apiUrl,
      deviceName,
      identity,
      bridgeVersion: ctx.bridgeVersion,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  } catch (err) {
    throw new CliError(
      `could not reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.error,
      'check your network, or pass --api-url / set PAGR_API_URL',
    );
  }

  ctx.out('');
  ctx.out(`  Pairing code  ${bold(cyan(started.code))}`);
  ctx.out(`  Open          ${started.pairUrl}`);
  ctx.out(dim(`  expires ${started.expiresAt}`));
  ctx.out('');
  if (opts.open) await ctx.openBrowser(started.pairUrl);

  const spin = spinner(ctx, 'waiting for you to approve this Mac in the browser…');
  let done: Awaited<ReturnType<typeof pollPairing>>;
  try {
    done = await pollPairing({
      apiUrl,
      pairingId: started.pairingId,
      sleep: ctx.sleep,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  } catch (err) {
    spin.stop();
    if (err instanceof PairingError) {
      const hints: Record<PairingError['code'], string> = {
        expired: 'run `pagr connect` again for a fresh code',
        rejected: 'the request was rejected in the dashboard; run `pagr connect` to retry',
        timeout: 'run `pagr connect` again',
        http: 'check the API URL and your network',
        invalid_response: 'the API returned something unexpected; update the CLI',
      };
      throw new CliError(`pairing failed: ${err.message}`, EXIT.error, hints[err.code]);
    }
    throw err;
  }
  spin.stop();
  persistPairing(paths.configFile, done, { apiUrl, deviceName, now: ctx.now });
  if (opts.gatewayUrl) updateConfig(paths.configFile, { gatewayUrl: opts.gatewayUrl });
  ctx.out(ok(`paired as ${bold(done.deviceId)} ${dim(`(user ${done.userId})`)}`));

  let plist: string | undefined;
  if (opts.daemon) {
    plist = installLaunchAgent({
      programArguments: [process.execPath, ctx.binPath, 'daemon', 'run'],
      logsDir: paths.logsDir,
      env: { PAGR_HOME: ctx.home, ...(ctx.env.PATH ? { PATH: ctx.env.PATH } : {}) },
      exec: (f, a) => void ctx.exec(f, a),
      ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
    });
    ctx.out(ok(`daemon installed ${dim(plist)}`));
  } else {
    ctx.out(warn('daemon not installed (--no-daemon); run `pagr daemon install` later'));
  }

  if (ctx.json) {
    printJson(ctx, {
      deviceId: done.deviceId,
      userId: done.userId,
      gatewayUrl: done.gatewayUrl,
      plist,
    });
    return;
  }
  ctx.out('');
  ctx.out(bold('Next steps'));
  ctx.out(
    `  1. ${cyan('pagr project add . --name MyApp')}   register a repo (only the id + name leave this Mac)`,
  );
  ctx.out('  2. Link iMessage from the dashboard (Settings → Messaging)');
  ctx.out(`  3. ${cyan('pagr status')}                        confirm the gateway is connected`);
}

export function registerConnect(program: Command, getCtx: () => CliContext): void {
  program
    .command('connect')
    .description('pair this Mac with your Pagr account and install the background daemon')
    .option('--api-url <url>', 'Pagr API base URL (default: $PAGR_API_URL or https://api.pagr.dev)')
    .option('--gateway-url <url>', 'override the gateway WebSocket URL returned by pairing')
    .option('--name <deviceName>', 'device name shown in the dashboard (default: hostname)')
    .option('--no-daemon', 'do not install the launchd agent')
    .option('--no-open', 'print the pairing URL without opening a browser')
    .option('-f, --force', 're-pair even if this Mac is already paired')
    .action((opts: ConnectOptions) => runConnect(getCtx(), opts));
}
