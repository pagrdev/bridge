import { existsSync, statSync } from 'node:fs';
import {
  auditPermissions,
  checkHomeWritable,
  clockSkewMs,
  describeClockSkew,
  hasIdentity,
  inspectConfig,
  inspectJson,
  LAUNCHCTL,
  launchAgentPlistPath,
  launchAgentStaleReason,
  MAX_SOCKET_PATH_BYTES,
  MAX_TOLERABLE_CLOCK_SKEW_MS,
  probeSecretStore,
  readDaemonLock,
  repairPermissions,
  SecretStoreError,
  usesShortSocketFallback,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, socketPath } from '../ipc.js';
import { bad, bold, dim, ok, printJson, warn } from '../output.js';
import { resolveApiUrl } from '../urls.js';

export interface Check {
  name: string;
  status: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  /** Also tighten any file modes that are too permissive. */
  fix?: boolean;
  /** Skip the network round-trips (API reachability, gateway TCP, clock skew). */
  offline?: boolean;
}

const NODE_MIN_MAJOR = 22;

/**
 * Every user-visible failure mode has a check here, because every error message in the CLI
 * points at `pagr doctor`. A check that cannot be run reports `skip`, never a false `ok`.
 */
export async function runChecks(ctx: CliContext, opts: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ---- runtime ------------------------------------------------------------
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  add({
    name: 'node',
    status: major >= NODE_MIN_MAJOR ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    ...(major < NODE_MIN_MAJOR
      ? { fix: `install Node ${NODE_MIN_MAJOR}+ (https://nodejs.org) and reinstall @pagr/cli` }
      : {}),
  });

  // ---- state directory ----------------------------------------------------
  if (!existsSync(ctx.home)) {
    add({
      name: 'pagr home',
      status: 'warn',
      detail: `${ctx.home} does not exist`,
      fix: 'run `pagr connect`',
    });
  } else {
    const writable = checkHomeWritable(ctx.home);
    const mode = safeMode(ctx.home);
    add({
      name: 'pagr home',
      status: !writable.ok ? 'fail' : 'ok',
      detail: writable.ok
        ? `${ctx.home} (${mode ?? '?'})`
        : `${ctx.home}: ${writable.error.message}`,
      ...(writable.ok ? {} : { fix: writable.error.hint ?? `check ownership of ${ctx.home}` }),
    });
  }

  const issues = auditPermissions(ctx.paths);
  if (opts.fix && issues.length > 0) repairPermissions(ctx.paths);
  const after = opts.fix ? auditPermissions(ctx.paths) : issues;
  add({
    name: 'permissions',
    status: after.length === 0 ? 'ok' : 'warn',
    detail:
      after.length === 0
        ? issues.length > 0
          ? `tightened ${issues.length} path(s)`
          : 'files are user-only (0700/0600)'
        : after.map((i) => `${i.path} is ${i.actual}, want ${i.expected}`).join('; '),
    ...(after.length === 0 ? {} : { fix: 'run `pagr doctor --fix`' }),
  });

  // ---- state files --------------------------------------------------------
  const { config, problem: configProblem } = inspectConfig(ctx.paths.configFile);
  add({
    name: 'config.json',
    status: configProblem ? 'fail' : 'ok',
    detail: configProblem
      ? configProblem.message
      : existsSync(ctx.paths.configFile)
        ? 'valid'
        : 'not written yet',
    ...(configProblem ? { fix: configProblem.hint } : {}),
  });

  const projects = inspectJson<Record<string, unknown>>(ctx.paths.projectsFile, {});
  add({
    name: 'projects.json',
    status: projects.problem ? 'fail' : 'ok',
    detail: projects.problem
      ? projects.problem.message
      : `${Object.keys(projects.value).length} project(s)`,
    ...(projects.problem
      ? {
          fix: `delete ${ctx.paths.projectsFile} and re-add your projects with \`pagr project add\``,
        }
      : {}),
  });

  // ---- secret store -------------------------------------------------------
  try {
    const store = await ctx.secretStore();
    const probe = await probeSecretStore(store);
    add({
      name: 'secret store',
      status: !probe.ok ? 'fail' : store.kind === 'file' ? 'warn' : 'ok',
      detail: probe.ok ? store.kind : `${store.kind}: ${probe.message}`,
      ...(!probe.ok
        ? { fix: probe.hint }
        : store.kind === 'file'
          ? { fix: 'unset PAGR_INSECURE_FILE_STORE to use the macOS Keychain' }
          : {}),
    });
    if (probe.ok) {
      const present = await hasIdentity(store);
      add({
        name: 'device key',
        status: present ? 'ok' : config.deviceId ? 'fail' : 'warn',
        detail: present
          ? `present in ${store.kind}`
          : config.deviceId
            ? `config.json claims ${config.deviceId} but no private key is stored`
            : 'not created yet',
        ...(present
          ? {}
          : {
              fix: config.deviceId
                ? 'the pairing is broken — run `pagr connect --force` to mint a new key'
                : 'run `pagr connect`',
            }),
      });
    } else {
      add({ name: 'device key', status: 'skip', detail: 'secret store unavailable' });
    }
  } catch (err) {
    add({
      name: 'secret store',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix:
        err instanceof SecretStoreError && err.hint
          ? err.hint
          : 'run on macOS with Keychain available',
    });
    add({ name: 'device key', status: 'skip', detail: 'secret store unavailable' });
  }

  // ---- pairing ------------------------------------------------------------
  add({
    name: 'paired',
    status: config.deviceId ? 'ok' : 'fail',
    detail: config.deviceId
      ? `${config.deviceId} (${config.deviceName ?? ''})`
      : 'no device id in config.json',
    ...(config.deviceId ? {} : { fix: 'run `pagr connect`' }),
  });

  // ---- API + clock --------------------------------------------------------
  const apiUrl = resolveApiUrl(ctx.env, undefined, config);
  if (opts.offline) {
    add({ name: 'api', status: 'skip', detail: '--offline' });
    add({ name: 'clock', status: 'skip', detail: '--offline' });
  } else {
    const probe = await probeApi(ctx, apiUrl);
    add({
      name: 'api',
      status: probe.reachable ? 'ok' : 'fail',
      detail: probe.detail,
      ...(probe.reachable
        ? {}
        : {
            fix: 'check your network; if you meant a local stack, pass --api-url or set PAGR_API_URL',
          }),
    });
    add(
      probe.skewMs === null
        ? { name: 'clock', status: 'skip', detail: 'the API did not send a Date header' }
        : {
            name: 'clock',
            status: Math.abs(probe.skewMs) > MAX_TOLERABLE_CLOCK_SKEW_MS ? 'fail' : 'ok',
            detail:
              Math.abs(probe.skewMs) > MAX_TOLERABLE_CLOCK_SKEW_MS
                ? `this Mac is ${describeClockSkew(probe.skewMs)} the server`
                : `within ${Math.round(Math.abs(probe.skewMs) / 1000)}s of the server`,
            ...(Math.abs(probe.skewMs) > MAX_TOLERABLE_CLOCK_SKEW_MS
              ? {
                  fix: 'commands are signed with an expiry — turn on System Settings → General → Date & Time → Set automatically',
                }
              : {}),
          },
    );
  }

  // ---- daemon -------------------------------------------------------------
  const status = await daemonStatus(ctx);
  const lock = readDaemonLock(ctx.paths.lockFile);
  add({
    name: 'daemon',
    status: status ? 'ok' : 'fail',
    detail: status
      ? `pid ${status.pid}, transport ${status.transport}`
      : lock
        ? `no answer on ${socketPath(ctx)} (lock file holds pid ${lock.pid})`
        : `no socket at ${socketPath(ctx)}`,
    ...(status
      ? {}
      : { fix: 'run `pagr daemon install` (or `pagr daemon run`), then `pagr daemon logs`' }),
  });

  const sock = socketPath(ctx);
  add({
    name: 'socket path',
    status: Buffer.byteLength(sock) <= MAX_SOCKET_PATH_BYTES ? 'ok' : 'fail',
    detail: usesShortSocketFallback(ctx.home)
      ? `${sock} ${dim(`(short fallback: PAGR_HOME is too long for a ${MAX_SOCKET_PATH_BYTES}-byte unix socket path)`)}`
      : sock,
    ...(Buffer.byteLength(sock) <= MAX_SOCKET_PATH_BYTES
      ? {}
      : { fix: 'set PAGR_HOME to a shorter path, or set TMPDIR to something short' }),
  });

  if (status)
    add({
      name: 'gateway link',
      status: status.transport === 'connected' ? 'ok' : 'fail',
      detail: status.transport,
      ...(status.transport === 'connected'
        ? {}
        : {
            fix:
              status.transport === 'unpaired'
                ? 'run `pagr connect`'
                : status.transport === 'blocked'
                  ? 'this bridge is too old for the gateway — `npm i -g @pagr/cli@latest`'
                  : 'run `pagr daemon logs -n 100` and look for `gateway disconnected`',
          }),
    });
  else add({ name: 'gateway link', status: 'skip', detail: 'daemon not running' });

  // ---- gateway reachability ----------------------------------------------
  if (opts.offline) add({ name: 'gateway', status: 'skip', detail: '--offline' });
  else if (config.gatewayUrl) {
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

  // ---- agent CLIs ---------------------------------------------------------
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

  // ---- launchd ------------------------------------------------------------
  if (!ctx.hasLaunchctl()) {
    add({
      name: 'launchd',
      status: 'warn',
      detail: `${LAUNCHCTL} not found — no background daemon on this machine`,
      fix: 'run `pagr daemon run` in the foreground (launchd only exists on macOS)',
    });
  } else {
    const plist = launchAgentPlistPath(ctx.launchAgentsDir);
    if (!existsSync(plist)) {
      add({
        name: 'launch agent',
        status: 'warn',
        detail: 'not installed',
        fix: 'run `pagr daemon install`',
      });
    } else {
      const loaded = launchAgentLoadedSafely(ctx);
      const stale = launchAgentStaleReason(plist, {
        programArguments: [process.execPath, ctx.binPath, 'daemon', 'run'],
        env: { PAGR_HOME: ctx.home },
      });
      add({
        name: 'launch agent',
        status: stale ? 'warn' : loaded ? 'ok' : 'fail',
        detail: stale
          ? `stale plist: ${stale}`
          : loaded
            ? 'loaded'
            : `${plist} present but not loaded`,
        ...(stale || !loaded
          ? { fix: 'run `pagr daemon install` to rewrite and re-bootstrap it' }
          : {}),
      });
    }
  }
  return checks;
}

function launchAgentLoadedSafely(ctx: CliContext): boolean {
  const uid = process.getuid?.() ?? 501;
  try {
    ctx.exec(LAUNCHCTL, ['print', `gui/${uid}/dev.pagr.bridge`], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function safeMode(path: string): string | null {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

/** A cheap, unauthenticated round-trip that proves the API host answers with JSON-ish HTTP. */
async function probeApi(
  ctx: CliContext,
  apiUrl: string,
): Promise<{ reachable: boolean; detail: string; skewMs: number | null }> {
  const fetchFn = ctx.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const url = `${apiUrl.replace(/\/$/, '')}/v1/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
    const skew = clockSkewMs(res, ctx.now().getTime());
    // Any HTTP answer proves the host is reachable; 404 just means no health route.
    return {
      reachable: res.status < 500,
      detail: `${apiUrl} → HTTP ${res.status}`,
      skewMs: skew,
    };
  } catch (err) {
    return {
      reachable: false,
      detail: `${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
      skewMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(ctx: CliContext, opts: DoctorOptions = {}): Promise<void> {
  const checks = await runChecks(ctx, opts);
  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  if (ctx.json) {
    printJson(ctx, {
      ok: failures.length === 0,
      home: ctx.home,
      bridgeVersion: ctx.bridgeVersion,
      node: process.versions.node,
      platform: process.platform,
      failures: failures.length,
      warnings: warnings.length,
      checks,
    });
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
      failures.length === 0
        ? ok(
            warnings.length === 0
              ? 'all checks passed'
              : `all checks passed (${warnings.length} warning(s))`,
          )
        : bad(`${failures.length} check(s) failed`),
    );
    if (failures.length > 0)
      ctx.out(dim('  `pagr doctor --json` produces a report you can send to support'));
  }
  if (failures.length > 0) throw new CliError('', EXIT.precondition, { code: 'doctor_failed' });
}

export function registerDoctor(program: Command, getCtx: () => CliContext): void {
  program
    .command('doctor')
    .description('diagnose install, pairing, daemon, gateway and agent problems')
    .option('--fix', 'tighten any file permissions that are too permissive')
    .option('--offline', 'skip the network checks (API, clock, gateway)')
    .action((opts: DoctorOptions) => runDoctor(getCtx(), opts));
}
