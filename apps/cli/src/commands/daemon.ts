import { existsSync, readFileSync } from 'node:fs';
import {
  type CodingAgentAdapter,
  createLogger,
  DaemonAlreadyRunningError,
  ensurePaths,
  FakeAdapter,
  isPidAlive,
  launchAgentPlistPath,
  readConfig,
  readDaemonLock,
  startDaemon,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from '@pagr/bridge-core';
import type { Provider } from '@pagr/protocol';
import type { Command } from 'commander';
import { installHookForUser, removeHookForUser } from '../claudeHook.js';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, socketPath } from '../ipc.js';
import {
  agentEnvGaps,
  describeEnvGaps,
  ENV_GAP_FIX,
  installAgent,
  launchAgentPlan,
} from '../launchd.js';
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
  const plan = launchAgentPlan(ctx);
  const plist = installAgent(ctx, paths.logsDir);
  const gaps = agentEnvGaps(ctx.env, plan.env);
  // The hook is what makes prompts from the person's OWN `claude` sessions reachable. Installed
  // here as well as in `connect` so that a Mac set up before this existed picks it up.
  const hook = installHookForUser(ctx, (l) => {
    if (!ctx.json) ctx.out(l);
  });
  if (ctx.json) {
    printJson(ctx, {
      installed: true,
      plist,
      label: LAUNCH_AGENT_LABEL,
      logsDir: paths.logsDir,
      launcher: plan.launcherPath,
      shellOnlyAgentEnv: gaps.map((g) => g.name),
      claudeHook: hook.action,
      ...(hook.report ? { claudeHookSettings: hook.report.settingsPath } : {}),
    });
    return plist;
  }
  ctx.out(ok(`launch agent installed ${dim(plist)}`));
  ctx.out(dim(`  label ${LAUNCH_AGENT_LABEL}; logs in ${paths.logsDir}`));
  ctx.out(dim('  confirm it came up with `pagr status` (gateway should read connected)'));
  if (gaps.length > 0) {
    ctx.out(
      warn(
        `${describeEnvGaps(gaps)} ${gaps.length === 1 ? 'is' : 'are'} set in this shell but not for the daemon`,
      ),
    );
    ctx.out(dim(`  ${ENV_GAP_FIX}`));
  }
  return plist;
}

/**
 * Stop the daemon, keep the install. `stop` used to be an alias for `uninstall`, which deleted
 * the launch agent: "stopping" the daemon silently meant nothing ever started again at login.
 */
export function runDaemonStop(ctx: CliContext): 'stopped' | 'not_loaded' | 'not_installed' {
  const result = stopLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    hasLaunchctl: () => ctx.hasLaunchctl(),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  const plist = launchAgentPlistPath(ctx.launchAgentsDir);
  if (ctx.json) {
    printJson(ctx, {
      stopped: result === 'stopped',
      state: result,
      installed: result !== 'not_installed',
      plist,
      label: LAUNCH_AGENT_LABEL,
    });
    return result;
  }
  if (result === 'not_installed') {
    ctx.out(warn('there is no launch agent installed, so nothing was running'));
    ctx.out(dim('  `pagr daemon install` sets it up'));
    return result;
  }
  ctx.out(ok(result === 'stopped' ? 'daemon stopped' : 'daemon was not running'));
  ctx.out(dim(`  the launch agent is still installed (${plist}) and starts again at login`));
  ctx.out(dim('  `pagr daemon start` to start it now · `pagr daemon uninstall` to remove it'));
  return result;
}

export function runDaemonStart(ctx: CliContext): 'started' | 'restarted' {
  const result = startLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    hasLaunchctl: () => ctx.hasLaunchctl(),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  if (ctx.json) {
    printJson(ctx, {
      started: true,
      state: result,
      plist: launchAgentPlistPath(ctx.launchAgentsDir),
      label: LAUNCH_AGENT_LABEL,
    });
    return result;
  }
  ctx.out(ok(result === 'started' ? 'daemon started' : 'daemon restarted (it was already loaded)'));
  ctx.out(dim('  confirm it with `pagr status`; `pagr daemon logs -n 50` if it does not come up'));
  return result;
}

/** The destructive one: the job is removed and nothing starts at the next login. */
export function runDaemonUninstall(ctx: CliContext): boolean {
  const plist = launchAgentPlistPath(ctx.launchAgentsDir);
  const existed = existsSync(plist);
  if (!ctx.json && existed) {
    ctx.out(warn(`removing the launch agent ${dim(plist)}`));
    ctx.out(
      dim(
        '  this stops the daemon and it will NOT start at login any more; your pairing, device key and projects are untouched',
      ),
    );
  }
  const removed = uninstallLaunchAgent({
    exec: (f, a) => void ctx.exec(f, a),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
  // Our entry in their Claude Code settings goes with the daemon that answered it. Leaving it
  // behind would mean every prompt waiting 540 s for a socket that is not there.
  const hook = removeHookForUser(ctx, (l) => {
    if (!ctx.json) ctx.out(l);
  });
  if (ctx.json) {
    printJson(ctx, {
      removed,
      plist,
      label: LAUNCH_AGENT_LABEL,
      claudeHookRemoved: hook.removed.length > 0,
    });
    return removed;
  }
  ctx.out(removed ? ok('launch agent removed') : warn('launch agent was not installed'));
  if (removed) ctx.out(dim('  put it back with `pagr daemon install` (no re-pairing needed)'));
  return removed;
}

/** Pid recorded in `run/daemon.lock`, if that process is still alive. */
export function lockedPid(ctx: CliContext): number | null {
  const lock = readDaemonLock(ctx.paths.lockFile);
  return lock && isPidAlive(lock.pid) ? lock.pid : null;
}

export async function runDaemonStatus(ctx: CliContext): Promise<void> {
  const plist = launchAgentPlistPath(ctx.launchAgentsDir);
  const installed = existsSync(plist);
  const loaded = installed && launchAgentLoaded(ctx);
  const status = await daemonStatus(ctx);
  const lockPid = lockedPid(ctx);
  const sock = socketPath(ctx);
  if (ctx.json) {
    printJson(ctx, { installed, loaded, plist, running: Boolean(status), lockPid, status });
    return;
  }
  const daemonLine = status
    ? ok(`running (pid ${status.pid}, since ${status.startedAt})`)
    : lockPid
      ? warn(`not reachable, but lock held by pid ${lockPid} (socket ${sock} did not answer)`)
      : bad('not running');
  ctx.out(
    kv([
      [
        'launch agent',
        installed
          ? ok(loaded ? 'installed, loaded' : 'installed, not loaded')
          : bad('not installed'),
      ],
      ['daemon', daemonLine],
      ['transport', status ? status.transport : '—'],
      ['lock', lockPid ? `pid ${lockPid} (${ctx.paths.lockFile})` : 'none'],
      ['socket', sock],
      ['log', ctx.paths.logFile],
    ]),
  );
  // Installed but not loaded is the state `pagr daemon stop` leaves behind, and the state
  // launchd leaves behind after a start failure it refuses to retry. Both end at `start`.
  if (installed && !loaded)
    ctx.out(dim('  `pagr daemon start` to run it now (`pagr daemon logs -n 50` if it will not)'));
}

export async function runDaemonLogs(
  ctx: CliContext,
  opts: { follow?: boolean; lines: string },
): Promise<void> {
  const file = ctx.paths.logFile;
  if (!existsSync(file))
    throw new CliError(`no log file at ${file}`, EXIT.precondition, {
      code: 'no_log_file',
      hint: 'the daemon has not run yet — `pagr daemon install`, then `pagr daemon logs`',
    });
  const n = Number.parseInt(opts.lines, 10) || 50;
  if (opts.follow) {
    if (ctx.json)
      throw new CliError('--follow cannot be combined with --json', EXIT.usage, {
        code: 'usage',
        hint: 'drop --json to stream, or drop --follow for a JSON snapshot',
      });
    await ctx.execStream('/usr/bin/tail', ['-n', String(n), '-f', file]);
    return;
  }
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n);
  if (ctx.json) {
    printJson(ctx, { file, lines });
    return;
  }
  for (const l of lines) ctx.out(l);
}

export function registerDaemon(program: Command, getCtx: () => CliContext): void {
  const d = program.command('daemon').description('manage the background bridge daemon');
  d.command('run')
    .description('run the daemon in the foreground (what the launch agent executes)')
    .option('--mock', 'use mock agents (same as PAGR_MOCK_AGENTS=1)')
    .action(async (opts: { mock?: boolean }) => {
      const ctx = getCtx();
      const mock = Boolean(opts.mock) || ctx.env.PAGR_MOCK_AGENTS === '1';
      try {
        await (ctx.runDaemonForever ?? runForeground)(ctx, { mock });
      } catch (err) {
        if (err instanceof DaemonAlreadyRunningError)
          throw new CliError(
            err.message,
            EXIT.precondition,
            'stop it first with `pagr daemon stop` (which leaves the launch agent installed) or kill that pid, then retry',
          );
        throw err;
      }
    });
  d.command('install')
    .description('install + start the launchd agent')
    .action(() => void runDaemonInstall(getCtx()));
  d.command('start')
    .description('start the installed launchd agent')
    .action(() => void runDaemonStart(getCtx()));
  d.command('stop')
    .description('stop the daemon, keeping the launchd agent installed')
    .action(() => void runDaemonStop(getCtx()));
  d.command('uninstall')
    .description('stop the daemon AND remove the launchd agent (it will not start at login)')
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
