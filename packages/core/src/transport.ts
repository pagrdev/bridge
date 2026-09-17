import { EventEmitter } from 'node:events';
import {
  type BridgeFrame,
  canonicalize,
  type DeviceEvent,
  type EventType,
  GatewayFrame,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ProtocolVersion,
  RECIPIENT_KEY_SET_CONTEXT,
  RecipientKeySet as RecipientKeySetSchema,
  type RecipientKeySetSignature,
  SERVER_KEY_SET_CONTEXT,
} from '@pagr/protocol';
import WebSocket from 'ws';
import type { z } from 'zod';
import { compareVersions, makeEvent } from './events.js';
import type { DeviceIdentity } from './identity.js';
import { verifyRaw } from './identity.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import { importRecipientKeys, SealError } from './seal.js';

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

/**
 * Events a v1 gateway has never heard of. They are emitted only once `auth.result` has agreed to
 * protocol 2 — a v1 gateway answers an unknown event type by closing the socket or, worse, by
 * dropping it silently, and a bridge that kept sending them would reconnect forever. Frames held
 * back this way are not lost: the journal keeps them and they replay when a v2 link is up (B3).
 */
export const V2_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'session.frame',
  'question.asked',
  'question.answered',
  'approval.applied',
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
  protocol_version_downgrade:
    'the gateway does not accept protocol v2 — offering v1 and reconnecting',
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
  /**
   * Called only when an ACCEPTED recipient key set differs from the pinned one (the phones this
   * Mac seals frames for). Persisting into `config.json` is the caller's job.
   */
  onRecipientKeys?: (keys: Record<string, string>) => void;
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
  /**
   * Recipient keys (`kid` → base64url raw X25519 public key) pinned in `config.json`. Same
   * acceptance rule as `serverKeys`, except that the signature comes from a pinned SERVER key.
   */
  recipientKeys?: Record<string, string>;
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

/** `{keyId, signature}` — a detached Ed25519 signature by a key the bridge already trusts. */
export type KeySetSignature = RecipientKeySetSignature;
/** The original name, kept so nothing downstream has to be renamed. */
export type ServerKeySignature = KeySetSignature;

export type KeySetDecision =
  | { accept: true; reason: 'first-pin' | 'unchanged' | 'narrowed' | 'signed' }
  | { accept: false; reason: 'unsigned-change' | 'unknown-signer' | 'bad-signature' };
export type ServerKeyDecision = KeySetDecision;

/**
 * Resolves a `keyId` to a trusted signer and checks the signature. Split out so the two key sets
 * can trust different things: a server key set is vouched for by the server keys already pinned,
 * while a RECIPIENT key set (the user's phones) is vouched for by a pinned SERVER key — the
 * phones never sign anything.
 */
export type KeySetVerify = (
  signature: KeySetSignature,
  payload: string,
) => 'ok' | 'unknown-signer' | 'bad-signature';

/** The usual verifier: the signature must come from one of `signers`, keyed by `keyId`. */
export const signedByOneOf =
  (signers: Record<string, string>): KeySetVerify =>
  (signature, payload) => {
    const signer = signers[signature.keyId];
    if (!signer) return 'unknown-signer';
    return verifyRaw(signer, payload, signature.signature) ? 'ok' : 'bad-signature';
  };

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
 * Decide whether an incoming key set may replace the pinned one (SEC-7). One rule, two uses:
 * the gateway's command-signing keys, and the recipient keys frames are sealed for.
 *
 * The old rule — "accept any set that overlaps the pinned one by a single key" — let anybody who
 * obtained one server key hand the bridge an extra key of their own, which the bridge then
 * persisted and trusted forever. Neither `auth.result` nor `keys.updated` is itself signed, so
 * neither can authenticate a widening of trust on its own.
 *
 * What is safe unsigned is anything that grants no NEW trust: the same set again, or a smaller
 * one (the retiring half of a rotation, or a phone the user just revoked). Adding a key id, or
 * changing what a pinned id maps to, must carry a signature by a key the bridge already trusts
 * over `context + canonicalize(signedOver ?? incoming)`. That keeps rotation working (publish the
 * new key signed by the outgoing one, then drop the outgoing one unsigned) while making additive
 * poisoning impossible for anyone who does not hold a trusted private key.
 *
 * `signedOver` exists because the two sets are signed over different documents: a server key set
 * is signed as the `keyId → key` map itself, while a recipient key set is signed as the whole
 * `{v, userId, keys, features, issuedAt}` set the cloud issued, exactly as it was received.
 */
export function evaluateKeySet(
  pinned: Record<string, string>,
  incoming: Record<string, string>,
  signature: KeySetSignature | undefined,
  verify: KeySetVerify,
  context: string,
  signedOver?: unknown,
): KeySetDecision {
  if (Object.keys(pinned).length === 0) return { accept: true, reason: 'first-pin' };
  if (sameKeySet(pinned, incoming)) return { accept: true, reason: 'unchanged' };
  if (isNarrowingKeySet(pinned, incoming)) return { accept: true, reason: 'narrowed' };
  if (!signature) return { accept: false, reason: 'unsigned-change' };
  const payload = `${context}${canonicalize(signedOver === undefined ? incoming : signedOver)}`;
  const verdict = verify(signature, payload);
  return verdict === 'ok' ? { accept: true, reason: 'signed' } : { accept: false, reason: verdict };
}

/** `evaluateKeySet` for the gateway's command-signing keys: the pinned keys vouch for changes. */
export function evaluateServerKeys(
  pinned: Record<string, string>,
  incoming: Record<string, string>,
  signature?: KeySetSignature | undefined,
): KeySetDecision {
  return evaluateKeySet(pinned, incoming, signature, signedByOneOf(pinned), SERVER_KEY_SET_CONTEXT);
}

// ---------- recipient keys (the phones a frame is sealed for) ----------

/**
 * The domain separator and the shape of the set are the protocol's — one definition, byte-synced
 * to the cloud and mirrored in Swift. They are re-exported here because this module is where the
 * bridge decides whether to TRUST a set, which is a different question from whether it parses.
 *
 * The parse is deliberately not the last word: the SIGNATURE is checked over the object exactly
 * as it arrived, never over the parsed copy, because zod strips unknown keys and a newer gateway
 * that adds a field would otherwise fail to verify against its own signature.
 */
export { RECIPIENT_KEY_SET_CONTEXT, RecipientKeySetSchema };
export type RecipientKeySetDoc = z.infer<typeof RecipientKeySetSchema>;

export type RecipientKeyDecision =
  | {
      accept: true;
      reason: 'first-pin' | 'unchanged' | 'narrowed' | 'signed';
      keys: Record<string, string>;
      features: { imessage: boolean } | null;
      userId: string;
    }
  | {
      accept: false;
      reason: 'unsigned-change' | 'unknown-signer' | 'bad-signature' | 'invalid-set' | 'bad-keys';
      detail?: string;
    };

/**
 * Decide whether a recipient key set off the wire may replace the pinned one.
 *
 * Three things have to hold before a phone is sealed for: the set parses, every key is a real
 * X25519 key that fingerprints to the `kid` it is filed under (`importRecipientKeys`), and the
 * change is either trust-narrowing or signed by a pinned SERVER key. Adding a phone is a
 * widening — it is exactly the move a compromised gateway would make — so it always needs the
 * signature, and the fingerprints are shown on both ends so the user can check them.
 */
export function evaluateRecipientKeys(
  pinned: Record<string, string>,
  incoming: unknown,
  signature: KeySetSignature | undefined,
  serverKeys: Record<string, string>,
): RecipientKeyDecision {
  const parsed = RecipientKeySetSchema.safeParse(incoming);
  if (!parsed.success)
    return {
      accept: false,
      reason: 'invalid-set',
      detail: parsed.error.issues[0]?.message ?? 'not a recipient key set',
    };
  const keys: Record<string, string> = {};
  for (const k of parsed.data.keys) keys[k.kid] = k.x25519;
  try {
    importRecipientKeys(keys);
  } catch (err) {
    return {
      accept: false,
      reason: 'bad-keys',
      detail: err instanceof SealError ? err.message : String(err),
    };
  }
  const decision = evaluateKeySet(
    pinned,
    keys,
    signature,
    signedByOneOf(serverKeys),
    RECIPIENT_KEY_SET_CONTEXT,
    incoming,
  );
  if (!decision.accept) return decision;
  return {
    accept: true,
    reason: decision.reason,
    keys,
    features: parsed.data.features ?? null,
    userId: parsed.data.userId,
  };
}

/**
 * One field of the frame as it arrived, before zod touched it.
 *
 * A signed document has to be verified over the bytes the signer signed. `GatewayFrame` strips
 * keys it does not know about, so a set from a newer cloud would verify against a shorter
 * document than the one it signed and every rotation would fail on the next release.
 */
function rawField(json: unknown, key: string): unknown {
  return (json as Record<string, unknown> | null)?.[key];
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
  /** The phones every sealed frame is encrypted for. Empty until a phone is paired. */
  recipientKeys: Record<string, string> = {};
  /** `auth.result.features` / the signed set's `features`, once a v2 gateway has sent them. */
  features: { imessage: boolean } | null = null;
  /** Why the transport is in a terminal state, for `pagr status` and the logs. */
  lastFailure: AuthFailure | null = null;
  /**
   * What the next `auth.response` OFFERS. It starts at the newest version this bridge speaks and
   * drops to the baseline for good once a gateway has refused the offer — a gateway that says
   * `protocol_version` to v2 will say it again, and flapping between offers would turn a working
   * v1 connection into a reconnect every time.
   */
  private offeredVersion: ProtocolVersion = LATEST_PROTOCOL_VERSION;
  /**
   * What this connection actually agreed on. Always the baseline until an `auth.result` says
   * otherwise, and back to it the moment the socket is gone: nothing v2-only may be put on a wire
   * whose other end has not said it understands v2.
   */
  private negotiated: ProtocolVersion = PROTOCOL_VERSION;

  constructor(private readonly opts: GatewayClientOptions) {
    super();
    assertSecureGatewayUrl(opts.url, opts.env);
    this.serverKeys = { ...(opts.serverKeys ?? {}) };
    this.recipientKeys = { ...(opts.recipientKeys ?? {}) };
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
  /** Pinned recipient key ids, sorted — what `device.hello` v2 reports as `recipientKeyIds`. */
  recipientKeyIds(): string[] {
    return Object.keys(this.recipientKeys).sort();
  }
  /** True when nothing can open a sealed frame yet, so sealing is skipped and frames stay local. */
  get sealsToNobody(): boolean {
    return Object.keys(this.recipientKeys).length === 0;
  }
  /** The protocol version in force on the current connection. 1 until a gateway answers 2. */
  get negotiatedVersion(): ProtocolVersion {
    return this.negotiated;
  }
  /** What the next handshake will offer; drops to 1 after a gateway refuses 2. */
  get offeredProtocolVersion(): ProtocolVersion {
    return this.offeredVersion;
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

  /**
   * Queue or send an event. Returns false if the event was dropped (buffer full, oversized, or
   * v2-only on a link that negotiated v1).
   *
   * While offline a v2-only event is still buffered, because the version is not known until the
   * handshake finishes; `flush` drops it then if the gateway turned out to speak v1.
   */
  sendEvent(event: DeviceEvent): boolean {
    if (this.state_ === 'connected' && this.ws?.readyState === this.WS.OPEN) {
      if (!this.mayEmit(event)) return false;
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
          protocolVersion: this.offeredVersion,
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
        if (frame.features) this.features = frame.features;
        // The set is taken from the RAW frame, not from `frame.recipientKeys`: zod strips keys it
        // does not know, and the signature covers the bytes the gateway actually sent. A v1
        // gateway sends no set at all and nothing here runs.
        if (frame.recipientKeys !== undefined)
          this.applyRecipientKeys(
            rawField(json, 'recipientKeys'),
            frame.recipientKeysSignature,
            'auth.result',
          );
        // Absent means 1: that is what every gateway older than protocol v2 sends. A gateway
        // cannot promote us past what we offered, either — it answers an offer, it does not make
        // one.
        this.negotiated = Math.min(
          frame.protocolVersion ?? PROTOCOL_VERSION,
          this.offeredVersion,
        ) as ProtocolVersion;
        if (this.negotiated > PROTOCOL_VERSION)
          this.logger.debug('protocol negotiated', { version: this.negotiated });
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
      case 'keys.updated':
        // Live push: a phone was added or revoked. Same trust rule as the set on `auth.result`,
        // and the same reason for reading the raw field rather than the parsed one.
        this.applyRecipientKeys(
          rawField(json, 'recipientKeys'),
          frame.recipientKeysSignature,
          'keys.updated',
        );
        return;
      case 'settings.updated':
        this.features = frame.features;
        return;
      case 'ack':
        // Frame cursors. The journal that resumes from them is MOB-032; until it exists there is
        // nothing to move, and an unhandled frame kind would be indistinguishable from a bug.
        this.logger.debug('gateway acked frames', { sessions: Object.keys(frame.cursors).length });
        return;
    }
  }

  /**
   * A refusal the gateway owns the meaning of. Only a refusal of this IDENTITY stops the client;
   * "too many attempts from your address" is a refusal of this MOMENT and keeps retrying, because
   * every bridge behind one office NAT trips that limiter together (BR-5, BR-23).
   */
  private onAuthRefused(error: string | undefined): void {
    let failure = classifyAuthFailure(error);
    // A gateway that refuses the v2 offer is not refusing this bridge: it is an older gateway
    // than this CLI. Drop the offer to the baseline and try once more before calling it fatal,
    // or an upgraded CLI would strand every Mac on a cloud that has not been deployed yet.
    if (failure.code === 'protocol_version' && this.offeredVersion > PROTOCOL_VERSION) {
      this.offeredVersion = PROTOCOL_VERSION;
      failure = {
        code: failure.code,
        fatal: false,
        reason: AUTH_REASONS.protocol_version_downgrade as string,
      };
    }
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

  /**
   * Pin an incoming recipient key set, or refuse it loudly.
   *
   * A refusal is never fatal to the connection: the bridge keeps the phones it already trusts and
   * carries on. That is the safe failure — frames stay readable by the phones the user pinned,
   * and a gateway that tried to add one of its own gets nothing.
   */
  private applyRecipientKeys(
    incoming: unknown,
    signature: KeySetSignature | undefined,
    source: 'auth.result' | 'keys.updated',
  ): void {
    const decision = evaluateRecipientKeys(
      this.recipientKeys,
      incoming,
      signature,
      this.serverKeys,
    );
    if (!decision.accept) {
      this.logger.error('refusing a recipient key set', {
        source,
        reason: decision.reason,
        ...(decision.detail ? { detail: decision.detail } : {}),
        pinned: Object.keys(this.recipientKeys),
      });
      return;
    }
    if (decision.features) this.features = decision.features;
    if (sameKeySet(this.recipientKeys, decision.keys)) return;
    this.logger.info('recipient key set updated', {
      source,
      reason: decision.reason,
      keys: Object.keys(decision.keys).sort(),
    });
    this.recipientKeys = { ...decision.keys };
    this.opts.onRecipientKeys?.({ ...decision.keys });
  }

  /** Whether the negotiated version allows this event on the wire at all. */
  private mayEmit(event: DeviceEvent): boolean {
    if (!V2_ONLY_EVENTS.has(event.type) || this.negotiated >= 2) return true;
    this.logger.debug('holding back a v2-only event; this gateway speaks protocol v1', {
      eventType: event.type,
      negotiatedVersion: this.negotiated,
    });
    return false;
  }

  private flush(): void {
    while (this.buffer.length && this.ws?.readyState === this.WS.OPEN) {
      const ev = this.buffer.shift();
      if (ev && this.mayEmit(ev)) this.sendFrame({ kind: 'event', event: ev });
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
    // The agreement belonged to that socket; the next one negotiates again from the baseline.
    this.negotiated = PROTOCOL_VERSION;
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
