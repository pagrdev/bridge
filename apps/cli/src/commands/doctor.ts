import { existsSync, statSync } from 'node:fs';
import { launchAgentPlistPath, readConfig } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus } from '../ipc.js';
import { bad, bold, dim, ok, printJson, warn } from '../output.js';
import { launchAgentLoaded } from './daemon.js';

export interface Check {
  name: string;
  status: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
  fix?: string;
}

export async function runChecks(ctx: CliContext): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  add({
    name: 'node',
    status: major >= 22 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    ...(major < 22 ? { fix: 'install Node 22+ (https://nodejs.org) and reinstall @pagr/cli' } : {}),
  });

  if (existsSync(ctx.home)) {
    const mode = statSync(ctx.home).mode & 0o777;
    add({
      name: 'pagr home',
      status: mode === 0o700 ? 'ok' : 'warn',
      detail: `${ctx.home} (${mode.toString(8)})`,
      ...(mode !== 0o700 ? { fix: `chmod 700 ${ctx.home}` } : {}),
    });
  } else {
    add({
      name: 'pagr home',
      status: 'warn',
      detail: `${ctx.home} does not exist`,
      fix: 'run `pagr connect`',
    });
  }

  try {
    const store = await ctx.secretStore();
    add({
      name: 'secret store',
      status: store.kind === 'file' ? 'warn' : 'ok',
      detail: store.kind,
      ...(store.kind === 'file'
        ? { fix: 'unset PAGR_INSECURE_FILE_STORE to use the macOS Keychain' }
        : {}),
    });
  } catch (err) {
    add({
      name: 'secret store',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'run on macOS with Keychain available',
    });
  }

  const config = readConfig(ctx.paths.configFile);
  add({
    name: 'paired',
    status: config.deviceId ? 'ok' : 'fail',
    detail: config.deviceId
      ? `${config.deviceId} (${config.deviceName ?? ''})`
      : 'no device id in config.json',
    ...(config.deviceId ? {} : { fix: 'run `pagr connect`' }),
  });

  const status = await daemonStatus(ctx);
  add({
    name: 'daemon',
    status: status ? 'ok' : 'fail',
    detail: status
      ? `pid ${status.pid}, transport ${status.transport}`
      : `no socket at ${ctx.paths.socketPath}`,
    ...(status
      ? {}
      : { fix: 'run `pagr daemon install` (or `pagr daemon run`), then `pagr daemon logs`' }),
  });

  if (config.gatewayUrl) {
    try {
      const u = new URL(config.gatewayUrl);
      const port = Number(u.port) || (u.protocol === 'wss:' || u.protocol === 'https:' ? 443 : 80);
      const reachable = await ctx.tcpConnect(u.hostname, port, 4000);
      add({
        name: 'gateway',
        status: reachable ? 'ok' : 'fail',
        detail: `${u.hostname}:${port}`,
        ...(reachable
          ? {}
          : { fix: 'check network / firewall; the bridge only needs outbound TLS on 443' }),
      });
    } catch {
      add({
        name: 'gateway',
        status: 'fail',
        detail: `invalid gatewayUrl ${config.gatewayUrl}`,
        fix: 're-pair with `pagr connect --force`',
      });
    }
  } else {
    add({ name: 'gateway', status: 'skip', detail: 'not paired' });
  }

  for (const [bin, hint] of [
    ['codex', 'install Codex: npm i -g @openai/codex, then `codex login`'],
    ['claude', 'install Claude Code: npm i -g @anthropic-ai/claude-code, then `claude`'],
  ] as const) {
    try {
      const v = ctx.exec(bin, ['--version'], { timeoutMs: 5000 }).trim().split('\n')[0] ?? '';
      add({ name: bin, status: 'ok', detail: v });
    } catch {
      add({ name: bin, status: 'warn', detail: 'not found on PATH', fix: hint });
    }
  }

  const plist = launchAgentPlistPath(ctx.launchAgentsDir);
  if (existsSync(plist)) {
    const loaded = launchAgentLoaded(ctx);
    add({
      name: 'launch agent',
      status: loaded ? 'ok' : 'fail',
      detail: loaded ? 'loaded' : `${plist} present but not loaded`,
      ...(loaded ? {} : { fix: 'run `pagr daemon install` to re-bootstrap' }),
    });
  } else {
    add({
      name: 'launch agent',
      status: 'warn',
      detail: 'not installed',
      fix: 'run `pagr daemon install`',
    });
  }
  return checks;
}

export async function runDoctor(ctx: CliContext): Promise<void> {
  const checks = await runChecks(ctx);
  const failures = checks.filter((c) => c.status === 'fail');
  if (ctx.json) {
    printJson(ctx, { ok: failures.length === 0, checks });
  } else {
    ctx.out(bold('pagr doctor'));
    for (const c of checks) {
      const mark =
        c.status === 'ok'
          ? ok
          : c.status === 'fail'
            ? bad
            : c.status === 'warn'
              ? warn
              : (s: string) => dim(`- ${s}`);
      ctx.out(mark(`${c.name.padEnd(14)} ${c.detail}`));
      if (c.fix && c.status !== 'ok') ctx.out(dim(`                 fix: ${c.fix}`));
    }
    ctx.out('');
    ctx.out(
      failures.length === 0 ? ok('all checks passed') : bad(`${failures.length} check(s) failed`),
    );
  }
  if (failures.length > 0) throw new CliError('', EXIT.precondition);
}

export function registerDoctor(program: Command, getCtx: () => CliContext): void {
  program
    .command('doctor')
    .description('diagnose install, pairing, daemon, gateway and agent problems')
    .action(() => runDoctor(getCtx()));
}
