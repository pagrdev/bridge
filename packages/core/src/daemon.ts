import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  DeviceEvent,
  EventPayload,
  Provider,
  SessionStatus,
  SessionSummary,
} from '@pagr/protocol';
import { z } from 'zod';
import type { CodingAgentAdapter } from './adapters/types.js';
import { claudeApprovalOptions } from './approvalOptions.js';
import type { FetchLike } from './attachments.js';
import { cleanupTmp } from './attachments.js';
import {
  BackfillGuard,
  type BackfillSource,
  DEFAULT_BACKFILL_BYTES,
  type DiscoveredSession,
  MAX_HISTORY_DAYS,
  MAX_HISTORY_LIMIT,
  type ReplayFrame,
} from './backfill.js';
import { CommandTracker, verifyIncoming } from './commandGuard.js';
import { SessionGuard } from './concurrency.js';
import { type BridgeConfig, inspectConfig, readConfig, updateConfig } from './config.js';
import { acquireDaemonLock, DaemonAlreadyRunningError, type DaemonLock } from './daemonLock.js';
import type { LocalActionDetail } from './deviceFloor.js';
import {
  ADOPTED_SESSION_NAME,
  DispatchError,
  Dispatcher,
  type RemoteProjectPickStatus,
} from './dispatcher.js';
import { makeEvent } from './events.js';
import { type DeviceIdentity, InvalidDeviceKeyError, loadOrCreateIdentity } from './identity.js';
import {
  type ChannelBridge,
  IpcMethodError,
  IpcServer,
  IpcSocketBusyError,
  registerChannelMethods,
} from './ipc.js';
import {
  JOURNAL_MAX_TOTAL_BYTES,
  JOURNAL_RETENTION_DAYS,
  JournalStore,
  journalSessions,
  OutboxCursors,
} from './journal.js';
import { KeepAwake, type KeepAwakeSpawn, type KeepAwakeStatus } from './keepAwake.js';
import { type SecretStore, SecretStoreError } from './keychain.js';
import { DAEMON_EXIT } from './launchAgent.js';
import { type Logger, silentLogger } from './logging.js';
import {
  getMirrorBridge,
  type MirrorStatus,
  resetMirrorBridge,
  setMirrorBridge,
} from './mirrorBridge.js';
import { ensurePaths, PagrHomeError, type PagrPaths } from './paths.js';
import { nearestGitRoot, ProjectError, ProjectRegistry, projectIdFor } from './projects.js';
import { ASK_USER_QUESTION, askUserQuestionUpdatedInput, questionBodyFor } from './questions.js';
import { type ReconciledSession, reconcileSessions } from './reconcile.js';
import { ReplayCache } from './replay.js';
import {
  DEFAULT_ADOPTED_RETENTION_MS,
  DEFAULT_MAX_SESSION_RECORDS,
  DEFAULT_SESSION_RETENTION_MS,
  isAdopted,
  type SessionRecord,
  SessionStore,
  UNREGISTERED_PROJECT,
} from './sessions.js';
import { GatewayClient } from './transport.js';

export interface CreateDaemonOptions {
  home: string;
  adapters: Map<Provider, CodingAgentAdapter>;
  secretStore: SecretStore;
  logger?: Logger;
  /** Override the gateway URL stored in config.json. */
  gatewayUrl?: string;
  bridgeVersion?: string;
  now?: () => Date;
  fetch?: FetchLike;
  /** Test hooks. */
  WebSocketCtor?: ConstructorParameters<typeof GatewayClient>[0]['WebSocketCtor'];
  heartbeatMs?: number;
  backoff?: { baseMs?: number; maxMs?: number; rateLimitedMs?: number; replacedMs?: number };
  livenessTimeoutMs?: number;
  authTimeoutMs?: number;
  tmpCleanupOlderThanMs?: number;
  /** How long a session's frame journal is kept (default 30 days). */
  journalRetentionDays?: number;
  /** Ceiling on every journal together (default 2 GiB). */
  journalMaxTotalBytes?: number;
  /** How long terminal sessions stay in `sessions.json` (default one week). */
  sessionRetentionMs?: number;
  /** Hard ceiling on rows in `sessions.json` (default 500). */
  maxSessionRecords?: number;
  /** How long an adopted session survives without news. Defaults to `DEFAULT_ADOPTED_RETENTION_MS`. */
  adoptedRetentionMs?: number;
  /** Environment for security checks (`PAGR_ENV`, `PAGR_ALLOW_INSECURE_WS`); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * How keep-awake starts `caffeinate`. Injected so tests never run a real one; defaults to
   * `child_process.spawn`.
   */
  spawn?: KeepAwakeSpawn;
  /** How long the power assertion outlives the last piece of work. Default 60 s. */
  keepAwakeHysteresisMs?: number;
  /**
   * How the daemon ends its own process when it hits something only a human can fix. Defaults to
   * `process.exit`; tests pass a recorder. See `DAEMON_EXIT`.
   */
  exit?: (code: number) => void;
  /**
   * The history sources `session.list_history` and `session.backfill` read.
   *
   * Supplied from outside because reading them means knowing what a Claude transcript and a Codex
   * thread are, and the core package deliberately does not depend on either adapter package. The
   * CLI, which already constructs the adapters, builds this and hands it in; a daemon with none
   * still journals and streams exactly as before and answers both commands
   * `capability_unsupported`.
   */
  backfill?: DaemonBackfillOptions;
}

/** What the daemon is handed about reading history; the rest of the channel it wires itself. */
export interface DaemonBackfillOptions {
  /** `$HOME` holding `.claude`. Null turns the Claude transcript source off. */
  claudeHome?: string | null;
  sources?: BackfillSource[];
  replayTranscript?: (session: DiscoveredSession) => Promise<ReplayFrame[] | null>;
}

export interface DaemonStatus {
  bridgeVersion: string;
  paired: boolean;
  deviceId: string | undefined;
  userId: string | undefined;
  gatewayUrl: string | undefined;
  transport: string;
  bufferedEvents: number;
  projects: number;
  sessions: number;
  /**
   * How many of `sessions` the bridge did not start. Reported separately because what Pagr can do
   * with one differs: it can relay their approvals and say they exist, but it cannot send them an
   * instruction, stop them, or resume them.
   */
  adoptedSessions: number;
  /** Adopted sessions whose directory is in no registered project, so the cloud never sees them. */
  unregisteredSessions: number;
  pendingApprovals: number;
  /**
   * Whether this Mac is being held awake, and what for. Optional so a newer `pagr` CLI still
   * parses the status of an older daemon that has no keep-awake at all.
   */
  keepAwake?: KeepAwakeStatus;
  /**
   * The Claude transcript mirror: how many of your own sessions it is following, how many files
   * that is, and how long ago it last produced a frame. Optional so a newer `pagr` CLI still
   * parses the status of an older daemon that has no mirror at all.
   */
  mirror?: MirrorStatus;
  /** Whether a phone may list and add repositories, and how many handles are cached right now. */
  remoteProjectPick: RemoteProjectPickStatus;
  socketPath: string;
  pid: number;
  startedAt: string;
}

export interface Daemon {
  readonly paths: PagrPaths;
  readonly identity: DeviceIdentity;
  readonly config: BridgeConfig;
  readonly registry: ProjectRegistry;
  readonly sessions: SessionStore;
  readonly dispatcher: Dispatcher;
  readonly ipc: IpcServer;
  /**
   * The Mac's power assertion. Hold a reason on it (`questions`, `backfill`, …) for any work
   * that must not be interrupted by idle sleep; `sessions` and `approvals` are held for you.
   */
  readonly keepAwake: KeepAwake;
  /** Null until paired (no deviceId / gatewayUrl). */
  readonly transport: GatewayClient | null;
  /** The phones sealed frames are encrypted for: `kid` → base64url raw X25519 public key. */
  readonly recipientKeys: Record<string, string>;
  /** Pinned recipient key ids, sorted — `device.hello` v2 reports these as `recipientKeyIds`. */
  recipientKeyIds(): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DaemonStatus;
  /** Whether Claude Code live steering is enabled AND actually reachable right now. */
  channelStatus(): ChannelStatus;
  /**
   * Bring `sessions.json` back in line with reality. Called by `start()`; exposed so tests and
   * `pagr sessions --reconcile` can force it.
   */
  reconcile(): Promise<ReconciledSession[]>;
  /** Feed a raw command envelope (as the gateway would). Returns the ack event. */
  handleEnvelope(envelope: unknown): Promise<DeviceEvent>;
}

const ApprovalRequestParams = z.object({
  /**
   * Bridge-spawned sessions send their `ses_…` id. The Claude PermissionRequest hook, running
   * inside the user's OWN interactive `claude`, sends `null` plus `cwd` (+ `claudeSessionId`);
   * the daemon then maps `cwd` to a registered project and mints a synthetic local session.
   */
  sessionId: z.string().nullable(),
  projectId: z.string().optional(),
  cwd: z.string().nullable().optional(),
  claudeSessionId: z.string().nullable().optional(),
  provider: z.enum(['claude', 'codex']),
  providerRequestId: z.string().min(1).max(200),
  actionType: z.enum(['command_execution', 'file_change', 'permission', 'tool_use', 'other']),
  preview: z.string().max(1500),
  hints: z.record(z.boolean()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Claude's `permission_suggestions` for this prompt, forwarded verbatim by the hook. Only their
   * presence is read here — they are the rules an "allow always" would write, so without them
   * there is no such option to offer. They never leave this Mac.
   */
  permissionSuggestions: z.array(z.unknown()).max(50).optional(),
  /**
   * Which tool the prompt is about. Only `AskUserQuestion` changes anything here: it is a
   * question, not a permission decision, and answering it as one ends the turn with
   * "The user did not answer the questions." (spike MOB-044).
   */
  toolName: z.string().max(100).optional(),
  /**
   * `tool_input.questions`, forwarded by the hook for `AskUserQuestion` alone. Unparsed here —
   * `questionBodyFor` is the one thing that decides what a question is.
   */
  questions: z.array(z.unknown()).max(50).optional(),
});

const AgentEventParams = z.object({
  provider: z.enum(['claude', 'codex']),
  sessionId: z.string(),
  projectId: z.string(),
  type: z.enum([
    'started',
    'progress',
    'agent_message',
    'needs_input',
    'completed',
    'failed',
    'stopped',
    'queued_followup',
    'followup_delivered',
  ]),
  summary: z.string().max(2000),
  providerEventId: z.string().optional(),
});

const ProjectAddParams = z.object({
  path: z.string().min(1),
  displayName: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  allowNonGit: z.boolean().optional(),
});

/** Reported by `pagr status` / `pagr doctor` so users can see the live-steering truth. */
export interface ChannelStatus {
  /** `PAGR_CLAUDE_CHANNEL=1`: the daemon registered the channel IPC methods. */
  enabled: boolean;
  /** Project roots with a channel server actually polling right now. */
  attachedProjects: string[];
  /** True only when at least one project can be steered live this second. */
  canSteerLive: boolean;
}

/** Stable `ses_…` id for a provider session the bridge did not spawn (hook path). */
export function syntheticSessionId(provider: Provider, providerSessionId?: string): string {
  const seed = providerSessionId ?? randomUUID();
  return `ses_${createHash('sha256').update(`${provider}:${seed}`).digest('hex').slice(0, 32)}`;
}

/**
 * Wire identity → transport → command guard → dispatcher → IPC. The daemon holds no cloud
 * secrets: only the device private key (in the secret store) and the pinned server keys.
 */
export async function createDaemon(o: CreateDaemonOptions): Promise<Daemon> {
  const logger = o.logger ?? silentLogger;
  const now = o.now ?? (() => new Date());
  const bridgeVersion = o.bridgeVersion ?? '0.1.0';
  const paths = ensurePaths(o.home);
  const config = readConfig(paths.configFile);
  const gatewayUrl = o.gatewayUrl ?? config.gatewayUrl;
  const identity = await loadOrCreateIdentity(
    o.secretStore,
    config.deviceId ? { deviceId: config.deviceId } : {},
  );
  const registry = new ProjectRegistry({ file: paths.projectsFile, pagrHome: paths.home });
  /**
   * Keep the Mac awake while Pagr has live work. Reference-counted by reason, so the three the
   * daemon owns (`sessions`, `approvals`, `questions`) are restated from the truth after every
   * change rather than paired hold-for-release across every path that can end a session — and any
   * later source of work (`backfill`) holds its own reason through `daemon.keepAwake`.
   */
  const keepAwake = new KeepAwake({
    env: o.env ?? process.env,
    logger: logger.child({ mod: 'keep-awake' }),
    clock: now,
    ...(o.spawn ? { spawn: o.spawn } : {}),
    ...(o.keepAwakeHysteresisMs !== undefined ? { hysteresisMs: o.keepAwakeHysteresisMs } : {}),
  });
  // Assigned once the dispatcher exists; the session store is built first and may fire before.
  let syncKeepAwake = (): void => {};
  const sessions = new SessionStore(paths.sessionsFile, now, () => syncKeepAwake());
  // Transcript frames, on this Mac, in full. The cloud only ever sees sealed, capped copies.
  const journal = new JournalStore({
    dir: paths.journalDir,
    now,
    logger: logger.child({ mod: 'journal' }),
  });
  const outbox = new OutboxCursors({
    file: paths.outboxFile,
    logger: logger.child({ mod: 'journal' }),
  });
  const replay = new ReplayCache({ file: paths.replayFile, now: () => now().getTime() });
  const commands = new CommandTracker();
  let serverKeys: Record<string, string> = { ...config.serverKeys };
  let recipientKeys: Record<string, string> = { ...config.recipientKeys };
  const startedAt = now().toISOString();
  const exitProcess = o.exit ?? ((code: number) => process.exit(code));

  let daemonRef: Daemon | null = null;
  let ending = false;
  /**
   * End the process for something only a human can fix. `DAEMON_EXIT.unrecoverable` is the half
   * of the launchd contract this side owns: the launch agent restarts the daemon on exit 0 and on
   * a crash signal, and refuses to restart it after any non-zero exit, so this must never be used
   * for something that might come right on its own (see `DAEMON_EXIT`).
   */
  const fatal = (reason: string): void => {
    if (ending) return;
    ending = true;
    process.stderr.write(`pagr daemon: ${reason}\n`);
    void Promise.resolve(daemonRef?.stop())
      .catch(() => {})
      .finally(() => exitProcess(DAEMON_EXIT.unrecoverable));
  };

  /**
   * Age and size retention for the journals, on the same hourly tick as everything else. A
   * session whose journal has gone also loses its cursors: keeping a `{sent, acked}` row for a
   * transcript that no longer exists would leave a resume asking for frames nobody has.
   */
  const pruneJournal = (): void => {
    try {
      const result = journal.prune({
        days: o.journalRetentionDays ?? JOURNAL_RETENTION_DAYS,
        maxTotalBytes: o.journalMaxTotalBytes ?? JOURNAL_MAX_TOTAL_BYTES,
      });
      for (const sessionId of result.removed) outbox.forget(sessionId);
    } catch (err) {
      logger.warn('could not prune the session journals', { error: String(err) });
    }
  };

  let transport: GatewayClient | null = null;
  /** Last status the Claude transcript mirror published; null until one runs in this process. */
  let mirror: MirrorStatus | null = null;
  const mirrorStatus = (): MirrorStatus | null => mirror ?? getMirrorBridge().status();
  const emit = (event: DeviceEvent) => {
    if (transport) transport.sendEvent(event);
    else logger.debug('event (unpaired, dropped)', { type: event.type });
  };

  /** One slot for every backfill on this Mac: a phone's and `pagr sessions backfill` alike. */
  const backfillGuard = new BackfillGuard();
  const dispatcher = new Dispatcher({
    deviceId: identity.deviceId ?? `dev_${'0'.repeat(32)}`,
    adapters: o.adapters,
    registry,
    sessions,
    emit,
    tmpDir: paths.tmpDir,
    bridgeVersion,
    policyFile: paths.policyFile,
    devicePolicyFile: paths.devicePolicyFile,
    env: o.env ?? process.env,
    now,
    logger: logger.child({ mod: 'dispatcher' }),
    guard: SessionGuard.fromEnv(o.env ?? process.env),
    // The live set, not a snapshot: the transport repins it from `auth.result` / `keys.updated`,
    // and it is built after the dispatcher, so this reads through to whatever is current.
    recipientKeyIds: () => transport?.recipientKeyIds() ?? Object.keys(recipientKeys).sort(),
    frames: {
      journal,
      cursors: outbox,
      // Read through to the live set, like `recipientKeyIds` above: a phone paired mid-session
      // must be able to read the rest of that session.
      recipientKeys: () => transport?.recipientKeys ?? recipientKeys,
      protocolVersion: () => transport?.negotiatedVersion ?? 1,
      imessageLinked: () => transport?.features?.imessage ?? false,
    },
    backfill: {
      // The same answer the transcript mirror gets, so a backfilled session lands in the same
      // project — and is refused for the same unregistered directory.
      projectFor: (cwd) => getMirrorBridge().projectFor(cwd),
      /**
       * Hold the Mac awake for the whole backfill. Replaying a long transcript and sealing a few
       * thousand frames takes longer than the idle timer, and a Mac that sleeps halfway through
       * leaves the phone with a partial answer and no signal that anything is coming.
       */
      hold: (reason) => {
        keepAwake.hold(reason);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          keepAwake.release(reason);
        };
      },
      guard: backfillGuard,
      ...(o.backfill?.claudeHome !== undefined ? { claudeHome: o.backfill.claudeHome } : {}),
      ...(o.backfill?.sources ? { sources: o.backfill.sources } : {}),
      ...(o.backfill?.replayTranscript ? { replayTranscript: o.backfill.replayTranscript } : {}),
    },
    onApprovalsChange: () => syncKeepAwake(),
    onQuestionsChange: () => syncKeepAwake(),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  /**
   * Restate both derived reasons from the truth. Idempotent, so it is safe to call from every
   * change hook — and it cannot drift the way a hold/release pair spread across the dispatcher,
   * the reconciler, the hook path and the pruner would.
   */
  syncKeepAwake = () => {
    keepAwake.setCount('sessions', dispatcher.activeSessionCount());
    keepAwake.setCount('approvals', dispatcher.approvals.list().length);
    // A blocked agent waiting on a question is work in progress exactly as an approval is: the
    // child process is idling on a control request and nothing moves until somebody answers.
    keepAwake.setCount('questions', dispatcher.questions.list().length);
  };
  syncKeepAwake();
  if (dispatcher.floor.lifted.length > 0)
    logger.warn('device approval floor partially lifted by local policy', {
      lifted: dispatcher.floor.lifted.join(','),
    });

  /**
   * The transcript mirror's one question, answered by the registry: which project is this
   * directory, and may the phone be told about it?
   *
   * The adapter asks; the answer is built here, where the device salt and the handle cache live.
   * A registered directory comes back with the project's own id. An unregistered one comes back
   * with the id its NEAREST GIT ROOT would get — so a terminal three folders deep inside a
   * repository is reported under the repository, not under a different id per subdirectory — plus
   * a `rh_…` handle, which is what turns "Pagr does not know this folder" into one tap.
   *
   * `ProjectRegistry.ensure` is never called from here. Registering a folder because somebody ran
   * `claude` in it would add projects nobody asked for; the handle exists precisely so the person
   * decides.
   */
  setMirrorBridge({
    wired: true,
    projectFor: (cwd) => {
      const rec = registry.findByPath(cwd);
      if (rec)
        return {
          projectId: rec.projectId,
          path: rec.path,
          displayName: rec.displayName,
          status: 'registered' as const,
        };
      const root = nearestGitRoot(cwd, { home: registry.homeDirectory }) ?? cwd;
      const handle = dispatcher.offerRepoHandle(root);
      return {
        projectId: projectIdFor(root, registry.deviceSalt()),
        path: root,
        displayName: basename(root) || root,
        status: 'unregistered' as const,
        ...(handle ? { handle } : {}),
      };
    },
    report: (s) => {
      mirror = s;
    },
    status: () => mirror,
  });

  const handleEnvelope = async (envelope: unknown): Promise<DeviceEvent> => {
    const deviceId = identity.deviceId;
    if (!deviceId) throw new Error('daemon is not paired');
    const verdict = verifyIncoming(envelope, {
      deviceId,
      trustedServerKeys: serverKeys,
      now,
      replay,
      commands,
      registry,
      sessions,
    });
    if (!verdict.ok) {
      logger.warn('command rejected', { errorCode: verdict.errorCode, message: verdict.message });
      const ack = makeEvent(
        deviceId,
        'command.ack',
        {
          commandId: verdict.commandId ?? `cmd_${'0'.repeat(32)}`,
          status: 'rejected',
          errorCode: verdict.errorCode,
          message: verdict.message,
        },
        { now, ...(verdict.commandId ? { inReplyTo: verdict.commandId } : {}) },
      );
      emit(ack);
      // The guard records a command as in-flight before the local-existence checks, so a rejection
      // from those must settle it too — otherwise a resend would wait on it forever.
      if (verdict.commandId) commands.settle(verdict.commandId, ack);
      return ack;
    }
    if (verdict.duplicate) {
      // The gateway resends an envelope it has had no ack for (after ~30 s). Answer with the
      // terminal ack of the ONE execution — waiting for it if it is still running — so a command
      // slower than the resend window is reported by its real outcome, never as a replay.
      logger.info('duplicate command', {
        commandId: verdict.body.commandId,
        inFlight: verdict.inFlight,
      });
      const original = await verdict.ack;
      const dup = makeEvent(
        deviceId,
        'command.ack',
        original.payload as EventPayload<'command.ack'>,
        { now, inReplyTo: verdict.body.commandId },
      );
      emit(dup);
      return dup;
    }
    let ack: DeviceEvent;
    try {
      ack = await dispatcher.handle(verdict.body);
    } catch (err) {
      // `dispatcher.handle` answers every command itself; this only runs if it threw anyway, and
      // exists so a duplicate awaiting this command can never hang.
      ack = makeEvent(
        deviceId,
        'command.ack',
        {
          commandId: verdict.body.commandId,
          status: 'failed',
          errorCode: 'provider_error',
          message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
        { now, inReplyTo: verdict.body.commandId },
      );
      emit(ack);
    }
    commands.settle(verdict.body.commandId, ack);
    return ack;
  };

  if (identity.deviceId && gatewayUrl) {
    const deviceId = identity.deviceId;
    transport = new GatewayClient({
      url: gatewayUrl,
      identity: { ...identity, deviceId, sign: identity.sign },
      bridgeVersion,
      onCommand: (envelope) => void handleEnvelope(envelope),
      serverKeys,
      onServerKeys: (keys) => {
        serverKeys = keys;
        updateConfig(paths.configFile, { serverKeys: keys });
      },
      recipientKeys,
      onRecipientKeys: (keys) => {
        recipientKeys = keys;
        updateConfig(paths.configFile, {
          recipientKeys: keys,
          recipientKeysUpdatedAt: now().toISOString(),
        });
        logger.info('recipient keys pinned', { keys: Object.keys(keys).sort() });
      },
      ...(o.env ? { env: o.env } : {}),
      activeSessions: () => dispatcher.activeSessionCount(),
      // The gateway learns what this Mac is before it is handed any transcript, and the frames it
      // never acked go out before the events buffered while the socket was down.
      onReady: async () => {
        const hello = await dispatcher.probe();
        emit(makeEvent(deviceId, 'device.hello', hello, { now }));
      },
      resume: {
        pending: () => dispatcher.pendingFrames(),
        noteSent: (sessionId, seq) => dispatcher.noteFrameSent(sessionId, seq),
        ack: (cursors) => outbox.ack(cursors),
      },
      logger: logger.child({ mod: 'transport' }),
      now,
      ...(o.WebSocketCtor ? { WebSocketCtor: o.WebSocketCtor } : {}),
      ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.livenessTimeoutMs ? { livenessTimeoutMs: o.livenessTimeoutMs } : {}),
      ...(o.authTimeoutMs ? { authTimeoutMs: o.authTimeoutMs } : {}),
      ...(o.backoff ? { backoff: o.backoff } : {}),
    });
    transport.on('connected', () => logger.info('gateway connected'));
    transport.on('disconnected', (reason) => logger.info('gateway disconnected', { reason }));
    // A refusal of this identity is not a network problem: say which it is, in words, once. The
    // transport has already stopped reconnecting for the fatal kind and keeps retrying the
    // transient kind (a per-IP rate limit is shared by every bridge behind one office NAT).
    transport.on('auth_failed', (_code, failure) => {
      if (failure.fatal) {
        logger.error('gateway refused this device; the daemon will not reconnect', {
          error: failure.code,
          fix: failure.reason,
        });
        fatal(`the gateway refused this device (${failure.code}): ${failure.reason}`);
      } else {
        logger.warn('gateway refused the handshake for now; retrying', {
          error: failure.code,
          detail: failure.reason,
        });
      }
    });
    transport.on('replaced', (retryInMs) =>
      logger.error('another machine is using this device identity', {
        retryInMs,
        fix: 'run `pagr connect` on the Mac that should own this pairing, or `pagr logout` on the other one',
      }),
    );
    transport.on('blocked', (min) => {
      logger.error('bridge too old; update required', { minBridgeVersion: min });
      fatal(`this bridge is older than the gateway's minimum (${min}); update the pagr CLI`);
    });
  }

  const ipc = new IpcServer({ socketPath: paths.socketPath, logger: logger.child({ mod: 'ipc' }) });
  const status = (): DaemonStatus => ({
    bridgeVersion,
    paired: Boolean(identity.deviceId && gatewayUrl),
    deviceId: identity.deviceId,
    userId: config.userId,
    gatewayUrl,
    transport: transport?.state ?? 'unpaired',
    bufferedEvents: transport?.bufferedCount ?? 0,
    projects: registry.list().length,
    sessions: sessions.list().length,
    adoptedSessions: sessions.list().filter(isAdopted).length,
    unregisteredSessions: sessions.list().filter((r) => r.projectId === UNREGISTERED_PROJECT)
      .length,
    pendingApprovals: dispatcher.approvals.list().length,
    keepAwake: keepAwake.status(),
    ...(mirrorStatus() ? { mirror: mirrorStatus() as MirrorStatus } : {}),
    remoteProjectPick: dispatcher.remoteProjectPick(),
    socketPath: paths.socketPath,
    pid: process.pid,
    startedAt,
  });

  ipc.registerMethod('status', () => status());
  ipc.registerMethod('projects.list', () => registry.list());
  ipc.registerMethod('projects.add', (params) => {
    const p = ProjectAddParams.parse(params);
    try {
      const rec = registry.add(p.path, {
        ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
        ...(p.aliases ? { aliases: p.aliases } : {}),
        ...(p.allowNonGit !== undefined ? { allowNonGit: p.allowNonGit } : {}),
      });
      emit(
        makeEvent(
          dispatcherDeviceId(),
          'project.registered',
          registry.summaries().find((s) => s.projectId === rec.projectId) ?? {
            projectId: rec.projectId,
            displayName: rec.displayName,
            aliases: rec.aliases,
          },
          { now },
        ),
      );
      return rec;
    } catch (err) {
      if (err instanceof ProjectError) throw new IpcMethodError(err.code, err.message);
      throw err;
    }
  });
  ipc.registerMethod('projects.remove', (params) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(params);
    const ok = registry.remove(projectId);
    if (!ok) throw new IpcMethodError('unknown_project', projectId);
    emit(makeEvent(dispatcherDeviceId(), 'project.removed', { projectId }, { now }));
    return { projectId };
  });
  ipc.registerMethod('sessions.list', () => sessions.list());
  ipc.registerMethod('sessions.reconcile', async () =>
    (await daemon.reconcile()).map((c) => ({
      sessionId: c.record.sessionId,
      provider: c.record.provider,
      projectId: c.record.projectId,
      status: c.record.status,
      outcome: c.outcome,
      reason: c.reason,
    })),
  );
  /**
   * `pagr sessions` needs three things `sessions.json` does not hold: how much journal a session
   * has, how far the gateway is behind on it, and whether it is one Pagr may drive. All three are
   * on disk already; this joins them so the CLI does not have to know the journal's layout.
   */
  ipc.registerMethod('sessions.journal', () => {
    outbox.flush();
    journal.flushAll();
    const out: Record<
      string,
      { lastSeq: number; bytes: number; sent: number; acked: number; updatedAt: string }
    > = {};
    for (const stat of journalSessions(paths.journalDir, paths.outboxFile)) {
      let lastSeq = 0;
      try {
        lastSeq = journal.lastSeq(stat.sessionId);
      } catch {
        // An unreadable journal reports zero rather than failing the whole listing.
      }
      out[stat.sessionId] = {
        lastSeq,
        bytes: stat.bytes,
        sent: stat.sent,
        acked: stat.acked,
        updatedAt: stat.updatedAt,
      };
    }
    return out;
  });
  /**
   * Age and size retention, on demand. It deletes journals — `~/.pagr/journal/*` — and NOTHING
   * else: a transcript under `~/.claude` is Claude Code's own file and Pagr never removes one.
   */
  ipc.registerMethod('sessions.purge', (params) => {
    const p = z.object({ days: z.number().int().min(0).max(3650).optional() }).parse(params ?? {});
    const result = journal.prune({
      days: p.days ?? o.journalRetentionDays ?? JOURNAL_RETENTION_DAYS,
      maxTotalBytes: o.journalMaxTotalBytes ?? JOURNAL_MAX_TOTAL_BYTES,
    });
    for (const sessionId of result.removed) outbox.forget(sessionId);
    return result;
  });
  /** The same code path a phone's `session.backfill` takes, so it can be tested without one. */
  ipc.registerMethod('sessions.backfill', async (params) => {
    const p = z
      .object({
        sessionId: z.string().min(1),
        fromSeq: z.number().int().nonnegative().optional(),
        toSeq: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .parse(params);
    try {
      return await dispatcher.runBackfill({
        sessionId: p.sessionId,
        fromSeq: p.fromSeq ?? 1,
        ...(p.toSeq !== undefined ? { toSeq: p.toSeq } : {}),
        maxBytes: p.maxBytes ?? DEFAULT_BACKFILL_BYTES,
      });
    } catch (err) {
      if (err instanceof DispatchError) throw new IpcMethodError(err.code, err.message);
      throw err;
    }
  });
  ipc.registerMethod('sessions.history', async (params) => {
    const p = z
      .object({
        provider: z.enum(['claude', 'codex']).optional(),
        projectId: z.string().min(1).optional(),
        sinceDays: z.number().int().min(1).max(MAX_HISTORY_DAYS).optional(),
        limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
      })
      .parse(params ?? {});
    return dispatcher.listHistory({
      ...(p.provider ? { provider: p.provider } : {}),
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...(p.sinceDays !== undefined ? { sinceDays: p.sinceDays } : {}),
      ...(p.limit !== undefined ? { limit: p.limit } : {}),
    });
  });
  ipc.registerMethod('approvals.list', () => dispatcher.approvals.list());
  /**
   * Record a provider session the bridge did not start, so that it exists as far as this Mac is
   * concerned: which agent, which directory, which provider session id, and when we first saw it.
   *
   * `projectId` may be `UNREGISTERED_PROJECT`. That is not a failure — somebody really is running
   * `claude` in that directory — it only means the cloud cannot be told about it, because a
   * `SessionSummary` has to name a `proj_…` id. Such a session is listed locally (`pagr sessions`,
   * `pagr status`) with the directory, so the fix (`pagr projects add <dir>`) is obvious.
   */
  function adoptSession(p: {
    provider: Provider;
    projectId: string;
    providerSessionId: string | null;
    cwd: string | null;
    status: SessionStatus;
  }): SessionRecord {
    const sessionId = syntheticSessionId(p.provider, p.providerSessionId ?? undefined);
    const existing = sessions.get(sessionId);
    const ts = now().toISOString();
    const rec = sessions.upsert({
      sessionId,
      provider: p.provider,
      projectId: p.projectId,
      providerSessionId: p.providerSessionId ?? sessionId,
      status: p.status,
      adopted: true,
      adoptedAt: existing?.adoptedAt ?? ts,
      ...(p.cwd ? { cwd: p.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}),
      startedAt: existing?.startedAt ?? ts,
      updatedAt: ts,
    });
    if (!existing)
      logger.info('adopted a session this bridge did not start', {
        sessionId,
        provider: p.provider,
        project: p.projectId === UNREGISTERED_PROJECT ? 'none' : p.projectId,
      });
    return rec;
  }

  ipc.registerMethod('approval.request', (params) => {
    const p = ApprovalRequestParams.parse(params);
    let projectId: string;
    if (p.projectId) {
      if (!registry.has(p.projectId)) throw new IpcMethodError('unknown_project', p.projectId);
      projectId = p.projectId;
    } else if (p.cwd) {
      const rec = registry.findByPath(p.cwd);
      if (!rec) {
        // No project contains this directory, so the prompt cannot be relayed — the cloud has no
        // id to route it to. The session is still adopted, and the hook is told "no decision", so
        // the prompt in their terminal behaves exactly as it does with Pagr uninstalled.
        if (!p.sessionId)
          adoptSession({
            provider: p.provider,
            projectId: UNREGISTERED_PROJECT,
            providerSessionId: p.claudeSessionId ?? null,
            cwd: p.cwd,
            status: 'idle',
          });
        throw new IpcMethodError(
          'unknown_project',
          `cwd is not inside a registered project; run \`pagr projects add ${p.cwd}\` to relay its prompts`,
        );
      }
      projectId = rec.projectId;
    } else {
      throw new IpcMethodError('invalid_params', 'projectId or cwd is required');
    }
    let sessionId: string;
    if (p.sessionId) sessionId = p.sessionId;
    else {
      // Interactive (hook) path: mint a stable local session so cloud approvals can be bound
      // and routed. Deterministic per provider session id so repeated prompts share it.
      const rec = adoptSession({
        provider: p.provider,
        projectId,
        providerSessionId: p.claudeSessionId ?? null,
        cwd: p.cwd ?? null,
        status: 'waiting_for_approval',
      });
      sessionId = rec.sessionId;
      emit(makeEvent(dispatcherDeviceId(), 'session.updated', interactive(rec), { now }));
    }
    /** Put the synthetic session back to idle once the prompt is done with (hook path only). */
    const releaseInteractive = () => {
      if (p.sessionId) return;
      const rec = sessions.setStatus(sessionId, 'idle');
      if (rec) emit(makeEvent(dispatcherDeviceId(), 'session.updated', interactive(rec), { now }));
    };

    // `AskUserQuestion` comes through this same IPC method — the PermissionRequest hook fires for
    // it like any other tool — but it is a question, and answering it with a bare allow is the
    // bug MOB-036 exists to fix. The hook is told to return `updatedInput`, which is the same
    // encoding the bridge-spawned path writes on the control response.
    const asked =
      p.toolName === ASK_USER_QUESTION ? questionBodyFor({ questions: p.questions }) : null;
    if (asked && asked.questions.length > 0) {
      return new Promise<{
        approvalId: string;
        decision: 'allow' | 'deny' | null;
        resolution: string;
        updatedInput?: Record<string, unknown>;
      }>((resolve) => {
        const record = dispatcher.requestQuestion({
          sessionId,
          projectId,
          provider: p.provider,
          providerRequestId: p.providerRequestId,
          questions: asked.questions,
          answerable: true,
          secret: asked.questions.map(() => false),
          providerRecordId: p.providerRequestId,
          meta: { source: 'stdio' },
          ...(p.timeoutMs
            ? { expiresAt: new Date(now().getTime() + p.timeoutMs).toISOString() }
            : {}),
          onAnswer: (answers, resolution) => {
            releaseInteractive();
            // No answer means no decision: the hook prints nothing and the prompt in the user's
            // own terminal behaves exactly as it does with Pagr uninstalled.
            resolve({
              approvalId: record.questionId,
              decision: answers ? 'allow' : null,
              resolution,
              ...(answers
                ? {
                    updatedInput: askUserQuestionUpdatedInput(
                      { questions: p.questions },
                      asked.questions,
                      answers,
                    ),
                  }
                : {}),
            });
          },
        });
      });
    }

    // The hook relays a prompt from the person's own `claude`, so it gets the same options a
    // bridge-spawned session would: "allow always" exactly when Claude offered rules to persist.
    const options =
      p.provider === 'claude'
        ? claudeApprovalOptions((p.permissionSuggestions?.length ?? 0) > 0, o.env ?? process.env)
        : [];
    return new Promise<{
      approvalId: string;
      decision: 'allow' | 'deny' | null;
      resolution: string;
      optionId?: string;
    }>((resolve) => {
      const record = dispatcher.requestApproval({
        sessionId,
        projectId,
        provider: p.provider,
        providerRequestId: p.providerRequestId,
        actionType: p.actionType,
        preview: p.preview,
        ...(options.length > 0 ? { options } : {}),
        ...(p.hints ? { hints: p.hints } : {}),
        // The hook sends a project-relative preview and its cwd; that plus the registered project
        // root is what the device floor gets to classify on this path. It is less than the
        // bridge-spawned path has (no raw argv), which is why the hook also computes hints.
        local: localDetail(projectId, p.cwd ?? undefined),
        ...(p.timeoutMs
          ? { expiresAt: new Date(now().getTime() + p.timeoutMs).toISOString() }
          : {}),
        onDecision: (decision, resolution, _source, outcome) => {
          releaseInteractive();
          // The hook is the one that answers Claude here, so it is told which option won: an
          // `allow_always` is the difference between allowing the call and writing a rule.
          resolve({
            approvalId: record.approvalId,
            decision,
            resolution,
            ...(outcome?.optionId ? { optionId: outcome.optionId } : {}),
          });
        },
      });
    });
  });

  function summaryOf(rec: SessionRecord, displayName?: string): SessionSummary {
    return {
      sessionId: rec.sessionId,
      projectId: rec.projectId,
      provider: rec.provider,
      status: rec.status,
      activeTurn: rec.status === 'waiting_for_approval',
      startedAt: rec.startedAt,
      updatedAt: rec.updatedAt,
      ...(displayName ? { displayName } : {}),
    };
  }
  /** Adopted sessions carry one label everywhere, so the phone can tell them from Pagr's own. */
  const interactive = (rec: SessionRecord) => summaryOf(rec, ADOPTED_SESSION_NAME);
  /**
   * Local helpers (the Claude hook, the channel server) push progress for sessions the daemon is
   * already tracking. The socket is uid-checked, so this is a same-user boundary, not a trust
   * boundary — but shape validation alone let any process running as you fabricate events on the
   * user's phone about sessions that do not exist. An event must name a session this daemon owns,
   * and must agree with that record about which provider and project it belongs to.
   */
  ipc.registerMethod('agent.event', (params) => {
    const p = AgentEventParams.parse(params);
    const rec = sessions.get(p.sessionId);
    if (!rec) throw new IpcMethodError('unknown_session', p.sessionId);
    if (rec.provider !== p.provider)
      throw new IpcMethodError(
        'invalid_params',
        `session ${p.sessionId} is not a ${p.provider} session`,
      );
    if (rec.projectId !== p.projectId)
      throw new IpcMethodError(
        'invalid_params',
        `session ${p.sessionId} belongs to another project`,
      );
    emit(
      makeEvent(
        dispatcherDeviceId(),
        'session.event',
        {
          sessionId: p.sessionId,
          projectId: p.projectId,
          provider: p.provider,
          kind: p.type,
          summary: p.summary,
          ...(p.providerEventId ? { providerEventId: p.providerEventId } : {}),
          at: now().toISOString(),
        },
        { now },
      ),
    );
    return { ok: true };
  });

  function dispatcherDeviceId(): string {
    return identity.deviceId ?? `dev_${'0'.repeat(32)}`;
  }

  /** What the device floor gets to judge a hook-relayed approval on. Never leaves this Mac. */
  function localDetail(projectId: string, cwd?: string): LocalActionDetail {
    let projectPath: string | undefined;
    try {
      projectPath = registry.resolve(projectId).path;
    } catch {
      projectPath = undefined; // unregistered between the lookup above and here
    }
    return { ...(cwd ? { cwd } : {}), ...(projectPath ? { projectPath } : {}) };
  }

  // --- Claude Code Channel (ADR 0001 `approved-channel`, research preview) -------------------
  // Additive and flag-gated: without PAGR_CLAUDE_CHANNEL=1 these methods are never registered
  // and the daemon behaves exactly as before. See integrations/claude-channel/README.md.
  const channelEnv = o.env ?? process.env;
  const channelEnabled = channelEnv.PAGR_CLAUDE_CHANNEL === '1';
  let channelBridge: ChannelBridge | null = null;
  const channelStatus = (): ChannelStatus => {
    const attachedProjects = channelBridge?.attachedProjects() ?? [];
    return { enabled: channelEnabled, attachedProjects, canSteerLive: attachedProjects.length > 0 };
  };
  // Always answerable, so `pagr doctor` can say "the channel is off" instead of "unknown".
  ipc.registerMethod('channel.status', () => channelStatus());
  if (channelEnabled) {
    channelBridge = registerChannelMethods(ipc, {
      resolveProject: (cwd) => {
        const rec = registry.findByPath(cwd);
        return rec ? { projectId: rec.projectId, path: rec.path } : null;
      },
      claudeSessionsIn: (projectId) =>
        sessions
          .list()
          .filter((s) => s.provider === 'claude' && s.projectId === projectId)
          .map((s) => s.sessionId),
      ensureSession: ({ projectId, sessionId }) => {
        if (sessionId && sessions.has(sessionId)) return sessionId;
        // One stable local session per project for the user's own channel-attached Claude Code.
        //
        // Deliberately NOT `adopted`, even though the bridge did not spawn this one either.
        // `adopted` is read as "approvals only" — the cloud refuses to steer or stop such a
        // session, and so does `Dispatcher.assertOurSession`. A channel-attached session is the
        // one exception: the channel exists precisely so it CAN be steered, so marking it would
        // ship a limit that is not true. If the channel ever detaches, what is left is a session
        // nothing can steer, which is what its `idle` status already says.
        const id = sessionId ?? syntheticSessionId('claude', `channel:${projectId}`);
        const existing = sessions.get(id);
        const ts = now().toISOString();
        const rec = sessions.upsert({
          sessionId: id,
          provider: 'claude',
          projectId,
          providerSessionId: existing?.providerSessionId ?? id,
          // `idle`, not `working`: nothing ever moves this synthetic session off a live status,
          // and a permanently "live" record would hold the project's working tree against every
          // future cloud session (see concurrency.ts). The same choice the approval-hook path
          // makes once a decision comes back.
          status: existing?.status ?? 'idle',
          startedAt: existing?.startedAt ?? ts,
          updatedAt: ts,
        });
        if (!existing)
          emit(makeEvent(dispatcherDeviceId(), 'session.updated', interactive(rec), { now }));
        return id;
      },
      emitAgentMessage: ({ sessionId, projectId, text }) => {
        emit(
          makeEvent(
            dispatcherDeviceId(),
            'session.event',
            {
              sessionId,
              projectId,
              provider: 'claude',
              kind: 'agent_message',
              summary: text.slice(0, 2000),
              at: now().toISOString(),
            },
            { now },
          ),
        );
      },
    });
    logger.warn('Claude Code channel IPC enabled (research preview; dev flag only)');
  }

  let cleanupTimer: NodeJS.Timeout | null = null;

  let lock: DaemonLock | null = null;
  const daemon: Daemon = {
    paths,
    identity,
    config,
    registry,
    sessions,
    dispatcher,
    ipc,
    keepAwake,
    get transport() {
      return transport;
    },
    get recipientKeys() {
      return { ...recipientKeys };
    },
    recipientKeyIds: () => Object.keys(recipientKeys).sort(),
    async start() {
      // Single instance per PAGR_HOME: take the pid lock, then bind the socket. Either step
      // finding a live daemon means we must not proceed (two daemons would share one device
      // identity and flap the gateway).
      lock = acquireDaemonLock({ lockPath: paths.lockFile, home: o.home });
      try {
        await ipc.listen();
      } catch (err) {
        lock.release();
        lock = null;
        if (err instanceof IpcSocketBusyError) throw new DaemonAlreadyRunningError(o.home, err.pid);
        throw err;
      }
      cleanupTmp(paths.tmpDir, o.tmpCleanupOlderThanMs ?? 24 * 3600_000, now);
      // Bound the file before anything else reads it, so a store that grew while the daemon was
      // down does not stay oversized until the first hourly tick.
      sessions.prune({
        retentionMs: o.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS,
        maxEntries: o.maxSessionRecords ?? DEFAULT_MAX_SESSION_RECORDS,
        adoptedRetentionMs: o.adoptedRetentionMs ?? DEFAULT_ADOPTED_RETENTION_MS,
      });
      pruneJournal();
      // No process outlived the daemon, so nothing in the store may still claim to be working.
      await daemon.reconcile();
      cleanupTimer = setInterval(() => {
        cleanupTmp(paths.tmpDir, o.tmpCleanupOlderThanMs ?? 24 * 3600_000, now);
        // Backstop for attachments whose turn never reported an end (see AttachmentLeaseRegistry).
        dispatcher.sweepAttachmentLeases();
        // Completed sessions must stay resumable well past 24h; only very old terminal ones go.
        sessions.prune({
          retentionMs: o.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS,
          maxEntries: o.maxSessionRecords ?? DEFAULT_MAX_SESSION_RECORDS,
          adoptedRetentionMs: o.adoptedRetentionMs ?? DEFAULT_ADOPTED_RETENTION_MS,
        });
        pruneJournal();
      }, 3600_000);
      cleanupTimer.unref();
      if (transport) transport.start();
      else logger.warn('not paired: run `pagr connect`; IPC available, gateway idle');
      logger.info('daemon started', {
        bridgeVersion,
        socketPath: paths.socketPath,
        paired: Boolean(transport),
      });
    },
    async stop() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      // Before the dispatcher, so the assertion goes even if an adapter shutdown hangs or throws.
      keepAwake.dispose();
      await dispatcher.shutdown();
      // What is on disk is the transcript, and the cursors describe it: both settled before the
      // socket goes, so a restart resumes from the truth rather than from a half-written file.
      journal.closeAll();
      outbox.flush();
      await transport?.stop();
      // The mirror's bridge is process-wide; a daemon that has stopped must not keep answering
      // "which project is this?" out of a registry it no longer owns.
      resetMirrorBridge();
      await ipc.close(); // unlinks the socket only if this instance bound it
      lock?.release(); // unlinks the lock only if it still records our pid
      lock = null;
      logger.info('daemon stopped');
    },
    status,
    channelStatus,
    handleEnvelope,
    async reconcile() {
      const changed = await reconcileSessions({
        sessions,
        adapters: o.adapters,
        logger: logger.child({ mod: 'reconcile' }),
        onChange: (c) => {
          emit(makeEvent(dispatcherDeviceId(), 'session.updated', summaryOf(c.record), { now }));
          emit(
            makeEvent(
              dispatcherDeviceId(),
              'session.event',
              {
                sessionId: c.record.sessionId,
                projectId: c.record.projectId,
                provider: c.record.provider,
                kind: c.outcome === 'failed' ? 'failed' : 'stopped',
                summary: c.reason,
                at: now().toISOString(),
              },
              { now },
            ),
          );
        },
      });
      return changed;
    },
  };
  daemonRef = daemon;
  return daemon;
}

export interface StartDaemonOptions extends CreateDaemonOptions {
  /** Backoff for transient start failures. Default 5 s doubling to 60 s. */
  startRetry?: { baseMs?: number; maxMs?: number; maxAttempts?: number };
  /** Test seam for the retry sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** A start failure and what the launchd contract should do about it. */
export interface StartFailure {
  /** True when a restart cannot help: it needs a person. */
  unrecoverable: boolean;
  /** One line naming the fix, written to stderr (i.e. `launchd.err.log`). */
  reason: string;
}

/**
 * Classify a start failure for the launchd contract (`DAEMON_EXIT`).
 *
 * Unrecoverable means "no amount of restarting fixes this": a Keychain that is locked, denied or
 * missing entirely (each retry can raise its own dialog at login), a device key that will not
 * parse, a `PAGR_HOME` that cannot be written. Everything else — a full disk, an I/O blip, an
 * adapter that was not up yet, a gateway that is unreachable because the daemon booted before the
 * network — is transient and is retried inside this process instead of being handed to launchd.
 */
export function classifyStartFailure(err: unknown): StartFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SecretStoreError) {
    const unrecoverable =
      err.code === 'locked' || err.code === 'denied' || err.code === 'unavailable';
    return {
      unrecoverable,
      reason: unrecoverable
        ? `${message}${err.hint ? ` — ${err.hint}` : ' — unlock the login Keychain and run `pagr daemon install` again'}`
        : message,
    };
  }
  if (err instanceof InvalidDeviceKeyError)
    return { unrecoverable: true, reason: `${message}${err.hint ? ` — ${err.hint}` : ''}` };
  if (err instanceof PagrHomeError) {
    // A full disk or a transient I/O error can come right; a path this user cannot write cannot.
    const unrecoverable = err.code !== 'no_space' && err.code !== 'io';
    return { unrecoverable, reason: `${message}${err.hint ? ` — ${err.hint}` : ''}` };
  }
  return { unrecoverable: false, reason: message };
}

const startDelay = (attempt: number, base: number, max: number): number =>
  Math.min(max, base * 2 ** attempt);

/**
 * Convenience for the CLI (and the entry point launchd runs): create + start, and stop on
 * SIGINT/SIGTERM.
 *
 * Exit-code contract, the other half of the launch agent's `KeepAlive` (see `DAEMON_EXIT`):
 * exit 0 is a clean or self-requested stop and gets restarted after the throttle; exit
 * `DAEMON_EXIT.unrecoverable` (78) means a person has to do something and launchd leaves it
 * alone; and a transient failure exits with nothing at all — the process stays up and keeps
 * retrying, because a daemon that merely started before the network did must not be killed off
 * permanently (BR-11).
 */
export async function startDaemon(o: StartDaemonOptions): Promise<Daemon> {
  const logger = o.logger ?? silentLogger;
  const exitProcess = o.exit ?? ((code: number) => process.exit(code));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const baseMs = o.startRetry?.baseMs ?? 5_000;
  const maxMs = o.startRetry?.maxMs ?? 60_000;
  const maxAttempts = o.startRetry?.maxAttempts ?? Number.POSITIVE_INFINITY;

  const refuse = (reason: string): never => {
    logger.error('daemon cannot start', { reason });
    process.stderr.write(`pagr daemon: ${reason}\n`);
    exitProcess(DAEMON_EXIT.unrecoverable);
    throw new DaemonStartRefused(reason);
  };

  // Read the pairing before anything is created: "not paired" and "config.json is unreadable"
  // both look like an idle daemon at runtime, and launchd would restart that shape forever.
  // A home that cannot be prepared at all falls through to the loop, which classifies it.
  try {
    const paths = ensurePaths(o.home);
    const inspected = inspectConfig(paths.configFile);
    if (inspected.problem) refuse(`${inspected.problem.message} — ${inspected.problem.hint}`);
    if (!inspected.config.deviceId || !(o.gatewayUrl ?? inspected.config.gatewayUrl))
      refuse('this Mac is not paired with a Pagr account — run `pagr connect`');
  } catch (err) {
    if (err instanceof DaemonStartRefused) throw err;
    const failure = classifyStartFailure(err);
    if (failure.unrecoverable) refuse(`failed to start: ${failure.reason}`);
  }

  for (let attempt = 0; ; attempt++) {
    let d: Daemon | null = null;
    try {
      d = await createDaemon(o);
      await d.start();
      const started = d;
      const onSignal = () => {
        void started.stop().finally(() => exitProcess(DAEMON_EXIT.ok));
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      return started;
    } catch (err) {
      // A partially started daemon still holds the pid lock and the socket; releasing them is
      // what makes the next attempt a retry rather than a self-inflicted "already running".
      await d?.stop().catch(() => {});
      // Another instance genuinely owns this home. The CLI reports it with its own (non-zero,
      // so never restarted) exit code, and a second daemon must not retry into the first one.
      if (err instanceof DaemonAlreadyRunningError) throw err;
      const failure = classifyStartFailure(err);
      if (failure.unrecoverable) refuse(`failed to start: ${failure.reason}`);
      if (attempt + 1 >= maxAttempts) throw err;
      const delayMs = startDelay(attempt, baseMs, maxMs);
      logger.warn('daemon failed to start; retrying in this process', {
        reason: failure.reason,
        delayMs,
        attempt: attempt + 1,
      });
      await sleep(delayMs);
    }
  }
}

/** Thrown after the exit seam declined to end the process (tests only). */
export class DaemonStartRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DaemonStartRefused';
  }
}

export {
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  LAUNCHCTL,
  LaunchAgentError,
  type LaunchAgentErrorCode,
  type LaunchAgentOptions,
  launchAgentPlistPath,
  launchAgentStaleReason,
  readPlistFacts,
  renderPlist,
  uninstallLaunchAgent,
} from './launchAgent.js';
