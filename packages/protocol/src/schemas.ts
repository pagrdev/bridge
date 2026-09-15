import { z } from 'zod';

/**
 * Pagr device protocol v1.
 *
 * This file is the CANONICAL definition of everything the Pagr cloud can ask a paired bridge
 * to do, and everything a bridge reports back. It is intentionally small and closed:
 *
 *   - There is no `shell.exec`, `filesystem.read_any`, `process.spawn_any`, or any generic
 *     command. Every command is a typed capability whose payload is validated here.
 *   - The cloud never sends filesystem paths. Projects are opaque `proj_…` IDs that the bridge
 *     resolves against its LOCAL registry. Cloud-supplied paths are rejected by schema.
 *   - Every command carries user/device binding, issue/expiry times, a nonce, an idempotency
 *     key, and a server signature (see `CommandEnvelope`).
 *
 * The private platform repo vendors a copy of this file and has a test that fails if it drifts.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------- primitives ----------

const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
export const UserId = prefixed('usr');
export const DeviceId = prefixed('dev');
export const ProjectId = prefixed('proj');
export const SessionId = prefixed('ses');
export const CommandId = prefixed('cmd');
export const ApprovalId = prefixed('apr');
export const AttachmentId = prefixed('att');
export const IsoDate = z.string().datetime({ offset: true });

export const Provider = z.enum(['claude', 'codex']);
export type Provider = z.infer<typeof Provider>;

export const SessionStatus = z.enum([
  'idle',
  'starting',
  'working',
  'waiting_for_user',
  'waiting_for_approval',
  'completed',
  'failed',
  'stopped',
  'offline',
  'unknown',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ClaudeMode = z.enum(['cli-hooks', 'approved-channel', 'disabled']);
export const CodexMode = z.enum(['app-server', 'disabled']);

export const AgentCapabilities = z.object({
  canStartSession: z.boolean(),
  canResumeSession: z.boolean(),
  canSteerActiveTurn: z.boolean(),
  canReceiveLiveExternalMessages: z.boolean(),
  canRelayApprovals: z.boolean(),
  canStop: z.boolean(),
  canAttachImages: z.boolean(),
  canListSessions: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

export const AgentConnectionStatus = z.object({
  provider: Provider,
  mode: z.string(), // ClaudeMode | CodexMode, kept string for forward-compat
  installed: z.boolean(),
  providerVersion: z.string().optional(),
  authStatus: z.enum(['authenticated', 'unauthenticated', 'unknown']),
  capabilities: AgentCapabilities,
  detail: z.string().optional(), // human-readable next action, never a secret
});
export type AgentConnectionStatus = z.infer<typeof AgentConnectionStatus>;

/** Safe metadata about a registered project. No local paths. */
export const ProjectSummary = z.object({
  projectId: ProjectId,
  displayName: z.string().min(1).max(80),
  aliases: z.array(z.string().min(1).max(40)).max(10).default([]),
  repoHint: z
    .object({
      host: z.string().optional(),
      name: z.string().optional(),
      defaultBranch: z.string().optional(),
    })
    .optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const SessionSummary = z.object({
  sessionId: SessionId,
  projectId: ProjectId,
  provider: Provider,
  status: SessionStatus,
  displayName: z.string().max(120).optional(),
  taskSummary: z.string().max(500).optional(),
  activeTurn: z.boolean().default(false),
  startedAt: IsoDate,
  updatedAt: IsoDate,
  endedAt: IsoDate.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Cloud→bridge instruction for fetching an attachment (device-bound, short-lived URL). */
export const AttachmentRef = z.object({
  attachmentId: AttachmentId,
  downloadUrl: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/heic', 'image/webp']),
  expiresAt: IsoDate,
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

// Builds a properly-typed discriminated union from a `{ type: payloadSchema }` map.
type VariantsOf<M extends Record<string, z.ZodTypeAny>> = {
  [K in keyof M & string]: z.ZodObject<{ type: z.ZodLiteral<K>; payload: M[K] }>;
}[keyof M & string];
function variantsOf<M extends Record<string, z.ZodTypeAny>>(m: M) {
  return Object.entries(m).map(([type, payload]) =>
    z.object({ type: z.literal(type), payload }),
  ) as unknown as [VariantsOf<M>, ...VariantsOf<M>[]];
}

// ---------- cloud → bridge commands ----------

export const CommandPayloads = {
  'device.probe': z.object({}),
  'project.list': z.object({}),
  'project.remove': z.object({ projectId: ProjectId }),
  'agent.start_session': z.object({
    provider: Provider,
    projectId: ProjectId,
    instruction: z.string().min(1).max(8000),
    sessionId: SessionId, // cloud pre-allocates so both sides share one id
    displayName: z.string().max(120).optional(),
    attachments: z.array(AttachmentRef).max(4).default([]),
    /** Reviewer sessions default to read-only where the provider supports it. */
    readOnly: z.boolean().default(false),
  }),
  'agent.send_instruction': z.object({
    sessionId: SessionId,
    instruction: z.string().min(1).max(8000),
    /** steer = inject into active turn; queue = wait for idle; auto = bridge decides by capability. */
    mode: z.enum(['auto', 'steer', 'queue']).default('auto'),
    attachments: z.array(AttachmentRef).max(4).default([]),
  }),
  'agent.stop_session': z.object({ sessionId: SessionId }),
  'agent.get_status': z.object({ sessionId: SessionId.optional() }),
  'agent.respond_to_approval': z.object({
    approvalId: ApprovalId,
    sessionId: SessionId,
    providerRequestId: z.string().min(1).max(200),
    /** sha256 of the preview shown to the user; bridge re-checks against its retained request. */
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum(['allow', 'deny']),
  }),
  'settings.sync_public_policy': z.object({
    approvalTimeoutSeconds: z.number().int().min(30).max(3600).default(600),
  }),
} as const;

export type CommandType = keyof typeof CommandPayloads;
export const CommandType = z.enum(Object.keys(CommandPayloads) as [CommandType, ...CommandType[]]);

const commandVariants = variantsOf(CommandPayloads);

/** The unsigned portion of a command. Signed as canonical JSON (see `canonicalize`). */
export const CommandBody = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    commandId: CommandId,
    userId: UserId,
    deviceId: DeviceId,
    issuedAt: IsoDate,
    expiresAt: IsoDate,
    nonce: z.string().min(16).max(128),
    idempotencyKey: z.string().min(8).max(128),
  })
  .and(z.discriminatedUnion('type', commandVariants));
export type CommandBody = z.infer<typeof CommandBody>;

export const CommandEnvelope = z.object({
  body: CommandBody,
  keyId: z.string().min(1).max(32),
  /** base64url Ed25519 signature over canonicalize(body). */
  signature: z.string().min(1),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export type CommandPayload<T extends CommandType> = z.infer<(typeof CommandPayloads)[T]>;

// ---------- bridge → cloud events ----------

export const ApprovalActionType = z.enum([
  'command_execution',
  'file_change',
  'permission',
  'tool_use',
  'other',
]);

export const EventPayloads = {
  'device.hello': z.object({
    bridgeVersion: z.string(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    platform: z.enum(['darwin']),
    osVersion: z.string().optional(),
    agents: z.array(AgentConnectionStatus),
    projects: z.array(ProjectSummary),
    sessions: z.array(SessionSummary),
  }),
  'device.heartbeat': z.object({ activeSessions: z.number().int().nonnegative() }),
  'command.ack': z.object({
    commandId: CommandId,
    status: z.enum(['accepted', 'rejected', 'completed', 'failed', 'duplicate']),
    errorCode: z
      .enum([
        'bad_signature',
        'expired',
        'replayed',
        'wrong_device',
        'unknown_project',
        'unknown_session',
        /** The approval id is not pending any more: it expired, or was already answered. */
        'unknown_approval',
        'capability_unsupported',
        'provider_error',
        'invalid_payload',
      ])
      .optional(),
    message: z.string().max(500).optional(),
    result: z.unknown().optional(),
  }),
  'project.registered': ProjectSummary,
  'project.removed': z.object({ projectId: ProjectId }),
  'agent.connection': AgentConnectionStatus,
  'session.updated': SessionSummary,
  'session.event': z.object({
    sessionId: SessionId,
    projectId: ProjectId,
    provider: Provider,
    kind: z.enum([
      'started',
      'progress',
      'agent_message',
      'needs_input',
      'completed',
      'failed',
      'stopped',
      'queued_followup',
      'followup_delivered',
    ]),
    summary: z.string().max(2000),
    providerEventId: z.string().optional(),
    at: IsoDate,
  }),
  'approval.requested': z.object({
    approvalId: ApprovalId, // bridge allocates; cloud stores
    sessionId: SessionId,
    projectId: ProjectId,
    provider: Provider,
    providerRequestId: z.string().min(1).max(200),
    actionType: ApprovalActionType,
    /** Short, user-safe preview: the command line or file list. Never full file contents. */
    preview: z.string().max(1500),
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Deterministic risk hints computed locally; cloud applies final tiering. */
    hints: z
      .object({
        touchesOutsideProject: z.boolean().default(false),
        networkAccess: z.boolean().default(false),
        destructive: z.boolean().default(false),
        gitPush: z.boolean().default(false),
        packageInstall: z.boolean().default(false),
        secretsTouch: z.boolean().default(false),
        productionHint: z.boolean().default(false),
      })
      .default({}),
    expiresAt: IsoDate,
  }),
  'approval.resolved_locally': z.object({
    approvalId: ApprovalId,
    resolution: z.enum(['allowed', 'denied', 'timed_out', 'canceled']),
  }),
  'attachment.consumed': z.object({
    attachmentId: AttachmentId,
    ok: z.boolean(),
    error: z.string().optional(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EventType = z.enum(Object.keys(EventPayloads) as [EventType, ...EventType[]]);

const eventVariants = variantsOf(EventPayloads);

export const DeviceEvent = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    eventId: z.string().min(8).max(64),
    deviceId: DeviceId,
    at: IsoDate,
    /** Set when the event is a response to a specific command. */
    inReplyTo: CommandId.optional(),
  })
  .and(z.discriminatedUnion('type', eventVariants));
export type DeviceEvent = z.infer<typeof DeviceEvent>;
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

// ---------- WebSocket frames ----------

/** Bridge → gateway first frame: prove possession of the device key. */
export const AuthChallengeRequest = z.object({
  kind: z.literal('auth.request'),
  deviceId: DeviceId,
});
export const AuthChallenge = z.object({
  kind: z.literal('auth.challenge'),
  nonce: z.string().min(32),
});
export const AuthResponse = z.object({
  kind: z.literal('auth.response'),
  deviceId: DeviceId,
  nonce: z.string(),
  signature: z.string(), // base64url Ed25519 over `${deviceId}.${nonce}`
  bridgeVersion: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export const AuthResult = z.object({
  kind: z.literal('auth.result'),
  ok: z.boolean(),
  error: z.string().optional(),
  /** Server public keys currently trusted for command signatures (keyId → base64url raw key). */
  serverKeys: z.record(z.string()).optional(),
  /**
   * Detached Ed25519 signature over `SERVER_KEY_SET_CONTEXT + canonicalize(serverKeys)`, made
   * with a key the bridge ALREADY trusts. Required to add a key id or change a pinned key's
   * value; dropping keys (and re-sending the pinned set) needs none. Without it a gateway that
   * has been talked into serving an extra key cannot poison a bridge's pin set (SEC-7).
   */
  serverKeysSignature: z
    .object({ keyId: z.string().min(1).max(32), signature: z.string().min(1).max(200) })
    .optional(),
  minBridgeVersion: z.string().optional(),
});

/** Domain separator for `serverKeysSignature`, so a command signature can never be replayed as one. */
export const SERVER_KEY_SET_CONTEXT = 'pagr.server-keys.v1:';

export const GatewayFrame = z.discriminatedUnion('kind', [
  AuthChallenge,
  AuthResult,
  z.object({ kind: z.literal('command'), envelope: CommandEnvelope }),
  z.object({ kind: z.literal('ping') }),
]);
export const BridgeFrame = z.discriminatedUnion('kind', [
  AuthChallengeRequest,
  AuthResponse,
  z.object({ kind: z.literal('event'), event: DeviceEvent }),
  z.object({ kind: z.literal('pong') }),
]);
export type GatewayFrame = z.infer<typeof GatewayFrame>;
export type BridgeFrame = z.infer<typeof BridgeFrame>;

// ---------- canonical JSON for signing ----------

/** Deterministic JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}
