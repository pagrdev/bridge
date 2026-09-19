import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted reply. Everything is optional so a test only spells out what it cares about.
 * `reset` destroys the TCP socket mid-flight; `delayMs` holds the response open.
 */
export interface Reply {
  status?: number;
  json?: unknown;
  /** Raw body; wins over `json`. Use for HTML pages and truncated JSON. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Kill the connection without replying (mid-poll connection reset). */
  reset?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeApiOptions {
  /** Replies for POST /v1/devices/pair/start; the last one repeats. */
  start?: Reply[];
  /** Replies for GET /v1/devices/pair/status/:id; the last one repeats. */
  status?: Reply[];
  /** Reply for GET /v1/health. */
  health?: Reply;
  /** Replies for GET /v1/messaging/line; the last one repeats. */
  line?: Reply[];
}

/** The account-side facts the enriched pair status carries. Defaults to "nothing done yet". */
export interface OnboardingOver {
  entitled?: boolean;
  messagingLinked?: boolean;
  hasProject?: boolean;
  claudeConnected?: boolean;
  codexConnected?: boolean;
}

export const PRODUCT_NUMBER = '+15550101234';

export const onboarding = (over: OnboardingOver = {}) => ({
  entitled: false,
  messagingLinked: false,
  hasProject: false,
  claudeConnected: false,
  codexConnected: false,
  ...over,
});

export const DEV_ID = `dev_${'a'.repeat(32)}`;
export const USER_ID = `usr_${'b'.repeat(32)}`;

export const startOk = (over: Record<string, unknown> = {}): Reply => ({
  json: {
    pairingId: 'pr_1',
    code: 'ABCD-EFGH',
    pairUrl: 'http://localhost:3000/device/pair?code=ABCD-EFGH',
    expiresAt: '2030-01-01T00:00:00Z',
    ...over,
  },
});

export const statusPending = (): Reply => ({ json: { status: 'pending' } });

export const statusCompleted = (over: Record<string, unknown> = {}): Reply => ({
  json: {
    status: 'completed',
    deviceId: DEV_ID,
    userId: USER_ID,
    gatewayUrl: 'wss://gw.example/ws',
    serverKeys: { k1: 'AAAA' },
    ...over,
  },
});

/**
 * A completed pairing from an api that also reports the account state (build-list ticket 6).
 * `productNumber: null` is the shared-pool case, where there is no number to print or encode.
 */
export const statusCompletedWithOnboarding = (
  over: OnboardingOver = {},
  productNumber: string | null = PRODUCT_NUMBER,
): Reply => statusCompleted({ onboarding: onboarding(over), productNumber });

export const lineOk = (productNumber: string | null = PRODUCT_NUMBER): Reply => ({
  json: { productNumber },
});

/**
 * A real `node:http` server on an ephemeral port, so `pagr connect` is exercised over actual
 * HTTP — sockets, headers, chunked bodies and all — instead of a hand-written fetch stub.
 */
export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  private startIdx = 0;
  private statusIdx = 0;
  private lineIdx = 0;
  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly opts: FakeApiOptions,
  ) {}

  static async start(opts: FakeApiOptions = {}): Promise<FakeApi> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = new FakeApi(server, (server.address() as AddressInfo).port, opts);
    server.on('request', (req, res) => void api.handle(req, res));
    return api;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Requests to the pairing endpoints only, in order. */
  paths(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  private next(list: Reply[] | undefined, idx: number, fallback: Reply): Reply {
    if (!list || list.length === 0) return fallback;
    return list[Math.min(idx, list.length - 1)] ?? fallback;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '';
    const body = await readBody(req);
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      body,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    let reply: Reply;
    if (path.endsWith('/v1/devices/pair/start')) {
      reply = this.next(this.opts.start, this.startIdx++, startOk());
    } else if (path.includes('/v1/devices/pair/status/')) {
      reply = this.next(this.opts.status, this.statusIdx++, statusCompleted());
    } else if (path.endsWith('/v1/messaging/line')) {
      reply = this.next(this.opts.line, this.lineIdx++, {
        status: 404,
        json: { error: 'no_line' },
      });
    } else if (path.endsWith('/v1/health')) {
      reply = this.opts.health ?? { json: { ok: true } };
    } else {
      reply = { status: 404, json: { error: 'not_found' } };
    }
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs).unref?.());
    if (reply.reset) {
      req.socket.destroy();
      return;
    }
    const payload = reply.text ?? JSON.stringify(reply.json ?? {});
    res.writeHead(reply.status ?? 200, {
      'content-type': reply.contentType ?? 'application/json',
      ...(reply.headers ?? {}),
    });
    res.end(payload);
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/** A port nothing is listening on — for the "API unreachable" cases. */
export async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
