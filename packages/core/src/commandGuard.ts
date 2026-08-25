import { type CommandBody, CommandEnvelope, canonicalize, type DeviceEvent } from '@pagr/protocol';
import { verifyRaw } from './identity.js';
import type { ProjectRegistry } from './projects.js';
import type { ReplayCache } from './replay.js';
import type { SessionStore } from './sessions.js';

export type GuardErrorCode =
  | 'invalid_payload'
  | 'bad_signature'
  | 'wrong_device'
  | 'expired'
  | 'replayed'
  | 'unknown_project'
  | 'unknown_session';

export type GuardResult =
  | { ok: true; body: CommandBody; duplicate: false }
  | { ok: true; body: CommandBody; duplicate: true; cachedAck: DeviceEvent }
  | { ok: false; errorCode: GuardErrorCode; message: string; commandId?: string };

/** Bounded map `idempotencyKey → ack event` so retried commands get the same answer. */
export class IdempotencyCache {
  private readonly map = new Map<string, DeviceEvent>();
  constructor(private readonly max = 1000) {}
  get(key: string): DeviceEvent | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, ack: DeviceEvent): void {
    this.map.set(key, ack);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export interface GuardContext {
  deviceId: string;
  /** keyId → base64url raw Ed25519 public key. */
  trustedServerKeys: Record<string, string>;
  now: () => Date;
  replay: ReplayCache;
  idempotency: IdempotencyCache;
  registry: Pick<ProjectRegistry, 'has'>;
  sessions: Pick<SessionStore, 'has'>;
  /** Max allowed clock skew for `issuedAt` in the future. Default 2 minutes. */
  maxFutureSkewMs?: number;
  /** Hard cap on how long a command may be valid (bounds replay memory). Default 15 minutes. */
  maxLifetimeMs?: number;
}

const FUTURE_SKEW_MS = 2 * 60_000;
const MAX_LIFETIME_MS = 15 * 60_000;

/**
 * Authorization gate for every cloud → bridge command. Checks run strictly in this order:
 * schema → known keyId → Ed25519 signature over canonicalize(body) → device binding →
 * expiry / issuedAt skew → nonce+commandId replay → idempotency (cached ack) →
 * referenced project / session exists locally.
 */
export function verifyIncoming(envelope: unknown, ctx: GuardContext): GuardResult {
  const parsed = CommandEnvelope.safeParse(envelope);
  if (!parsed.success) {
    const cmdId = extractCommandId(envelope);
    return {
      ok: false,
      errorCode: 'invalid_payload',
      message:
        `schema: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(),
      ...(cmdId ? { commandId: cmdId } : {}),
    };
  }
  const { body, keyId, signature } = parsed.data;
  const fail = (errorCode: GuardErrorCode, message: string): GuardResult => ({
    ok: false,
    errorCode,
    message,
    commandId: body.commandId,
  });

  const serverKey = ctx.trustedServerKeys[keyId];
  if (!serverKey) return fail('bad_signature', `unknown server keyId ${keyId}`);
  if (!verifyRaw(serverKey, canonicalize(body), signature))
    return fail('bad_signature', 'signature verification failed');

  if (body.deviceId !== ctx.deviceId)
    return fail('wrong_device', 'command bound to another device');

  const now = ctx.now().getTime();
  const issuedAt = Date.parse(body.issuedAt);
  const expiresAt = Date.parse(body.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return fail('expired', 'unparsable times');
  if (expiresAt <= now) return fail('expired', 'command expired');
  if (issuedAt > now + (ctx.maxFutureSkewMs ?? FUTURE_SKEW_MS))
    return fail('expired', 'issuedAt is too far in the future');
  if (expiresAt < issuedAt) return fail('expired', 'expiresAt precedes issuedAt');
  const lifetimeCap = issuedAt + (ctx.maxLifetimeMs ?? MAX_LIFETIME_MS);
  const rememberUntil = Math.min(expiresAt, lifetimeCap) + 60_000;

  const nonceKey = `n:${body.nonce}`;
  const cmdKey = `c:${body.commandId}`;
  if (ctx.replay.has(nonceKey) || ctx.replay.has(cmdKey)) {
    const cached = ctx.idempotency.get(body.idempotencyKey);
    if (cached) return { ok: true, body, duplicate: true, cachedAck: cached };
    return fail('replayed', 'nonce or commandId already seen');
  }
  const cached = ctx.idempotency.get(body.idempotencyKey);
  ctx.replay.add(nonceKey, rememberUntil);
  ctx.replay.add(cmdKey, rememberUntil);
  if (cached) return { ok: true, body, duplicate: true, cachedAck: cached };

  const ref = referencedIds(body);
  if (ref.projectId && !ctx.registry.has(ref.projectId))
    return fail('unknown_project', 'project is not registered on this device');
  if (ref.sessionId && !ctx.sessions.has(ref.sessionId))
    return fail('unknown_session', 'session is not known on this device');

  return { ok: true, body, duplicate: false };
}

/** Which locally-registered objects a command refers to (must exist before dispatch). */
export function referencedIds(body: CommandBody): { projectId?: string; sessionId?: string } {
  switch (body.type) {
    case 'project.remove':
      return { projectId: body.payload.projectId };
    case 'agent.start_session':
      return { projectId: body.payload.projectId };
    case 'agent.send_instruction':
    case 'agent.stop_session':
    case 'agent.respond_to_approval':
      return { sessionId: body.payload.sessionId };
    case 'agent.get_status':
      return body.payload.sessionId ? { sessionId: body.payload.sessionId } : {};
    default:
      return {};
  }
}

function extractCommandId(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const body = (envelope as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return undefined;
  const id = (body as { commandId?: unknown }).commandId;
  return typeof id === 'string' && /^cmd_[0-9a-f]{32}$/.test(id) ? id : undefined;
}
