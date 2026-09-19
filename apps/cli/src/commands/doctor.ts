import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  codexHomeDir,
  controlSocketPath,
  daemonDoctorLine,
  probeDaemon,
} from '@pagr/bridge-adapter-codex';
import type { ChannelStatus, DaemonStatus } from '@pagr/bridge-core';
import {
  auditPermissions,
  CLAUDE_CHANNEL_ENV,
  checkHomeWritable,
  clockSkewMs,
  DEVICE_FLOOR_ENV,
  DeviceFloor,
  describeClockSkew,
  describeKeepAwake,
  hasIdentity,
  inspectConfig,
  inspectJson,
  journalStats,
  KEEP_AWAKE_ENV,
  LAUNCHCTL,
  launchAgentPlistPath,
  launchAgentStaleReason,
  MAX_SOCKET_PATH_BYTES,
  MAX_TOLERABLE_CLOCK_SKEW_MS,
  MIRROR_ENV,
  probeSecretStore,
  REMOTE_PROJECT_PICK_ENV,
  readDaemonLock,
  repairPermissions,
  SecretStoreError,
  usesShortSocketFallback,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import { linkPhoneFix, readAccount } from '../account.js';
import { hookState } from '../claudeHook.js';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, ipc, socketPath } from '../ipc.js';
import {
  agentEnvGaps,
  describeEnvGaps,
  ENV_GAP_FIX,
  installedAgentEnv,
  launchAgentPlan,
} from '../launchd.js';
import { bad, bold, dim, ok, printJson, warn } from '../output.js';
import { configuredApiUrl, tryResolveWebUrl } from '../urls.js';
import { LAUNCH_COMMAND, MCP_CONFIG_FILE, MCP_SERVER_KEY } from './claude.js';
import {
  CLAUDE_VERSION_FLOOR,
  channelServerPath,
  claudeVersionOf,
  meetsVersionFloor,
  readRegistration,
} from './claudeChannel.js';
import { findRealClaude } from './claudeLauncher.js';

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
 *
 * `fail` means *broken*, not *unfinished*. A Mac that has just installed `@pagr/cli` and has not
 * run `pagr connect` yet is in a correct state: it has no device id, no gateway URL, no API URL
 * and no daemon, and every one of those reports `warn`/`skip` with the next command to run. That
 * is what makes `pagr doctor` usable as the post-install smoke test (packaging/RELEASING.md §
 * "Post-release smoke on a clean machine") and why it exits 0 there. A broken Keychain, an
 * unparsable `config.json`, a gateway URL that was paired and no longer resolves, a daemon that
 * was installed and does not answer — those still fail.
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

  // ---- device approval floor ---------------------------------------------
  // The one thing in `pagr doctor` that is about what the CLOUD can do to this Mac, so it reports
  // `warn` when it has been lifted — not as a fault, but so a lift is never invisible.
  const floor = DeviceFloor.fromFile(ctx.paths.devicePolicyFile, process.env);
  const lifted = floor.lifted;
  add({
    name: 'device policy',
    status: lifted.length === 0 ? 'ok' : 'warn',
    detail:
      lifted.length === 0
        ? 'a cloud approval cannot run remote scripts, reach the network, leave the project, touch credentials, escalate, or destroy'
        : `lifted locally: ${lifted.join(', ')}${
            process.env[DEVICE_FLOOR_ENV] ? ` (via ${DEVICE_FLOOR_ENV})` : ''
          }`,
    ...(lifted.length === 0
      ? {}
      : {
          fix: `remove them from ${ctx.paths.devicePolicyFile} (or unset ${DEVICE_FLOOR_ENV}) to restore the default`,
        }),
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
  // Not a failure: a fresh install is *supposed* to be unpaired. Everything downstream that needs
  // a pairing (API URL, gateway, daemon) reads this flag and skips rather than failing too.
  const paired = Boolean(config.deviceId);
  add({
    name: 'paired',
    status: paired ? 'ok' : 'warn',
    detail: paired
      ? `${config.deviceId} (${config.deviceName ?? ''})`
      : 'not paired yet — run `pagr connect`',
    ...(paired ? {} : { fix: 'run `pagr connect`' }),
  });

  // ---- the account this Mac belongs to ------------------------------------
  // Two facts that live in the cloud, not here: is a phone linked, and is there a trial. Both
  // are `warn` at worst — `doctor` exits 0 on a correct but unfinished machine, and an install
  // whose owner has not texted Pagr yet is exactly that. `--offline` skips the round-trip, and
  // a Mac paired before `connect` recorded the pairing id has nothing to ask with, so it says
  // so rather than reporting "not linked".
  const account = await readAccount(ctx, config, {
    ...(opts.offline ? { offline: true } : {}),
  });
  const welcome = tryResolveWebUrl(ctx.env, config);
  const welcomeUrl = welcome ? `${welcome}/welcome` : null;
  const accountFix =
    account.unavailable && !config.pairingId && paired
      ? 're-run `pagr connect --force` to enable this check'
      : undefined;
  add({
    name: 'phone',
    status: account.onboarding ? (account.onboarding.messagingLinked ? 'ok' : 'warn') : 'skip',
    detail: account.onboarding
      ? account.onboarding.messagingLinked
        ? 'linked'
        : 'not linked yet — agents cannot text you'
      : (account.unavailable ?? 'unknown'),
    ...(account.onboarding && !account.onboarding.messagingLinked
      ? { fix: linkPhoneFix(account.productNumber, welcome) }
      : accountFix
        ? { fix: accountFix }
        : {}),
  });
  add({
    name: 'trial',
    status: account.onboarding ? (account.onboarding.entitled ? 'ok' : 'warn') : 'skip',
    detail: account.onboarding
      ? account.onboarding.entitled
        ? 'active'
        : 'not started — agents refuse to run without one'
      : (account.unavailable ?? 'unknown'),
    ...(account.onboarding && !account.onboarding.entitled
      ? { fix: `open ${welcomeUrl ?? 'your Pagr dashboard'}` }
      : accountFix
        ? { fix: accountFix }
        : {}),
  });

  // ---- recipient keys -----------------------------------------------------
  // Frames are sealed on this Mac for the user's own phones and for nobody else — the cloud
  // relays ciphertext it cannot read. With no phone key pinned there is nothing that could open
  // a frame, so the bridge seals nothing and sends nothing: a correct state, but an invisible
  // one, and "I paired my Mac and my phone shows no transcript" is exactly what it looks like.
  const recipientKids = Object.keys(config.recipientKeys).sort();
  add({
    name: 'phone keys',
    status: !paired ? 'skip' : recipientKids.length > 0 ? 'ok' : 'warn',
    detail: !paired
      ? 'not paired yet — run `pagr connect`'
      : recipientKids.length > 0
        ? `${recipientKids.length} phone key(s) pinned: ${recipientKids.join(', ')}${
            config.recipientKeysUpdatedAt ? ` (updated ${config.recipientKeysUpdatedAt})` : ''
          }`
        : 'no phone key is pinned — nothing could read a transcript, so none is sent',
    ...(paired && recipientKids.length === 0
      ? { fix: 'open Pagr on your iPhone and sign in; its key is pinned here on the next connect' }
      : {}),
  });

  // ---- session journal ----------------------------------------------------
  // Transcripts live on this Mac, in the clear, because this Mac is where they happened. The
  // check answers the two questions somebody actually has about that: how much disk is it using,
  // and is any of it stuck here because the cloud never confirmed it.
  const journal = journalStats(ctx.paths.journalDir, ctx.paths.outboxFile);
  const behind = journal.lagging.reduce((n, s) => n + s.behind, 0);
  add({
    name: 'journal',
    status: journal.sessions === 0 ? 'skip' : behind > 0 ? 'warn' : 'ok',
    detail:
      journal.sessions === 0
        ? 'no session transcripts on disk yet'
        : [
            `${journal.sessions} session(s), ${formatBytes(journal.bytes)}`,
            journal.oldestAt ? `oldest ${journal.oldestAt.slice(0, 10)}` : null,
            behind > 0
              ? `${behind} frame(s) not confirmed by the cloud across ${journal.lagging.length} session(s)`
              : 'every frame confirmed by the cloud',
          ]
            .filter(Boolean)
            .join('; '),
    ...(behind > 0
      ? {
          fix: 'they re-send on the next gateway connection; check the `gateway link` row above if that never happens',
        }
      : {}),
  });

  // ---- API + clock --------------------------------------------------------
  // Only ever probed against a URL somebody chose (--api-url / PAGR_API_URL / a paired
  // config.json). With none of those there is nothing to be reachable, so both checks skip: an
  // unpaired Mac is not "offline", and reporting it as such sends people chasing a network fault
  // that does not exist.
  const apiUrl = configuredApiUrl(ctx.env, undefined, config);
  if (opts.offline) {
    add({ name: 'api', status: 'skip', detail: '--offline' });
    add({ name: 'clock', status: 'skip', detail: '--offline' });
  } else if (!apiUrl) {
    const why = 'no API URL configured yet — run `pagr connect`';
    add({ name: 'api', status: 'skip', detail: why });
    add({ name: 'clock', status: 'skip', detail: 'needs a configured API to compare against' });
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
  // A lock file means a daemon was started and is not answering — that is broken whatever the
  // pairing says. No lock and no pairing just means `pagr daemon install` has not been run yet.
  const daemonExpected = Boolean(lock) || paired;
  add({
    name: 'daemon',
    status: status ? 'ok' : daemonExpected ? 'fail' : 'warn',
    detail: status
      ? `pid ${status.pid}, transport ${status.transport}`
      : lock
        ? `no answer on ${socketPath(ctx)} (lock file holds pid ${lock.pid})`
        : paired
          ? `no socket at ${socketPath(ctx)}`
          : 'not installed yet',
    ...(status
      ? {}
      : daemonExpected
        ? { fix: 'run `pagr daemon install` (or `pagr daemon run`), then `pagr daemon logs`' }
        : { fix: 'run `pagr connect`, then `pagr daemon install`' }),
  });

  add(remoteProjectPickCheck(status));
  add(mirrorCheck(status));

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
      // `unpaired` is the daemon correctly reporting that it has no account to dial — the daemon
      // runs and serves IPC in that state by design, so it is a warning, not a fault.
      status:
        status.transport === 'connected' ? 'ok' : status.transport === 'unpaired' ? 'warn' : 'fail',
      detail:
        status.transport === 'unpaired' ? 'not paired yet — run `pagr connect`' : status.transport,
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
    add({ name: 'gateway', status: 'skip', detail: 'not paired yet — run `pagr connect`' });
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

  // ---- Codex shared app-server daemon -------------------------------------
  // Terminal Codex threads are mirrored only while a shared daemon is running, and the bridge
  // never starts one: `codex app-server daemon start` works solely for the installer-managed
  // standalone package, so an npm install would watch it fail on every launch. One honest line.
  if (opts.offline) add({ name: 'codex daemon', status: 'skip', detail: '--offline' });
  else {
    const socket = controlSocketPath(codexHomeDir(ctx.env));
    add(daemonDoctorLine(await probeDaemon({ socketPath: socket })));
  }

  // ---- Claude Code permission hook ----------------------------------------
  // The headline capability: prompts raised by the person's OWN `claude` sessions reach their
  // phone. Installed at user scope, so it covers every session they start — terminal, IDE
  // extension, desktop app — and it fires only when a decision is actually needed.
  const hook = hookState(ctx);
  add({
    name: 'claude hook',
    status: hook.problem
      ? 'fail'
      : hook.entryInstalled
        ? hook.scriptInstalled
          ? 'ok'
          : 'fail'
        : 'warn',
    detail: hook.problem
      ? hook.problem
      : hook.entryInstalled
        ? hook.scriptInstalled
          ? `${hook.settingsPath} runs ${hook.hookPath} when Claude Code needs a decision`
          : `${hook.settingsPath} points at ${hook.hookPath}, which is missing`
        : hook.conflict.length > 0
          ? `not installed; you have a PermissionRequest hook of your own (${hook.conflict.join(', ')}) in ${hook.settingsPath}`
          : `not installed in ${hook.settingsPath} — prompts from your own \`claude\` stay in the terminal`,
    ...(hook.problem
      ? { fix: `fix the JSON in ${hook.settingsPath}, then run \`pagr claude hook-install\`` }
      : hook.entryInstalled && hook.scriptInstalled
        ? {}
        : hook.conflict.length > 0
          ? {
              fix: 'two PermissionRequest hooks race over who answers; run `pagr claude hook-install --force` to add Pagr’s anyway',
            }
          : { fix: 'run `pagr daemon install` (or `pagr claude hook-install`)' }),
  });

  // ---- Claude Code channel -------------------------------------------------
  // Four separate truths, reported separately, because "installed", "registered", "bound" and
  // "what a follow-up actually does" are routinely confused and the product must never claim the
  // wrong one. See docs/spikes/2026-09-17-dev-channels-warning.md.
  const channel = status ? await channelStatusOf(ctx) : null;

  // The launcher only works if there is a real `claude` to exec, and the floor is about models,
  // not channels: 2.1.220 accepts the flag but refuses the current default model outright.
  const realClaude = findRealClaude(ctx.env, [ctx.binPath]);
  const claudeVersion = realClaude ? claudeVersionOf(ctx) : null;
  const meetsFloor = claudeVersion ? meetsVersionFloor(claudeVersion, CLAUDE_VERSION_FLOOR) : null;
  add({
    name: 'claude launcher',
    status: !realClaude ? 'warn' : meetsFloor === false ? 'warn' : 'ok',
    detail: !realClaude
      ? 'no `claude` on PATH, so `pagr claude` has nothing to start'
      : meetsFloor === false
        ? `${realClaude} is ${claudeVersion}; channels need ${CLAUDE_VERSION_FLOOR} or newer`
        : `${realClaude}${claudeVersion ? ` (${claudeVersion})` : ''}`,
    ...(!realClaude
      ? { fix: 'npm i -g @anthropic-ai/claude-code, then run `claude` once and sign in' }
      : meetsFloor === false
        ? { fix: 'npm i -g @anthropic-ai/claude-code@latest' }
        : {}),
  });

  const serverPath = channelServerPath(ctx);
  const registration = readRegistration(ctx);
  const serverBuilt = existsSync(serverPath);
  add({
    name: 'claude channel',
    status: registration.registered && serverBuilt ? 'ok' : registration.problem ? 'warn' : 'warn',
    detail: registration.problem
      ? `could not ask Claude Code: ${registration.problem}`
      : !registration.registered
        ? `\`${MCP_SERVER_KEY}\` is not registered at user scope`
        : serverBuilt
          ? `\`${MCP_SERVER_KEY}\` registered at user scope → ${serverPath}`
          : `registered, but the server file is missing at ${serverPath}`,
    ...(registration.registered && serverBuilt ? {} : { fix: 'run `pagr claude channel-install`' }),
  });

  add({
    name: 'channel sessions',
    status: !status ? 'skip' : (channel?.boundSessions ?? 0) > 0 ? 'ok' : 'warn',
    detail: !status
      ? 'daemon not running'
      : channel === null
        ? 'the daemon did not answer channel.status (older bridge?)'
        : channel.boundSessions
          ? `${channel.boundSessions} Claude session(s) bound, ${channel.attachedProjects.length} project(s) attached`
          : channel.enabled
            ? 'no Claude session is bound to a channel right now'
            : 'channel IPC is off (PAGR_CLAUDE_CHANNEL=0)',
    ...(status && channel?.enabled && !channel.boundSessions
      ? { fix: `start Claude Code with \`${LAUNCH_COMMAND}\` inside a registered project` }
      : {}),
  });

  add({
    name: 'live steering',
    status: 'ok',
    // Never "steered". The spike timed it: the line renders in the terminal instantly and the
    // model acts on it when the turn it was already running ends. Saying otherwise would sell an
    // interruption the bridge cannot perform.
    detail: channel?.boundSessions
      ? 'queued, surfaced at the next turn boundary'
      : 'queued, surfaced at the next turn boundary (no channel bound: after the current turn)',
  });

  // The per-project `.mcp.json` path is still supported and still reported, but it is no longer
  // the recommendation: it adds a consent dialog per project on top of the per-launch warning.
  const projectDir = ctx.env.PAGR_DOCTOR_PROJECT ?? process.cwd();
  const mcpFile = join(projectDir, MCP_CONFIG_FILE);
  const mcp = readMcpEntry(mcpFile);
  if (mcp.present || mcp.problem)
    add({
      name: 'claude channel (project)',
      status: mcp.problem ? 'warn' : 'ok',
      detail: mcp.problem
        ? `${mcpFile}: ${mcp.problem}`
        : `\`${MCP_SERVER_KEY}\` also configured in ${mcpFile} (adds a per-project consent dialog)`,
    });

  // ---- keep-awake ---------------------------------------------------------
  // Two things people need to know and cannot see: whether the Mac is being held awake right
  // now, and that closing the lid still sleeps it. Pagr asserts against IDLE sleep only, so
  // saying "your Mac will stay awake" without that qualifier would be a lie people discover at
  // the worst possible moment.
  const keepAwake = status?.keepAwake ?? null;
  // Only a darwin daemon ever reports keep-awake as enabled, so "enabled" is the honest test for
  // whether the lid caveat applies — not this CLI's own platform.
  const lidNote = ' — closing the lid still sleeps the Mac; only idle sleep is prevented';
  add({
    name: 'keep-awake',
    status: !status ? 'skip' : keepAwake === null ? 'skip' : keepAwake.disabled ? 'skip' : 'ok',
    detail: !status
      ? 'daemon not running'
      : keepAwake === null
        ? 'the daemon did not report keep-awake (older bridge?)'
        : `${describeKeepAwake(keepAwake)}${keepAwake.disabled ? '' : lidNote}`,
    ...(keepAwake?.disabled && keepAwake.disabledReason === 'opt_out'
      ? { fix: `unset ${KEEP_AWAKE_ENV} on the daemon to let Pagr hold the Mac awake again` }
      : {}),
  });

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
      const plan = launchAgentPlan(ctx);
      const stale = launchAgentStaleReason(plist, {
        programArguments: plan.programArguments,
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
          ? {
              fix: stale
                ? 'run `pagr daemon install` to rewrite and re-bootstrap it (it resolves Node at launch, so a Node upgrade cannot break it again)'
                : 'run `pagr daemon start` (or `pagr daemon install` to rewrite and re-bootstrap it)',
            }
          : {}),
      });
    }
    addAgentEnvCheck(ctx, add, plist);
  }
  return checks;
}

/**
 * What a phone may ADD, not just reach. With this on, a paired phone can ask this Mac to list the
 * git repositories under its conventional code folders and register one — so the state is
 * reported rather than assumed, exactly like the device floor above. Only the daemon knows it:
 * the handles live in its memory and nowhere else.
 */
function remoteProjectPickCheck(status: DaemonStatus | null): Check {
  const pick = status?.remoteProjectPick;
  if (!pick) return { name: 'remote pick', status: 'skip', detail: 'daemon not running' };
  return {
    name: 'remote pick',
    status: 'ok',
    detail: pick.enabled
      ? `on — your phone can list and add git repositories under your code folders (${pick.handles} handle(s) cached)`
      : `off (${REMOTE_PROJECT_PICK_ENV}=0) — projects can only be added on this Mac`,
  };
}

/**
 * The Claude sessions you started yourself.
 *
 * Reported as counts and an age, never as a path or a session name: what a person needs from this
 * line is "is it following anything, and is anything still arriving?". `PAGR_MIRROR=0` is a
 * deliberate choice, so it reports `ok` and says so rather than complaining.
 */
function mirrorCheck(status: DaemonStatus | null): Check {
  const mirror = status?.mirror;
  if (!mirror)
    return {
      name: 'mirror',
      status: 'skip',
      detail: status ? 'no Claude sessions mirrored yet' : 'daemon not running',
    };
  return { name: 'mirror', status: 'ok', detail: describeMirror(mirror) };
}

// ---- describers shared with `pagr status` --------------------------------------------------
// One phrasing per fact, in one place. `pagr status` prints the same sentence `pagr doctor` does,
// so nobody has to reconcile two descriptions of the same thing when they differ.

/** The Claude transcript mirror: counts and an age, never a path or a session name. */
export function describeMirror(mirror: NonNullable<DaemonStatus['mirror']>): string {
  if (!mirror.enabled) return `off (${MIRROR_ENV}=0) — your own terminal sessions are not mirrored`;
  const age = mirror.lastFrameAt ? Date.now() - Date.parse(mirror.lastFrameAt) : null;
  const last =
    age === null || Number.isNaN(age)
      ? 'no frames yet'
      : `last frame ${Math.round(age / 1000)}s ago`;
  const unknown =
    mirror.unknownRecordTypes > 0
      ? `; ${mirror.unknownRecordTypes} unrecognised record type(s) — Claude Code writes something this bridge has no frame for`
      : '';
  return `${mirror.sessions} session(s), ${mirror.filesWatched} file(s) watched, ${last}${unknown}`;
}

/** What the gateway and this bridge settled on. v1 means no frames, no questions, no backfill. */
export function describeProtocol(version: number | undefined): string {
  if (version === undefined) return 'unknown (older bridge)';
  return version >= 2
    ? 'v2 — sealed transcript frames, questions, backfill'
    : 'v1 — summaries only; this gateway has not accepted v2';
}

/**
 * The phones this Mac seals to, by fingerprint.
 *
 * Printed in full rather than counted: the fingerprint is the thing a person compares against
 * what their phone shows them, and a key set you cannot read is a key set you cannot check.
 */
export function describeRecipientKeys(ids: string[] | undefined): string {
  if (ids === undefined) return 'unknown (older bridge)';
  if (ids.length === 0) return 'none — nothing can be sealed, frames stay on this Mac';
  return `${ids.length} phone(s): ${ids.join(', ')}`;
}

/** The Claude channel, as the daemon reports it in `device.hello`. */
export function describeChannel(channel: DaemonStatus['channel'] | undefined): string {
  if (!channel) return 'unknown (older bridge)';
  if (!channel.registered)
    return channel.serverInstalled
      ? `off (${CLAUDE_CHANNEL_ENV}=0) — terminal sessions stay approvals-only`
      : 'not registered — terminal sessions stay approvals-only';
  return `registered, ${channel.boundSessions} session(s) bound, follow-ups ${channel.mode === 'queued_next_turn' ? 'queued to the next turn boundary' : 'off'}`;
}

/** The plaintext transcript archive on this disk. */
export function describeJournal(bytes: number | undefined): string {
  if (bytes === undefined) return 'unknown (older bridge)';
  return bytes === 0
    ? 'empty'
    : `${formatBytes(bytes)} of plaintext transcript in ~/.pagr/journal (pagr sessions purge)`;
}

/**
 * The "works in my terminal, not from my phone" check. launchd hands a launch agent a minimal
 * environment, so an agent that is authenticated by a variable in `.zshrc` looks signed out to
 * the daemon. Pagr never copies these into the plist (a plist is world-readable and the bridge
 * does not touch provider credentials) — it names them here so the state is at least explicable.
 */
function addAgentEnvCheck(ctx: CliContext, add: (c: Check) => void, plist: string): void {
  const agentEnv = installedAgentEnv(plist);
  if (agentEnv === null) {
    add({ name: 'agent env', status: 'skip', detail: 'no launch agent installed yet' });
    return;
  }
  const gaps = agentEnvGaps(ctx.env, agentEnv);
  const secrets = gaps.filter((g) => g.secret);
  add({
    name: 'agent env',
    status: gaps.length === 0 ? 'ok' : 'warn',
    detail:
      gaps.length === 0
        ? 'the daemon sees the same agent settings as this shell'
        : `${describeEnvGaps(gaps)} set here but not for the daemon${
            secrets.length > 0
              ? ' — an agent authenticated this way will look signed out to Pagr'
              : ''
          }`,
    ...(gaps.length === 0 ? {} : { fix: ENV_GAP_FIX }),
  });
}

/** Does this project's `.mcp.json` carry the Pagr channel server? Never throws. */
function readMcpEntry(file: string): { present: boolean; problem?: string } {
  if (!existsSync(file)) return { present: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8') || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { present: false, problem: 'not a JSON object' };
    const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers;
    return { present: Boolean(servers && MCP_SERVER_KEY in servers) };
  } catch (err) {
    return { present: false, problem: `invalid JSON (${(err as Error).message})` };
  }
}

async function channelStatusOf(ctx: CliContext): Promise<ChannelStatus | null> {
  try {
    return await ipc(ctx).call<ChannelStatus>('channel.status', undefined, 3000);
  } catch {
    return null;
  }
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

/** Sizes people read at a glance; the exact byte count is never the point here. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
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
  const paired = checks.find((c) => c.name === 'paired')?.status === 'ok';
  if (ctx.json) {
    printJson(ctx, {
      ok: failures.length === 0,
      paired,
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
    else if (!paired)
      ctx.out(dim('  this Mac is not paired yet — run `pagr connect` to finish setup'));
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
