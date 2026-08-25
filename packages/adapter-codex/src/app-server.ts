import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
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

export interface AppServerOptions {
  /** Full argv used to launch the server, e.g. `['codex', 'app-server']`. */
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  requestTimeoutMs?: number;
  logger: FileLogger;
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

/**
 * One `codex app-server` child speaking JSONL JSON-RPC over stdio.
 * Owns the initialize handshake; exposes request/notify; surfaces server requests + notifications.
 */
export class AppServerClient extends EventEmitter<AppServerEvents> {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private lines = new LineBuffer();
  private closing = false;
  private ready: Promise<InitializeResponse> | null = null;

  constructor(private readonly opts: AppServerOptions) {
    super();
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Spawn (if needed) and complete the initialize handshake. Idempotent. */
  start(): Promise<InitializeResponse> {
    if (this.ready && this.running) return this.ready;
    this.ready = this.spawnAndInit();
    return this.ready;
  }

  private spawnAndInit(): Promise<InitializeResponse> {
    const [bin, ...args] = this.opts.command;
    if (!bin) throw new Error('app-server command is empty');
    this.closing = false;
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (this.opts.cwd) spawnOpts.cwd = this.opts.cwd;
    if (this.opts.env) spawnOpts.env = this.opts.env;
    const child = spawn(bin, args, spawnOpts);
    this.child = child;
    this.lines = new LineBuffer();
    this.opts.logger.log('info', 'app-server spawned', { pid: child.pid ?? null, bin });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) this.onLine(line);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // stderr is tracing output; keep it short and never at info level.
      this.opts.logger.log('warn', `app-server stderr: ${chunk.trim().slice(0, 300)}`);
    });
    child.on('error', (err) => {
      this.opts.logger.log('error', 'app-server spawn error', { message: err.message });
      this.failAllPending(new Error(`app-server error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      const expected = this.closing;
      this.opts.logger.log(expected ? 'info' : 'error', 'app-server exited', { code, signal });
      this.failAllPending(new Error(`app-server exited (code ${code}, signal ${signal})`));
      this.child = null;
      this.ready = null;
      this.emit('exit', { code, signal, expected });
    });

    const params: InitializeParams = {
      clientInfo: { name: 'pagr-bridge', title: 'Pagr', version: this.opts.clientVersion },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    return this.request<InitializeResponse>(METHODS.initialize, params).then((res) => {
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
    const child = this.child;
    if (!child?.stdin || child.exitCode !== null) {
      return Promise.reject(new Error('app-server not running'));
    }
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
      child.stdin?.write(encode({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.child?.stdin?.write(encode({ method, params }));
  }

  /** Answer a server → client request. */
  respond(id: RpcId, result: unknown): void {
    this.opts.logger.log('info', 'respond', { id });
    this.child?.stdin?.write(encode({ id, result }));
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.child?.stdin?.write(encode({ id, error: { code, message } }));
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.stdin?.end();
      const t = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }, 1500);
      t.unref();
      child.once('exit', () => clearTimeout(t));
    });
    this.child = null;
    this.ready = null;
  }
}
