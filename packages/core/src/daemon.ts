import { createHash, randomUUID } from 'node:crypto';
import type { DeviceEvent, EventPayload, Provider, SessionSummary } from '@pagr/protocol';
import { z } from 'zod';
import type { CodingAgentAdapter } from './adapters/types.js';
import type { FetchLike } from './attachments.js';
import { cleanupTmp } from './attachments.js';
import { CommandTracker, verifyIncoming } from './commandGuard.js';
import { SessionGuard } from './concurrency.js';
import { type BridgeConfig, readConfig, updateConfig } from './config.js';
import { acquireDaemonLock, DaemonAlreadyRunningError, type DaemonLock } from './daemonLock.js';
import { Dispatcher } from './dispatcher.js';
import { makeEvent } from './events.js';
import { type DeviceIdentity, loadOrCreateIdentity } from './identity.js';
import {
  type ChannelBridge,
  IpcMethodError,
  IpcServer,
  IpcSocketBusyError,
  registerChannelMethods,
} from './ipc.js';
import type { SecretStore } from './keychain.js';
import { type Logger, silentLogger } from './logging.js';
import { ensurePaths, type PagrPaths } from './paths.js';
import { ProjectError, ProjectRegistry } from './projects.js';
import { type ReconciledSession, reconcileSessions } from './reconcile.js';
import { ReplayCache } from './replay.js';
import {
  DEFAULT_MAX_SESSION_RECORDS,
  DEFAULT_SESSION_RETENTION_MS,
  type SessionRecord,
  SessionStore,
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
  backoff?: { baseMs?: number; maxMs?: number };
  tmpCleanupOlderThanMs?: number;
  /** How long terminal sessions stay in `sessions.json` (default one week). */
  sessionRetentionMs?: number;
  /** Hard ceiling on rows in `sessions.json` (default 500). */
  maxSessionRecords?: number;
  /** Environment for security checks (`PAGR_ENV`, `PAGR_ALLOW_INSECURE_WS`); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
  pendingApprovals: number;
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
  /** Null until paired (no deviceId / gatewayUrl). */
  readonly transport: GatewayClient | null;
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
  const sessions = new SessionStore(paths.sessionsFile, now);
  const replay = new ReplayCache({ file: paths.replayFile, now: () => now().getTime() });
  const commands = new CommandTracker();
  let serverKeys: Record<string, string> = { ...config.serverKeys };
  const startedAt = now().toISOString();

  let transport: GatewayClient | null = null;
  const emit = (event: DeviceEvent) => {
    if (transport) transport.sendEvent(event);
    else logger.debug('event (unpaired, dropped)', { type: event.type });
  };

  const dispatcher = new Dispatcher({
    deviceId: identity.deviceId ?? `dev_${'0'.repeat(32)}`,
    adapters: o.adapters,
    registry,
    sessions,
    emit,
    tmpDir: paths.tmpDir,
    bridgeVersion,
    policyFile: paths.policyFile,
    now,
    logger: logger.child({ mod: 'dispatcher' }),
    guard: SessionGuard.fromEnv(o.env ?? process.env),
    ...(o.fetch ? { fetch: o.fetch } : {}),
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
      ...(o.env ? { env: o.env } : {}),
      activeSessions: () => dispatcher.activeSessionCount(),
      logger: logger.child({ mod: 'transport' }),
      now,
      ...(o.WebSocketCtor ? { WebSocketCtor: o.WebSocketCtor } : {}),
      ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.backoff ? { backoff: o.backoff } : {}),
    });
    transport.on('connected', () => {
      logger.info('gateway connected');
      void dispatcher
        .probe()
        .then((hello) => emit(makeEvent(deviceId, 'device.hello', hello, { now })));
    });
    transport.on('disconnected', (reason) => logger.info('gateway disconnected', { reason }));
    transport.on('blocked', (min) =>
      logger.error('bridge too old; update required', { minBridgeVersion: min }),
    );
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
    pendingApprovals: dispatcher.approvals.list().length,
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
  ipc.registerMethod('approvals.list', () => dispatcher.approvals.list());
  ipc.registerMethod('approval.request', (params) => {
    const p = ApprovalRequestParams.parse(params);
    let projectId: string;
    if (p.projectId) {
      if (!registry.has(p.projectId)) throw new IpcMethodError('unknown_project', p.projectId);
      projectId = p.projectId;
    } else if (p.cwd) {
      const rec = registry.findByPath(p.cwd);
      if (!rec)
        throw new IpcMethodError('unknown_project', 'cwd is not inside a registered project');
      projectId = rec.projectId;
    } else {
      throw new IpcMethodError('invalid_params', 'projectId or cwd is required');
    }
    let sessionId: string;
    if (p.sessionId) sessionId = p.sessionId;
    else {
      // Interactive (hook) path: mint a stable local session so cloud approvals can be bound
      // and routed. Deterministic per provider session id so repeated prompts share it.
      sessionId = syntheticSessionId(p.provider, p.claudeSessionId ?? undefined);
      const existing = sessions.get(sessionId);
      const ts = now().toISOString();
      const rec = sessions.upsert({
        sessionId,
        provider: p.provider,
        projectId,
        providerSessionId: p.claudeSessionId ?? sessionId,
        status: 'waiting_for_approval',
        startedAt: existing?.startedAt ?? ts,
        updatedAt: ts,
      });
      emit(makeEvent(dispatcherDeviceId(), 'session.updated', interactive(rec), { now }));
    }
    return new Promise<{
      approvalId: string;
      decision: 'allow' | 'deny' | null;
      resolution: string;
    }>((resolve) => {
      const record = dispatcher.requestApproval({
        sessionId,
        projectId,
        provider: p.provider,
        providerRequestId: p.providerRequestId,
        actionType: p.actionType,
        preview: p.preview,
        ...(p.hints ? { hints: p.hints } : {}),
        ...(p.timeoutMs
          ? { expiresAt: new Date(now().getTime() + p.timeoutMs).toISOString() }
          : {}),
        onDecision: (decision, resolution) => {
          if (!p.sessionId) {
            const rec = sessions.setStatus(sessionId, 'idle');
            if (rec)
              emit(makeEvent(dispatcherDeviceId(), 'session.updated', interactive(rec), { now }));
          }
          resolve({ approvalId: record.approvalId, decision, resolution });
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
  const interactive = (rec: SessionRecord) => summaryOf(rec, 'Interactive session');
  ipc.registerMethod('agent.event', (params) => {
    const p = AgentEventParams.parse(params);
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
        // One stable local session per project for the user's own channel-attached Claude Code,
        // mirroring the hook path in `approval.request`.
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
    get transport() {
      return transport;
    },
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
      });
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
        });
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
      await dispatcher.shutdown();
      await transport?.stop();
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
  return daemon;
}

/** Convenience for the CLI: create + start, and stop on SIGINT/SIGTERM. */
export async function startDaemon(o: CreateDaemonOptions): Promise<Daemon> {
  const logger = o.logger ?? silentLogger;
  let d: Daemon;
  try {
    d = await createDaemon(o);
    await d.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('daemon failed to start', { message });
    // Another instance owns this home: let the caller (CLI) report it with its own exit code.
    if (err instanceof DaemonAlreadyRunningError) throw err;
    // Fail loudly: a daemon that cannot listen on its IPC socket is useless, and launchd would
    // otherwise keep restarting a silently broken process.
    process.stderr.write(`pagr daemon: failed to start: ${message}\n`);
    process.exit(1);
  }
  const onSignal = () => {
    void d.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return d;
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
