import type { DeviceEvent, Provider } from '@pagr/protocol';
import { z } from 'zod';
import type { CodingAgentAdapter } from './adapters/types.js';
import type { FetchLike } from './attachments.js';
import { cleanupTmp } from './attachments.js';
import { IdempotencyCache, verifyIncoming } from './commandGuard.js';
import { type BridgeConfig, readConfig, updateConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { makeEvent } from './events.js';
import { type DeviceIdentity, loadOrCreateIdentity } from './identity.js';
import { IpcMethodError, IpcServer } from './ipc.js';
import type { SecretStore } from './keychain.js';
import { type Logger, silentLogger } from './logging.js';
import { ensurePaths, type PagrPaths } from './paths.js';
import { ProjectError, ProjectRegistry } from './projects.js';
import { ReplayCache } from './replay.js';
import { SessionStore } from './sessions.js';
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
  sessionId: z.string(),
  projectId: z.string(),
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
      onServerKeys: (keys) => {
        serverKeys = keys;
        updateConfig(paths.configFile, { serverKeys: keys });
      },
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
    if (!registry.has(p.projectId)) throw new IpcMethodError('unknown_project', p.projectId);
    return new Promise<{
      approvalId: string;
      decision: 'allow' | 'deny' | null;
      resolution: string;
    }>((resolve) => {
      const record = dispatcher.requestApproval({
        sessionId: p.sessionId,
        projectId: p.projectId,
        provider: p.provider,
        providerRequestId: p.providerRequestId,
        actionType: p.actionType,
        preview: p.preview,
        ...(p.hints ? { hints: p.hints } : {}),
        ...(p.timeoutMs
          ? { expiresAt: new Date(now().getTime() + p.timeoutMs).toISOString() }
          : {}),
        onDecision: (decision, resolution) =>
          resolve({ approvalId: record.approvalId, decision, resolution }),
      });
    });
  });
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

  let cleanupTimer: NodeJS.Timeout | null = null;
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
      await ipc.listen();
      cleanupTmp(paths.tmpDir, o.tmpCleanupOlderThanMs ?? 24 * 3600_000, now);
      cleanupTimer = setInterval(
        () => cleanupTmp(paths.tmpDir, o.tmpCleanupOlderThanMs ?? 24 * 3600_000, now),
        3600_000,
      );
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
      await ipc.close();
      logger.info('daemon stopped');
    },
    status,
    handleEnvelope,
  };
  return daemon;
}

/** Convenience for the CLI: create + start, and stop on SIGINT/SIGTERM. */
export async function startDaemon(o: CreateDaemonOptions): Promise<Daemon> {
  const d = await createDaemon(o);
  await d.start();
  const onSignal = () => {
    void d.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return d;
}

export {
  installLaunchAgent,
  launchAgentPlistPath,
  renderPlist,
  uninstallLaunchAgent,
} from './launchAgent.js';
