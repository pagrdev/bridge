/**
 * Narrow, hand-curated subset of the Codex app-server v2 protocol used by this adapter.
 *
 * The full generated surface lives in `./generated/` (output of
 * `codex app-server generate-ts --out src/generated`, Codex CLI 0.149.1, 2026-08-24). Those
 * files are kept for reference/auditing only; they are excluded from the TypeScript build because
 * ts-rs emits extension-less relative imports that NodeNext rejects. Every shape below was copied
 * from the corresponding generated file (named in the comment) so the two stay easy to diff.
 *
 * Wire format (codex-rs/app-server/README.md): "JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"`
 * header omitted on the wire)", newline-delimited JSON over stdio.
 */

// ---- generic JSON-RPC (no `jsonrpc` field) ----

export type RpcId = number | string;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}
export interface RpcNotification {
  method: string;
  params?: unknown;
  /** Present on real app-server notifications (observed 0.149.1). */
  emittedAtMs?: number;
}
export interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

// ---- initialize (generated/InitializeParams.ts, InitializeCapabilities.ts, InitializeResponse.ts) ----

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ---- thread (generated/v2/ThreadStartParams.ts, Thread.ts, ThreadStatus.ts, AskForApproval.ts, SandboxMode.ts) ----

/** generated/v2/AskForApproval.ts: "untrusted" | "on-request" | { granular } | "never" */
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
/** generated/v2/SandboxMode.ts */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> };

export interface Thread {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  name: string | null;
  turns: Turn[];
}

export interface ThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  ephemeral?: boolean | null;
}
export interface ThreadStartResponse {
  thread: Thread;
}
export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
}
export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  cwd?: string | string[] | null;
}
export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

// ---- turn (generated/v2/Turn*.ts, UserInput.ts, ThreadItem.ts) ----

export type UserInput =
  | { type: 'text'; text: string; text_elements: never[] }
  | { type: 'localImage'; path: string };

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export interface TurnError {
  message: string;
  additionalDetails: string | null;
}
export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
}
export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
}
export interface TurnStartResponse {
  turn: Turn;
}
export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  /** "Required active turn id precondition. The request fails when it does not match." */
  expectedTurnId: string;
}
export interface TurnSteerResponse {
  turnId: string;
}
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; status: string }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string; kind: string }> }
  | { type: 'userMessage'; id: string }
  | { type: 'reasoning'; id: string }
  | { type: string; id: string };

// ---- notifications ----

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}
export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}
export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}
export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}
export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}
/** generated/v2/AccountUpdatedNotification.ts */
export interface AccountUpdatedNotification {
  authMode: string | null;
  planType: string | null;
}

// ---- account (generated/v2/GetAccountResponse.ts, Account.ts) ----

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

// ---- server → client requests (must be answered by id) ----

/** generated/v2/CommandExecutionRequestApprovalParams.ts */
export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}
/** generated/v2/CommandExecutionApprovalDecision.ts (subset we ever send) */
export type CommandExecutionApprovalDecision = 'accept' | 'decline' | 'cancel';

/** generated/v2/FileChangeRequestApprovalParams.ts */
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}
export type FileChangeApprovalDecision = 'accept' | 'decline' | 'cancel';

/** generated/v2/PermissionsRequestApprovalParams.ts */
export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: { network: unknown | null; fileSystem: unknown | null };
}
/** generated/v2/PermissionsRequestApprovalResponse.ts — an empty grant is a denial. */
export interface PermissionsRequestApprovalResponse {
  permissions: { network?: unknown; fileSystem?: unknown };
  scope: 'turn' | 'session';
}

export const METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
} as const;

export const NOTIFICATIONS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  threadStatusChanged: 'thread/status/changed',
  accountUpdated: 'account/updated',
  error: 'error',
} as const;
