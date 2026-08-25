import { existsSync } from 'node:fs';
import { inspectConfig, ProjectRegistry } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { daemonStatus } from '../ipc.js';
import { bad, bold, dim, kv, ok, printJson, shortId, warn } from '../output.js';

export interface AgentLine {
  provider: 'claude' | 'codex';
  mode: string;
  installed: boolean;
  version?: string;
  auth: string;
}

/** Cheap local probe: is the CLI on PATH and what version. Auth is only known to the daemon. */
export function probeAgentsLocally(ctx: CliContext): AgentLine[] {
  const probe = (bin: string, mode: string, provider: 'claude' | 'codex'): AgentLine => {
    try {
      const v = ctx.exec(bin, ['--version'], { timeoutMs: 5000 }).trim().split('\n')[0] ?? '';
      return { provider, mode, installed: true, version: v, auth: 'unknown' };
    } catch {
      return { provider, mode, installed: false, auth: 'unknown' };
    }
  };
  return [probe('claude', 'cli-hooks', 'claude'), probe('codex', 'app-server', 'codex')];
}

export async function runStatus(ctx: CliContext): Promise<void> {
  const { config, problem } = inspectConfig(ctx.paths.configFile);
  const status = await daemonStatus(ctx);
  const agents = probeAgentsLocally(ctx);
  const projects =
    status?.projects ??
    (existsSync(ctx.paths.projectsFile)
      ? new ProjectRegistry({ file: ctx.paths.projectsFile, pagrHome: ctx.home }).list().length
      : 0);
  // A running daemon is the better source of truth: it holds the identity in memory even if
  // config.json was damaged after it started.
  const data = {
    home: ctx.home,
    paired: status?.paired ?? Boolean(config.deviceId),
    deviceId: config.deviceId ?? status?.deviceId ?? null,
    deviceName: config.deviceName ?? null,
    userId: config.userId ?? status?.userId ?? null,
    gatewayUrl: config.gatewayUrl ?? status?.gatewayUrl ?? null,
    configProblem: problem ? problem.message : null,
    daemon: status
      ? {
          running: true,
          pid: status.pid,
          transport: status.transport,
          bridgeVersion: status.bridgeVersion,
          bufferedEvents: status.bufferedEvents,
        }
      : { running: false },
    agents,
    projects,
    sessions: status?.sessions ?? null,
    pendingApprovals: status?.pendingApprovals ?? null,
  };
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const gw = !status
    ? warn('daemon not running')
    : status.transport === 'connected'
      ? ok('connected')
      : status.transport === 'unpaired'
        ? warn('unpaired')
        : warn(status.transport);
  ctx.out(bold('Pagr bridge'));
  if (problem) ctx.out(warn(`${problem.message} — ${problem.hint}`));
  ctx.out(
    kv([
      [
        'device',
        data.deviceId
          ? `${shortId(data.deviceId)} ${dim(config.deviceName ?? '')}`
          : bad('not paired — run `pagr connect`'),
      ],
      ['user', data.userId ? shortId(data.userId) : '—'],
      ['gateway', gw],
      [
        'daemon',
        status ? ok(`running (pid ${status.pid}, v${status.bridgeVersion})`) : bad('not running'),
      ],
      ['projects', String(projects)],
      [
        'sessions',
        status
          ? `${status.sessions} ${dim(`(${status.pendingApprovals} pending approvals)`)}`
          : '—',
      ],
    ]),
  );
  ctx.out('');
  ctx.out(bold('Agents'));
  ctx.out(
    kv(
      agents.map((a) => [
        a.provider,
        a.installed
          ? `${ok(a.version ?? 'installed')} ${dim(`${a.mode}, auth ${a.auth}`)}`
          : bad(`not found on PATH ${dim(`(${a.mode})`)}`),
      ]),
    ),
  );
}

export function registerStatus(program: Command, getCtx: () => CliContext): void {
  program
    .command('status')
    .description('pairing, daemon, gateway, agents and project summary')
    .action(() => runStatus(getCtx()));
}
