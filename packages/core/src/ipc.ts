import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { ZodError, z } from 'zod';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { MAX_SOCKET_PATH_BYTES } from './paths.js';

/**
 * Local IPC over a Unix-domain socket (`~/.pagr/run/daemon.sock`, mode 0600).
 * Protocol: newline-delimited JSON. Request `{ id, method, params }` →
 * response `{ id, result }` or `{ id, error: { code, message } }`.
 * Used by Claude hooks and the CLI. Never bound to TCP.
 */
export const IpcRequest = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});
export type IpcRequest = z.infer<typeof IpcRequest>;

export interface IpcError {
  code: string;
  message: string;
}
export type IpcResponse =
  | { id: string | number; result: unknown }
  | { id: string | number; error: IpcError };

export type IpcHandler = (params: unknown) => Promise<unknown> | unknown;

export class IpcMethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IpcMethodError';
  }
}

const MAX_LINE = 1024 * 1024;
const PROBE_TIMEOUT_MS = 2000;

/** Thrown by `IpcServer.listen()` when something is already answering on the socket path. */
export class IpcSocketBusyError extends Error {
  constructor(
    readonly socketPath: string,
    readonly pid: number | undefined,
  ) {
    super(
      pid === undefined
        ? `another daemon is already listening on ${socketPath}`
        : `another daemon is already listening on ${socketPath} (pid ${pid})`,
    );
    this.name = 'IpcSocketBusyError';
  }
}

/**
 * Is a daemon alive behind this socket? Only a refused/missing connection proves it dead;
 * anything that accepts the connection (even without a `status` method) is treated as live,
 * because unlinking a socket someone is bound to silently orphans them.
 */
async function probeSocket(socketPath: string): Promise<{ alive: boolean; pid?: number }> {
  try {
    const res = await new IpcClient(socketPath).call<unknown>(
      'status',
      undefined,
      PROBE_TIMEOUT_MS,
    );
    const pid = (res as { pid?: unknown } | null)?.pid;
    return typeof pid === 'number' ? { alive: true, pid } : { alive: true };
  } catch (err) {
    if (err instanceof IpcClientError && err.code === 'connect') return { alive: false };
    return { alive: true };
  }
}

export interface IpcServerOptions {
  socketPath: string;
  logger?: Logger;
}

export class IpcServer {
  private readonly methods = new Map<string, IpcHandler>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly logger: Logger;
  /** True only while this instance has bound the socket; gates every unlink in `close()`. */
  private bound = false;
  readonly socketPath: string;

  constructor(opts: IpcServerOptions) {
    this.socketPath = opts.socketPath;
    this.logger = opts.logger ?? silentLogger;
  }

  registerMethod(name: string, handler: IpcHandler): void {
    this.methods.set(name, handler);
  }

  methodNames(): string[] {
    return [...this.methods.keys()];
  }

  async listen(): Promise<void> {
    if (Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `IPC socket path is too long (${Buffer.byteLength(this.socketPath)} bytes > ${MAX_SOCKET_PATH_BYTES}): ${this.socketPath}. Use a shorter PAGR_HOME.`,
      );
    }
    if (existsSync(this.socketPath)) {
      // An existing socket is either stale (previous run crashed) or live (another daemon on
      // this home). Only unlink sockets we own AND that nobody answers on.
      const st = statSync(this.socketPath);
      if (!st.isSocket()) throw new Error(`${this.socketPath} exists and is not a socket`);
      if (st.uid !== process.getuid?.())
        throw new Error(`${this.socketPath} owned by another user`);
      const probe = await probeSocket(this.socketPath);
      if (probe.alive) throw new IpcSocketBusyError(this.socketPath, probe.pid);
      this.logger.info('removing stale ipc socket', { socketPath: this.socketPath });
      unlinkSync(this.socketPath);
    }
    const server = createServer((sock) => this.onConnection(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.bound = true;
    chmodSync(this.socketPath, 0o600);
    const st = statSync(this.socketPath);
    if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      await this.close();
      throw new Error('socket ownership/permission check failed');
    }
    this.logger.info('ipc listening', { socketPath: this.socketPath });
  }

  /**
   * Stop listening. The socket file is removed only if this instance bound it: a server whose
   * `listen()` was refused must never unlink the socket a live daemon is serving on.
   */
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    const owned = this.bound;
    this.bound = false;
    // Note: libuv itself unlinks the path when a bound server closes; the explicit unlink below
    // just covers the case where that did not happen.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!owned) return;
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) {
        sock.destroy();
        return;
      }
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) void this.handleLine(sock, line);
        idx = buf.indexOf('\n');
      }
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => this.sockets.delete(sock));
  }

  private async handleLine(sock: Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = IpcRequest.parse(JSON.parse(line));
    } catch {
      this.send(sock, { id: 0, error: { code: 'bad_request', message: 'invalid request' } });
      return;
    }
    const handler = this.methods.get(req.method);
    if (!handler) {
      this.send(sock, { id: req.id, error: { code: 'unknown_method', message: req.method } });
      return;
    }
    try {
      const result = await handler(req.params);
      this.send(sock, { id: req.id, result: result ?? null });
    } catch (err) {
      const code =
        err instanceof IpcMethodError
          ? err.code
          : err instanceof ZodError
            ? 'invalid_params'
            : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('ipc method failed', { method: req.method, code, message });
      this.send(sock, { id: req.id, error: { code, message } });
    }
  }

  private send(sock: Socket, res: IpcResponse): void {
    if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Claude Code Channel bridge  (ADR 0001 mode `approved-channel` — research preview)
// ---------------------------------------------------------------------------
//
// A "channel" is an MCP stdio server Claude Code spawns and pushes events into
// (https://code.claude.com/docs/en/channels-reference, fetched 2026-08-24). The Pagr channel
// server (`@pagr/claude-channel`) is that MCP server; it talks to this daemon over the same
// Unix socket the hooks use. Everything below is additive: nothing here runs unless the
// channel server actually connects and calls these methods.
//
// Two methods:
//   channel.poll     {cwd, cursor?}            → long-poll for texts queued for that project
//   channel.outbound {sessionId?, cwd, text}   → Claude's `reply` tool → cloud → user's phone
//
// A project becomes *channel-attached* on its first `channel.poll`; that is what flips the
// Claude adapter from "queue a follow-up" to real live steering.

/** One queued inbound text, addressed by a per-project monotonic cursor. */
export interface ChannelMessage {
  seq: number;
  text: string;
}

export interface ChannelPollResult {
  cursor: number;
  messages: ChannelMessage[];
}

/** Session identity the daemon has bound to a channel-attached project. */
export interface ChannelSessionBinding {
  cwd: string;
  projectId: string;
}

interface ChannelQueue {
  seq: number;
  messages: ChannelMessage[];
  waiters: Set<() => void>;
  attachedAt: string;
  /** Epoch ms of the last `channel.poll`. 0 for a queue created by an enqueue with no channel. */
  lastPollMs: number;
}

/** Keep the tail only: a channel that stops polling must not grow the daemon's heap. */
const CHANNEL_QUEUE_MAX = 200;
/** Long-poll ceiling. Well under Claude Code's own stdio patience and any proxy idle timeout. */
export const CHANNEL_POLL_TIMEOUT_MS = 25_000;
/**
 * A channel counts as live only while it keeps polling. Two long-poll periods of silence means
 * the user quit that `claude`, and continuing to advertise live steering for it would make the
 * bridge tell the cloud something untrue.
 */
export const CHANNEL_ATTACH_TTL_MS = CHANNEL_POLL_TIMEOUT_MS * 2;

/**
 * In-memory inbound queue + session bindings shared by the daemon's IPC methods and the Claude
 * adapter. Keyed by the *registered project root*, so a channel started in a subdirectory still
 * lands on the same queue. Nothing is persisted: a channel that dies loses its backlog, which is
 * correct — replaying a steer into a session that no longer exists would be worse than dropping it.
 */
export class ChannelBridge {
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly bindings = new Map<string, ChannelSessionBinding>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly attachTtlMs: number = CHANNEL_ATTACH_TTL_MS,
  ) {}

  private queue(cwd: string): ChannelQueue {
    let q = this.queues.get(cwd);
    if (!q) {
      q = {
        seq: 0,
        messages: [],
        waiters: new Set(),
        attachedAt: new Date(this.now()).toISOString(),
        // Not attached until something actually polls: an enqueue alone proves nothing.
        lastPollMs: 0,
      };
      this.queues.set(cwd, q);
    }
    return q;
  }

  /** Mark a project root as served by a live channel. Called on every `channel.poll`. */
  attach(cwd: string): void {
    this.queue(cwd).lastPollMs = this.now();
  }

  /** True only while a channel server has polled within the TTL. */
  isAttached(cwd: string): boolean {
    const q = this.queues.get(cwd);
    return q !== undefined && q.lastPollMs > 0 && this.now() - q.lastPollMs <= this.attachTtlMs;
  }

  attachedProjects(): string[] {
    return [...this.queues.keys()].filter((cwd) => this.isAttached(cwd));
  }

  /** Remember which channel-attached project a `ses_…` belongs to (adapter lookup path). */
  bindSession(sessionId: string, binding: ChannelSessionBinding): void {
    this.bindings.set(sessionId, binding);
  }

  bindingFor(sessionId: string): ChannelSessionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  /** Queue a text for injection and wake any long-poll waiting on this project. */
  enqueue(cwd: string, text: string): ChannelMessage {
    const q = this.queue(cwd);
    q.seq += 1;
    const msg: ChannelMessage = { seq: q.seq, text };
    q.messages.push(msg);
    if (q.messages.length > CHANNEL_QUEUE_MAX)
      q.messages.splice(0, q.messages.length - CHANNEL_QUEUE_MAX);
    for (const wake of [...q.waiters]) wake();
    return msg;
  }

  /** Everything newer than `cursor`, waiting up to `timeoutMs` for the first arrival. */
  async poll(cwd: string, cursor: number, timeoutMs: number): Promise<ChannelPollResult> {
    // Polling *is* the proof of life, so it renews the attachment itself rather than relying on
    // every caller to remember to call `attach` first.
    this.attach(cwd);
    const q = this.queue(cwd);
    const take = (): ChannelPollResult | null => {
      const messages = q.messages.filter((m) => m.seq > cursor);
      if (messages.length === 0) return null;
      return { cursor: messages[messages.length - 1]?.seq ?? cursor, messages };
    };
    const immediate = take();
    if (immediate) return immediate;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        q.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, timeoutMs));
      timer.unref?.();
      q.waiters.add(wake);
    });
    return take() ?? { cursor: Math.min(cursor, q.seq), messages: [] };
  }

  /** Drop every queue and binding (daemon shutdown, tests). */
  reset(): void {
    for (const q of this.queues.values()) for (const wake of [...q.waiters]) wake();
    this.queues.clear();
    this.bindings.clear();
  }
}

let sharedChannelBridge: ChannelBridge | null = null;

/**
 * Process-wide bridge. The daemon and the Claude adapter live in the same process but are
 * wired through different packages, so they meet here rather than through constructor plumbing.
 */
export function getChannelBridge(): ChannelBridge {
  if (!sharedChannelBridge) sharedChannelBridge = new ChannelBridge();
  return sharedChannelBridge;
}

const ChannelPollParams = z.object({
  cwd: z.string().min(1),
  cursor: z.number().int().nonnegative().optional(),
});

const ChannelOutboundParams = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1),
  text: z.string().min(1).max(4000),
});

export interface ChannelIpcDeps {
  bridge?: ChannelBridge;
  /** Map a channel's cwd onto a registered project, or null when it is not registered. */
  resolveProject(cwd: string): { projectId: string; path: string } | null;
  /** Existing local `ses_…` ids for this project, bound so live steering can find the queue. */
  claudeSessionsIn(projectId: string): string[];
  /** Mint (or reuse) the local session id representing this interactive Claude Code session. */
  ensureSession(input: { projectId: string; sessionId?: string | undefined }): string;
  /** Emit a `session.event` of kind `agent_message` so the cloud texts the user. */
  emitAgentMessage(input: { sessionId: string; projectId: string; text: string }): void;
  pollTimeoutMs?: number;
}

/**
 * Register `channel.poll` and `channel.outbound` on an existing IPC server. Purely additive —
 * no existing method changes behaviour, and a daemon that never registers these is unaffected.
 */
export function registerChannelMethods(ipc: IpcServer, deps: ChannelIpcDeps): ChannelBridge {
  const bridge = deps.bridge ?? getChannelBridge();
  const timeoutMs = deps.pollTimeoutMs ?? CHANNEL_POLL_TIMEOUT_MS;

  const project = (cwd: string) => {
    const rec = deps.resolveProject(cwd);
    if (!rec) throw new IpcMethodError('unknown_project', 'cwd is not inside a registered project');
    return rec;
  };

  ipc.registerMethod('channel.poll', async (params) => {
    const p = ChannelPollParams.parse(params);
    const rec = project(p.cwd);
    bridge.attach(rec.path);
    // Re-bind on every poll: a session minted after the channel started (permission hook,
    // cloud-started turn) becomes steerable within one poll interval.
    for (const sessionId of deps.claudeSessionsIn(rec.projectId))
      bridge.bindSession(sessionId, { cwd: rec.path, projectId: rec.projectId });
    const res = await bridge.poll(rec.path, p.cursor ?? 0, timeoutMs);
    return { ...res, projectId: rec.projectId, projectPath: rec.path };
  });

  ipc.registerMethod('channel.outbound', (params) => {
    const p = ChannelOutboundParams.parse(params);
    const rec = project(p.cwd);
    const sessionId = deps.ensureSession({ projectId: rec.projectId, sessionId: p.sessionId });
    bridge.bindSession(sessionId, { cwd: rec.path, projectId: rec.projectId });
    deps.emitAgentMessage({ sessionId, projectId: rec.projectId, text: p.text });
    return { ok: true, sessionId, projectId: rec.projectId };
  });

  return bridge;
}

export class IpcClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IpcClientError';
  }
}

/** One-shot client: opens a connection per call. Fine for hooks and CLI. */
export class IpcClient {
  private seq = 0;
  constructor(private readonly socketPath: string) {}

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let buf = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new IpcClientError('timeout', `${method} timed out`))),
        timeoutMs,
      );
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(`${JSON.stringify({ id, method, params })}\n`));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        const line = buf.slice(0, idx);
        try {
          const res = JSON.parse(line) as IpcResponse;
          if ('error' in res)
            finish(() => reject(new IpcClientError(res.error.code, res.error.message)));
          else finish(() => resolve(res.result as T));
        } catch {
          finish(() => reject(new IpcClientError('bad_response', 'unparsable response')));
        }
      });
      sock.on('error', (e) => finish(() => reject(new IpcClientError('connect', e.message))));
      sock.on('close', () =>
        finish(() => reject(new IpcClientError('closed', 'connection closed'))),
      );
    });
  }
}
