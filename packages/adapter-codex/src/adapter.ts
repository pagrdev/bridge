import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterEvent,
  AgentConnectionStatus,
  CodingAgentAdapter,
  FrameQuestion,
  LocalActionDetail,
  RunOnceError,
  RunOnceInput,
  RunOnceResult,
  SendInstructionInput,
  SessionSummary,
  SessionSummaryV2,
  StartSessionInput,
} from '@pagr/bridge-core';
import {
  newRunId,
  runOnceFrameMeta,
  runOnceSessionId,
  syntheticSessionId,
  UNREGISTERED_PROJECT,
} from '@pagr/bridge-core';
import type { ApprovalOption } from '@pagr/protocol';
import { AppServerClient, type AppServerTransportSpec } from './app-server.js';
import {
  commandApprovalOptions,
  decisionForOption,
  fileChangeApprovalOptions,
  permissionsApprovalOptions,
  scopeForOption,
} from './approvals.js';
import {
  codexHomeDir,
  controlSocketPath,
  controlSocketPresent,
  DAEMON_PROBE_TIMEOUT_MS,
} from './daemon.js';
import { clip, type Hints, hintsForCommand, hintsForFiles, relativizePaths } from './heuristics.js';
import { DeltaCoalescer, framesForItem, framesForTurns, type MappedFrame } from './items.js';
import { FileLogger } from './logger.js';
import { type MirroredThread, TerminalThreadMirror } from './mirror.js';
import {
  type AgentMessageDeltaNotification,
  type ApprovalDecision,
  type CommandExecutionOutputDeltaNotification,
  type CommandExecutionRequestApprovalParams,
  type ErrorNotification,
  type FileChangeRequestApprovalParams,
  type GetAccountResponse,
  type ItemCompletedNotification,
  METHODS,
  NOTIFICATIONS,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type ReasoningTextDeltaNotification,
  type RpcId,
  type RpcNotification,
  type RpcRequest,
  SERVER_REQUESTS,
  type ThreadReadResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadStatus,
  type ThreadStatusChangedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type TurnStartResponse,
  type TurnSteerResponse,
  type UserInput,
} from './protocol.js';
import { runOnceThreadParams, runOnceTurnParams } from './run-once.js';
import { type PersistedSession, SessionMap } from './session-map.js';

export interface CodexAdapterOptions {
  /** PAGR_HOME; state + logs live here. */
  home: string;
  /** Base command for the Codex CLI, default `['codex']`. Tests pass `['node', fixture]`. */
  codexCommand?: string[];
  approvalTimeoutMs?: number;
  requestTimeoutMs?: number;
  bridgeVersion?: string;
  /** Base restart delay after an unexpected app-server exit; doubles each attempt. */
  restartDelayMs?: number;
  /** Ceiling for the restart backoff. */
  maxRestartDelayMs?: number;
  /** Consecutive automatic restarts before the adapter gives up until the next command. */
  maxRestartAttempts?: number;
  /** How long an app-server must stay up to count as healthy and clear the backoff. */
  healthyUptimeMs?: number;
  /** Extra environment for the spawned app-server (tests; `CODEX_HOME` isolation). */
  env?: NodeJS.ProcessEnv;
  /** Where `codex login` keeps its credentials. Default `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  /** How long a `codex --version` answer is reused before forking again. 0 disables caching. */
  versionCacheMs?: number;
  /** Idle time before the shared app-server is stopped. 0 keeps it up forever. */
  idleShutdownMs?: number;
  /** Disable file logging (tests). */
  log?: boolean;

  // ---- shared daemon (B9) ----

  /** Attach to the user's shared app-server daemon when its control socket is there. Default on. */
  attachDaemon?: boolean;
  /** Control socket path. Defaults to `<codexHome>/app-server-control/app-server-control.sock`. */
  controlSocketPath?: string;
  /** Mirror terminal threads hosted by the daemon. Default on whenever attached. */
  mirror?: boolean;
  /**
   * Which registered project a directory belongs to. Without it every mirrored thread is
   * `projectStatus: 'unregistered'` — known locally, never described to the cloud, because a
   * `SessionSummary` has to name a `proj_…` id.
   */
  resolveProject?: (cwd: string) => { projectId: string; projectPath: string } | null;
  /** Emit transcript frames. Off in tests that only care about session events. */
  frames?: boolean;
  /** Budget for the daemon's `initialize` before we fall back to a child. */
  daemonProbeTimeoutMs?: number;
  discoveryIntervalMs?: number;
  readPollIntervalMs?: number;
  idleUnsubscribeMs?: number;
  streamFlushMs?: number;
  streamFlushBytes?: number;
}

interface LiveSession {
  summary: SessionSummaryV2;
  threadId: string;
  projectPath: string;
  readOnly: boolean;
  activeTurnId: string | null;
  /** Thread has been started/resumed in the CURRENT app-server process. */
  loaded: boolean;
  agentBuffers: Map<string, string>;
  lastAgentMessage: string;
  queued: Array<{ instruction: string; images: string[] }>;
  /**
   * Turns the notification stream has already reported on before the `turn/start` response
   * promise was resolved. Both travel on one stdout stream, so a whole fast turn — start,
   * approval request, completion — can be parsed out of a single chunk while resolving the
   * response is still a queued microtask.
   */
  observedTurnIds: Set<string>;
  /**
   * This thread belongs to somebody else's terminal. Pagr streams it and may relay its approvals;
   * it never starts a turn, never steers, never answers a question and never stops it.
   */
  mirror?: boolean;
  /** `commandExecution` item id → the command line, so an output chunk is self-describing. */
  commands?: Map<string, string>;
}

/** Enough to cover a coalesced chunk; the set is per session and pruned on every insert. */
const OBSERVED_TURN_MEMORY = 32;

interface PendingApproval {
  approvalId: string;
  rpcId: RpcId;
  sessionId: string;
  providerRequestId: string;
  kind: 'command' | 'file' | 'permissions';
  timer: NodeJS.Timeout;
  requested: PermissionsRequestApprovalParams['permissions'] | null;
  /**
   * The request belongs to a thread we only mirror. Every subscriber received the same request
   * id and the first answer wins (MOB-043 finding 5), so the bridge writes an answer ONLY when
   * the phone chose one — never on a timeout, a cancel or a shutdown.
   */
  mirror?: boolean;
}

/** One `item/tool/requestUserInput` waiting for an answer. */
interface PendingQuestion {
  rpcId: RpcId;
  sessionId: string;
  threadId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  answerable: boolean;
}

export const newApprovalId = (): string => `apr_${randomUUID().replace(/-/g, '')}`;

/** A mirrored thread's status, from the only thing a mirror gets to see. */
export function mirrorStatus(status: ThreadStatus | undefined): SessionSummary['status'] {
  if (status?.type !== 'active') return 'idle';
  if (status.activeFlags.includes('waitingOnApproval')) return 'waiting_for_approval';
  if (status.activeFlags.includes('waitingOnUserInput')) return 'waiting_for_user';
  return 'working';
}
const now = () => new Date().toISOString();

const TERMINAL = new Set<SessionSummary['status']>(['completed', 'failed', 'stopped']);

/**
 * How a session with no live thread is reported. A finished session keeps the status it finished
 * with: `listSessions` used to hard-code `idle` for every remembered session, and since the cloud
 * upserts what a `device.hello` carries, every reconnect resurrected completed, failed and
 * stopped sessions as resumable on the user's phone (BR-4). Anything non-terminal has no thread
 * loaded after a restart, so it is reported as `idle` — resumable, which is true.
 */
export function persistedSummary(sessionId: string, p: PersistedSession): SessionSummary {
  const recorded = p.lastStatus as SessionSummary['status'];
  return {
    sessionId,
    projectId: p.projectId,
    provider: 'codex',
    status: TERMINAL.has(recorded) ? recorded : 'idle',
    activeTurn: false,
    startedAt: p.startedAt,
    updatedAt: p.updatedAt,
    ...(p.displayName ? { displayName: p.displayName } : {}),
  };
}

const CAPABILITIES = {
  canStartSession: true,
  canResumeSession: true,
  canSteerActiveTurn: true,
  canReceiveLiveExternalMessages: false,
  canRelayApprovals: true,
  canStop: true,
  canAttachImages: true,
  canListSessions: true,
} as const;

const INSTALL_HINT = 'Install Codex: npm i -g @openai/codex, then run `codex login`';

/** Said out loud rather than silently ignored: a mirrored thread is somebody else's to drive. */
export const MIRROR_READ_ONLY =
  'this Codex thread belongs to a terminal session; Pagr mirrors it and relays its approvals, but cannot steer or stop it';

/** How long `codex --version` is trusted before forking again. */
const VERSION_CACHE_MS = 5 * 60_000;

/** "Codex is not installed" is cached for much less: installing it should be noticed quickly. */
const MISSING_CACHE_MS = 30_000;

/**
 * How long the shared `codex app-server` may sit with nothing to do before it is stopped. The
 * next command starts a fresh one and `ensureLoaded` resumes the thread, so the only cost of
 * being wrong is one spawn.
 */
const IDLE_SHUTDOWN_MS = 5 * 60_000;

/**
 * One in-flight `runOnce`, keyed by its thread.
 *
 * Deliberately NOT a `LiveSession` and deliberately not in `this.sessions`: a run is not
 * something anyone can steer, stop, resume or be offered (`core/src/adapters/runOnce.ts`). This
 * is the whole of what the adapter remembers about one, and it is forgotten the moment the run
 * resolves.
 */
interface RunState {
  runId: string;
  /** The `ses_…` its frames are mirrored under. Never announced, never listed. */
  sessionId: string;
  projectId: string | undefined;
  threadId: string;
  turnId: string | null;
  /** What the agent said, in order. */
  said: string[];
  /**
   * The outcome a stop THIS bridge asked for is going to settle as, set the moment it starts.
   *
   * Interrupting a turn makes the server answer the turn `interrupted` and makes its own
   * `turn/start` fail, and both of those arrive before the interrupt request resolves. Without
   * this, whichever landed first settled the run — so a timeout or a cancel was reported as
   * "the turn was interrupted" or "Codex could not be started", depending on the machine.
   *
   * Why it is *claimed* rather than checked at those two sites: they are not the only messages
   * the stop shakes loose. The turn can complete normally in the same instant the interrupt
   * lands (`turn/completed {status:'completed'}`), the server can emit a non-retryable `error`,
   * and the app-server can exit outright and take `failRuns` with it. Every one of those is a
   * `settle` inside the window between the claim and `stop()` resuming, so `settle` — not each
   * caller — is where the claim is enforced.
   */
  stopping: 'timeout' | 'canceled' | null;
  /** Resolves the run exactly once. */
  settle: (outcome: RunOnceResult['outcome'], error?: RunOnceError) => void;
}

/**
 * Codex adapter over the local `codex app-server` (stdio JSON-RPC). One app-server process is
 * shared by all sessions; each cloud session maps to one Codex thread.
 */
export class CodexAdapter implements CodingAgentAdapter {
  readonly provider = 'codex' as const;
  private readonly logger: FileLogger;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly byThread = new Map<string, string>();
  /** In-flight headless runs, by thread id. Never sessions; see `RunState`. */
  private readonly runs = new Map<string, RunState>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly map: SessionMap;
  private client: AppServerClient | null = null;
  /** In-flight spawn. Without this, two concurrent sessions each start their own app-server. */
  private starting: Promise<AppServerClient> | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  /** When the current app-server finished its handshake; null while none is up. */
  private startedAtMs: number | null = null;
  /** Memoised `codex --version`, so a gateway reconnect storm does not fork per connect. */
  private versionCache: { value: string | null; atMs: number } | null = null;
  /** Armed whenever the app-server has nothing left to do. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Terminal threads hosted by the shared daemon. Null while we run our own child. */
  private mirror: TerminalThreadMirror | null = null;
  /** Deltas → streaming frames. One per adapter; keyed internally by item. */
  private readonly coalescer: DeltaCoalescer;
  private readonly questions = new Map<string, PendingQuestion>();

  constructor(private readonly opts: CodexAdapterOptions) {
    this.logger = new FileLogger(
      opts.log === false ? null : path.join(opts.home, 'logs', 'codex.log'),
    );
    this.map = new SessionMap(path.join(opts.home, 'codex-sessions.json'));
    this.coalescer = new DeltaCoalescer({
      emit: (frame, owner) => this.onStreamFrame(owner, frame),
      ...(opts.streamFlushMs !== undefined ? { flushMs: opts.streamFlushMs } : {}),
      ...(opts.streamFlushBytes !== undefined ? { flushBytes: opts.streamFlushBytes } : {}),
    });
  }

  /** The socket the shared daemon would be listening on, whether or not it is. */
  private controlSocket(): string {
    if (this.opts.controlSocketPath) return this.opts.controlSocketPath;
    const home =
      this.opts.codexHome ??
      this.opts.env?.CODEX_HOME ??
      codexHomeDir(this.opts.env ?? process.env);
    return controlSocketPath(home);
  }

  // ---------- public API ----------

  subscribe(emit: (e: AdapterEvent) => void): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  /** One `codex app-server` serves every Codex session; this says whether it is up. */
  get appServerRunning(): boolean {
    return this.client?.running === true;
  }

  /**
   * Cheap and side-effect free, because the daemon probes on EVERY gateway connect. It used to
   * call `ensureClient()`, so any Mac with `codex` on its PATH carried a permanent extra
   * `codex app-server` process from the first connect onwards, and every reconnect re-forked
   * `codex --version`. Now: the version is memoised, auth is read off disk, and the app-server
   * is consulted only when a session already has one running.
   */
  async probe(): Promise<AgentConnectionStatus> {
    const version = await this.codexVersion();
    if (!version) {
      return {
        provider: 'codex',
        mode: 'disabled',
        installed: false,
        authStatus: 'unknown',
        capabilities: { ...CAPABILITIES, canStartSession: false, canResumeSession: false },
        detail: INSTALL_HINT,
      };
    }
    const auth = await this.authStatus();
    const status: AgentConnectionStatus = {
      provider: 'codex',
      // Before anything is connected this is still just "the app server": which of the two links
      // we would get is not known until we try, and probe() never connects.
      mode: this.client?.running ? this.client.mode : 'app-server',
      installed: true,
      providerVersion: version,
      authStatus: auth.authStatus,
      capabilities: { ...CAPABILITIES },
    };
    if (auth.detail) status.detail = auth.detail;
    return status;
  }

  /** `codex login` writes `$CODEX_HOME/auth.json` (default `~/.codex`). */
  private codexAuthFile(): string {
    const home =
      this.opts.codexHome ??
      this.opts.env?.CODEX_HOME ??
      process.env.CODEX_HOME ??
      path.join(os.homedir(), '.codex');
    return path.join(home, 'auth.json');
  }

  /**
   * Authoritative when an app-server is already up (one RPC, no new process); inferred from
   * `auth.json` / `OPENAI_API_KEY` otherwise. Never starts anything.
   */
  private async authStatus(): Promise<{
    authStatus: AgentConnectionStatus['authStatus'];
    detail?: string;
  }> {
    if (this.client?.running) {
      try {
        const acct = await this.client.request<GetAccountResponse>(METHODS.accountRead, {});
        if (acct.account) return { authStatus: 'authenticated' };
        if (acct.requiresOpenaiAuth)
          return { authStatus: 'unauthenticated', detail: 'Run `codex login` to sign in to Codex' };
        return { authStatus: 'unknown' };
      } catch (err) {
        return { authStatus: 'unknown', detail: `Codex app-server: ${(err as Error).message}` };
      }
    }
    const file = this.codexAuthFile();
    if (existsSync(file)) return { authStatus: 'authenticated' };
    const key = this.opts.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    if (key) return { authStatus: 'authenticated' };
    return {
      authStatus: 'unauthenticated',
      detail: `No Codex credentials at ${file} — run \`codex login\``,
    };
  }

  async listSessions(): Promise<SessionSummaryV2[]> {
    // Bound what we remember before anyone copies it into a `device.hello` (BR-3).
    this.map.prune({ protect: new Set(this.sessions.keys()) });
    const out = new Map<string, SessionSummaryV2>();
    for (const [sid, p] of this.map.entries()) out.set(sid, persistedSummary(sid, p));
    for (const [sid, s] of this.sessions) {
      // A mirrored thread in an unregistered directory has no `proj_…` id to be described by,
      // so it stays local: it is listed by `pagr sessions`, never by `device.hello`.
      if (s.mirror && !s.summary.projectId) continue;
      out.set(sid, s.summary);
    }
    return [...out.values()];
  }

  async getStatus(sessionId: string): Promise<SessionSummaryV2 | null> {
    const live = this.sessions.get(sessionId);
    if (live) return live.summary;
    const p = this.map.get(sessionId);
    if (!p) return null;
    return persistedSummary(sessionId, p);
  }

  async startSession(input: StartSessionInput): Promise<SessionSummaryV2> {
    const client = await this.ensureClient();
    const params: ThreadStartParams = {
      cwd: input.project.path,
      approvalPolicy: 'on-request',
      sandbox: input.readOnly ? 'read-only' : 'workspace-write',
    };
    const res = await client.request<ThreadStartResponse>(METHODS.threadStart, params);
    const threadId = res.thread.id;
    const ts = now();
    const summary: SessionSummary = {
      sessionId: input.sessionId,
      projectId: input.project.projectId,
      provider: 'codex',
      status: 'starting',
      activeTurn: false,
      startedAt: ts,
      updatedAt: ts,
      taskSummary: clip(input.instruction, 500),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    };
    const live: LiveSession = {
      summary,
      threadId,
      projectPath: input.project.path,
      readOnly: input.readOnly,
      activeTurnId: null,
      loaded: true,
      agentBuffers: new Map(),
      lastAgentMessage: '',
      queued: [],
      observedTurnIds: new Set(),
    };
    this.sessions.set(input.sessionId, live);
    this.byThread.set(threadId, input.sessionId);
    this.map.set(input.sessionId, {
      threadId,
      projectId: input.project.projectId,
      projectPath: input.project.path,
      readOnly: input.readOnly,
      startedAt: ts,
      updatedAt: ts,
      lastStatus: 'starting',
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    // No `starting` event before the first turn is accepted: the daemon writes every session
    // event straight into its store, and a start that then throws would leave a permanently
    // "live" record holding this working tree and a slot in the session budget. `startTurn`
    // emits `working` on success, which is the first thing the daemon should hear about.
    try {
      await this.startTurn(live, input.instruction, input.localImagePaths);
    } catch (err) {
      this.sessions.delete(input.sessionId);
      this.byThread.delete(threadId);
      this.map.remove(input.sessionId);
      throw err;
    }
    return live.summary;
  }

  /**
   * One bounded headless run: `thread/start`, one turn, wait for `turn/completed` (spec §3, §5).
   *
   * Its own thread, every time. Never a live session's — a handoff prompt injected into the
   * thread somebody is talking to would land in their transcript as if they had asked for it,
   * and Codex's writer lock means we would be fighting whoever owns it anyway.
   *
   * The thread is never registered: not in `this.sessions`, not in `this.byThread`, not in the
   * session map. `listSessions` cannot see it, `sendInstruction` and `stopSession` cannot reach
   * it, no `session` event is emitted for it, and `ownsThread` claims it only so the terminal
   * mirror does not adopt it as somebody's TUI thread.
   */
  async runOnce(input: RunOnceInput): Promise<RunOnceResult> {
    const runId = input.runId ?? newRunId();
    const sessionId = runOnceSessionId('codex', runId);
    const startedMs = Date.now();
    const failed = (
      message: string,
      code: RunOnceError['code'] = 'start_failed',
    ): RunOnceResult => ({
      runId,
      sessionId,
      outcome: 'failed',
      output: '',
      error: { code, message: clip(message, 300) },
      durationMs: Date.now() - startedMs,
    });
    if (this.shuttingDown) return failed('adapter is shut down');

    let client: AppServerClient;
    try {
      client = await this.ensureClient();
    } catch (err) {
      return failed((err as Error).message);
    }

    const params = runOnceThreadParams(input);
    this.logger.log('info', 'starting a one-shot codex run', {
      runId,
      repo: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    let threadId: string;
    try {
      const res = await client.request<ThreadStartResponse>(METHODS.threadStart, params);
      threadId = res.thread.id;
    } catch (err) {
      return failed(`thread/start failed: ${(err as Error).message}`);
    }

    const said: string[] = [];
    let settleRun: ((r: RunOnceResult) => void) | null = null;
    const finished = new Promise<RunOnceResult>((resolve) => {
      settleRun = resolve;
    });
    const run: RunState = {
      runId,
      sessionId,
      projectId: input.projectId,
      threadId,
      turnId: null,
      said,
      stopping: null,
      settle: (outcome, error) => {
        const resolve = settleRun;
        if (!resolve) return;
        settleRun = null;
        // A run we decided to stop reports that decision, never the noise the decision itself
        // produced on the way down. See `RunState.stopping`.
        const decided = run.stopping ?? outcome;
        const reported = run.stopping ? undefined : error;
        this.runs.delete(threadId);
        this.logger.log('info', 'one-shot codex run finished', {
          runId,
          outcome: decided,
          ...(decided === outcome ? {} : { instead: outcome }),
          durationMs: Date.now() - startedMs,
        });
        this.runFrame(run, {
          body: {
            kind: 'system',
            subtype: `run_once_${decided}`,
            text: runOutcomeText(decided, reported),
          },
          meta: runOnceFrameMeta(runId, 'app_server'),
          endsTurn: true,
        });
        resolve({
          runId,
          sessionId,
          outcome: decided,
          output: said.join('\n\n'),
          ...(reported ? { error: reported } : {}),
          durationMs: Date.now() - startedMs,
        });
      },
    };
    // Registered BEFORE the turn starts: on a fast server `turn/started` and even the whole turn
    // can arrive before `turn/start` returns, and a notification for a thread nothing remembers
    // is a notification that gets dropped.
    this.runs.set(threadId, run);
    this.runFrame(run, {
      body: {
        kind: 'system',
        subtype: 'run_once_started',
        text: `Codex is running headless in ${input.cwd}.`,
      },
      meta: runOnceFrameMeta(runId, 'app_server'),
    });

    const stop = async (outcome: 'timeout' | 'canceled'): Promise<void> => {
      // Already resolved on its own merits: there is no turn left to interrupt, and claiming an
      // outcome for a run that finished before we decided anything would rewrite a real result.
      if (!settleRun) return;
      // Claimed before the interrupt goes out, not after it comes back: see `RunState.stopping`.
      // `??=` so the first decision stands if a timeout and an abort land in the same window.
      run.stopping ??= outcome;
      const turnId = run.turnId;
      if (turnId) {
        await client.request(METHODS.turnInterrupt, { threadId, turnId }).catch((err: Error) =>
          this.logger.log('warn', 'interrupting a one-shot codex run failed', {
            runId,
            message: err.message,
          }),
        );
      }
      run.settle(outcome);
    };
    const timer = setTimeout(() => void stop('timeout'), input.timeoutMs);
    timer.unref();
    const onAbort = () => void stop('canceled');
    if (input.signal?.aborted) void stop('canceled');
    else input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await client.request<TurnStartResponse>(
        METHODS.turnStart,
        runOnceTurnParams(threadId, input),
      );
      // A turn the stream already completed must not be revived by its own late response.
      if (this.runs.has(threadId)) run.turnId = res.turn.id;
    } catch (err) {
      // A `turn/start` that failed BECAUSE we interrupted the turn is not a failure to start.
      if (!run.stopping)
        run.settle('failed', {
          code: 'start_failed',
          message: clip(`turn/start failed: ${(err as Error).message}`, 300),
        });
    }

    try {
      return await finished;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      this.runs.delete(threadId);
      // Best effort: the thread is finished with, and leaving it subscribed on the user's own
      // shared daemon means the bridge keeps receiving notifications nobody reads.
      await this.client?.request(METHODS.threadUnsubscribe, { threadId }).catch(() => {});
    }
  }

  async sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }> {
    const live = await this.requireLive(input.sessionId);
    // The thread's own process holds its writer lock (openai/codex#44449): a second writer is
    // refused by Codex itself, and pretending otherwise would lose the user's instruction.
    if (live.mirror) throw new Error(MIRROR_READ_ONLY);
    const client = await this.ensureClient();
    if (live.activeTurnId) {
      if (input.mode === 'queue') {
        live.queued.push({ instruction: input.instruction, images: input.localImagePaths });
        this.sessionEvent(live, 'queued_followup', clip(input.instruction, 500));
        return { delivered: 'queued' };
      }
      await client.request<TurnSteerResponse>(METHODS.turnSteer, {
        threadId: live.threadId,
        input: buildInput(input.instruction, input.localImagePaths),
        expectedTurnId: live.activeTurnId,
      });
      this.sessionEvent(live, 'progress', `Steered: ${clip(input.instruction, 400)}`);
      return { delivered: 'steered' };
    }
    await this.startTurn(live, input.instruction, input.localImagePaths);
    return { delivered: 'new_turn' };
  }

  async stopSession(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    if (live.mirror) throw new Error(MIRROR_READ_ONLY);
    live.queued = [];
    if (live.activeTurnId && this.client?.running) {
      try {
        await this.client.request(METHODS.turnInterrupt, {
          threadId: live.threadId,
          turnId: live.activeTurnId,
        });
        // turn/completed(interrupted) will finalize as 'stopped'.
        return;
      } catch (err) {
        this.logger.log('warn', 'turn/interrupt failed', { message: (err as Error).message });
      }
    }
    this.cancelApprovalsFor(sessionId);
    this.setStatus(live, 'stopped', { activeTurn: false, endedAt: now() });
    this.sessionEvent(live, 'stopped', 'Session stopped');
  }

  async respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
    /** v2. The agent's own option the user picked; `decision` is the v1 truth without it. */
    optionId?: string;
  }): Promise<void> {
    const p = this.pending.get(input.approvalId);
    if (!p) throw new Error(`unknown or expired approval ${input.approvalId}`);
    if (p.providerRequestId !== input.providerRequestId) {
      throw new Error('providerRequestId does not match retained approval request');
    }
    this.pending.delete(input.approvalId);
    clearTimeout(p.timer);
    this.answer(p, decisionForOption(input.optionId, input.decision), input.optionId);
    this.emit({
      kind: 'approval_resolved_locally',
      approvalId: p.approvalId,
      resolution: input.decision === 'allow' ? 'allowed' : 'denied',
    });
    const live = this.sessions.get(p.sessionId);
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
    this.armIdleShutdown();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdleTimer();
    this.failRuns('the bridge is shutting down');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const p of [...this.pending.values()]) {
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.answer(p, 'decline', undefined, false);
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
    this.starting = null;
    // Hand back every mirrored thread's subscription BEFORE the link goes. A thread we resumed
    // and never unsubscribed stays attached on the user's own shared daemon, where the writer
    // lock then belongs to a Pagr that is no longer running — so `pagr logout` and
    // `pagr daemon uninstall` would leave the person's `codex` TUI worse than they found it.
    await this.mirror?.stop().catch(() => {});
    await this.client?.stop();
    this.client = null;
    this.logger.close();
  }

  // ---------- internals ----------

  private emit(e: AdapterEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.logger.log('error', 'listener threw', { message: (err as Error).message });
      }
    }
  }

  private sessionEvent(
    live: LiveSession,
    type: Extract<AdapterEvent, { kind: 'session_event' }>['type'],
    summary: string,
    providerEventId?: string,
  ): void {
    this.emit({
      kind: 'session_event',
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      type,
      summary: clip(summary, 2000),
      ...(providerEventId ? { providerEventId } : {}),
    });
  }

  private setStatus(
    live: LiveSession,
    status: SessionSummary['status'],
    patch: Partial<SessionSummary> = {},
  ): void {
    live.summary = { ...live.summary, ...patch, status, updatedAt: now() };
    this.map.update(live.summary.sessionId, {
      lastStatus: status,
      updatedAt: live.summary.updatedAt,
    });
    this.emit({ kind: 'session', session: live.summary });
    this.armIdleShutdown();
  }

  // ---- idle app-server ----

  /** A turn in flight, a queued follow-up or an approval waiting on a human all count as busy. */
  private get busy(): boolean {
    if (this.pending.size > 0) return true;
    for (const s of this.sessions.values()) if (s.activeTurnId || s.queued.length > 0) return true;
    return false;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Stop the shared app-server once nothing needs it. One idle `codex app-server` per Mac,
   * forever, is what `probe()` used to leave behind; keeping one alive after the last turn has
   * the same cost, just later.
   */
  private armIdleShutdown(): void {
    this.clearIdleTimer();
    const ms = this.opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    if (ms <= 0 || this.shuttingDown || this.busy || !this.client?.running) return;
    // Nothing to reclaim when we are attached to a daemon we did not start — and dropping the
    // link would stop mirroring the user's terminal threads for no gain at all.
    if (this.client.mode === 'app-server-daemon') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stopIdleAppServer();
    }, ms);
    this.idleTimer.unref();
  }

  private async stopIdleAppServer(): Promise<void> {
    const client = this.client;
    if (!client?.running || this.busy || this.shuttingDown || this.starting) return;
    this.logger.log('info', 'app-server idle; stopping it until the next command');
    // Drop the reference BEFORE stopping: the `exit` handler sees an expected exit and must not
    // find a client it would try to restart.
    this.client = null;
    this.startedAtMs = null;
    // A fresh process knows nothing about these threads; they get `thread/resume`d on next use.
    for (const s of this.sessions.values()) s.loaded = false;
    await client.stop().catch(() => {});
  }

  /**
   * `codex --version`, memoised. The daemon probes on every gateway connect, and a flapping
   * network turned that into one fork per reconnect. The TTL is short enough that installing
   * (or removing) Codex is still noticed within a few minutes.
   */
  private async codexVersion(): Promise<string | null> {
    const cached = this.versionCache;
    const ttl =
      this.opts.versionCacheMs ?? (cached?.value === null ? MISSING_CACHE_MS : VERSION_CACHE_MS);
    if (cached && ttl > 0 && Date.now() - cached.atMs < ttl) return cached.value;
    const value = await this.forkCodexVersion();
    this.versionCache = { value, atMs: Date.now() };
    return value;
  }

  private forkCodexVersion(): Promise<string | null> {
    const [bin, ...rest] = this.opts.codexCommand ?? ['codex'];
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        bin,
        [...rest, '--version'],
        {
          timeout: 10_000,
          ...(this.opts.env ? { env: { ...process.env, ...this.opts.env } } : {}),
        },
        (err, stdout) => {
          if (err) return resolve(null);
          const m = /(\d+\.\d+\.\d+)/.exec(stdout);
          resolve(m?.[1] ?? (stdout.trim() || null));
        },
      );
    });
  }

  /**
   * The single shared app-server, spawned at most once even under concurrent callers. Two
   * sessions starting at the same moment used to each construct a client and the second one
   * replaced the first, orphaning its threads — so this memoises the in-flight spawn.
   */
  private ensureClient(): Promise<AppServerClient> {
    // Somebody wants the app-server: it is not idle any more.
    this.clearIdleTimer();
    if (this.client?.running) return Promise.resolve(this.client);
    if (this.shuttingDown) return Promise.reject(new Error('adapter is shut down'));
    if (this.starting) return this.starting;
    // An explicit command means the operator wants another go: forget the give-up state.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.starting = this.connect()
      .then((client) => {
        this.startedAtMs = Date.now();
        // Threads must be re-resumed in a fresh process.
        for (const s of this.sessions.values()) s.loaded = false;
        if (client.mode === 'app-server-daemon') this.startMirror(client);
        return client;
      })
      .catch(async (err: Error) => {
        // `start()` connects first and rejects later (initialize timed out, or answered with an
        // error). The child is still alive at that point, so dropping the reference without
        // stopping it would leak one `codex app-server` per attempt.
        const client = this.client;
        this.client = null;
        await client?.stop().catch(() => {});
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /**
   * Attach to the user's shared daemon if there is one; otherwise spawn our own child.
   *
   * The bridge never runs `codex app-server daemon start`: that command only works for the
   * installer-managed standalone package (MOB-043 finding 1), so an npm install would see it fail
   * every time. `pagr doctor` says so once, and this falls back to a private child — which is
   * what every Codex user had before this existed.
   */
  private async connect(): Promise<AppServerClient> {
    const socketPath = this.controlSocket();
    if (this.daemonAttachEnabled() && controlSocketPresent(socketPath)) {
      const client = this.newClient({ kind: 'daemon', socketPath });
      try {
        // The handshake is bounded (the daemon's own client allows 2 s); everything after it uses
        // the ordinary request timeout, because a real turn is not a probe.
        await withTimeout(
          client.start(),
          this.opts.daemonProbeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS,
          'codex daemon did not answer initialize',
        );
        this.logger.log('info', 'using the shared codex app-server daemon', { socketPath });
        return client;
      } catch (err) {
        this.logger.log('warn', 'codex daemon did not answer; starting our own app-server', {
          socketPath,
          message: (err as Error).message,
        });
        await client.stop().catch(() => {});
        if (this.client === client) this.client = null;
      }
    }
    const [bin, ...rest] = this.opts.codexCommand ?? ['codex'];
    const client = this.newClient({
      kind: 'stdio',
      command: [bin ?? 'codex', ...rest, 'app-server'],
      ...(this.opts.env ? { env: { ...process.env, ...this.opts.env } } : {}),
    });
    await client.start();
    return client;
  }

  /**
   * Whether to look for a shared daemon at all.
   *
   * The default is yes — but only for the machine's own `codex`. A configured `codexCommand` is
   * the operator saying WHICH Codex this bridge drives (a wrapper, a pinned build, a fake in
   * tests); attaching to the daemon of a different installation would quietly talk to something
   * they did not choose. Passing `controlSocketPath` is the explicit way to say "that one".
   */
  private daemonAttachEnabled(): boolean {
    if (this.opts.attachDaemon !== undefined) return this.opts.attachDaemon;
    if (this.opts.controlSocketPath) return true;
    const cmd = this.opts.codexCommand;
    return !cmd || (cmd.length === 1 && cmd[0] === 'codex');
  }

  private newClient(transport: AppServerTransportSpec): AppServerClient {
    const client = new AppServerClient({
      transport,
      clientVersion: this.opts.bridgeVersion ?? '0.1.0',
      logger: this.logger,
      // `thread/loaded/list` and `thread/unsubscribe` are experimental-era APIs; the mirror needs
      // them and asking costs nothing on a server that does not gate them.
      experimentalApi: transport.kind === 'daemon',
      ...(this.opts.requestTimeoutMs ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}),
    });
    client.on('notification', (n) => this.onNotification(n));
    client.on('request', (r) => this.onServerRequest(r));
    client.on('exit', (info) => this.onExit(info.expected));
    this.client = client;
    return client;
  }

  // ---- mirrored terminal threads (B9) ----

  /** True for a thread this bridge started: its session is ours to drive. */
  private ownsThread(threadId: string): boolean {
    // A run's thread is ours and is nobody's to adopt: without this the terminal mirror would
    // find it, call it somebody's TUI session, and list the handoff writer as a session.
    if (this.runs.has(threadId)) return true;
    const sid = this.byThread.get(threadId);
    const live = sid ? this.sessions.get(sid) : undefined;
    if (live) return live.mirror !== true;
    return this.map.findByThread(threadId) !== undefined;
  }

  private startMirror(client: AppServerClient): void {
    if (this.opts.mirror === false || this.mirror) return;
    const mirror = new TerminalThreadMirror({
      request: (method, params) => client.request(method, params),
      isOurs: (threadId) => this.ownsThread(threadId),
      onThread: (t) => this.adoptMirroredThread(t),
      onFrames: (threadId, frames) => {
        const live = this.liveByThread(threadId);
        if (live) this.emitFrames(live, frames);
      },
      logger: this.logger,
      ...(this.opts.discoveryIntervalMs
        ? { discoveryIntervalMs: this.opts.discoveryIntervalMs }
        : {}),
      ...(this.opts.readPollIntervalMs ? { pollIntervalMs: this.opts.readPollIntervalMs } : {}),
      ...(this.opts.idleUnsubscribeMs ? { idleUnsubscribeMs: this.opts.idleUnsubscribeMs } : {}),
    });
    this.mirror = mirror;
    mirror.start();
    void mirror.discover().catch((err) =>
      this.logger.log('warn', 'first codex thread discovery failed', {
        message: (err as Error).message,
      }),
    );
  }

  /**
   * Discovery on demand — one pass, now. Connects the app-server if it is not up, which is the
   * same thing any other command does; it never starts a daemon.
   */
  async discoverTerminalThreads(): Promise<MirroredThread[]> {
    await this.ensureClient();
    if (!this.mirror) return [];
    await this.mirror.discover();
    return this.mirror.list();
  }

  /**
   * A terminal thread becomes a session this Mac knows about: `mirror_only`, `origin: 'terminal'`.
   *
   * It is deliberately NOT written to `codex-sessions.json`. That file is the map of threads the
   * bridge may resume, and resuming somebody else's terminal thread is exactly what the writer
   * lock exists to prevent.
   */
  private adoptMirroredThread(t: MirroredThread): LiveSession {
    const sessionId = syntheticSessionId('codex', t.threadId);
    const existing = this.sessions.get(sessionId);
    const project = t.cwd ? (this.opts.resolveProject?.(t.cwd) ?? null) : null;
    const status = mirrorStatus(t.status);
    if (existing) {
      if (existing.summary.status !== status) this.setStatus(existing, status);
      return existing;
    }
    const ts = now();
    const summary: SessionSummaryV2 = {
      sessionId,
      projectId: project?.projectId ?? UNREGISTERED_PROJECT,
      provider: 'codex',
      status,
      activeTurn: status === 'working',
      startedAt: ts,
      updatedAt: ts,
      controlLevel: 'mirror_only',
      origin: 'terminal',
      projectStatus: project ? 'registered' : 'unregistered',
      ...(t.preview ? { taskSummary: clip(t.preview, 500) } : {}),
    };
    const live: LiveSession = {
      summary,
      threadId: t.threadId,
      projectPath: project?.projectPath ?? t.cwd,
      readOnly: true,
      activeTurnId: null,
      loaded: true,
      agentBuffers: new Map(),
      lastAgentMessage: '',
      queued: [],
      observedTurnIds: new Set(),
      mirror: true,
      commands: new Map(),
    };
    this.sessions.set(sessionId, live);
    this.byThread.set(t.threadId, sessionId);
    this.logger.log('info', 'mirroring a terminal codex thread', {
      sessionId,
      hosting: t.hosting,
      project: project?.projectId ?? 'none',
    });
    // A thread in a directory no project covers is real, and local: the cloud cannot be told
    // about it, because a `SessionSummary` has to name a `proj_…` id.
    if (live.summary.projectId) this.emit({ kind: 'session', session: summary });
    return live;
  }

  // ---- frames ----

  private emitFrames(live: LiveSession, frames: MappedFrame[]): void {
    if (this.opts.frames === false || frames.length === 0) return;
    if (!live.summary.projectId) return; // unregistered: journaled by nobody, sent to nobody
    for (const f of frames) {
      this.emit({
        kind: 'frame',
        sessionId: live.summary.sessionId,
        projectId: live.summary.projectId,
        body: f.body,
        meta: f.meta,
        ...(f.providerRecordId ? { providerRecordId: f.providerRecordId } : {}),
        ...(f.endsTurn ? { endsTurn: true } : {}),
      });
    }
  }

  /** A coalesced streaming frame came out; `owner` is the thread it belongs to. */
  private onStreamFrame(owner: string, frame: MappedFrame): void {
    const live = this.liveByThread(owner);
    if (live) this.emitFrames(live, [frame]);
  }

  private framesForCompletedItem(live: LiveSession, n: ItemCompletedNotification): void {
    const item = n.item;
    this.coalescer.finish(item.id, 'assistant');
    this.coalescer.finish(item.id, 'thinking');
    this.coalescer.finish(item.id, 'terminal');
    live.commands?.delete(item.id);
    this.emitFrames(live, framesForItem(item, { turnId: n.turnId, source: 'app_server' }));
  }

  /**
   * Every frame of a thread, read back through `thread/read`. The B12 backfill command calls this;
   * the frames are marked `source: 'backfill'` and keyed on (turnId, position), because
   * `thread/read` renumbers item ids and a backfill must not duplicate what was streamed live.
   */
  async readThreadFrames(threadId: string): Promise<MappedFrame[]> {
    const client = await this.ensureClient();
    const res = await client.request<ThreadReadResponse>(METHODS.threadRead, {
      threadId,
      includeTurns: true,
    });
    return framesForTurns(res?.thread?.turns ?? [], 'backfill');
  }

  /**
   * The raw `thread/read` thread, turns and all.
   *
   * `readThreadFrames` maps a thread into frames for the phone; the handoff writer needs the
   * thread itself, because what it produces is a plaintext NDJSON dump for a LOCAL agent to read
   * (`core/src/handoff/receiver.ts`, spec §3) and mapping it to frames first would throw away
   * exactly the tool calls and outputs a handoff note has to describe. Nothing sealed, nothing
   * sent: the dump lives under `PAGR_HOME/tmp` for the length of one run and is then deleted.
   */
  async readThread(threadId: string): Promise<ThreadReadResponse['thread'] | null> {
    const client = await this.ensureClient();
    const res = await client.request<ThreadReadResponse>(METHODS.threadRead, {
      threadId,
      includeTurns: true,
    });
    return res?.thread ?? null;
  }

  private onExit(expected: boolean): void {
    if (expected || this.shuttingDown) return;
    // Reset the backoff only for a server that actually stayed up. Resetting on a successful
    // handshake instead would pin the delay at `restartDelayMs` forever for the common failure
    // — a server that starts fine and dies seconds later — which is the crash loop this guards.
    const upFor = this.startedAtMs === null ? 0 : Date.now() - this.startedAtMs;
    const base = this.opts.restartDelayMs ?? 2000;
    if (upFor >= (this.opts.healthyUptimeMs ?? Math.max(60_000, base * 10)))
      this.restartAttempts = 0;
    this.startedAtMs = null;
    this.coalescer.clear();
    this.mirror?.reset();
    this.mirror = null;
    // Threads we only mirrored belong to the server that is gone; they are rediscovered on the
    // next connect rather than lingering as sessions nobody can see the end of.
    for (const [sid, live] of [...this.sessions]) {
      if (!live.mirror) continue;
      this.sessions.delete(sid);
      this.byThread.delete(live.threadId);
    }
    this.failLiveSessions('Codex app-server exited unexpectedly');
    this.failRuns('Codex app-server exited unexpectedly');
    for (const p of [...this.pending.values()]) {
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
    // Back off exponentially and give up after a few tries. A crash loop that respawns every
    // two seconds forever is indistinguishable from a fork bomb, and the sessions it would
    // serve have already been reported failed.
    const maxAttempts = this.opts.maxRestartAttempts ?? 5;
    if (this.restartAttempts >= maxAttempts) {
      this.logger.log('error', 'app-server keeps exiting; not restarting again', {
        attempts: this.restartAttempts,
      });
      return;
    }
    const cap = this.opts.maxRestartDelayMs ?? 30_000;
    const delay = Math.min(cap, base * 2 ** this.restartAttempts);
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureClient().catch((err) =>
        this.logger.log('error', 'app-server restart failed', { message: err.message }),
      );
    }, delay);
    this.restartTimer.unref();
  }

  /** Any session with a turn in flight when the provider died is failed, never left "working". */
  private failLiveSessions(reason: string): void {
    for (const live of this.sessions.values()) {
      if (live.activeTurnId) {
        live.activeTurnId = null;
        this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
        this.sessionEvent(live, 'failed', reason);
      }
      live.loaded = false;
    }
  }

  private async requireLive(sessionId: string): Promise<LiveSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const p = this.map.get(sessionId);
    if (!p) throw new Error(`unknown session ${sessionId}`);
    const ts = now();
    const live: LiveSession = {
      summary: {
        sessionId,
        projectId: p.projectId,
        provider: 'codex',
        status: 'idle',
        activeTurn: false,
        startedAt: p.startedAt,
        updatedAt: ts,
        ...(p.displayName ? { displayName: p.displayName } : {}),
      },
      threadId: p.threadId,
      projectPath: p.projectPath,
      readOnly: p.readOnly === true,
      activeTurnId: null,
      loaded: false,
      agentBuffers: new Map(),
      lastAgentMessage: '',
      queued: [],
      observedTurnIds: new Set(),
    };
    this.sessions.set(sessionId, live);
    this.byThread.set(p.threadId, sessionId);
    return live;
  }

  private async ensureLoaded(live: LiveSession): Promise<void> {
    const client = await this.ensureClient();
    if (live.loaded) return;
    const params: ThreadResumeParams = {
      threadId: live.threadId,
      cwd: live.projectPath,
      approvalPolicy: 'on-request',
      // Re-assert the sandbox on every resume: thread/resume accepts `sandbox` (generated/v2/
      // ThreadResumeParams.ts) and a read-only session must never widen after a restart.
      sandbox: live.readOnly ? 'read-only' : 'workspace-write',
    };
    await client.request(METHODS.threadResume, params);
    live.loaded = true;
  }

  private async startTurn(live: LiveSession, instruction: string, images: string[]): Promise<void> {
    await this.ensureLoaded(live);
    const client = await this.ensureClient();
    const res = await client.request<TurnStartResponse>(METHODS.turnStart, {
      threadId: live.threadId,
      input: buildInput(instruction, images),
    });
    // The response and every notification for this turn share one stdout stream. A fast turn can
    // be fully parsed out of a single chunk — `turn/started`, an approval request, even
    // `turn/completed` — while resolving this promise is still a queued microtask. Stamping
    // `working` here would then rewind a session that is already finished (stuck "working"
    // forever, with a dead `activeTurnId` to steer into) or already waiting for an approval.
    if (live.observedTurnIds.delete(res.turn.id)) {
      this.logger.log('info', 'turn was already reported before its start response', {
        turnId: res.turn.id,
        status: live.summary.status,
      });
      live.summary = { ...live.summary, taskSummary: clip(instruction, 500) };
      return;
    }
    live.activeTurnId = res.turn.id;
    live.lastAgentMessage = '';
    this.setStatus(live, 'working', { activeTurn: true, taskSummary: clip(instruction, 500) });
  }

  /** Note a turn the stream has reported on, so a late `turn/start` response cannot rewind it. */
  private rememberObserved(live: LiveSession, turnId: string): void {
    live.observedTurnIds.add(turnId);
    while (live.observedTurnIds.size > OBSERVED_TURN_MEMORY) {
      const oldest = live.observedTurnIds.values().next().value;
      if (oldest === undefined) break;
      live.observedTurnIds.delete(oldest);
    }
  }

  // ---- notifications ----

  private onNotification(n: RpcNotification): void {
    const p = (n.params ?? {}) as Record<string, unknown>;
    // A headless run's thread is handled on its own, and never falls through: its notifications
    // must not touch session state, the mirror, or the coalescer that belongs to sessions.
    const onThread = typeof p.threadId === 'string' ? this.runs.get(p.threadId) : undefined;
    if (onThread) {
      this.onRunNotification(onThread, n, p);
      return;
    }
    switch (n.method) {
      case NOTIFICATIONS.turnStarted: {
        const { threadId, turn } = p as unknown as TurnStartedNotification;
        this.mirror?.noteActivity(threadId);
        const live = this.liveByThread(threadId);
        if (!live) return;
        live.activeTurnId = turn.id;
        live.lastAgentMessage = '';
        this.rememberObserved(live, turn.id);
        if (live.summary.status !== 'working')
          this.setStatus(live, 'working', { activeTurn: true });
        this.sessionEvent(live, 'started', 'Turn started', turn.id);
        return;
      }
      case NOTIFICATIONS.agentMessageDelta: {
        const d = p as unknown as AgentMessageDeltaNotification;
        const live = this.liveByThread(d.threadId);
        if (!live) return;
        this.mirror?.noteActivity(d.threadId);
        live.agentBuffers.set(d.itemId, (live.agentBuffers.get(d.itemId) ?? '') + d.delta);
        this.coalescer.push({
          owner: d.threadId,
          itemId: d.itemId,
          turnId: d.turnId,
          kind: 'assistant',
          delta: d.delta,
        });
        return;
      }
      case NOTIFICATIONS.reasoningTextDelta:
      case NOTIFICATIONS.reasoningSummaryTextDelta: {
        const d = p as unknown as ReasoningTextDeltaNotification;
        const live = this.liveByThread(d.threadId);
        if (!live) return;
        this.mirror?.noteActivity(d.threadId);
        this.coalescer.push({
          owner: d.threadId,
          itemId: d.itemId,
          turnId: d.turnId,
          kind: 'thinking',
          delta: d.delta,
        });
        return;
      }
      case NOTIFICATIONS.commandOutputDelta: {
        const d = p as unknown as CommandExecutionOutputDeltaNotification;
        const live = this.liveByThread(d.threadId);
        if (!live) return;
        this.mirror?.noteActivity(d.threadId);
        const command = live.commands?.get(d.itemId);
        this.coalescer.push({
          owner: d.threadId,
          itemId: d.itemId,
          turnId: d.turnId,
          kind: 'terminal',
          delta: d.delta,
          ...(command ? { command } : {}),
        });
        return;
      }
      case NOTIFICATIONS.itemStarted: {
        const { item, threadId } = p as unknown as ItemCompletedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        this.mirror?.noteActivity(threadId);
        if (item.type === 'commandExecution' && 'command' in item) {
          live.commands ??= new Map();
          live.commands.set(item.id, String(item.command));
          this.sessionEvent(
            live,
            'progress',
            `Running: ${clip(relativizePaths(String(item.command), live.projectPath), 300)}`,
            item.id,
          );
        }
        return;
      }
      case NOTIFICATIONS.itemCompleted: {
        const n = p as unknown as ItemCompletedNotification;
        const { item, threadId } = n;
        const live = this.liveByThread(threadId);
        if (!live) return;
        this.mirror?.noteActivity(threadId);
        // The owner of a mirrored thread answered its own prompt; the phone's card is stale.
        this.resolveMirrorApprovalsFor(item.id);
        this.framesForCompletedItem(live, n);
        if (item.type === 'agentMessage') {
          const text =
            ('text' in item && typeof item.text === 'string' && item.text) ||
            live.agentBuffers.get(item.id) ||
            '';
          live.agentBuffers.delete(item.id);
          if (text.trim()) {
            live.lastAgentMessage = text;
            this.sessionEvent(live, 'agent_message', clip(text, 500), item.id);
          }
        } else if (item.type === 'fileChange' && 'changes' in item) {
          const files = (item.changes as Array<{ path: string }>).map((c) =>
            relativizePaths(c.path, live.projectPath),
          );
          this.sessionEvent(
            live,
            'progress',
            `Changed ${files.length} file(s): ${clip(files.join(', '), 300)}`,
            item.id,
          );
        }
        return;
      }
      case NOTIFICATIONS.turnCompleted: {
        const { threadId, turn } = p as unknown as TurnCompletedNotification;
        const live = this.liveByThread(threadId);
        if (!live) return;
        this.mirror?.noteActivity(threadId);
        if (live.mirror) {
          // A mirrored turn ends the way it began: as somebody else's. Anything still pending on
          // it was answered by whoever owns it — the turn could not have finished otherwise.
          for (const p of [...this.pending.values()]) {
            if (p.mirror && p.sessionId === live.summary.sessionId) this.answeredElsewhere(p);
          }
          this.setStatus(live, turn.status === 'failed' ? 'failed' : 'idle', { activeTurn: false });
          return;
        }
        live.activeTurnId = null;
        this.rememberObserved(live, turn.id);
        this.cancelApprovalsFor(live.summary.sessionId);
        const final = live.lastAgentMessage || `Turn ${turn.status}`;
        if (turn.status === 'failed') {
          this.setStatus(live, 'failed', { activeTurn: false, endedAt: now() });
          this.sessionEvent(live, 'failed', turn.error?.message ?? final, turn.id);
        } else if (turn.status === 'interrupted') {
          this.setStatus(live, 'stopped', { activeTurn: false, endedAt: now() });
          this.sessionEvent(live, 'stopped', final, turn.id);
        } else {
          this.setStatus(live, 'completed', { activeTurn: false });
          this.sessionEvent(live, 'completed', final, turn.id);
          this.deliverQueued(live);
        }
        return;
      }
      case NOTIFICATIONS.threadStatusChanged: {
        const { threadId, status } = p as unknown as ThreadStatusChangedNotification;
        this.mirror?.noteActivity(threadId, status);
        const live = this.liveByThread(threadId);
        if (!live) return;
        if (live.mirror) {
          const next = mirrorStatus(status);
          if (next !== live.summary.status) this.setStatus(live, next);
          return;
        }
        if (status.type === 'active' && status.activeFlags.includes('waitingOnUserInput')) {
          this.setStatus(live, 'waiting_for_user');
          this.sessionEvent(live, 'needs_input', 'Codex is waiting for your input');
        }
        return;
      }
      case NOTIFICATIONS.serverRequestResolved: {
        // Somebody answered a request we were relaying — for a mirrored thread that is the owner
        // at their keyboard, and their answer is the one the agent acted on.
        const { requestId } = p as unknown as { requestId: RpcId };
        for (const pending of [...this.pending.values()]) {
          if (pending.mirror && pending.rpcId === requestId) this.answeredElsewhere(pending);
        }
        return;
      }
      case NOTIFICATIONS.error: {
        const e = p as unknown as ErrorNotification;
        const live = this.liveByThread(e.threadId);
        if (!live) return;
        this.logger.log('warn', 'turn error', { willRetry: e.willRetry, message: e.error.message });
        if (!e.willRetry)
          this.sessionEvent(live, 'progress', `Error: ${clip(e.error.message, 300)}`);
        return;
      }
      default:
        return;
    }
  }

  private deliverQueued(live: LiveSession): void {
    const next = live.queued.shift();
    if (!next) return;
    this.startTurn(live, next.instruction, next.images)
      .then(() => this.sessionEvent(live, 'followup_delivered', clip(next.instruction, 500)))
      .catch((err) => {
        this.logger.log('error', 'queued follow-up failed', { message: (err as Error).message });
        this.sessionEvent(live, 'failed', `Queued follow-up failed: ${(err as Error).message}`);
      });
  }

  private liveByThread(threadId: string): LiveSession | undefined {
    const sid = this.byThread.get(threadId) ?? this.map.findByThread(threadId);
    return sid ? this.sessions.get(sid) : undefined;
  }

  // ---- headless runs ----

  /** One frame from a run. Marked as a run's, mirrored under an id nobody can talk to. */
  private runFrame(run: RunState, f: MappedFrame): void {
    if (this.opts.frames === false) return;
    // No project means no route: journaled by nobody, sent to nobody — as with a mirrored
    // thread in an unregistered directory. The run itself is unaffected.
    if (!run.projectId) return;
    this.emit({
      kind: 'frame',
      sessionId: run.sessionId,
      projectId: run.projectId,
      body: f.body,
      meta: { ...f.meta, ...runOnceFrameMeta(run.runId, 'app_server') },
      ...(f.providerRecordId ? { providerRecordId: f.providerRecordId } : {}),
      ...(f.endsTurn ? { endsTurn: true } : {}),
    });
  }

  /**
   * Everything the app-server says about a run's thread.
   *
   * The same item→frame mapping a session uses, so the phone sees the handoff being written in
   * the shape it already knows how to draw; what differs is where it goes (`runFrame`) and that
   * nothing here updates a session, a status, or the mirror.
   */
  private onRunNotification(run: RunState, n: RpcNotification, p: Record<string, unknown>): void {
    switch (n.method) {
      case NOTIFICATIONS.turnStarted: {
        const { turn } = p as unknown as TurnStartedNotification;
        run.turnId = turn.id;
        return;
      }
      case NOTIFICATIONS.itemCompleted: {
        const c = p as unknown as ItemCompletedNotification;
        if (c.item.type === 'agentMessage') {
          const text = (c.item as { text?: string }).text ?? '';
          if (text.trim()) run.said.push(text);
        }
        for (const f of framesForItem(c.item, { turnId: c.turnId, source: 'app_server' })) {
          this.runFrame(run, f);
        }
        return;
      }
      case NOTIFICATIONS.turnCompleted: {
        const { turn } = p as unknown as TurnCompletedNotification;
        if (turn.status === 'completed') run.settle('completed');
        else if (turn.status === 'failed')
          run.settle('failed', {
            code: 'agent_error',
            message: clip(turn.error?.message ?? 'the turn failed', 300),
          });
        // Our own timeout and cancel claim the outcome before they interrupt, so a turn
        // interrupted at our request settles as what it is; one interrupted by anything else
        // (a person in the TUI, the server giving up) is a failure.
        else if (turn.status === 'interrupted' && run.stopping) run.settle(run.stopping);
        // (`settle` would rewrite this one too, now that the claim is enforced there; the
        // branch above stays because this is where the confusion lived and it costs nothing.)
        else if (turn.status === 'interrupted')
          run.settle('failed', { code: 'exited', message: 'the turn was interrupted' });
        return;
      }
      case NOTIFICATIONS.error: {
        const e = p as unknown as ErrorNotification;
        if (e.willRetry) return;
        run.settle('failed', { code: 'agent_error', message: clip(e.error.message, 300) });
        return;
      }
      default:
        return;
    }
  }

  /** Every in-flight run gives up with the same typed failure. */
  private failRuns(message: string): void {
    for (const run of [...this.runs.values()]) {
      run.settle('failed', { code: 'exited', message });
    }
  }

  // ---- server → client approval requests ----

  /**
   * A run asked for permission. Nobody is there to answer, so the answer is no — here, now,
   * and never as an `approval_requested` event that something downstream could relay to a phone.
   *
   * `approvalPolicy: 'never'` should mean this is never reached; it is reached anyway when a
   * server re-reads the policy, when an MCP tool asks on its own account, or when a future
   * request type arrives. A prompt nobody answers is a run that hangs until its timeout, and
   * `allow` is not ours to give: a run's prompt carries text the cloud supplied, so granting an
   * approval here would hand a compromised cloud the action `deviceFloor.ts` refuses it.
   * `workspace-write` needs no approval for the file the run was asked to write.
   */
  private declineForRun(run: RunState, r: RpcRequest): void {
    const client = this.client;
    if (!client) return;
    this.logger.log('info', 'one-shot run declined a server request', {
      runId: run.runId,
      method: r.method,
    });
    if (r.method === SERVER_REQUESTS.permissionsApproval) {
      // An empty grant is a denial.
      client.respond(r.id, {
        permissions: {},
        scope: 'turn',
      } satisfies PermissionsRequestApprovalResponse);
    } else if (r.method === SERVER_REQUESTS.requestUserInput) {
      client.respond(r.id, { answers: {} } satisfies ToolRequestUserInputResponse);
    } else if (
      r.method === SERVER_REQUESTS.commandApproval ||
      r.method === SERVER_REQUESTS.fileChangeApproval
    ) {
      client.respond(r.id, { decision: 'decline' });
    } else {
      client.respondError(r.id, -32601, 'unsupported request');
      return;
    }
    this.runFrame(run, {
      body: {
        kind: 'system',
        subtype: 'run_once_denied',
        text: `Refused ${r.method}: this run is headless, so there is nobody to approve it.`,
      },
      meta: runOnceFrameMeta(run.runId, 'app_server'),
    });
  }

  private onServerRequest(r: RpcRequest): void {
    const client = this.client;
    if (!client) return;
    const params = (r.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const run = this.runs.get(threadId);
    if (run) {
      this.declineForRun(run, r);
      return;
    }
    const live = this.liveByThread(threadId);
    if (r.method === SERVER_REQUESTS.requestUserInput) {
      this.onQuestionRequest(r, live);
      return;
    }
    // Attached to the shared daemon, every subscriber receives the same request — including
    // requests for threads that are none of our business. Answering one would silently decide
    // it for whoever does own it (MOB-043 finding 5: one id, first answer wins), so we do not
    // answer at all. Our own private child only ever asks us about our own threads, so there
    // the historical fail-safe decline still stands.
    if (!live && client.mode === 'app-server-daemon') {
      this.logger.log('info', 'server request for a thread we do not own; leaving it alone', {
        method: r.method,
        threadId: threadId.slice(0, 40),
      });
      return;
    }
    if (!live) {
      // Not one of ours (or unknown method): fail safe by declining.
      this.logger.log('warn', 'server request for unknown thread; declining', { method: r.method });
      if (r.method === SERVER_REQUESTS.permissionsApproval) {
        client.respond(r.id, {
          permissions: {},
          scope: 'turn',
        } satisfies PermissionsRequestApprovalResponse);
      } else if (
        r.method === SERVER_REQUESTS.commandApproval ||
        r.method === SERVER_REQUESTS.fileChangeApproval
      ) {
        client.respond(r.id, { decision: 'decline' });
      } else {
        client.respondError(r.id, -32601, 'unsupported request');
      }
      return;
    }

    let kind: PendingApproval['kind'];
    let actionType: Extract<AdapterEvent, { kind: 'approval_requested' }>['actionType'];
    let preview: string;
    let hints: Hints;
    let providerRequestId: string;
    let requested: PendingApproval['requested'] = null;
    let options: ApprovalOption[];
    // Unredacted facts for the device floor (`@pagr/bridge-core`'s deviceFloor). Never emitted to
    // the cloud — `preview` below is the relativized, clipped string that leaves the Mac.
    const local: LocalActionDetail = { projectPath: live.projectPath };
    switch (r.method) {
      case SERVER_REQUESTS.commandApproval: {
        const c = params as unknown as CommandExecutionRequestApprovalParams;
        kind = 'command';
        actionType = 'command_execution';
        preview = c.command ?? '(command)';
        if (c.reason) preview += `\n— ${c.reason}`;
        hints = hintsForCommand(c.command ?? '', c.cwd ?? undefined, live.projectPath);
        local.toolName = 'shell';
        if (c.command) local.command = c.command;
        if (c.cwd) local.cwd = c.cwd;
        providerRequestId = c.approvalId ?? c.itemId;
        options = commandApprovalOptions();
        break;
      }
      case SERVER_REQUESTS.fileChangeApproval: {
        const f = params as unknown as FileChangeRequestApprovalParams;
        kind = 'file';
        actionType = 'file_change';
        const files = f.grantRoot ? [f.grantRoot] : [];
        preview = f.grantRoot
          ? `Write access requested under ${f.grantRoot}`
          : `Apply file changes${f.reason ? ` — ${f.reason}` : ''}`;
        hints = hintsForFiles(files, live.projectPath);
        local.toolName = 'apply_patch';
        local.paths = files;
        providerRequestId = f.itemId;
        options = fileChangeApprovalOptions();
        break;
      }
      case SERVER_REQUESTS.permissionsApproval: {
        const pr = params as unknown as PermissionsRequestApprovalParams;
        kind = 'permissions';
        actionType = 'permission';
        const wants: string[] = [];
        if (pr.permissions.network) wants.push('network access');
        if (pr.permissions.fileSystem) wants.push('extra file-system access');
        preview = `Codex requests ${wants.join(' and ') || 'additional permissions'}${
          pr.reason ? ` — ${pr.reason}` : ''
        }`;
        hints = {
          ...(pr.permissions.network ? { networkAccess: true } : {}),
          ...(pr.permissions.fileSystem ? { touchesOutsideProject: true } : {}),
        };
        local.toolName = 'permissions';
        // A blanket grant of network or extra file-system access is exactly what the floor is
        // for: name it so `classifyLocally` sees it even though there is no command to read.
        if (pr.permissions.network) local.url = 'codex:requested-network-access';
        if (pr.permissions.fileSystem) local.paths = ['/'];
        providerRequestId = pr.itemId;
        requested = pr.permissions;
        options = permissionsApprovalOptions();
        break;
      }
      default:
        client.respondError(r.id, -32601, 'unsupported request');
        return;
    }

    // A prompt from a thread inside no registered project cannot be routed: the cloud has no
    // project id to send it to. Leave it entirely alone — the terminal that owns it still shows it.
    if (live.mirror && !live.summary.projectId) {
      this.logger.log('info', 'mirrored approval in an unregistered directory; not relaying');
      return;
    }
    const approvalId = newApprovalId();
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    const timer = setTimeout(() => this.timeoutApproval(approvalId), timeoutMs);
    timer.unref();
    const pending: PendingApproval = {
      approvalId,
      rpcId: r.id,
      sessionId: live.summary.sessionId,
      providerRequestId: providerRequestId.slice(0, 200),
      kind,
      timer,
      requested,
      ...(live.mirror ? { mirror: true } : {}),
    };
    this.pending.set(approvalId, pending);
    this.setStatus(live, 'waiting_for_approval');
    this.emit({
      kind: 'approval_requested',
      approvalId,
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      providerRequestId: pending.providerRequestId,
      actionType,
      preview: clip(relativizePaths(preview, live.projectPath), 1500),
      hints,
      local,
      options,
      source: live.mirror ? 'mirror' : 'owned',
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
  }

  /** The owner answered it in their own terminal: withdraw the phone's card, write nothing. */
  private answeredElsewhere(p: PendingApproval): void {
    if (!this.pending.delete(p.approvalId)) return;
    clearTimeout(p.timer);
    this.emit({
      kind: 'approval_resolved_locally',
      approvalId: p.approvalId,
      resolution: 'canceled',
      answeredElsewhere: true,
    });
    const live = this.sessions.get(p.sessionId);
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, mirrorStatus(undefined));
  }

  private resolveMirrorApprovalsFor(itemId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.mirror && p.providerRequestId === itemId) this.answeredElsewhere(p);
    }
  }

  // ---- questions (`item/tool/requestUserInput`) ----

  private onQuestionRequest(r: RpcRequest, live: LiveSession | undefined): void {
    const q = (r.params ?? {}) as unknown as ToolRequestUserInputParams;
    if (!live) {
      this.logger.log('info', 'question for a thread we do not own; leaving it alone');
      return;
    }
    if (!live.summary.projectId) return;
    const questions: FrameQuestion[] = q.questions.map((one) => ({
      question: one.question,
      header: one.header,
      // Codex asks one answer per question; `isOther` means the user may type their own.
      multiSelect: false,
      options: (one.options ?? []).map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
    }));
    // A thread we merely mirror is answered by the person sitting in front of it. Saying
    // `answerable: false` is the honest version of "we cannot type into your terminal".
    const answerable = live.mirror !== true;
    const timeoutMs = this.opts.approvalTimeoutMs ?? 600_000;
    this.questions.set(q.itemId, {
      rpcId: r.id,
      sessionId: live.summary.sessionId,
      threadId: q.threadId,
      itemId: q.itemId,
      questions: q.questions,
      answerable,
    });
    this.setStatus(live, 'waiting_for_user');
    this.emit({
      kind: 'question_asked',
      sessionId: live.summary.sessionId,
      projectId: live.summary.projectId,
      providerRequestId: q.itemId,
      questions,
      answerable,
      ...(answerable ? {} : { reason: 'mirror_only' }),
      secret: q.questions.map((one) => one.isSecret === true),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      // The dispatcher journals the `question` frame from the event, so `question.asked` can
      // name its seq. The frame below carries the same `providerRecordId`, which is what makes
      // the two one journal line instead of two (`JournalStore.append` dedupes on it).
      providerRecordId: q.itemId,
      meta: { source: 'app_server', turnId: q.turnId, final: true },
    });
    this.emitFrames(live, [
      {
        body: { kind: 'question', questions },
        meta: { source: 'app_server', turnId: q.turnId, final: true },
        providerRecordId: q.itemId,
      },
    ]);
  }

  /**
   * Answer a question by option index. Indexes, never text: the options came from the agent, and
   * echoing text back would let a compromised cloud put words in the user's mouth.
   */
  async answerQuestion(input: {
    providerRequestId: string;
    answers: Array<{ questionIndex: number; optionIndexes: number[]; freeText?: string }>;
  }): Promise<void> {
    const pending = this.questions.get(input.providerRequestId);
    if (!pending) throw new Error(`unknown or expired question ${input.providerRequestId}`);
    if (!pending.answerable)
      throw new Error('this thread is mirrored; answer it in the terminal that owns it');
    const answers: ToolRequestUserInputResponse['answers'] = {};
    for (const a of input.answers) {
      const question = pending.questions[a.questionIndex];
      if (!question) continue;
      const chosen = a.optionIndexes
        .map((i) => question.options?.[i]?.label)
        .filter((l): l is string => typeof l === 'string');
      if (a.freeText) chosen.push(a.freeText);
      answers[question.id] = { answers: chosen };
    }
    this.questions.delete(input.providerRequestId);
    this.client?.respond(pending.rpcId, { answers } satisfies ToolRequestUserInputResponse);
    const live = this.sessions.get(pending.sessionId);
    if (live) this.setStatus(live, 'working');
  }

  /**
   * Write the answer the agent is waiting for.
   *
   * `fromUser` is what separates a decision from a wind-down. A mirrored thread's request went to
   * every subscriber at once and the owner is sitting in front of it; a timeout, a cancel or a
   * shutdown on our side must leave their prompt exactly as they found it, so nothing is written
   * unless a person on the phone actually chose something.
   */
  private answer(
    p: PendingApproval,
    decision: ApprovalDecision,
    optionId?: string,
    fromUser = true,
  ): void {
    const client = this.client;
    if (!client?.running) return;
    if (p.mirror && !fromUser) {
      this.logger.log('info', 'not answering a mirrored approval on our own account', {
        approvalId: p.approvalId,
      });
      return;
    }
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    if (p.kind === 'permissions') {
      const granted: PermissionsRequestApprovalResponse =
        accepted && p.requested
          ? {
              permissions: {
                ...(p.requested.network ? { network: p.requested.network } : {}),
                ...(p.requested.fileSystem ? { fileSystem: p.requested.fileSystem } : {}),
              },
              scope: scopeForOption(optionId),
            }
          : // An empty grant IS the denial (generated/v2/PermissionsRequestApprovalResponse.ts).
            { permissions: {}, scope: 'turn' };
      client.respond(p.rpcId, granted);
    } else {
      client.respond(p.rpcId, { decision });
    }
  }

  private timeoutApproval(approvalId: string): void {
    const p = this.pending.get(approvalId);
    if (!p) return;
    this.pending.delete(approvalId);
    this.answer(p, 'decline', undefined, false);
    this.emit({ kind: 'approval_resolved_locally', approvalId, resolution: 'timed_out' });
    const live = this.sessions.get(p.sessionId);
    if (live && !this.hasPendingFor(p.sessionId)) this.setStatus(live, 'working');
  }

  private hasPendingFor(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  private cancelApprovalsFor(sessionId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(p.approvalId);
      this.answer(p, 'decline', undefined, false);
      this.emit({
        kind: 'approval_resolved_locally',
        approvalId: p.approvalId,
        resolution: 'canceled',
      });
    }
  }
}

/** Reject after `ms` without leaving the underlying promise's rejection unhandled. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function buildInput(instruction: string, images: string[]): UserInput[] {
  const input: UserInput[] = [{ type: 'text', text: instruction, text_elements: [] }];
  for (const p of images) input.push({ type: 'localImage', path: p });
  return input;
}

/** What a run's closing `system` frame says. One line, for a phone. */
function runOutcomeText(outcome: RunOnceResult['outcome'], error?: RunOnceError): string {
  switch (outcome) {
    case 'completed':
      return 'Headless run finished.';
    case 'timeout':
      return 'Headless run timed out and was stopped.';
    case 'canceled':
      return 'Headless run was canceled.';
    default:
      return `Headless run failed: ${error?.message ?? 'unknown error'}`;
  }
}
