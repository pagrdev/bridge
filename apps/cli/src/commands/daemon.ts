import { existsSync, readFileSync } from 'node:fs';
import {
  type CodingAgentAdapter,
  createLogger,
  ensurePaths,
  FakeAdapter,
  installLaunchAgent,
  launchAgentPlistPath,
  readConfig,
  startDaemon,
  uninstallLaunchAgent,
} from '@pagr/bridge-core';
import type { Provider } from '@pagr/protocol';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus } from '../ipc.js';
import { bad, dim, kv, ok, printJson, warn } from '../output.js';

/** Mirrors core's launchAgent label (not re-exported from the core index). */
export const LAUNCH_AGENT_LABEL = 'dev.pagr.bridge';

/** Build the adapter map. Real adapters come from the adapter packages; `mock` swaps in their
 *  scripted mocks (or core's FakeAdapter when `PAGR_MOCK_AGENTS=1` and a package is absent). */
export async function buildAdapters(
  home: string,
  mock: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<Provider, CodingAgentAdapter>> {
  const map = new Map<Provider, CodingAgentAdapter>();
  const [codexMod, claudeMod] = await Promise.all([
    import('@pagr/bridge-adapter-codex'),
    import('@pagr/bridge-adapter-claude'),
  ]);
  // `PAGR_MOCK_AGENT_DELAY_MS` stretches the scripted mock turns (E2E scripts use it).
  const delayMs = Number.parseInt(env.PAGR_MOCK_AGENT_DELAY_MS ?? '', 10);
  const mockOptions = Number.isFinite(delayMs) && delayMs > 0 ? { delayMs } : {};
  map.set('codex', codexMod.createCodexAdapter({ home, mock, mockOptions }));
  map.set('claude', claudeMod.createClaudeAdapter({ home, mock, mockOptions }));
  return map;
}

export function fallbackAdapters(): Map<Provider, CodingAgentAdapter> {
  return new Map<Provider, CodingAgentAdapter>([
    ['codex', new FakeAdapter('codex')],
    ['claude', new FakeAdapter('claude')],
  ]);
}

async function runForeground(ctx: CliContext, opts: { mock: boolean }): Promise<void> {
  const paths = ensurePaths(ctx.home);
  const logger = createLogger({
    file: paths.logFile,
    stderr: true,
    home: ctx.env.HOME ?? '',
    level: ctx.env.PAGR_LOG_LEVEL === 'debug' ? 'debug' : 'info',
  });
  let adapters: Map<Provider, CodingAgentAdapter>;
  try {
    adapters = await buildAdapters(ctx.home, opts.mock, ctx.env);
  } catch (err) {
    if (!opts.mock) throw err;
    logger.warn('adapter packages unavailable; using core FakeAdapter', {
      error: err instanceof Error ? err.message : String(err),
    });
    adapters = fallbackAdapters();
  }
  if (opts.mock)
    logger.warn('PAGR_MOCK_AGENTS=1: agents are mocked; no real Codex/Claude sessions');
  const config = readConfig(paths.configFile);
  await startDaemon({
    home: ctx.home,
    adapters,
    secretStore: await ctx.secretStore(),
    logger,
    bridgeVersion: ctx.bridgeVersion,
    ...(config.gatewayUrl ? { gatewayUrl: config.gatewayUrl } : {}),
  });
  await new Promise<never>(() => {}); // until SIGINT/SIGTERM (handled by startDaemon)
}

export function launchAgentLoaded(ctx: CliContext): boolean {
  const uid = process.getuid?.() ?? 501;
  try {
    ctx.exec('/bin/launchctl', ['print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

export function runDaemonInstall(ctx: CliContext): string {
  const paths = ensurePaths(ctx.home);
  const plist = installLaunchAgent({
    programArguments: [process.execPath, ctx.binPath, 'daemon', 'run'],
    logsDir: paths.logsDir,
    env: { PAGR_HOME: ctx.home, ...(ctx.env.PATH ? { PATH: ctx.env.PATH } : {}) },
    exec: (f, a) => void ctx.exec(f, a),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  ctx.out(ok(`launch agent installed ${dim(plist)}`));
  ctx.out(dim(`  label ${LAUNCH_AGENT_LABEL}; logs in ${paths.logsDir}`));
  return plist;
}

export function runDaemonUninstall(ctx: CliContext): boolean {
  const removed = uninstallLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  ctx.out(removed ? ok('launch agent removed') : warn('launch agent was not installed'));
  return removed;
}

export async function runDaemonStatus(ctx: CliContext): Promise<void> {
  const plist = launchAgentPlistPath(ctx.launchAgentsDir);
  const installed = existsSync(plist);
  const loaded = installed && launchAgentLoaded(ctx);
  const status = await daemonStatus(ctx);
  if (ctx.json) {
    printJson(ctx, { installed, loaded, plist, running: Boolean(status), status });
    return;
  }
  ctx.out(
    kv([
      [
        'launch agent',
        installed
          ? ok(loaded ? 'installed, loaded' : 'installed, not loaded')
          : bad('not installed'),
      ],
      [
        'daemon',
        status ? ok(`running (pid ${status.pid}, since ${status.startedAt})`) : bad('not running'),
      ],
      ['transport', status ? status.transport : '—'],
      ['socket', ctx.paths.socketPath],
      ['log', ctx.paths.logFile],
    ]),
  );
}

export async function runDaemonLogs(
  ctx: CliContext,
  opts: { follow?: boolean; lines: string },
): Promise<void> {
  const file = ctx.paths.logFile;
  if (!existsSync(file))
    throw new CliError(`no log file at ${file}`, EXIT.precondition, 'the daemon has not run yet');
  const n = Number.parseInt(opts.lines, 10) || 50;
  if (opts.follow) {
    await ctx.execStream('/usr/bin/tail', ['-n', String(n), '-f', file]);
    return;
  }
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  for (const l of lines.slice(-n)) ctx.out(l);
}

export function registerDaemon(program: Command, getCtx: () => CliContext): void {
  const d = program.command('daemon').description('manage the background bridge daemon');
  d.command('run')
    .description('run the daemon in the foreground (what the launch agent executes)')
    .option('--mock', 'use mock agents (same as PAGR_MOCK_AGENTS=1)')
    .action(async (opts: { mock?: boolean }) => {
      const ctx = getCtx();
      const mock = Boolean(opts.mock) || ctx.env.PAGR_MOCK_AGENTS === '1';
      await (ctx.runDaemonForever ?? runForeground)(ctx, { mock });
    });
  d.command('install')
    .description('install + start the launchd agent')
    .action(() => void runDaemonInstall(getCtx()));
  d.command('uninstall')
    .description('stop + remove the launchd agent')
    .action(() => void runDaemonUninstall(getCtx()));
  d.command('stop')
    .description('alias for uninstall')
    .action(() => void runDaemonUninstall(getCtx()));
  d.command('status')
    .description('launch agent + daemon process status')
    .action(() => runDaemonStatus(getCtx()));
  d.command('logs')
    .description('print the daemon log')
    .option('-f, --follow', 'follow (tail -f)')
    .option('-n, --lines <n>', 'number of lines', '50')
    .action((opts: { follow?: boolean; lines: string }) => runDaemonLogs(getCtx(), opts));
}
