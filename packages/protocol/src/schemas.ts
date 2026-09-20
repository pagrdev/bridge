import { z } from 'zod';

/**
 * Pagr device protocol, versions 1 and 2.
 *
 * This file is the CANONICAL definition of everything the Pagr cloud can ask a paired bridge
 * to do, and everything a bridge reports back. It is intentionally small and closed:
 *
 *   - There is no `shell.exec`, `filesystem.read_any`, `process.spawn_any`, or any generic
 *     command. Every command is a typed capability whose payload is validated here.
 *   - The cloud never sends filesystem paths, and no path ever travels back either: projects are
 *     opaque `proj_…` IDs the bridge resolves against its LOCAL registry, and a repository the
 *     phone has not registered yet is an opaque `rh_…` handle. Paths are rejected by schema.
 *   - Every command carries user/device binding, issue/expiry times, a nonce, an idempotency
 *     key, and a server signature (see `CommandEnvelope`).
 *
 * ## v2, and why one schema describes both
 *
 * v2 adds the phone: sealed transcript frames, questions, approval options, control levels,
 * backfill and repository handles. It is strictly ADDITIVE, and both versions are described by
 * these same schemas, because a bridge and a gateway of different vintages have to understand
 * each other's frames on the same socket. Every v2 field a v1 peer would not send is therefore
 * optional (or defaulted), and no v1 shape has been narrowed.
 *
 * ## Named capabilities on top of v2
 *
 * A version says what the LINK can carry; a capability says what this Mac will actually do.
 * `handoff.v1` is the second kind: the handoff and review commands below are v2 commands that a
 * bridge only honours once its handoff engine is wired up, and a cloud that respects
 * `device.hello.capabilities` never sends one to a Mac that did not name it (`capability_unsupported`).
 *
 * Which version is in force is negotiated, not assumed: the bridge OFFERS
 * `auth.response.protocolVersion` (2 for a current bridge) and the gateway ANSWERS with
 * `auth.result.protocolVersion` — absent means 1. Neither side may send a v2-only command or
 * event until that answer says 2; a gateway that refuses the offer with `protocol_version` gets
 * one more attempt offering 1.
 *
 * Content is sealed end to end (`SealedEnvelope`): the cloud stores and forwards the envelope
 * without holding a key that opens it, and only routing metadata — ids, kinds, sizes, statuses,
 * risk hints — is in the clear.
 *
 * The private platform repo vendors a copy of this file and has a test that fails if it drifts.
 */

/** The baseline both peers always speak; also what the pairing API is checked against. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The newest version this file describes — what a current bridge OFFERS in `auth.response`.
 * What it may actually SEND is the negotiated version from `auth.result`, never this constant.
 */
export const LATEST_PROTOCOL_VERSION = 2 as const;

/** Every protocol version these schemas parse. */
export const ProtocolVersion = z.union([z.literal(1), z.literal(2)]);
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

// ---------- primitives ----------

const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
export const UserId = prefixed('usr');
export const DeviceId = prefixed('dev');
export const ProjectId = prefixed('proj');
export const SessionId = prefixed('ses');
export const CommandId = prefixed('cmd');
export const ApprovalId = prefixed('apr');
export const AttachmentId = prefixed('att');
/** v2. A question an agent asked the user; answered from the phone or on the Mac. */
export const QuestionId = prefixed('qst');
/**
 * v2. A repository the bridge found on disk but that is not a registered project yet. It is a
 * salted hash of the real path, held in memory for an hour — never the path itself, so a phone
 * can offer "add this repo" without the cloud ever learning where anything lives.
 */
export const RepoHandle = prefixed('rh');
/** v2, `handoff.v1`. One mid-task switch from one agent to another. */
export const HandoffId = prefixed('hnd');
/** v2, `handoff.v1`. One cross-agent review of a commit range. */
export const ReviewId = prefixed('rev');
export const IsoDate = z.string().datetime({ offset: true });

/**
 * An abbreviated or full git object name. Never a ref and never a path: this is the WIP commit a
 * switch made, reported back so the person can find it.
 */
export const GitCommit = z.string().regex(/^[0-9a-f]{7,40}$/);

/**
 * A `<base>..HEAD` (or `...`) commit range, restricted to ref characters at the schema so that a
 * string the cloud chose can never reach `git` as an option or a second argument. A leading `-`
 * is refused for the same reason paths are: the bridge passes this straight to `git log`/`diff`.
 */
const gitRef = '(?!-)[A-Za-z0-9._/~^@{}-]{1,100}';
export const GitRange = z.string().regex(new RegExp(`^${gitRef}\\.\\.\\.?${gitRef}$`));

/**
 * v2. A public key's fingerprint: `sha256(raw key).hex[0:16]` in groups of four. Identical on
 * both sides of the wire and short enough to read out loud when verifying a phone by hand.
 */
export const KeyFingerprint = z.string().regex(/^[0-9a-f]{4}(?::[0-9a-f]{4}){3}$/);

/**
 * Unpadded base64url. With `bytes`, the exact length that many bytes encode to, so a malformed
 * key, nonce or tag is refused by schema rather than by a decryption failure later.
 */
const base64url = (bytes?: number) =>
  z
    .string()
    .regex(
      bytes === undefined
        ? /^[A-Za-z0-9_-]+$/
        : new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`),
    );

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
/**
 * `app-server` is the historical answer and still what a probe reports before anything is
 * connected; once there is a link it says WHICH one — the user's shared daemon, or the private
 * child this bridge spawned because there was no daemon to attach to.
 */
export const CodexMode = z.enum([
  'app-server',
  'app-server-daemon',
  'app-server-embedded',
  'disabled',
]);

export const AgentCapabilities = z.object({
  canStartSession: z.boolean(),
  canResumeSession: z.boolean(),
  canSteerActiveTurn: z.boolean(),
  canReceiveLiveExternalMessages: z.boolean(),
  canRelayApprovals: z.boolean(),
  canStop: z.boolean(),
  canAttachImages: z.boolean(),
  canListSessions: z.boolean(),
  /**
   * The bridge can put a follow-up into a turn that is already running, and the agent will act on
   * it when that turn ends — the Claude channel's real behaviour.
   *
   * Deliberately NOT `canSteerActiveTurn`, which promises an interruption. Optional (additive):
   * an adapter or a bridge that predates it simply does not say, and the phone reads that as no.
   */
  canQueueIntoActiveTurn: z.boolean().optional(),
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

/** What an approval is asking permission to do. Also used as a frame's `actionType`. */
export const ApprovalActionType = z.enum([
  'command_execution',
  'file_change',
  'permission',
  'tool_use',
  'other',
]);
export type ApprovalActionType = z.infer<typeof ApprovalActionType>;

// ---------- v2: sealed transcript frames ----------

/**
 * Domain separator for the frame seal. It is the HKDF `info` (together with the canonical AAD),
 * so a key derived for one sealing scheme can never open an envelope made under another.
 */
export const SEAL_CONTEXT = 'pagr.seal.v1';

/**
 * Domain separator for `recipientKeysSignature`, so a command signature can never be replayed as
 * a recipient-key-set signature — the same discipline as `SERVER_KEY_SET_CONTEXT`.
 */
export const RECIPIENT_KEY_SET_CONTEXT = 'pagr.recipient-keys.v1:';

/**
 * What a frame IS, in the clear. The kind drives routing, badges and push on the cloud side; the
 * words themselves are inside the seal. `imessage` is the one kind that is plaintext by nature —
 * those messages travelled in the clear through the iMessage thread anyway.
 */
export const FrameKind = z.enum([
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'diff',
  'terminal',
  'thinking',
  'question',
  'approval_preview',
  'system',
  'imessage',
  /** v2, `handoff.v1`. The sealed handoff file, so the phone can read what was handed over. */
  'handoff',
  /** v2, `handoff.v1`. The sealed review report a reviewing agent wrote. */
  'review',
]);
export type FrameKind = z.infer<typeof FrameKind>;

/** A body too large for one frame is split; the phone reassembles by `group`. */
export const FrameChunk = z.object({
  group: z.string().min(1).max(64),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive().max(1000),
});
export type FrameChunk = z.infer<typeof FrameChunk>;

/**
 * The plaintext both ends authenticate and the cloud indexes on. Deliberately only what routing
 * needs: which session, which position in it, and what kind of thing it is.
 */
export const SealAad = z.object({
  sessionId: SessionId,
  seq: z.number().int().nonnegative(),
  kind: FrameKind,
  chunk: FrameChunk.optional(),
});
export type SealAad = z.infer<typeof SealAad>;

/** One phone's copy of the content key, wrapped to its X25519 key. */
export const SealedRecipient = z.object({
  kid: KeyFingerprint,
  nonce: base64url(12),
  /** ChaCha20-Poly1305 of the 32-byte content key: 32 bytes + a 16-byte tag. */
  wrap: base64url(48),
});
export type SealedRecipient = z.infer<typeof SealedRecipient>;

/** The envelope format version. Bumped only if the sealing scheme itself changes. */
export const SEAL_ENVELOPE_VERSION = 1 as const;

/**
 * A sealed frame body. Ephemeral X25519 per envelope; one wrapped content key per phone; the body
 * itself encrypted once under that content key with `canonicalize(aad)` as the AAD.
 *
 * The cloud validates this shape and its size and stores it opaque. It holds no key that opens
 * `ct`, and `aad` is the only part it can read — which is why `aad` carries ids and never words.
 */
export const SealedEnvelope = z.object({
  v: z.literal(SEAL_ENVELOPE_VERSION),
  /** The ephemeral X25519 public key, raw. */
  epk: base64url(32),
  recipients: z.array(SealedRecipient).min(1).max(32),
  nonce: base64url(12),
  /** Ciphertext + 16-byte tag. Sized by the bridge's chunker, not by this cap. */
  ct: base64url().max(262_144),
  aad: SealAad,
});
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

/** Plaintext facts about a frame. Never its content. */
export const FrameMeta = z.object({
  turnId: z.string().min(1).max(200).optional(),
  parentFrameId: z.string().min(1).max(200).optional(),
  actionType: ApprovalActionType.optional(),
  status: z.enum(['ok', 'error', 'interrupted', 'streaming']).optional(),
  /** False while a streaming frame is still being appended to. */
  final: z.boolean().optional(),
  subagent: z
    .object({ id: z.string().min(1).max(200), depth: z.number().int().nonnegative().max(8) })
    .optional(),
  /** Size of the body BEFORE sealing, so the phone can show "truncated" honestly. */
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  chunk: FrameChunk.optional(),
  /** Where the bridge read it: the agent's stdio, the on-disk transcript, the app server, or a backfill. */
  source: z.enum(['stdio', 'transcript', 'app_server', 'backfill']),
  delivery: z
    .object({
      state: z.enum(['queued', 'picked_up', 'delivered']),
      followupId: z.string().min(1).max(200).optional(),
    })
    .optional(),
});
export type FrameMeta = z.infer<typeof FrameMeta>;

// ---------- v2: control, approvals, questions ----------

/**
 * How much of a session Pagr may drive. A session Pagr started is `full`; a terminal session with
 * a bound channel is `full`, without one `approvals_only`; a Codex TUI thread is `mirror_only`;
 * an unregistered working directory is `none`.
 */
export const ControlLevel = z.enum(['full', 'approvals_only', 'mirror_only', 'none']);
export type ControlLevel = z.infer<typeof ControlLevel>;

/** Who started the session, as far as the bridge can tell. */
export const SessionOrigin = z.enum(['pagr', 'terminal', 'ide', 'unknown']);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/** Whether the session's directory is a project the user has registered. */
export const ProjectStatus = z.enum(['registered', 'unregistered']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * What the agent itself offers for an approval. `optionId` is the agent's own identifier (for
 * Claude and Codex it equals `kind`); the phone renders the options in the order given and never
 * invents one.
 */
export const ApprovalOptionKind = z.enum([
  'allow_once',
  'allow_always',
  'allow_session',
  'reject_once',
  'reject_always',
]);
export type ApprovalOptionKind = z.infer<typeof ApprovalOptionKind>;

export const ApprovalOption = z.object({
  optionId: z.string().min(1).max(64),
  kind: ApprovalOptionKind,
  label: z.string().min(1).max(120),
});
export type ApprovalOption = z.infer<typeof ApprovalOption>;

/** A / B / C, coarsest first. The cloud takes the higher of this and its own hint-based tier. */
export const RiskTier = z.enum(['A', 'B', 'C']);
export type RiskTier = z.infer<typeof RiskTier>;

/** What `agent.send_instruction` did with the instruction, reported in its `command.ack.result`. */
export const InstructionDelivery = z.enum(['steered', 'queued', 'new_turn']);
export type InstructionDelivery = z.infer<typeof InstructionDelivery>;
export const SendInstructionResult = z.object({ delivered: InstructionDelivery });
export type SendInstructionResult = z.infer<typeof SendInstructionResult>;

/** What `repo.scan` answers with, in its `command.ack.result`. Handles, never paths. */
export const RepoScanResult = z.object({
  repos: z
    .array(
      z.object({
        handle: RepoHandle,
        displayName: z.string().min(1).max(80),
        repoHint: z
          .object({
            host: z.string().optional(),
            name: z.string().optional(),
            defaultBranch: z.string().optional(),
          })
          .optional(),
        /** Set when this repository is already a registered project. */
        registeredAs: ProjectId.optional(),
      }),
    )
    .max(500),
  truncated: z.boolean().default(false),
});
export type RepoScanResult = z.infer<typeof RepoScanResult>;

// ---------- v2: handoff and review (`handoff.v1`) ----------

/**
 * Where a switch has got to. The cloud's `handoff` workflow walks these in order and texts the
 * phone at each one; `failed` can follow any of them and is the only state that carries `error`.
 */
export const HandoffState = z.enum([
  'requested',
  'capturing',
  'committing',
  'stopping',
  'starting',
  'running',
  'done',
  'failed',
]);
export type HandoffState = z.infer<typeof HandoffState>;

/**
 * Which agent actually wrote the handoff file. The sender writes its own when Pagr can talk to it;
 * otherwise the receiving agent writes it headless from the transcript. Both happen on the Mac —
 * the difference matters to the person because a receiver-written handoff is a reconstruction.
 */
export const HandoffWriter = z.enum(['sender', 'receiver']);
export type HandoffWriter = z.infer<typeof HandoffWriter>;

/** A reviewing agent's answer, in the order a person cares about it. */
export const ReviewVerdict = z.enum(['approve', 'comment', 'block']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/**
 * The rules files a migration can read from or write to, named rather than free text: everything
 * else in this protocol refuses a path, and a filename the cloud could choose is a path with the
 * directory left off. These three are the whole set the conversion knows about.
 */
export const RulesFile = z.enum(['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md']);
export type RulesFile = z.infer<typeof RulesFile>;

/**
 * What `rules.migrate` decided, in its `command.ack.result`. It is a PROPOSAL when `consent` was
 * false: nothing is written until the person says yes by text and the command is sent again.
 */
export const RulesMigrationAction = z.enum([
  /** The receiver already has its own rules file; nothing to do. */
  'already_present',
  /** The receiver reads the sender's file natively (Claude ≥ 2.1.277 reading `AGENTS.md`). */
  'native_read',
  /** A file was written, because consent was given. */
  'write',
  /** Proposed and declined, or nothing was asked; the handoff carries the rules instead. */
  'skipped',
  /** Neither repo has a rules file. */
  'none',
]);
export type RulesMigrationAction = z.infer<typeof RulesMigrationAction>;

/**
 * What `session.handoff.capture` answers with. `summary` is the one line under `# Goal` — the only
 * part of the handoff that is allowed to reach the cloud in the clear; the file itself travels as
 * a sealed `handoff` frame, and its transcript never leaves the Mac at all.
 */
export const HandoffCaptureResult = z.object({
  writer: HandoffWriter,
  summary: z.string().max(500),
  /** Absent when the tree was already clean, which is the common case at the end of a turn. */
  wipCommit: GitCommit.optional(),
  filesChanged: z.number().int().nonnegative().max(100_000).default(0),
  /** True when the file hit the 64 KiB cap and sections were dropped from the bottom. */
  truncated: z.boolean().default(false),
});
export type HandoffCaptureResult = z.infer<typeof HandoffCaptureResult>;

/** What `review.start` answers with: the review it accepted. The verdict arrives later, as an event. */
export const ReviewStartResult = z.object({ reviewId: ReviewId });
export type ReviewStartResult = z.infer<typeof ReviewStartResult>;

/**
 * What `review.apply` answers with: which agent the findings were handed to, and how.
 *
 * `instructed` means the session that wrote the code is still live and took the turn;
 * `started` means it could not, and a fresh session was started on the same tree with the same
 * instruction. Either way a person asked for this — nothing here happens on a verdict alone.
 */
export const ReviewApplyResult = z.object({
  reviewId: ReviewId,
  /** The session now holding the instruction: the live builder, or the one just started. */
  sessionId: SessionId,
  applied: z.enum(['instructed', 'started']),
  /** How the instruction reached a live session. Absent when a new one was started. */
  delivered: InstructionDelivery.optional(),
});
export type ReviewApplyResult = z.infer<typeof ReviewApplyResult>;

/**
 * What `rules.migrate` answers with. The line count and the file names are composed on the Mac so
 * the cloud can write "Write AGENTS.md from CLAUDE.md (142 lines)?" without ever holding the body.
 */
export const RulesMigrateResult = z.object({
  action: RulesMigrationAction,
  /** The file the rules would be converted FROM, when there is one. */
  sourceFile: RulesFile.optional(),
  lineCount: z.number().int().nonnegative().max(1_000_000).optional(),
  /** The file the conversion would write, when the action is a proposal or a `write`. */
  targetFile: RulesFile.optional(),
});
export type RulesMigrateResult = z.infer<typeof RulesMigrateResult>;

// ---------- v2: recipient keys ----------

/** Feature flags the gateway tells the bridge about; they decide what may be sent in the clear. */
export const ProtocolFeatures = z.object({
  /** The user has an iMessage thread linked, so plaintext `imessage` text is allowed. */
  imessage: z.boolean().default(false),
});
export type ProtocolFeatures = z.infer<typeof ProtocolFeatures>;

/**
 * One phone the bridge seals to.
 *
 * `kid` and `x25519` are checked hard — the bridge re-derives the fingerprint from the key and
 * refuses a set where they disagree. The descriptive fields are optional because this parse must
 * never be STRICTER than whatever a gateway signed: the signature is verified over the bytes as
 * received, so a set that a slightly older (or newer) cloud issued must still parse here, or the
 * bridge would reject a perfectly valid rotation it could verify.
 */
export const RecipientKey = z.object({
  kid: KeyFingerprint,
  /** Raw X25519 public key. */
  x25519: base64url(32),
  name: z.string().min(1).max(80).optional(),
  registeredAt: IsoDate.optional(),
});
export type RecipientKey = z.infer<typeof RecipientKey>;

/**
 * The set of phones a bridge seals frames for. Signed by the gateway under
 * `RECIPIENT_KEY_SET_CONTEXT + canonicalize(set)`; the bridge accepts an unsigned set only when
 * it grants no new trust (the same set again, or a narrower one), exactly as it treats server
 * keys — otherwise a gateway that has been talked into serving one extra key could read
 * everything from then on.
 */
export const RecipientKeySet = z.object({
  v: z.literal(1),
  userId: UserId,
  keys: z.array(RecipientKey).max(32),
  features: ProtocolFeatures.optional(),
  issuedAt: IsoDate.optional(),
});
export type RecipientKeySet = z.infer<typeof RecipientKeySet>;

export const RecipientKeySetSignature = z.object({
  keyId: z.string().min(1).max(32),
  signature: z.string().min(1).max(200),
});
export type RecipientKeySetSignature = z.infer<typeof RecipientKeySetSignature>;

/**
 * A session as v2 describes it. Every added field is optional so a v1 bridge's summary — which
 * has none of them — parses through this same schema unchanged; absent `controlLevel` means the
 * v1 answer, full control of a session Pagr started.
 */
export const SessionSummaryV2 = SessionSummary.extend({
  controlLevel: ControlLevel.optional(),
  origin: SessionOrigin.optional(),
  projectStatus: ProjectStatus.optional(),
  /** Highest frame sequence the bridge has journaled for this session. */
  lastSeq: z.number().int().nonnegative().optional(),
  /**
   * Only on a session whose `projectStatus` is `unregistered`: the `rh_…` handle that
   * `project.register_handle` turns into a project.
   *
   * It is what makes "somebody is running Claude in a folder Pagr does not know about" an
   * actionable card instead of a dead end — one tap registers the folder and the session starts
   * producing frames. It is a handle, not a path, it only resolves on the Mac that offered it,
   * and it expires with the rest of them (`repoScan.ts`).
   */
  repoHandle: RepoHandle.optional(),
});
export type SessionSummaryV2 = z.infer<typeof SessionSummaryV2>;

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
    /**
     * v2, `handoff.v1`. What this session is a continuation of, so the bridge and the cloud can
     * join it to the switch or the review that asked for it.
     *
     * Additive and optional in every part: a v1 payload has no `context` at all and parses
     * unchanged, and the adapters prepend nothing — `instruction` already names the file to read.
     */
    context: z
      .object({ handoffId: HandoffId.optional(), reviewId: ReviewId.optional() })
      .optional(),
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
    /**
     * v2. The exact option the user chose, from `approval.requested.options`. `decision` stays
     * required and stays the truth for a v1 bridge, which has never heard of options; a v2 bridge
     * answers the agent with this id (so "allow always" really is the agent's own "always").
     */
    optionId: z.string().min(1).max(64).optional(),
  }),
  'settings.sync_public_policy': z.object({
    approvalTimeoutSeconds: z.number().int().min(30).max(3600).default(600),
  }),

  // ---- v2 ----

  /** Answer a question the agent asked. Indexes, not text: the options came from the agent. */
  'agent.answer_question': z.object({
    questionId: QuestionId,
    sessionId: SessionId,
    providerRequestId: z.string().min(1).max(200),
    answers: z
      .array(
        z.object({
          questionIndex: z.number().int().nonnegative().max(50),
          optionIndexes: z.array(z.number().int().nonnegative().max(200)).max(50),
          freeText: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
  /** List sessions the bridge knows about but has not streamed, so the phone can ask for them. */
  'session.list_history': z.object({
    provider: Provider.optional(),
    projectId: ProjectId.optional(),
    sinceDays: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  /** Replay journaled frames the phone does not have. Bounded, because it competes with live traffic. */
  'session.backfill': z.object({
    sessionId: SessionId,
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative().optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024)
      .default(1024 * 1024),
  }),
  /**
   * List the repositories on this Mac as opaque handles, so a phone can add a project without
   * anybody — the cloud included — learning a path. Rate limited by the bridge.
   */
  'repo.scan': z.object({}),
  /** Register one of those handles as a project. The bridge resolves the handle locally. */
  'project.register_handle': z.object({
    handle: RepoHandle,
    displayName: z.string().min(1).max(80).optional(),
  }),
  /** Ask the gateway to re-send the recipient key set (after a phone was added or revoked). */
  'keys.sync': z.object({}),

  // ---- v2, capability `handoff.v1` ----

  /**
   * Write the handoff file for a session and, if the tree is dirty, WIP-commit it. The bridge
   * decides who writes (see `HandoffWriter`); the cloud never sees the file, only the ack's
   * summary line and, sealed, the `handoff` frame.
   */
  'session.handoff.capture': z.object({
    handoffId: HandoffId,
    sessionId: SessionId,
    /** The agent that will pick the task up. */
    to: Provider,
    /** An optional line from the person: "focus on the refund path". */
    note: z.string().max(2000).optional(),
  }),
  /**
   * Build the review packet for a commit range and start the reviewing agent read-only on it.
   * The packet is the diff plus one line of intent — never the builder's transcript or reasoning.
   */
  'review.start': z.object({
    reviewId: ReviewId,
    projectId: ProjectId,
    reviewer: Provider,
    range: GitRange,
    /** One line: what the builder was trying to do. */
    intent: z.string().min(1).max(500),
  }),
  /** Send a finished review's findings to the builder — the "fix it" reply. Never automatic. */
  'review.apply': z.object({
    reviewId: ReviewId,
    /** The live builder session to steer; absent means start a fresh one. */
    sessionId: SessionId.optional(),
  }),
  /**
   * Decide — and, with consent, perform — the one rules conversion a switch may need. Sent twice:
   * once with `consent: false` to get the proposal the phone asks about, and again with
   * `consent: true` only after the person said yes. An existing rules file is never modified.
   */
  'rules.migrate': z.object({
    projectId: ProjectId,
    from: Provider,
    to: Provider,
    consent: z.boolean(),
  }),
} as const;

export type CommandType = keyof typeof CommandPayloads;
export const CommandType = z.enum(Object.keys(CommandPayloads) as [CommandType, ...CommandType[]]);

const commandVariants = variantsOf(CommandPayloads);

/** The unsigned portion of a command. Signed as canonical JSON (see `canonicalize`). */
export const CommandBody = z
  .object({
    /** 1 or 2 — see the header. The *negotiated* version decides what may be sent. */
    version: ProtocolVersion,
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

export const EventPayloads = {
  'device.hello': z.object({
    bridgeVersion: z.string(),
    protocolVersion: ProtocolVersion,
    platform: z.enum(['darwin']),
    osVersion: z.string().optional(),
    agents: z.array(AgentConnectionStatus),
    projects: z.array(ProjectSummary),
    sessions: z.array(SessionSummaryV2),
    /** v2. Named capabilities (`frames.v1`, `seal.v1`, …) so the cloud gates features on facts. */
    capabilities: z.array(z.string().min(1).max(64)).max(64).optional(),
    /** v2. Approval classes the user has lifted off the floor on this Mac. */
    floor: z.object({ lifted: z.array(z.string().min(1).max(64)).max(64) }).optional(),
    /**
     * v2. State of the Claude channel on this Mac, for `pagr doctor` and the app's Security
     * screen. Four separate truths that are routinely confused, so each is its own field:
     *
     *   - `serverInstalled` — the channel server file is present in this install.
     *   - `registered` — the bridge has the channel registered and ready (the daemon's
     *     `channel.*` IPC is on and the server is installed), so `pagr claude` can attach one.
     *   - `boundSessions` — Claude sessions bound by session id right now. This is the number
     *     that decides whether any single terminal can be given a turn from a phone.
     *   - `mode` — `queued_next_turn` when the channel is registered, `off` when it is not.
     *     Never `steered`: a channel line is surfaced to Claude at the next turn boundary.
     *
     * `shimOnPath` is the field the shim-based design used before the launcher replaced it
     * (there is no `claude` shim any more — see `pagr claude`). It is optional and no longer
     * sent; it stays in the schema so a hello from an older bridge still parses.
     */
    channel: z
      .object({
        serverInstalled: z.boolean(),
        registered: z.boolean().optional(),
        /** @deprecated replaced by `registered`; never sent by a bridge that has the launcher. */
        shimOnPath: z.boolean().optional(),
        boundSessions: z.number().int().nonnegative(),
        mode: z.string().max(40),
      })
      .optional(),
    /** v2. Which phones this bridge is currently sealing to, so a mismatch is visible. */
    recipientKeyIds: z.array(KeyFingerprint).max(32).optional(),
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
        /** v2. The question id is not pending any more: it expired, or was already answered. */
        'unknown_question',
        /** v2. The bridge is throttling this command class (a repeated `repo.scan`, say). */
        'rate_limited',
        /** v2. A v2-only command arrived on a link that negotiated v1. */
        'not_negotiated',
      ])
      .optional(),
    message: z.string().max(500).optional(),
    /**
     * Command-specific payload. Typed per command by the schemas above: `SendInstructionResult`
     * for `agent.send_instruction`, `RepoScanResult` for `repo.scan`. Left `unknown` here because
     * an ack does not carry the type of the command it answers — the caller knows it from the row.
     */
    result: z.unknown().optional(),
  }),
  'project.registered': ProjectSummary,
  'project.removed': z.object({ projectId: ProjectId }),
  'agent.connection': AgentConnectionStatus,
  'session.updated': SessionSummaryV2,
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
    /**
     * Short, user-safe preview: the command line or file list. Never full file contents.
     *
     * v1 always sends it and keeps working exactly as before. v2 sends the preview sealed, in its
     * own `approval_preview` frame, so this plaintext copy defaults away — one schema cannot ask
     * for a field conditionally, and defaulting is what lets a v1 payload and a v2 payload both
     * parse without the cloud having to guess which it is holding.
     */
    preview: z.string().max(1500).default(''),
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
    /** v2. The agent's own options, in the agent's order. The phone renders exactly these. */
    options: z.array(ApprovalOption).max(8).optional(),
    /** v2. The bridge's local tier; the cloud takes the higher of this and its own. */
    riskTier: RiskTier.optional(),
    /** v2. Sequence of the sealed `approval_preview` frame carrying the full preview. */
    frameSeq: z.number().int().nonnegative().optional(),
    /** v2. Plaintext line for the iMessage thread; only sent when iMessage is linked. */
    imessage: z.string().max(1500).optional(),
  }),
  'approval.resolved_locally': z.object({
    approvalId: ApprovalId,
    resolution: z.enum(['allowed', 'denied', 'timed_out', 'canceled']),
    /** v2. Where the answer came from, so the phone can say "answered on your Mac". */
    source: z.enum(['terminal', 'ide', 'provider', 'bridge', 'timeout', 'shutdown']).optional(),
    /**
     * v2. True when somebody answered it somewhere else while the phone was showing it — the
     * phone dismisses its card instead of reporting an error.
     */
    answeredElsewhere: z.boolean().default(false),
  }),
  'attachment.consumed': z.object({
    attachmentId: AttachmentId,
    ok: z.boolean(),
    error: z.string().optional(),
  }),

  // ---- v2 ----

  /**
   * One transcript frame. The body is inside `sealed`; everything outside it is routing metadata
   * the cloud is allowed to see. `seq` is allocated by the bridge's journal and is monotonic per
   * session, which is what makes replay and backfill exact.
   */
  'session.frame': z.object({
    sessionId: SessionId,
    projectId: ProjectId,
    provider: Provider,
    seq: z.number().int().nonnegative(),
    kind: FrameKind,
    at: IsoDate,
    /** The provider's own id for the record this frame came from; used to de-duplicate. */
    providerRecordId: z.string().min(1).max(200).optional(),
    sealed: SealedEnvelope,
    meta: FrameMeta,
    /** Plaintext line for the iMessage thread; only sent when iMessage is linked. */
    imessage: z.string().max(1500).optional(),
  }),
  /**
   * The agent asked the user something. The text and the option labels are in the sealed frame at
   * `seq`; `meta` says only what the phone needs to lay the answer sheet out before decrypting.
   */
  'question.asked': z.object({
    questionId: QuestionId,
    sessionId: SessionId,
    projectId: ProjectId,
    provider: Provider,
    providerRequestId: z.string().min(1).max(200),
    seq: z.number().int().nonnegative(),
    meta: z.object({
      /** False when only the Mac can answer (a terminal dialog Pagr cannot reach). */
      answerable: z.boolean(),
      reason: z.string().max(80).optional(),
      multiSelect: z.array(z.boolean()).max(50),
      optionCount: z.array(z.number().int().nonnegative().max(200)).max(50),
      /** Per question: the answer must never be echoed back or stored in the clear. */
      secret: z.array(z.boolean()).max(50),
    }),
    expiresAt: IsoDate,
    imessage: z.string().max(1500).optional(),
  }),
  'question.answered': z.object({
    questionId: QuestionId,
    /** True when the Mac answered it while the phone had it open. */
    answeredElsewhere: z.boolean().default(false),
    /**
     * Why it ended, when it did not end in an answer from the phone: `timed_out`, `canceled`,
     * `shutdown`, `answered_elsewhere`. Additive and optional — a client that has never heard of
     * it still learns the only thing it must act on, which is that the sheet can go away.
     */
    reason: z.string().max(80).optional(),
  }),
  /**
   * The agent actually applied a decision. This is what moves the phone's card from `sending` to
   * `acknowledged`: the command ack only says the bridge received the instruction.
   */
  'approval.applied': z.object({
    approvalId: ApprovalId,
    sessionId: SessionId,
    optionId: z.string().min(1).max(64),
    applied: z.boolean(),
    /** What the agent did with it, when that differs from the option asked for. */
    appliedAs: z.string().min(1).max(64).optional(),
    error: z.string().max(500).optional(),
  }),

  // ---- v2, capability `handoff.v1` ----

  /**
   * A switch moved. One of these is emitted for every `HandoffState` the bridge enters, which is
   * what makes the phone's running commentary ("Handing off…", "✓ WIP committed (3 files)") a
   * report of what happened rather than an optimistic guess.
   *
   * Everything past `state` is optional because each field becomes true at a different step:
   * `writer` and `summary` at `capturing`, `wipCommit` and `filesChanged` at `committing`,
   * `error` only on `failed`.
   */
  'handoff.updated': z.object({
    handoffId: HandoffId,
    state: HandoffState,
    /** The `# Goal` line. The only part of the handoff the cloud sees in the clear. */
    summary: z.string().max(500).optional(),
    wipCommit: GitCommit.optional(),
    writer: HandoffWriter.optional(),
    filesChanged: z.number().int().nonnegative().max(100_000).optional(),
    truncated: z.boolean().optional(),
    /** Set only with `state: 'failed'`; the first line of whatever went wrong, never a path. */
    error: z.string().max(500).optional(),
  }),
  /** The reviewing agent wrote its report. `summary` is the verdict line the phone is sent. */
  'review.completed': z.object({
    reviewId: ReviewId,
    verdict: ReviewVerdict,
    summary: z.string().max(500),
    /**
     * Why the verdict needed interpreting, when it did — including the first line the reviewer
     * actually wrote.
     *
     * A report whose first line is not `verdict: …` is read as `comment` (see `parseVerdict`),
     * and without this field that is indistinguishable from a reviewer that looked hard and had
     * something mild to say. The person is owed the difference: one is a reviewer that
     * misformatted its answer, the other is a reviewer that judged the change.
     */
    note: z.string().max(500).optional(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EventType = z.enum(Object.keys(EventPayloads) as [EventType, ...EventType[]]);

const eventVariants = variantsOf(EventPayloads);

export const DeviceEvent = z
  .object({
    version: ProtocolVersion,
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
  /** The highest version this bridge speaks — an OFFER. The gateway's answer is what binds. */
  protocolVersion: ProtocolVersion,
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
  /**
   * v2. The version the gateway ACCEPTS for this connection, answering the bridge's offer.
   * Absent means 1 — which is what every gateway deployed before v2 sends, and why nothing
   * v2-only may be emitted until this says 2.
   */
  protocolVersion: ProtocolVersion.optional(),
  /** v2. The phones to seal frames for. Empty set → the bridge journals frames and sends none. */
  recipientKeys: RecipientKeySet.optional(),
  /** v2. Signature over `RECIPIENT_KEY_SET_CONTEXT + canonicalize(recipientKeys)`. */
  recipientKeysSignature: RecipientKeySetSignature.optional(),
  /** v2. What the account has switched on; `imessage` gates every plaintext `imessage` field. */
  features: ProtocolFeatures.optional(),
});

/** Domain separator for `serverKeysSignature`, so a command signature can never be replayed as one. */
export const SERVER_KEY_SET_CONTEXT = 'pagr.server-keys.v1:';

/**
 * v2. The gateway has persisted every frame up to `cursors[sessionId]`. The bridge resumes from
 * its journal for any session where what it sent is ahead of what was acked, which is what makes
 * a dropped socket lossless rather than a gap in the transcript.
 */
export const GatewayAck = z.object({
  kind: z.literal('ack'),
  cursors: z.record(z.number().int().nonnegative()),
});

/** v2. A phone was added or revoked; seal to this set from now on. Same trust rule as `auth.result`. */
export const KeysUpdated = z.object({
  kind: z.literal('keys.updated'),
  recipientKeys: RecipientKeySet,
  recipientKeysSignature: RecipientKeySetSignature.optional(),
});

/** v2. A feature was switched on or off mid-connection (linking iMessage, say). */
export const SettingsUpdated = z.object({
  kind: z.literal('settings.updated'),
  features: ProtocolFeatures,
});

export const GatewayFrame = z.discriminatedUnion('kind', [
  AuthChallenge,
  AuthResult,
  z.object({ kind: z.literal('command'), envelope: CommandEnvelope }),
  z.object({ kind: z.literal('ping') }),
  GatewayAck,
  KeysUpdated,
  SettingsUpdated,
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
