import { existsSync } from 'node:fs';
import { describeKeepAwake, inspectConfig, ProjectRegistry } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { daemonStatus } from '../ipc.js';
import { bad, bold, dim, kv, ok, printJson, shortId, warn } from '../output.js';
import {
  describeChannel,
  describeJournal,
  describeMirror,
  describeProtocol,
  describeRecipientKeys,
} from './doctor.js';

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
    // Older daemons do not report these; `null` says "not known", never "none".
    adoptedSessions: status?.adoptedSessions ?? null,
    unregisteredSessions: status?.unregisteredSessions ?? null,
    pendingApprovals: status?.pendingApprovals ?? null,
    // v2. What the phone half of Pagr depends on, in the order a person would ask about it:
    // is the link speaking v2 at all, who can read what it sends, will the Mac stay awake,
    // can a terminal be given a turn, is your own work being mirrored, and how much of it is
    // sitting in plaintext on this disk.
    protocolVersion: status?.protocolVersion ?? null,
    recipientKeyIds: status?.recipientKeyIds ?? null,
    keepAwake: status?.keepAwake ?? null,
    channel: status?.channel ?? null,
    mirror: status?.mirror ?? null,
    journalBytes: status?.journalBytes ?? null,
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
          ? `${status.sessions} ${dim(
              [
                `${status.pendingApprovals} pending approvals`,
                ...(data.adoptedSessions === null
                  ? []
                  : [`${data.adoptedSessions} your own, not started by Pagr`]),
              ].join(', '),
            )}`
          : '—',
      ],
    ]),
  );
  if (data.unregisteredSessions !== null && data.unregisteredSessions > 0)
    ctx.out(
      warn(
        `${data.unregisteredSessions} of your own session(s) run outside every registered project, so their prompts stay in the terminal — see \`pagr sessions\``,
      ),
    );
  if (status) {
    ctx.out('');
    ctx.out(bold('Phone link'));
    ctx.out(
      kv([
        ['protocol', describeProtocol(status.protocolVersion)],
        ['phone keys', describeRecipientKeys(status.recipientKeyIds)],
        ['keep-awake', status.keepAwake ? describeKeepAwake(status.keepAwake) : 'unknown'],
        ['channel', describeChannel(status.channel)],
        ['mirror', status.mirror ? describeMirror(status.mirror) : 'nothing mirrored yet'],
        ['journal', describeJournal(status.journalBytes)],
      ]),
    );
  }
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
