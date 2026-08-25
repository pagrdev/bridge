import { createHash, randomUUID } from 'node:crypto';
import type { DeviceEvent, Provider, SessionSummary } from '@pagr/protocol';
import { z } from 'zod';
import type { CodingAgentAdapter } from './adapters/types.js';
import type { FetchLike } from './attachments.js';
import { cleanupTmp } from './attachments.js';
import { IdempotencyCache, verifyIncoming } from './commandGuard.js';
import { type BridgeConfig, readConfig, updateConfig } from './config.js';
import { acquireDaemonLock, DaemonAlreadyRunningError, type DaemonLock } from './daemonLock.js';
import { Dispatcher } from './dispatcher.js';
import { makeEvent } from './events.js';
import { type DeviceIdentity, loadOrCreateIdentity } from './identity.js';
import { IpcMethodError, IpcServer, IpcSocketBusyError, registerChannelMethods } from './ipc.js';
import type { SecretStore } from './keychain.js';
import { type Logger, silentLogger } from './logging.js';
import { ensurePaths, type PagrPaths } from './paths.js';
import { ProjectError, ProjectRegistry } from './projects.js';
import { ReplayCache } from './replay.js';
import { type SessionRecord, SessionStore } from './sessions.js';
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

const SESSION_RETENTION_MS = 7 * 24 * 3600_000;

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
  const idempotency = new IdempotencyCache();
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
      idempotency,
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
      return ack;
    }
    if (verdict.duplicate) {
      const dup = makeEvent(
        deviceId,
        'command.ack',
        { ...(verdict.cachedAck.payload as { commandId: string }), status: 'duplicate' },
        { now, inReplyTo: verdict.body.commandId },
      );
      emit(dup);
      return dup;
    }
    const ack = await dispatcher.handle(verdict.body);
    idempotency.set(verdict.body.idempotencyKey, ack);
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
      emit(makeEvent(dispatcherDeviceId(), 'session.updated', summaryOf(rec), { now }));
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
              emit(makeEvent(dispatcherDeviceId(), 'session.updated', summaryOf(rec), { now }));
          }
          resolve({ approvalId: record.approvalId, decision, resolution });
        },
      });
    });
  });

  function summaryOf(rec: SessionRecord): SessionSummary {
    return {
      sessionId: rec.sessionId,
      projectId: rec.projectId,
      provider: rec.provider,
      status: rec.status,
      activeTurn: rec.status === 'waiting_for_approval',
      startedAt: rec.startedAt,
      updatedAt: rec.updatedAt,
      displayName: 'Interactive session',
    };
  }
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
  if (channelEnv.PAGR_CLAUDE_CHANNEL === '1') {
    registerChannelMethods(ipc, {
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
          status: existing?.status ?? 'working',
          startedAt: existing?.startedAt ?? ts,
          updatedAt: ts,
        });
        if (!existing)
          emit(makeEvent(dispatcherDeviceId(), 'session.updated', summaryOf(rec), { now }));
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
      cleanupTimer = setInterval(() => {
        cleanupTmp(paths.tmpDir, o.tmpCleanupOlderThanMs ?? 24 * 3600_000, now);
        // Completed sessions must stay resumable well past 24h; only very old terminal ones go.
        sessions.pruneTerminal(SESSION_RETENTION_MS);
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
    handleEnvelope,
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
