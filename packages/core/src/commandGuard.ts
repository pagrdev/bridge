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
  /**
   * The same command again (a gateway resend, or a retry under the same idempotency key). It is
   * NOT executed a second time: `ack` settles with the terminal ack of the one execution —
   * already finished when `inFlight` is false, still running when it is true.
   */
  | { ok: true; body: CommandBody; duplicate: true; inFlight: boolean; ack: Promise<DeviceEvent> }
  | { ok: false; errorCode: GuardErrorCode; message: string; commandId?: string };

/** One command the bridge has accepted, from receipt until its terminal ack. */
export interface TrackedCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  /** Settles with the terminal ack for this command's single execution. Never rejects. */
  readonly ack: Promise<DeviceEvent>;
  /** The terminal ack once it exists; null while the command is still executing. */
  readonly settled: DeviceEvent | null;
}

interface Slot extends TrackedCommand {
  settled: DeviceEvent | null;
  resolve: (ack: DeviceEvent) => void;
}

/**
 * Bounded record of the commands this bridge has accepted, indexed by `commandId` and by
 * `idempotencyKey`, so a second copy of a command is answered rather than executed again.
 *
 * The entry is created at RECEIPT (`begin`), not after dispatch: the gateway resends an unacked
 * envelope after 30 s, and anything slower than that — a Codex cold start, four attachments —
 * would otherwise come back as a replayed nonce while the real work was still running.
 */
export class CommandTracker {
  private readonly byCommand = new Map<string, Slot>();
  private readonly byKey = new Map<string, Slot>();
  constructor(private readonly max = 1000) {}

  /** The command this envelope is a second copy of, if any. */
  find(body: Pick<CommandBody, 'commandId' | 'idempotencyKey'>): TrackedCommand | undefined {
    return this.byCommand.get(body.commandId) ?? this.byKey.get(body.idempotencyKey);
  }

  /** Record a command as executing. Call once, before dispatch. */
  begin(body: Pick<CommandBody, 'commandId' | 'idempotencyKey' | 'nonce'>): TrackedCommand {
    const existing = this.byCommand.get(body.commandId);
    if (existing) return existing;
    let resolve!: (ack: DeviceEvent) => void;
    const ack = new Promise<DeviceEvent>((r) => {
      resolve = r;
    });
    const slot: Slot = {
      commandId: body.commandId,
      idempotencyKey: body.idempotencyKey,
      nonce: body.nonce,
      ack,
      settled: null,
      resolve,
    };
    this.byCommand.set(slot.commandId, slot);
    this.byKey.set(slot.idempotencyKey, slot);
    this.prune();
    return slot;
  }

  /**
   * Record the terminal ack. Idempotent, and safe to call for a commandId that was never
   * `begin`-ned (a command the guard rejected outright).
   */
  settle(commandId: string, ack: DeviceEvent): void {
    const slot = this.byCommand.get(commandId);
    if (!slot || slot.settled) return;
    slot.settled = ack;
    slot.resolve(ack);
    // A `rejected` ack is a verdict on this ENVELOPE, not on the operation the idempotency key
    // names. A later, well-formed command carrying the same key (issued after the project was
    // registered, say) must be executed, not handed this rejection.
    const status = (ack.payload as { status?: string }).status;
    if (status === 'rejected' && this.byKey.get(slot.idempotencyKey) === slot)
      this.byKey.delete(slot.idempotencyKey);
  }

  get size(): number {
    return this.byCommand.size;
  }

  /** Drop the oldest settled commands. An unsettled one is never evicted: a duplicate awaits it. */
  private prune(): void {
    if (this.byCommand.size <= this.max) return;
    for (const [id, slot] of this.byCommand) {
      if (this.byCommand.size <= this.max) return;
      if (!slot.settled) continue;
      this.byCommand.delete(id);
      if (this.byKey.get(slot.idempotencyKey) === slot) this.byKey.delete(slot.idempotencyKey);
    }
  }
}

export interface GuardContext {
  deviceId: string;
  /** keyId → base64url raw Ed25519 public key. */
  trustedServerKeys: Record<string, string>;
  now: () => Date;
  replay: ReplayCache;
  commands: CommandTracker;
  registry: Pick<ProjectRegistry, 'has'>;
  sessions: Pick<SessionStore, 'has'>;
  /** Max allowed clock skew for `issuedAt` in the future. Default 2 minutes. */
  maxFutureSkewMs?: number;
  /** Hard cap on how long a command may be valid (bounds replay memory). Default 15 minutes. */
  maxLifetimeMs?: number;
}

const FUTURE_SKEW_MS = 2 * 60_000;
export const MAX_LIFETIME_MS = 15 * 60_000;
/** Slack added to the remembered-nonce window so it always outlives the accepted lifetime. */
const REPLAY_SLACK_MS = 60_000;

/**
 * Authorization gate for every cloud → bridge command. Checks run strictly in this order:
 * schema → known keyId → Ed25519 signature over canonicalize(body) → device binding →
 * expiry / issuedAt skew / 15-minute lifetime ceiling → nonce+commandId replay →
 * de-duplication (the in-flight or finished execution of the same command) →
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
  const maxLifetime = ctx.maxLifetimeMs ?? MAX_LIFETIME_MS;
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return fail('expired', 'unparsable times');
  if (expiresAt <= now) return fail('expired', 'command expired');
  if (issuedAt > now + (ctx.maxFutureSkewMs ?? FUTURE_SKEW_MS))
    return fail('expired', 'issuedAt is too far in the future');
  if (expiresAt < issuedAt) return fail('expired', 'expiresAt precedes issuedAt');
  // Absolute ceiling, independent of what the envelope claims (docs/SECURITY.md): a command is
  // never valid for more than 15 minutes. Without this a signing key could mint a command with a
  // year-long `expiresAt` that stays acceptable long after its nonce is forgotten, i.e. replayable.
  if (now - issuedAt > maxLifetime)
    return fail('expired', `issuedAt is more than ${maxLifetime}ms old`);
  if (expiresAt - issuedAt > maxLifetime)
    return fail('expired', `expiresAt is more than ${maxLifetime}ms after issuedAt`);
  // Remember the nonce for the whole window in which this command could still be accepted, plus
  // slack — never shorter than the maximum accepted lifetime, or the nonce would be forgotten
  // while the command is still valid.
  const rememberUntil = issuedAt + maxLifetime + REPLAY_SLACK_MS;

  const nonceKey = `n:${body.nonce}`;
  const cmdKey = `c:${body.commandId}`;
  /**
   * A second copy of a command we already accepted is a duplicate, not a replay — the gateway
   * resends an envelope it has had no ack for. It is de-duplicated onto the single execution
   * (`prior.ack`), never rejected, so a slow command is reported by its real outcome. A *different*
   * command reusing a seen nonce, or this commandId arriving with a different nonce, is a genuine
   * replay and is still rejected.
   */
  const dedupe = (): GuardResult | undefined => {
    const prior = ctx.commands.find(body);
    if (!prior) return undefined;
    if (prior.commandId === body.commandId && prior.nonce !== body.nonce) return undefined;
    return { ok: true, body, duplicate: true, inFlight: prior.settled === null, ack: prior.ack };
  };
  if (ctx.replay.has(nonceKey) || ctx.replay.has(cmdKey))
    return dedupe() ?? fail('replayed', 'nonce or commandId already seen');
  const duplicate = dedupe();
  ctx.replay.add(nonceKey, rememberUntil);
  ctx.replay.add(cmdKey, rememberUntil);
  if (duplicate) return duplicate;

  // At receipt, before dispatch: a resend that arrives mid-execution must find this entry.
  // The caller MUST `commands.settle(commandId, ack)` on every path, including a rejection below.
  ctx.commands.begin(body);

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
    // v2. The `qst_` id is checked by the question registry, which is the only thing that knows
    // whether it is still pending; what must exist before dispatch is the session it names.
    case 'agent.answer_question':
      return { sessionId: body.payload.sessionId };
    case 'agent.get_status':
      return body.payload.sessionId ? { sessionId: body.payload.sessionId } : {};
    // `repo.scan` names nothing, and `project.register_handle` names an `rh_…` handle, which is
    // NOT a registry id: it is resolved against the dispatcher's in-memory scan cache, where an
    // unknown or expired one is refused as `unknown_project` without the filesystem being read.
    // Checking it here would need that cache, and would answer the same question twice.
    case 'repo.scan':
    case 'project.register_handle':
      return {};
    // `session.backfill` names a session on purpose and is NOT checked here. The whole point of a
    // backfill is a session this Mac can still serve but no longer has a row for — one that ran
    // before Pagr was installed, or whose `sessions.json` entry aged out weeks ago. Rejecting it
    // as `unknown_session` at the guard would make the command useless for exactly the sessions it
    // exists for; the dispatcher answers `unknown_session` itself, after asking the journal and
    // every history source whether anything can be replayed.
    case 'session.backfill':
    case 'session.list_history':
      return {};
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
