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
