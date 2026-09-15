import { EventEmitter } from 'node:events';
import {
  type BridgeFrame,
  canonicalize,
  type DeviceEvent,
  GatewayFrame,
  PROTOCOL_VERSION,
  SERVER_KEY_SET_CONTEXT,
} from '@pagr/protocol';
import WebSocket from 'ws';
import { compareVersions, makeEvent } from './events.js';
import type { DeviceIdentity } from './identity.js';
import { verifyRaw } from './identity.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  /** Another connection authenticated with this device identity; waiting out a long backoff. */
  | 'displaced'
  | 'blocked'
  /** The gateway refused this identity for good (revoked / wrong key). No further attempts. */
  | 'unauthorized'
  | 'stopped';

/** The gateway closes the older socket with this code when a newer one takes the identity. */
export const CLOSE_REPLACED = 4000;
/** The handshake failed or did not complete in time. */
export const CLOSE_AUTH_FAILED = 4001;
/** The bridge is below the gateway's `minBridgeVersion`. */
export const CLOSE_VERSION_BLOCKED = 4002;

/**
 * The gateway's inbound frame cap (`maxPayload`). A larger frame is not rejected politely — the
 * peer closes with 1009, which used to mean an oversized `device.hello` produced an endless
 * reconnect loop. Nothing oversized is ever put on the wire (BR-3).
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * `auth.result.error` codes that will never resolve by trying again: the gateway is refusing
 * THIS identity, not this attempt. Everything else — a rate limit, an expired nonce, a frame the
 * gateway did not like — is transient and keeps its backoff (BR-5, BR-23).
 */
export const FATAL_AUTH_ERRORS = new Set([
  /** The device was revoked (or deleted) in the dashboard. */
  'revoked',
  /** The signature did not verify against the key the gateway holds for this device. */
  'bad_signature',
  /** The `auth.response` named a different device than the `auth.request`. */
  'device_mismatch',
  /** This bridge speaks a protocol version the gateway will not accept. */
  'protocol_version',
]);

export interface AuthFailure {
  /** The gateway's machine-readable `auth.result.error`, or `unknown` when it sent none. */
  code: string;
  /** True when retrying cannot help: the device must be re-paired or updated. */
  fatal: boolean;
  /** Plain-language reason, safe to log and to show in `pagr status`. */
  reason: string;
}

const AUTH_REASONS: Record<string, string> = {
  revoked: 'this device was revoked — re-pair with `pagr connect`',
  bad_signature: 'the gateway does not recognise this device key — re-pair with `pagr connect`',
  device_mismatch: 'the gateway answered for a different device id — re-pair with `pagr connect`',
  protocol_version: 'this bridge is too old for the gateway — update the pagr CLI',
  rate_limited:
    'too many authentication attempts from this network — backing off, this is not a revocation',
  nonce_expired: 'the handshake took too long (clock skew or a slow link) — retrying',
  nonce_mismatch: 'the gateway answered a different challenge — retrying',
};

/** Classify an `auth.result{ok:false}`. Unknown codes are treated as transient on purpose. */
export function classifyAuthFailure(error: string | undefined): AuthFailure {
  const code = error?.length ? error : 'unknown';
  const fatal = FATAL_AUTH_ERRORS.has(code);
  return {
    code,
    fatal,
    reason:
      AUTH_REASONS[code] ?? (fatal ? `authentication refused (${code})` : `retrying (${code})`),
  };
}

export interface GatewayClientOptions {
  url: string;
  identity: DeviceIdentity & { deviceId: string };
  bridgeVersion: string;
  onCommand: (envelope: unknown) => void;
  /** Called only when an ACCEPTED key set differs from the pinned one. Persisting is the caller's job. */
  onServerKeys?: (keys: Record<string, string>) => void;
  activeSessions?: () => number;
  /** Heartbeat + liveness probe period. Default 20 s. */
  heartbeatMs?: number;
  /**
   * How long the peer may be silent — no frame, no WebSocket pong — before the socket is
   * considered half-open and torn down. Default 3 × `heartbeatMs` (BR-15).
   */
  livenessTimeoutMs?: number;
  /** How long the authentication phase may take before the socket is torn down. Default 20 s (BR-22). */
  authTimeoutMs?: number;
  backoff?: {
    baseMs?: number;
    maxMs?: number;
    /** Floor after a rate-limited handshake. Default 60 s. */
    rateLimitedMs?: number;
    /** Floor after being replaced by another connection on this identity. Default 5 min. */
    replacedMs?: number;
  };
  bufferLimit?: number;
  /** Largest frame that may be sent. Default `MAX_FRAME_BYTES`. */
  maxFrameBytes?: number;
  logger?: Logger;
  random?: () => number;
  now?: () => Date;
  /** Injectable for tests. */
  WebSocketCtor?: typeof WebSocket;
  /** Monotonic-ish clock for the liveness watchdog. Tests override it. */
  monotonicNow?: () => number;
  /**
   * Server keys pinned from pairing / a previous `auth.result`. A set that adds or changes a key
   * is only accepted with a `serverKeysSignature` from a key that is already pinned.
   */
  serverKeys?: Record<string, string>;
  /** Environment used for the transport-security checks (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The gateway URL must be `wss://`. Plain `ws://` is only allowed for local development
 * (`PAGR_ENV=local`) or with the explicit `PAGR_ALLOW_INSECURE_WS=1` escape hatch.
 */
export function assertSecureGatewayUrl(url: string, env: NodeJS.ProcessEnv = process.env): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid gateway url: ${url}`);
  }
  if (parsed.protocol === 'wss:') return;
  const insecureOk = env.PAGR_ENV === 'local' || env.PAGR_ALLOW_INSECURE_WS === '1';
  if (parsed.protocol === 'ws:' && insecureOk) return;
  throw new Error(
    `gateway url must use wss:// (got ${parsed.protocol}//); set PAGR_ENV=local or PAGR_ALLOW_INSECURE_WS=1 to allow ws:// for local development`,
  );
}

export interface ServerKeySignature {
  keyId: string;
  signature: string;
}

export type ServerKeyDecision =
  | { accept: true; reason: 'first-pin' | 'unchanged' | 'narrowed' | 'signed' }
  | { accept: false; reason: 'unsigned-change' | 'unknown-signer' | 'bad-signature' };

/** True when `incoming` grants no trust `pinned` did not already grant. */
export function isNarrowingKeySet(
  pinned: Record<string, string>,
  incoming: Record<string, string>,
): boolean {
  return Object.entries(incoming).every(([id, key]) => pinned[id] === key);
}

export const sameKeySet = (a: Record<string, string>, b: Record<string, string>): boolean =>
  canonicalize(a) === canonicalize(b);

/**
 * Decide whether an `auth.result` may replace the pinned server key set (SEC-7).
 *
 * The old rule — "accept any set that overlaps the pinned one by a single key" — let anybody who
 * obtained one server key hand the bridge an extra key of their own, which the bridge then
 * persisted and trusted forever. `auth.result` is not itself signed, so it cannot authenticate a
 * widening of trust on its own.
 *
 * What is safe unsigned is anything that grants no NEW trust: the same set again, or a smaller
 * one (the retiring half of a rotation). Adding a key id, or changing what a pinned id maps to,
 * must carry `serverKeysSignature` — a signature by a key the bridge already trusts over
 * `SERVER_KEY_SET_CONTEXT + canonicalize(incoming)`. That keeps rotation working (publish the new
 * key signed by the outgoing one, then drop the outgoing one unsigned) while making additive
 * poisoning impossible for anyone who does not hold a trusted private key.
 */
export function evaluateServerKeys(
  pinned: Record<string, string>,
  incoming: Record<string, string>,
  signature?: ServerKeySignature | undefined,
): ServerKeyDecision {
  if (Object.keys(pinned).length === 0) return { accept: true, reason: 'first-pin' };
  if (sameKeySet(pinned, incoming)) return { accept: true, reason: 'unchanged' };
  if (isNarrowingKeySet(pinned, incoming)) return { accept: true, reason: 'narrowed' };
  if (!signature) return { accept: false, reason: 'unsigned-change' };
  const signer = pinned[signature.keyId];
  if (!signer) return { accept: false, reason: 'unknown-signer' };
  const payload = `${SERVER_KEY_SET_CONTEXT}${canonicalize(incoming)}`;
  return verifyRaw(signer, payload, signature.signature)
    ? { accept: true, reason: 'signed' }
    : { accept: false, reason: 'bad-signature' };
}

export interface GatewayClientEvents {
  connected: [];
  disconnected: [reason: string];
  auth_failed: [error: string, failure: AuthFailure];
  blocked: [minBridgeVersion: string];
  /** Another connection authenticated with this device identity and evicted this one. */
  replaced: [retryInMs: number];
}

/**
 * Outbound WebSocket client to the Pagr gateway. Auth: `auth.request` → `auth.challenge`
 * → sign `${deviceId}.${nonce}` → `auth.response` → `auth.result`. Reconnects with
 * exponential backoff + jitter; buffers up to `bufferLimit` events while offline.
 * The bridge never listens on a port — every connection is outbound.
 */
export class GatewayClient extends EventEmitter<GatewayClientEvents> {
  private ws: WebSocket | null = null;
  private state_: TransportState = 'idle';
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  /** Minimum delay for the NEXT reconnect, set by a rate limit or an identity takeover. */
  private retryFloorMs = 0;
  private lastInboundMs = 0;
  private readonly buffer: DeviceEvent[] = [];
  private readonly logger: Logger;
  private readonly heartbeatMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly rateLimitedMs: number;
  private readonly replacedMs: number;
  private readonly bufferLimit: number;
  private readonly maxFrameBytes: number;
  private readonly random: () => number;
  private readonly monotonicNow: () => number;
  private readonly WS: typeof WebSocket;
  serverKeys: Record<string, string> = {};
  /** Why the transport is in a terminal state, for `pagr status` and the logs. */
  lastFailure: AuthFailure | null = null;

  constructor(private readonly opts: GatewayClientOptions) {
    super();
    assertSecureGatewayUrl(opts.url, opts.env);
    this.serverKeys = { ...(opts.serverKeys ?? {}) };
    this.logger = opts.logger ?? silentLogger;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? this.heartbeatMs * 3;
    this.authTimeoutMs = opts.authTimeoutMs ?? 20_000;
    this.baseMs = opts.backoff?.baseMs ?? 1000;
    this.maxMs = opts.backoff?.maxMs ?? 60_000;
    this.rateLimitedMs = opts.backoff?.rateLimitedMs ?? 60_000;
    this.replacedMs = opts.backoff?.replacedMs ?? 300_000;
    this.bufferLimit = opts.bufferLimit ?? 500;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.random = opts.random ?? Math.random;
    this.monotonicNow = opts.monotonicNow ?? (() => Date.now());
    this.WS = opts.WebSocketCtor ?? WebSocket;
  }

  get state(): TransportState {
    return this.state_;
  }
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** States the client will never leave on its own; only `start()` clears them. */
  private terminal(): boolean {
    return this.state_ === 'stopped' || this.state_ === 'blocked' || this.state_ === 'unauthorized';
  }

  start(): void {
    if (this.terminal()) {
      this.state_ = 'idle';
      this.lastFailure = null;
      this.attempt = 0;
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.state_ = 'stopped';
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === this.WS.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close(1000, 'bridge stopping');
        setTimeout(resolve, 500).unref();
      });
    } else ws?.terminate();
  }

  /** Queue or send an event. Returns false if the event was dropped (buffer full, or oversized). */
  sendEvent(event: DeviceEvent): boolean {
    if (this.state_ === 'connected' && this.ws?.readyState === this.WS.OPEN) {
      return this.sendFrame({ kind: 'event', event });
    }
    if (this.buffer.length >= this.bufferLimit) {
      this.buffer.shift();
      this.buffer.push(event);
      return false;
    }
    this.buffer.push(event);
    return true;
  }

  /** Delay before the next attempt: min(max, base·2^n) with ±50% jitter. */
  nextDelayMs(attempt: number): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** attempt);
    const jitter = exp * (0.5 + this.random());
    return Math.min(this.maxMs, Math.round(jitter));
  }

  private connect(): void {
    if (this.terminal()) return;
    this.state_ = 'connecting';
    let ws: WebSocket;
    try {
      ws = new this.WS(this.opts.url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.onClose(`connect error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.state_ = 'authenticating';
      this.touch();
      this.startAuthDeadline();
      this.sendFrame({ kind: 'auth.request', deviceId: this.opts.identity.deviceId });
    });
    ws.on('message', (data) => {
      this.touch();
      this.onMessage(data.toString());
    });
    ws.on('pong', () => this.touch());
    ws.on('ping', () => this.touch());
    ws.on('error', (err) => this.logger.warn('gateway socket error', { error: err.message }));
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.onClose(`close ${code} ${reason.toString()}`, code);
    });
  }

  private touch(): void {
    this.lastInboundMs = this.monotonicNow();
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn('gateway sent non-JSON frame');
      return;
    }
    const parsed = GatewayFrame.safeParse(json);
    if (!parsed.success) {
      this.logger.warn('gateway sent invalid frame', { issue: parsed.error.issues[0]?.message });
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case 'auth.challenge': {
        const signature = this.opts.identity.sign(`${this.opts.identity.deviceId}.${frame.nonce}`);
        this.sendFrame({
          kind: 'auth.response',
          deviceId: this.opts.identity.deviceId,
          nonce: frame.nonce,
          signature,
          bridgeVersion: this.opts.bridgeVersion,
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }
      case 'auth.result': {
        this.clearAuthDeadline();
        if (!frame.ok) {
          this.onAuthRefused(frame.error);
          return;
        }
        if (
          frame.minBridgeVersion &&
          compareVersions(this.opts.bridgeVersion, frame.minBridgeVersion) < 0
        ) {
          this.logger.error('bridge version blocked by gateway', {
            minBridgeVersion: frame.minBridgeVersion,
          });
          this.state_ = 'blocked';
          this.emit('blocked', frame.minBridgeVersion);
          this.ws?.close(CLOSE_VERSION_BLOCKED, 'version blocked');
          return;
        }
        if (frame.serverKeys) this.applyServerKeys(frame.serverKeys, frame.serverKeysSignature);
        this.state_ = 'connected';
        this.attempt = 0;
        this.retryFloorMs = 0;
        this.lastFailure = null;
        this.touch();
        this.flush();
        this.startHeartbeat();
        this.emit('connected');
        return;
      }
      case 'ping':
        this.sendFrame({ kind: 'pong' });
        return;
      case 'command':
        // Guarding happens downstream; the transport only enforces the frame shape.
        this.opts.onCommand(frame.envelope);
        return;
    }
  }

  /**
   * A refusal the gateway owns the meaning of. Only a refusal of this IDENTITY stops the client;
   * "too many attempts from your address" is a refusal of this MOMENT and keeps retrying, because
   * every bridge behind one office NAT trips that limiter together (BR-5, BR-23).
   */
  private onAuthRefused(error: string | undefined): void {
    const failure = classifyAuthFailure(error);
    this.lastFailure = failure;
    const ws = this.ws;
    if (failure.fatal) {
      this.logger.error('gateway refused this device; not reconnecting', {
        error: failure.code,
        reason: failure.reason,
      });
      this.state_ = 'unauthorized';
      this.emit('auth_failed', failure.code, failure);
      this.ws = null;
      ws?.close(CLOSE_AUTH_FAILED, 'auth failed');
      this.clearTimers();
      return;
    }
    this.logger.warn('gateway refused the handshake for now; will retry', {
      error: failure.code,
      reason: failure.reason,
    });
    if (failure.code === 'rate_limited') this.retryFloorMs = this.rateLimitedMs;
    this.emit('auth_failed', failure.code, failure);
    ws?.close(CLOSE_AUTH_FAILED, 'auth refused');
  }

  private applyServerKeys(
    incoming: Record<string, string>,
    signature: ServerKeySignature | undefined,
  ): void {
    const decision = evaluateServerKeys(this.serverKeys, incoming, signature);
    if (!decision.accept) {
      this.logger.error(
        'refusing a server key set that would widen trust without a signature from a pinned key',
        {
          reason: decision.reason,
          pinned: Object.keys(this.serverKeys),
          offered: Object.keys(incoming),
        },
      );
      return;
    }
    if (sameKeySet(this.serverKeys, incoming)) return;
    this.logger.info('server key set updated', {
      reason: decision.reason,
      keys: Object.keys(incoming),
    });
    this.serverKeys = { ...incoming };
    this.opts.onServerKeys?.({ ...incoming });
  }

  private flush(): void {
    while (this.buffer.length && this.ws?.readyState === this.WS.OPEN) {
      const ev = this.buffer.shift();
      if (ev) this.sendFrame({ kind: 'event', event: ev });
    }
  }

  /**
   * One timer does three jobs: the application heartbeat, a WebSocket ping, and the liveness
   * check. A sleeping laptop or a NAT that forgot the flow leaves a socket that still reads as
   * OPEN while the gateway has already dropped the device; without this, commands queue behind a
   * connection that will never deliver them and `pagr status` says `connected` (BR-15).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state_ !== 'connected') return;
      const silentMs = this.monotonicNow() - this.lastInboundMs;
      if (silentMs > this.livenessTimeoutMs) {
        this.logger.warn('gateway stopped answering; tearing the connection down', { silentMs });
        const ws = this.ws;
        this.ws = null;
        ws?.terminate();
        this.onClose(`no response from gateway for ${silentMs}ms`);
        return;
      }
      try {
        this.ws?.ping();
      } catch (err) {
        this.logger.debug('ping failed', { error: String(err) });
      }
      const ev = makeEvent(
        this.opts.identity.deviceId,
        'device.heartbeat',
        { activeSessions: this.opts.activeSessions?.() ?? 0 },
        { now: this.opts.now ?? (() => new Date()) },
      );
      this.sendFrame({ kind: 'event', event: ev });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** A proxy that accepts the upgrade and then says nothing must not hold the bridge forever (BR-22). */
  private startAuthDeadline(): void {
    this.clearAuthDeadline();
    this.authTimer = setTimeout(() => {
      if (this.state_ !== 'authenticating') return;
      this.logger.warn('gateway did not finish the handshake in time', {
        timeoutMs: this.authTimeoutMs,
      });
      const ws = this.ws;
      this.ws = null;
      ws?.terminate();
      this.onClose(`auth timed out after ${this.authTimeoutMs}ms`);
    }, this.authTimeoutMs);
    this.authTimer.unref();
  }

  private clearAuthDeadline(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    this.clearAuthDeadline();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onClose(reason: string, code?: number): void {
    const wasConnected = this.state_ === 'connected';
    this.stopHeartbeat();
    this.clearAuthDeadline();
    this.ws = null;
    if (this.terminal()) return;
    if (wasConnected) this.emit('disconnected', reason);
    let floor = this.retryFloorMs;
    this.retryFloorMs = 0;
    if (code === CLOSE_REPLACED) {
      // Two daemons on one identity evict each other. Racing back in at the base backoff makes
      // them flap at about a second each and lose commands in between, so this one steps well
      // back and says so instead of fighting (BR-6).
      floor = Math.max(floor, this.replacedMs);
      this.state_ = 'displaced';
    } else {
      this.state_ = 'idle';
    }
    const delay = Math.max(this.nextDelayMs(this.attempt++), floor);
    if (code === CLOSE_REPLACED) {
      this.logger.error(
        'another machine is connected to Pagr with this device identity; backing off',
        {
          delayMs: delay,
          hint: 'run `pagr connect` on the Mac that should own this pairing, or `pagr logout` on the other one',
        },
      );
      this.emit('replaced', delay);
    } else {
      this.logger.info('gateway disconnected; reconnecting', { reason, delayMs: delay });
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  /**
   * Serialise, measure, then send. A frame over the gateway's cap is dropped here with a loud
   * log: sending it would earn a 1009 close and, for anything sent on every connect, an endless
   * reconnect loop (BR-3).
   */
  private sendFrame(frame: BridgeFrame): boolean {
    if (this.ws?.readyState !== this.WS.OPEN) return false;
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxFrameBytes) {
      this.logger.error('refusing to send an oversized frame; the gateway would close on it', {
        kind: frame.kind,
        ...(frame.kind === 'event' ? { eventType: frame.event.type } : {}),
        bytes,
        limitBytes: this.maxFrameBytes,
      });
      return false;
    }
    this.ws.send(text);
    return true;
  }
}
