import { EventEmitter } from 'node:events';
import { type BridgeFrame, type DeviceEvent, GatewayFrame, PROTOCOL_VERSION } from '@pagr/protocol';
import WebSocket from 'ws';
import { compareVersions, makeEvent } from './events.js';
import type { DeviceIdentity } from './identity.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'blocked'
  | 'stopped';

export interface GatewayClientOptions {
  url: string;
  identity: DeviceIdentity & { deviceId: string };
  bridgeVersion: string;
  onCommand: (envelope: unknown) => void;
  /** Called after a successful auth with the server's trusted key set. */
  onServerKeys?: (keys: Record<string, string>) => void;
  activeSessions?: () => number;
  heartbeatMs?: number;
  backoff?: { baseMs?: number; maxMs?: number };
  bufferLimit?: number;
  logger?: Logger;
  random?: () => number;
  now?: () => Date;
  /** Injectable for tests. */
  WebSocketCtor?: typeof WebSocket;
}

export interface GatewayClientEvents {
  connected: [];
  disconnected: [reason: string];
  auth_failed: [error: string];
  blocked: [minBridgeVersion: string];
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
  private readonly buffer: DeviceEvent[] = [];
  private readonly logger: Logger;
  private readonly heartbeatMs: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly bufferLimit: number;
  private readonly random: () => number;
  private readonly WS: typeof WebSocket;
  serverKeys: Record<string, string> = {};

  constructor(private readonly opts: GatewayClientOptions) {
    super();
    this.logger = opts.logger ?? silentLogger;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.baseMs = opts.backoff?.baseMs ?? 1000;
    this.maxMs = opts.backoff?.maxMs ?? 60_000;
    this.bufferLimit = opts.bufferLimit ?? 500;
    this.random = opts.random ?? Math.random;
    this.WS = opts.WebSocketCtor ?? WebSocket;
  }

  get state(): TransportState {
    return this.state_;
  }
  get bufferedCount(): number {
    return this.buffer.length;
  }

  start(): void {
    if (this.state_ === 'stopped' || this.state_ === 'blocked') this.state_ = 'idle';
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

  /** Queue or send an event. Returns false if the event was dropped (buffer full). */
  sendEvent(event: DeviceEvent): boolean {
    if (this.state_ === 'connected' && this.ws?.readyState === this.WS.OPEN) {
      this.sendFrame({ kind: 'event', event });
      return true;
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
    if (this.state_ === 'stopped' || this.state_ === 'blocked') return;
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
      this.sendFrame({ kind: 'auth.request', deviceId: this.opts.identity.deviceId });
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', (err) => this.logger.warn('gateway socket error', { error: err.message }));
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.onClose(`close ${code} ${reason.toString()}`);
    });
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
        if (!frame.ok) {
          this.logger.error('gateway auth failed', { error: frame.error });
          this.emit('auth_failed', frame.error ?? 'unknown');
          this.ws?.close(4001, 'auth failed');
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
          this.ws?.close(4002, 'version blocked');
          return;
        }
        if (frame.serverKeys) {
          this.serverKeys = frame.serverKeys;
          this.opts.onServerKeys?.(frame.serverKeys);
        }
        this.state_ = 'connected';
        this.attempt = 0;
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

  private flush(): void {
    while (this.buffer.length && this.ws?.readyState === this.WS.OPEN) {
      const ev = this.buffer.shift();
      if (ev) this.sendFrame({ kind: 'event', event: ev });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state_ !== 'connected') return;
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

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onClose(reason: string): void {
    const wasConnected = this.state_ === 'connected';
    this.stopHeartbeat();
    this.ws = null;
    if (this.state_ === 'stopped' || this.state_ === 'blocked') return;
    this.state_ = 'idle';
    if (wasConnected) this.emit('disconnected', reason);
    const delay = this.nextDelayMs(this.attempt++);
    this.logger.info('gateway disconnected; reconnecting', { reason, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private sendFrame(frame: BridgeFrame): void {
    if (this.ws?.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(frame));
  }
}
