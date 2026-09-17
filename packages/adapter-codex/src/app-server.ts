import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { classifyLine, encode, LineBuffer } from './jsonrpc.js';
import type { FileLogger } from './logger.js';
import {
  type InitializeParams,
  type InitializeResponse,
  METHODS,
  type RpcId,
  type RpcNotification,
  type RpcRequest,
} from './protocol.js';

/**
 * How this client reaches an app-server.
 *
 * `stdio` is the private child the bridge spawns and owns. `daemon` is the shared app-server the
 * user already runs, reached over its Unix control socket — which speaks WebSocket, one JSON-RPC
 * message per text frame (MOB-043 finding 3). Both carry exactly the same payloads: `encode()`'s
 * bytes, `classifyLine()`'s parsing, the same handshake.
 */
export type AppServerTransportSpec =
  | { kind: 'stdio'; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  | { kind: 'daemon'; socketPath: string };

export interface AppServerOptions {
  /** How to reach the server. Defaults to a `stdio` child built from `command`. */
  transport?: AppServerTransportSpec;
  /** Full argv used to launch the server, e.g. `['codex', 'app-server']`. */
  command?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  requestTimeoutMs?: number;
  logger: FileLogger;
  /**
   * `initialize.capabilities.experimentalApi`. `thread/loaded/list`, `thread/unsubscribe` and
   * `useStateDbOnly` are experimental-era APIs (spike risk 6), so the mirror asks for them.
   */
  experimentalApi?: boolean;
}

export interface AppServerEvents {
  notification: [RpcNotification];
  /** Server → client request. Handler MUST eventually call `respond(id, result)`. */
  request: [RpcRequest];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** What the two transports have to provide. Neither parses anything. */
interface Transport {
  readonly kind: 'stdio' | 'daemon';
  readonly running: boolean;
  /** Resolves once the link can carry a message. */
  open(): Promise<void>;
  write(payload: string): void;
  close(): Promise<void>;
}

interface TransportHooks {
  onMessage(text: string): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void;
  onError(err: Error): void;
}

/** The private `codex app-server` child: JSONL JSON-RPC over stdio. */
class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  private child: ChildProcess | null = null;
  private lines = new LineBuffer();

  constructor(
    private readonly spec: Extract<AppServerTransportSpec, { kind: 'stdio' }>,
    private readonly logger: FileLogger,
    private readonly hooks: TransportHooks,
  ) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  open(): Promise<void> {
    const [bin, ...args] = this.spec.command;
    if (!bin) throw new Error('app-server command is empty');
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (this.spec.cwd) spawnOpts.cwd = this.spec.cwd;
    if (this.spec.env) spawnOpts.env = this.spec.env;
    const child = spawn(bin, args, spawnOpts);
    this.child = child;
    this.lines = new LineBuffer();
    this.logger.log('info', 'app-server spawned', { pid: child.pid ?? null, bin });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) this.hooks.onMessage(line);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // stderr is tracing output; keep it short and never at info level.
      this.logger.log('warn', `app-server stderr: ${chunk.trim().slice(0, 300)}`);
    });
    child.on('error', (err) => this.hooks.onError(err));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.hooks.onExit({ code, signal });
    });
    // The child accepts stdin the moment it exists; no handshake to wait for.
    return Promise.resolve();
  }

  write(payload: string): void {
    this.child?.stdin?.write(payload);
  }

  close(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.stdin?.end();
      const t = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }, 1500);
      t.unref();
      child.once('exit', () => clearTimeout(t));
    }).then(() => {
      this.child = null;
    });
  }
}

/** Handshake budget for the control socket; the daemon's own client allows 2 s end to end. */
const DAEMON_HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * The shared daemon's Unix control socket, as a WebSocket client.
 *
 * `ws+unix://<path>:/` is `ws`'s own spelling for "dial this Unix socket, request path `/`" —
 * exactly what the daemon's Rust client does (`connect_at(socket_path, "ws://localhost/")`).
 * Server → client pings are answered automatically by `ws`, which is required: the spike found
 * the server pings and drops clients that do not pong.
 */
class DaemonTransport implements Transport {
  readonly kind = 'daemon' as const;
  private ws: WebSocket | null = null;
  private opened = false;

  constructor(
    private readonly spec: Extract<AppServerTransportSpec, { kind: 'daemon' }>,
    private readonly logger: FileLogger,
    private readonly hooks: TransportHooks,
    private readonly handshakeTimeoutMs = DAEMON_HANDSHAKE_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.opened && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  open(): Promise<void> {
    const url = `ws+unix://${this.spec.socketPath}:/`;
    const ws = new WebSocket(url, { handshakeTimeout: this.handshakeTimeoutMs });
    this.ws = ws;
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // One JSON-RPC message per text frame. A binary frame is not something the app-server
      // sends; ignoring it is safer than feeding arbitrary bytes to the parser.
      if (isBinary) return;
      this.hooks.onMessage(data.toString());
    });
    ws.on('close', (code: number) => {
      this.opened = false;
      this.ws = null;
      this.hooks.onExit({ code, signal: null });
    });
    ws.on('error', (err: Error) => this.hooks.onError(err));
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.opened = true;
        this.logger.log('info', 'attached to the codex app-server daemon', {
          socketPath: this.spec.socketPath,
        });
        ws.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(new Error(`codex daemon socket: ${err.message}`));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  write(payload: string): void {
    // The daemon frames messages itself, so the JSONL newline would be trailing junk inside
    // the frame. Same bytes otherwise — `encode()` is shared with the stdio path.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload.replace(/\n$/, ''));
  }

  close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.once('close', done);
      try {
        ws.close();
      } catch {
        resolve();
      }
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        resolve();
      }, 1000);
      t.unref();
    }).then(() => {
      this.ws = null;
      this.opened = false;
    });
  }
}

/**
 * One app-server connection speaking JSON-RPC (no `jsonrpc` header), over a private stdio child
 * or over the shared daemon's control socket. Owns the initialize handshake; exposes
 * request/notify; surfaces server requests + notifications.
 */
export class AppServerClient extends EventEmitter<AppServerEvents> {
  private transport: Transport | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closing = false;
  private ready: Promise<InitializeResponse> | null = null;
  private readonly spec: AppServerTransportSpec;

  constructor(private readonly opts: AppServerOptions) {
    super();
    if (opts.transport) this.spec = opts.transport;
    else {
      if (!opts.command) throw new Error('app-server needs a transport or a command');
      this.spec = {
        kind: 'stdio',
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      };
    }
  }

  get running(): boolean {
    return this.transport?.running === true;
  }

  /** Which of the two links this client is: what `probe()` reports as its mode. */
  get mode(): 'app-server-daemon' | 'app-server-embedded' {
    return this.spec.kind === 'daemon' ? 'app-server-daemon' : 'app-server-embedded';
  }

  /** Connect (if needed) and complete the initialize handshake. Idempotent. */
  start(): Promise<InitializeResponse> {
    if (this.ready && this.running) return this.ready;
    this.ready = this.connectAndInit();
    return this.ready;
  }

  private connectAndInit(): Promise<InitializeResponse> {
    this.closing = false;
    const hooks: TransportHooks = {
      onMessage: (text) => this.onLine(text),
      onError: (err) => {
        this.opts.logger.log('error', 'app-server transport error', { message: err.message });
        this.failAllPending(new Error(`app-server error: ${err.message}`));
      },
      onExit: ({ code, signal }) => {
        const expected = this.closing;
        this.opts.logger.log(expected ? 'info' : 'error', 'app-server link closed', {
          code,
          signal,
          transport: this.spec.kind,
        });
        this.failAllPending(new Error(`app-server exited (code ${code}, signal ${signal})`));
        this.transport = null;
        this.ready = null;
        this.emit('exit', { code, signal, expected });
      },
    };
    const transport: Transport =
      this.spec.kind === 'daemon'
        ? new DaemonTransport(this.spec, this.opts.logger, hooks)
        : new StdioTransport(this.spec, this.opts.logger, hooks);
    this.transport = transport;

    const params: InitializeParams = {
      clientInfo: { name: 'pagr-bridge', title: 'Pagr', version: this.opts.clientVersion },
      capabilities: {
        experimentalApi: this.opts.experimentalApi ?? false,
        requestAttestation: false,
      },
    };
    return transport
      .open()
      .then(() => this.request<InitializeResponse>(METHODS.initialize, params))
      .then((res) => {
        this.notify(METHODS.initialized);
        this.opts.logger.log('info', 'app-server initialized', { userAgent: res.userAgent });
        return res;
      });
  }

  private onLine(line: string): void {
    const c = classifyLine(line);
    switch (c.kind) {
      case 'response': {
        const p = this.pending.get(c.msg.id);
        if (!p) {
          this.opts.logger.log('warn', 'response for unknown id', { id: c.msg.id });
          return;
        }
        this.pending.delete(c.msg.id);
        clearTimeout(p.timer);
        if (c.msg.error) {
          p.reject(new Error(`${p.method} failed: ${c.msg.error.message} (${c.msg.error.code})`));
        } else {
          p.resolve(c.msg.result);
        }
        return;
      }
      case 'request':
        this.opts.logger.log('info', 'server request', { id: c.msg.id, method: c.msg.method });
        this.emit('request', c.msg);
        return;
      case 'notification':
        this.emit('notification', c.msg);
        return;
      case 'invalid':
        if (c.reason !== 'empty') {
          this.opts.logger.log('warn', 'unparseable line', { reason: c.reason });
        }
        return;
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const transport = this.transport;
    if (!transport?.running) return Promise.reject(new Error('app-server not running'));
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      // Never log params: account/* and thread/* params can be sensitive.
      this.opts.logger.log('info', 'request', { id, method });
      transport.write(encode({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport?.write(encode({ method, params }));
  }

  /** Answer a server → client request. */
  respond(id: RpcId, result: unknown): void {
    this.opts.logger.log('info', 'respond', { id });
    this.transport?.write(encode({ id, result }));
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.transport?.write(encode({ id, error: { code, message } }));
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.closing = true;
    await transport.close();
    this.transport = null;
    this.ready = null;
  }
}
