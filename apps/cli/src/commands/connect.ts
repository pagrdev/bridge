import { existsSync } from 'node:fs';
import {
  auditPermissions,
  checkHomeWritable,
  type DeviceIdentity,
  describeClockSkew,
  ensurePaths,
  getPaths,
  inspectConfig,
  LINK_PHONE_BODY,
  linkPhoneSms,
  loadOrCreateIdentity,
  MAX_TOLERABLE_CLOCK_SKEW_MS,
  type OnboardingFacts,
  type PairingCompleted,
  type PairStartResponse,
  ProjectRegistry,
  persistPairing,
  pollOnboarding,
  pollPairing,
  readConfig,
  readProductNumber,
  repairPermissions,
  type StagedIdentity,
  stageNewIdentity,
  startPairing,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import { installHookForUser } from '../claudeHook.js';
import type { CliContext } from '../context.js';
import { isRemoteSession } from '../context.js';
import { CliError, EXIT, interruptedError, toCliError } from '../errors.js';
import { daemonStatus } from '../ipc.js';
import {
  agentEnvGaps,
  describeEnvGaps,
  ENV_GAP_FIX,
  installAgent,
  launchAgentPlan,
} from '../launchd.js';
import {
  bold,
  cyan,
  dim,
  duration,
  ok,
  printJson,
  qr,
  say,
  spinner,
  step,
  warn,
} from '../output.js';
import { resolveApiUrl, tryResolveWebUrl } from '../urls.js';
import { installChannelRegistration, LAUNCH_COMMAND } from './claudeChannel.js';

export interface ConnectOptions {
  apiUrl?: string;
  gatewayUrl?: string;
  name?: string;
  daemon: boolean;
  /** `--no-channel`: pair without registering the Claude Code channel server. */
  channel?: boolean;
  force?: boolean;
  open: boolean;
  /** Minutes to wait for the browser approval. */
  timeout?: string;
  /** Seconds to wait for the daemon's gateway handshake after install. */
  wait?: string;
  /** `--no-qr`: print the `sms:` link as text instead of drawing a QR code. */
  qr?: boolean;
  /** Open Messages on this Mac for the phone step. Off by default — see `PHONE_OPEN_CAVEAT`. */
  openMessages?: boolean;
}

const STEPS = 6;

/** Gateway states that mean "up, but not usable yet". */
export type VerifyOutcome =
  | { kind: 'connected'; pid: number }
  | { kind: 'daemon_down' }
  | { kind: 'not_connected'; transport: string; pid: number }
  | { kind: 'skipped'; reason: string };

/**
 * Wait for the daemon to complete the gateway handshake. Bounded by both attempts and wall
 * clock so an injected no-op `sleep` (tests) cannot spin. "Started" is not "connected": we
 * only say connected once the transport reports it.
 */
export async function verifyGatewayConnected(
  ctx: CliContext,
  o: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 20_000 },
): Promise<VerifyOutcome> {
  const intervalMs = o.intervalMs ?? 700;
  const attempts = Math.max(1, Math.ceil(o.timeoutMs / intervalMs));
  const deadline = ctx.now().getTime() + o.timeoutMs;
  let last: { transport: string; pid: number } | null = null;
  for (let i = 0; i < attempts; i++) {
    const status = await daemonStatus(ctx);
    if (status) {
      if (status.transport === 'connected') return { kind: 'connected', pid: status.pid };
      last = { transport: status.transport, pid: status.pid };
    }
    if (i + 1 < attempts && ctx.now().getTime() < deadline) await ctx.sleep(intervalMs);
    else break;
  }
  return last ? { kind: 'not_connected', ...last } : { kind: 'daemon_down' };
}

interface ConnectResult {
  /** What happened to `~/.claude/settings.json`: installed / already-installed / conflict / failed. */
  claudeHook: string;
  /** What happened to the user-scope channel registration: installed / already-installed / failed / skipped. */
  claudeChannel: string;
  deviceId: string;
  userId: string;
  gatewayUrl: string;
  deviceName: string;
  apiUrl: string;
  plist: string | null;
  gateway: VerifyOutcome;
  warnings: string[];
  projects: number;
  /** Null when the api is older than this CLI and says nothing about the account. */
  onboarding: OnboardingFacts | null;
  productNumber: string | null;
  welcomeUrl: string | null;
}

export async function runConnect(ctx: CliContext, opts: ConnectOptions): Promise<void> {
  const warnings: string[] = [];
  const note = (line: string) => {
    warnings.push(stripMarkup(line));
    say(ctx, warn(line));
  };

  // --- 1. local state -------------------------------------------------------
  say(ctx, step(1, STEPS, 'Checking this Mac'));
  const writable = checkHomeWritable(ctx.home);
  if (!writable.ok) throw toCliError(writable.error);
  // Audit BEFORE `ensurePaths`, which silently tightens directory modes on its way through.
  const loose = auditPermissions(getPaths(ctx.home)).map((i) => i.path);
  const paths = ensurePaths(ctx.home);
  const { config: existing, problem } = inspectConfig(paths.configFile);
  if (problem)
    note(`${problem.message.replace(`${paths.configFile} `, 'config.json ')} — starting fresh`);
  const tightened = new Set([...loose, ...repairPermissions(paths)]);
  if (tightened.size > 0)
    note(`tightened permissions on ${tightened.size} path(s) under ${ctx.home}`);

  if (existing.deviceId && !opts.force)
    return alreadyPaired(ctx, existing.deviceId, existing.deviceName);
  say(ctx, ok(`state directory ${dim(ctx.home)}`));

  const apiUrl = resolveApiUrl(ctx.env, opts.apiUrl, existing);
  const deviceName = opts.name?.trim() || ctx.deviceName();
  // Escape hatch for slow/intercepted networks (and for tests): per-request ceiling in ms.
  const requestTimeoutMs = positiveInt(ctx.env.PAGR_HTTP_TIMEOUT_MS);

  // --- 2. device key --------------------------------------------------------
  say(ctx, step(2, STEPS, 'Preparing the device key'));
  const store = await ctx.secretStore();
  // `--force` on a paired Mac STAGES its replacement key: it is minted in memory and the working
  // key stays in the store untouched until the cloud has approved the new pairing (step 5). A
  // failure anywhere before that — 5xx, denial, timeout, Ctrl-C — leaves the old identity exactly
  // as it was, instead of stranding the Mac with a config and a key that disagree.
  const staged: StagedIdentity | null =
    opts.force && existing.deviceId ? await stageNewIdentity(store) : null;
  const identity: DeviceIdentity = staged ? staged.identity : await loadOrCreateIdentity(store);
  say(
    ctx,
    ok(
      staged
        ? `replacement device key minted ${dim(`(public key ${identity.publicKeyRaw.slice(0, 12)}…; the key for ${existing.deviceId} stays in ${store.kind} until this pairing is approved)`)}`
        : `device key ready ${dim(`(${store.kind}; public key ${identity.publicKeyRaw.slice(0, 12)}…)`)}`,
    ),
  );
  if (store.kind === 'file')
    note('PAGR_INSECURE_FILE_STORE=1: the device key is in a plaintext file, not the Keychain');

  // Ctrl-C from here on must leave nothing behind: config is written in one atomic step later.
  const aborter = new AbortController();
  const releaseInterrupt = ctx.onInterrupt(() => aborter.abort());
  try {
    // --- 3. ask the cloud for a code ---------------------------------------
    say(ctx, step(3, STEPS, 'Contacting Pagr'));
    const startSpin = spinner(ctx, `asking ${apiUrl} for a pairing code…`);
    let started: PairStartResponse;
    try {
      started = await startPairing({
        apiUrl,
        deviceName,
        identity,
        bridgeVersion: ctx.bridgeVersion,
        sleep: ctx.sleep,
        now: () => ctx.now().getTime(),
        onClockSkew: (skew) => {
          if (Math.abs(skew) > MAX_TOLERABLE_CLOCK_SKEW_MS)
            note(
              `this Mac's clock is ${describeClockSkew(skew)} the Pagr server — signed commands expire on a schedule, so fix the date in System Settings → General → Date & Time (set it automatically)`,
            );
        },
        ...(opts.force && existing.deviceId ? { replacesDeviceId: existing.deviceId } : {}),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      });
    } finally {
      startSpin.stop();
    }
    if (aborter.signal.aborted) throw interruptedError();

    // --- 4. approval in the browser ----------------------------------------
    say(ctx, step(4, STEPS, 'Approve this Mac in your browser'));
    say(ctx, '');
    say(ctx, `  Pairing code  ${bold(cyan(started.code))}`);
    say(ctx, `  Open          ${bold(started.pairUrl)}`);
    say(ctx, dim(`  the code expires ${started.expiresAt}`));
    say(ctx, '');

    if (!opts.open) say(ctx, dim('  (--no-open) open that URL yourself to approve'));
    else if (isRemoteSession(ctx.env))
      note('this looks like an SSH session — open the URL above on your own computer');
    else if (!(await ctx.openBrowser(started.pairUrl)))
      note('could not open a browser here — open the URL above yourself; pagr keeps waiting');

    const timeoutMs = minutesOption(opts.timeout, 10) * 60_000;
    const spin = spinner(ctx, 'waiting for you to approve this Mac…');
    let done: Awaited<ReturnType<typeof pollPairing>>;
    try {
      done = await pollPairing({
        apiUrl,
        pairingId: started.pairingId,
        sleep: ctx.sleep,
        timeoutMs,
        signal: aborter.signal,
        now: () => ctx.now().getTime(),
        onProgress: (p) =>
          spin.update(
            p.transientError
              ? `network trouble (${p.transientError.message}) — retrying…`
              : `waiting for you to approve this Mac… ${dim(`${duration(p.elapsedMs)} elapsed, ${duration(p.remainingMs)} left`)}`,
          ),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      });
    } catch (err) {
      if (aborter.signal.aborted) throw interruptedError();
      throw err;
    } finally {
      spin.stop();
    }

    // --- 5. persist + install ----------------------------------------------
    say(ctx, step(5, STEPS, 'Saving the pairing'));
    // Approving under a different Pagr account is legal but almost never intended — this Mac's
    // projects would move to that account's dashboard. Say it out loud.
    if (existing.userId && existing.userId !== done.userId)
      note(
        `this Mac now belongs to a different Pagr account (was ${existing.userId}, now ${done.userId}) — if that was not deliberate, run \`pagr connect --force\` and approve with the right account`,
      );
    // The replacement key goes in only now that the cloud has accepted it, and the config right
    // after. If either write fails the previous identity is restored, so the Mac keeps working
    // with the pairing it already had.
    if (staged) {
      try {
        await staged.commit();
      } catch (err) {
        throw new CliError(
          `approved as ${done.deviceId}, but the new device key could not be stored: ${
            err instanceof Error ? err.message : String(err)
          }`,
          EXIT.secretStore,
          {
            code: 'device_key_not_stored',
            hint: `nothing changed on this Mac — it is still paired as ${existing.deviceId} and still works. Fix the Keychain (\`pagr doctor\`), revoke ${done.deviceId} in the dashboard, then run \`pagr connect --force\` again`,
            cause: err,
          },
        );
      }
    }
    try {
      persistPairing(paths.configFile, done, {
        apiUrl,
        deviceName,
        now: ctx.now,
        // Kept so `status` and `doctor` can ask the same public route about the account later.
        pairingId: started.pairingId,
        ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
      });
    } catch (err) {
      // The pairing exists in the cloud but we could not record it: full disk, read-only home.
      await rollbackQuietly(staged, note);
      throw new CliError(
        `paired with Pagr, but ${paths.configFile} could not be written: ${
          err instanceof Error ? err.message : String(err)
        }`,
        EXIT.state,
        {
          code: 'pairing_not_persisted',
          hint: staged
            ? `the previous device key was put back, so this Mac still works as ${existing.deviceId} — free up disk space (or fix the permissions on PAGR_HOME), revoke ${done.deviceId} in the dashboard, then run \`pagr connect --force\` again`
            : 'free up disk space (or fix the permissions on PAGR_HOME) and run `pagr connect --force`; then revoke the stranded device in the dashboard',
          cause: err,
        },
      );
    }
    say(ctx, ok(`paired as ${bold(done.deviceId)} ${dim(`(user ${done.userId})`)}`));

    let plist: string | null = null;
    if (!opts.daemon) note('daemon not installed (--no-daemon); run `pagr daemon install` later');
    else if (!ctx.hasLaunchctl())
      note(
        'launchd is not available here, so the background daemon was not installed — run `pagr daemon run` in the foreground',
      );
    else {
      plist = installAgent(ctx, paths.logsDir);
      say(ctx, ok(`background daemon installed ${dim(plist)}`));
      noteAgentEnvGaps(ctx, note);
    }

    // Register the Claude Code PermissionRequest hook for this user. At user scope it covers
    // every session they start, and it only fires when Claude Code actually needs a decision —
    // so a repo they have already auto-approved never reaches Pagr at all. A settings file we
    // could not parse, or a PermissionRequest hook of their own, is a note, never a failed
    // pairing: `installHookForUser` reports and moves on.
    const hook = installHookForUser(ctx, (line) => say(ctx, line));
    if (hook.action === 'conflict' || hook.action === 'failed')
      warnings.push(
        stripMarkup(
          hook.action === 'conflict'
            ? 'a PermissionRequest hook of your own is already installed; Pagr did not touch it'
            : 'your Claude Code settings file could not be read, so the hook was not installed',
        ),
      );

    // Register the channel server at user scope, so `pagr claude` works in every project from
    // here on. Registering it changes nothing on its own: plain `claude` never loads a channel,
    // and the server is only spawned by a session that names it on the command line.
    const channel =
      opts.channel === false ? ({ action: 'skipped' } as const) : installChannelRegistration(ctx);
    if (channel.action === 'installed' || channel.action === 'already-installed')
      say(ctx, ok(`Claude Code channel registered ${dim('(user scope)')}`));
    if (channel.action === 'failed')
      warnings.push(
        stripMarkup(
          `the Claude Code channel could not be registered (${channel.problem ?? 'unknown error'}); run \`pagr claude channel-install\` later`,
        ),
      );

    // --- 6. prove the gateway handshake ------------------------------------
    say(ctx, step(6, STEPS, 'Verifying the connection'));
    const gateway = plist
      ? await verifyOrReport(ctx, opts, note)
      : ({ kind: 'skipped', reason: 'the daemon was not installed' } as const);

    // --- 7/8. the account, not the Mac -------------------------------------
    // Everything above is finished and saved: whatever happens here, this Mac works. These two
    // steps are about the account it belongs to, and either can be walked away from.
    //
    // Not when the daemon never came up, though: that is a real failure with a fix, and making
    // somebody sit through two account steps before they are told about it would be perverse.
    const account =
      gateway.kind === 'daemon_down'
        ? { facts: null, productNumber: null, welcomeUrl: null }
        : await accountSteps(ctx, opts, {
            apiUrl,
            pairingId: started.pairingId,
            done,
            note,
            ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
          });

    const result: ConnectResult = {
      claudeHook: hook.action,
      claudeChannel: channel.action,
      deviceId: done.deviceId,
      userId: done.userId,
      gatewayUrl: opts.gatewayUrl ?? done.gatewayUrl,
      deviceName,
      apiUrl,
      plist,
      gateway,
      warnings,
      projects: countProjects(ctx),
      onboarding: account.facts,
      productNumber: account.productNumber,
      welcomeUrl: account.welcomeUrl,
    };
    // A paired Mac whose daemon never came up is a failed install, but the pairing IS saved —
    // say so, and never send the user back to `connect`.
    const fatal =
      gateway.kind === 'daemon_down'
        ? new CliError(
            'this Mac is paired, but the background daemon did not start',
            EXIT.precondition,
            {
              code: 'daemon_did_not_start',
              hint: 'run `pagr daemon logs -n 50` to see why, then `pagr daemon install` to retry — your pairing is saved, do not run `connect` again',
            },
          )
        : null;
    if (ctx.json) {
      printJson(ctx, {
        ok: !fatal,
        ...result,
        ...(fatal ? { error: fatal.toJson().error } : {}),
      });
      if (fatal) throw new CliError('', fatal.exitCode, { code: fatal.code ?? 'error' });
      return;
    }
    printSummary(ctx, result);
    if (fatal) throw fatal;
  } finally {
    releaseInterrupt();
  }
}

/**
 * What `open "sms:…"` actually does, and why it is not the default.
 *
 * It opens Messages with the recipient and body filled in — but the message is sent from *this
 * Mac's* Messages identity, which is usually an Apple ID email rather than the phone number on
 * the account. A text from an email handle links nothing: the number it arrives from is the only
 * thing that identifies the person. The CLI cannot see which identity Messages will use, so the
 * QR — scanned by the phone itself — stays the primary path and this is opt-in.
 */
export const PHONE_OPEN_CAVEAT =
  "Messages will send this from this Mac's identity. If that is an Apple ID email rather than the phone number on your Pagr account, the text will not link — check Messages → Settings → \u201cStart new conversations from\u201d.";

interface AccountSteps {
  /** Null when the api said nothing about the account: unknown, not "nothing done". */
  facts: OnboardingFacts | null;
  productNumber: string | null;
  welcomeUrl: string | null;
}

interface AccountContext {
  apiUrl: string;
  pairingId: string;
  done: PairingCompleted;
  note: (line: string) => void;
  requestTimeoutMs?: number;
}

/**
 * Steps 7 and 8: link a phone, start a trial. Both are account state, not machine state, so
 * neither can fail `pagr connect` and both are skipped the moment the server says they are
 * already done — a person who came in through the web door and linked their phone there never
 * sees the phone step here (§1, "never re-do a step done elsewhere").
 *
 * The facts come from the pairing response this command already has in hand, so an api that
 * does not send them costs nothing: no extra request, no extra output, and the summary falls
 * back to pointing at the dashboard.
 *
 * In `--json` mode nothing waits. A scripted run gets the facts as they are and exits.
 */
async function accountSteps(
  ctx: CliContext,
  opts: ConnectOptions,
  o: AccountContext,
): Promise<AccountSteps> {
  const welcomeUrl = tryResolveWebUrl(ctx.env, readConfig(ctx.paths.configFile));
  const welcome = welcomeUrl ? `${welcomeUrl}/welcome` : null;
  let facts = o.done.onboarding ?? null;
  let productNumber = o.done.productNumber ?? null;
  if (!facts) return { facts: null, productNumber, welcomeUrl: welcome };

  const phoneNeeded = !facts.messagingLinked;
  const trialNeeded = !facts.entitled;
  if (!phoneNeeded) say(ctx, ok('phone already linked'));
  if (!trialNeeded) say(ctx, ok('trial already active'));
  const total = STEPS + (phoneNeeded ? 1 : 0) + (trialNeeded ? 1 : 0);
  const timeoutMs = minutesOption(opts.timeout, 10) * 60_000;
  // `--json` is a scripted run: report what is true, open nothing, wait for nobody.
  let interactive = !ctx.json;
  let n = STEPS;

  if (phoneNeeded) {
    say(ctx, step(++n, total, 'Link your phone'));
    if (!productNumber) productNumber = await productNumberOrNull(ctx, o);
    say(ctx, '');
    if (productNumber) {
      const link = linkPhoneSms(productNumber);
      say(
        ctx,
        `  Scan this with your iPhone, or text  ${bold(cyan(LINK_PHONE_BODY))}  to  ${bold(cyan(productNumber))}`,
      );
      say(ctx, '');
      // A QR needs a real terminal and room for its quiet zone; anything else gets the link,
      // which is just as usable and does not turn into confetti when it wraps.
      const art = opts.qr === false || !ctx.isTTY ? null : qr(link, { maxWidth: ctx.columns });
      for (const line of art ?? []) say(ctx, `  ${line}`);
      if (!art) say(ctx, `  ${dim(link)}`);
      say(ctx, '');
      if (opts.openMessages && interactive) {
        say(ctx, warn(PHONE_OPEN_CAVEAT));
        if (!(await ctx.openBrowser(link)))
          say(ctx, dim('  could not open Messages here — scan the code above instead'));
      }
    } else {
      // No published line: there is nothing to text or encode, and the conversation has to be
      // started by Pagr instead. The dashboard does that.
      say(ctx, '  This Pagr deployment has no number to text yet.');
      if (welcome) say(ctx, `  Link your phone here instead: ${bold(welcome)}`);
    }
    say(
      ctx,
      dim(
        '  any text from the number on your account links it — Ctrl-C to skip, this Mac works either way',
      ),
    );
    if (interactive) {
      const got = await waitFor(
        ctx,
        o,
        'waiting for your text…',
        timeoutMs,
        (f) => f.messagingLinked,
      );
      facts = got.onboarding ?? facts;
      if (got.outcome === 'satisfied') say(ctx, ok('phone linked — Pagr texted you a welcome'));
      else if (got.outcome === 'error')
        o.note(`could not check whether your phone linked: ${got.error?.message ?? 'unknown'}`);
      else say(ctx, dim('  not linked yet — the text still works whenever you send it'));
      // One Ctrl-C ends the waiting, not just this wait: somebody who wants out is not asked to
      // ask again. The step below still prints what would finish it.
      if (got.outcome === 'canceled') interactive = false;
    }
  }

  if (trialNeeded) {
    say(ctx, step(++n, total, 'Start your trial'));
    say(ctx, '');
    say(ctx, '  Pagr runs agents only on an account with a trial or subscription.');
    if (welcome) {
      say(ctx, `  Open  ${bold(welcome)}`);
      say(ctx, '');
      if (!interactive) say(ctx, dim('  not waiting — open it whenever you are ready'));
      else if (!opts.open) say(ctx, dim('  (--no-open) open that URL yourself'));
      else if (isRemoteSession(ctx.env))
        say(ctx, dim('  this looks like an SSH session — open the URL on your own computer'));
      else if (!(await ctx.openBrowser(welcome)))
        say(ctx, dim('  could not open a browser here — open the URL above yourself'));
      if (interactive) {
        const got = await waitFor(
          ctx,
          o,
          'waiting for the trial to start…',
          timeoutMs,
          (f) => f.entitled,
        );
        facts = got.onboarding ?? facts;
        if (got.outcome === 'satisfied') say(ctx, ok('trial started'));
        else if (got.outcome === 'error')
          o.note(`could not check whether the trial started: ${got.error?.message ?? 'unknown'}`);
        else say(ctx, dim(`  not started yet — you can start it any time at ${welcome}`));
      }
    } else {
      say(ctx, dim('  start it from your Pagr dashboard when you are ready'));
    }
  }

  return { facts, productNumber, welcomeUrl: welcome };
}

/** The number to text, asked for separately only when the pairing response did not carry it. */
async function productNumberOrNull(ctx: CliContext, o: AccountContext): Promise<string | null> {
  try {
    return await readProductNumber({
      apiUrl: o.apiUrl,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(o.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: o.requestTimeoutMs }),
    });
  } catch {
    // An api without the route is an api with no number to give; the branch below says so.
    return null;
  }
}

/** Wait for one account fact, with its own Ctrl-C so skipping the step does not kill `connect`. */
async function waitFor(
  ctx: CliContext,
  o: AccountContext,
  label: string,
  timeoutMs: number,
  until: (f: OnboardingFacts) => boolean,
): Promise<Awaited<ReturnType<typeof pollOnboarding>>> {
  const abort = new AbortController();
  const release = ctx.onInterrupt(() => abort.abort());
  const spin = spinner(ctx, label);
  try {
    return await pollOnboarding({
      apiUrl: o.apiUrl,
      pairingId: o.pairingId,
      until,
      timeoutMs,
      signal: abort.signal,
      sleep: ctx.sleep,
      now: () => ctx.now().getTime(),
      onProgress: (p) => spin.update(`${label} ${dim(`${duration(p.remainingMs)} left`)}`),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(o.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: o.requestTimeoutMs }),
    });
  } finally {
    spin.stop();
    release();
  }
}

async function verifyOrReport(
  ctx: CliContext,
  opts: ConnectOptions,
  note: (line: string) => void,
): Promise<VerifyOutcome> {
  const waitMs = secondsOption(opts.wait, 20) * 1000;
  if (waitMs === 0) return { kind: 'skipped', reason: '--wait 0' };
  const spin = spinner(ctx, 'waiting for the daemon to reach the Pagr gateway…');
  let outcome: VerifyOutcome;
  try {
    outcome = await verifyGatewayConnected(ctx, { timeoutMs: waitMs });
  } finally {
    spin.stop();
  }
  if (outcome.kind === 'connected')
    say(ctx, ok(`gateway connected ${dim(`(daemon pid ${outcome.pid})`)}`));
  else if (outcome.kind === 'not_connected')
    note(
      `the daemon is running (pid ${outcome.pid}) but the gateway is "${outcome.transport}", not connected yet — check again with \`pagr status\`, and \`pagr doctor\` if it stays that way`,
    );
  else if (outcome.kind === 'daemon_down')
    note('the daemon did not answer on its local socket within the wait window');
  return outcome;
}

function printSummary(ctx: CliContext, r: ConnectResult): void {
  ctx.out('');
  ctx.out(bold('Done'));
  ctx.out(`  device    ${r.deviceId} ${dim(`(${r.deviceName})`)}`);
  ctx.out(
    `  gateway   ${
      r.gateway.kind === 'connected'
        ? ok('connected')
        : r.gateway.kind === 'not_connected'
          ? warn(r.gateway.transport)
          : r.gateway.kind === 'daemon_down'
            ? warn('daemon not answering')
            : dim(`not checked (${r.gateway.reason})`)
    }`,
  );
  ctx.out(`  daemon    ${r.plist ? dim(r.plist) : dim('not installed')}`);
  // The account half, read from the same booleans the steps above waited on. Absent entirely on
  // an api that does not report them, because a confident "not linked" would be a guess.
  if (r.onboarding) {
    ctx.out(
      `  phone     ${
        r.onboarding.messagingLinked
          ? ok('linked')
          : warn(
              r.productNumber
                ? `not linked — text ${LINK_PHONE_BODY} to ${r.productNumber}`
                : 'not linked',
            )
      }`,
    );
    ctx.out(
      `  trial     ${
        r.onboarding.entitled
          ? ok('active')
          : warn(`not started${r.welcomeUrl ? ` — ${r.welcomeUrl}` : ''}`)
      }`,
    );
  }
  if (r.warnings.length > 0) {
    ctx.out('');
    ctx.out(bold(`${r.warnings.length} thing(s) to know`));
    for (const w of r.warnings) ctx.out(dim(`  · ${w}`));
  }
  ctx.out('');
  ctx.out(bold('Next steps'));
  // Only what is actually left: a step finished during this run never reappears as a chore.
  const next: string[] = [
    r.projects === 0
      ? `${cyan(`pagr project add ${exampleProjectPath(ctx)} --name MyApp`)}\n     ${dim('register a repo — only its id and name ever leave this Mac')}`
      : `${cyan('pagr projects')}   ${dim(`${r.projects} project(s) already registered`)}`,
  ];
  if (!r.onboarding) next.push(dim('link iMessage from the dashboard (Settings → Messaging)'));
  else {
    if (!r.onboarding.messagingLinked)
      next.push(
        r.productNumber
          ? `${cyan(`text ${LINK_PHONE_BODY} to ${r.productNumber}`)}   ${dim('links your phone')}`
          : dim('link your phone from the dashboard'),
      );
    if (!r.onboarding.entitled && r.welcomeUrl)
      next.push(`${cyan(r.welcomeUrl)}   ${dim('start your trial')}`);
  }
  next.push(`${cyan('pagr status')}    ${dim('confirm the gateway stays connected')}`);
  if (r.claudeChannel === 'installed' || r.claudeChannel === 'already-installed')
    next.push(
      `${cyan(LAUNCH_COMMAND)}    ${dim('start Claude Code so your phone can take a turn in it')}`,
    );
  for (const [i, line] of next.entries()) ctx.out(`  ${i + 1}. ${line}`);
  ctx.out(dim('\nSomething off? `pagr doctor` explains and fixes almost everything.'));
}

/**
 * A rollback that itself fails must not replace the error the user actually needs to see.
 * It is reported as a warning instead, with the one command that repairs the machine.
 */
async function rollbackQuietly(
  staged: StagedIdentity | null,
  note: (line: string) => void,
): Promise<void> {
  if (!staged) return;
  try {
    await staged.rollback();
  } catch (err) {
    note(
      `the previous device key could not be put back (${
        err instanceof Error ? err.message : String(err)
      }) — run \`pagr logout\` then \`pagr connect\` to start clean`,
    );
  }
}

/**
 * An agent authenticated by a variable in the user's shell profile is invisible to launchd, and
 * that is the whole of "it works in my terminal but not from my phone". Say it at install time;
 * `pagr doctor` says it again. Only the NAMES are printed, and nothing is copied into the plist.
 */
function noteAgentEnvGaps(ctx: CliContext, note: (line: string) => void): void {
  const gaps = agentEnvGaps(ctx.env, launchAgentPlan(ctx).env);
  if (gaps.length === 0) return;
  note(
    `${describeEnvGaps(gaps)} ${gaps.length === 1 ? 'is set' : 'are set'} in this shell but not for the background daemon — ${ENV_GAP_FIX}`,
  );
}

/** A real path the user can recognise, so step 1 is copy-pasteable. */
function exampleProjectPath(ctx: CliContext): string {
  const home = ctx.env.HOME;
  return home ? `${home}/code/my-app` : '~/code/my-app';
}

function countProjects(ctx: CliContext): number {
  const paths = getPaths(ctx.home);
  if (!existsSync(paths.projectsFile)) return 0;
  return new ProjectRegistry({ file: paths.projectsFile, pagrHome: ctx.home }).list().length;
}

/** Re-running `connect` on a paired Mac is a no-op that reports the truth, never an error. */
function alreadyPaired(ctx: CliContext, deviceId: string, deviceName?: string): void {
  if (ctx.json) {
    printJson(ctx, { ok: true, alreadyPaired: true, deviceId, deviceName: deviceName ?? null });
    return;
  }
  ctx.out(ok(`already paired as ${bold(deviceId)} ${dim(`(${deviceName ?? 'this Mac'})`)}`));
  ctx.out(dim('  nothing to do — `pagr status` shows the live picture'));
  ctx.out(dim('  re-pair with `pagr connect --force`, or `pagr logout` first'));
}

const stripMarkup = (s: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI for the JSON payload
  s.replace(/\x1b\[[0-9;]*m/g, '');

function minutesOption(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function secondsOption(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function registerConnect(program: Command, getCtx: () => CliContext): void {
  program
    .command('connect')
    .description('pair this Mac with your Pagr account and install the background daemon')
    .option(
      '--api-url <url>',
      'Pagr API base URL (default: $PAGR_API_URL; required — this build has no hosted default)',
    )
    .option('--gateway-url <url>', 'override the gateway WebSocket URL returned by pairing')
    .option('--name <deviceName>', 'device name shown in the dashboard (default: hostname)')
    .option('--no-daemon', 'do not install the launchd agent')
    .option('--no-channel', 'do not register the Claude Code channel server')
    .option('--no-open', 'print the pairing URL without opening a browser')
    .option(
      '--timeout <minutes>',
      'how long to wait for browser approval, and for each account step',
      '10',
    )
    .option('--no-qr', 'print the phone-linking sms: link as text instead of a QR code')
    .option(
      '--open-messages',
      "open Messages on this Mac for the phone step (only correct if Messages sends from your account's phone number)",
    )
    .option('--wait <seconds>', 'how long to wait for the gateway handshake (0 to skip)', '20')
    .option('-f, --force', 're-pair even if this Mac is already paired')
    .action((opts: ConnectOptions) => runConnect(getCtx(), opts));
}
