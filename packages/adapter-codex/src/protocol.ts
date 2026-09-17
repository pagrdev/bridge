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
  /** generated/v2/Thread.ts: "Origin of the thread (CLI, VSCode, codex exec, app-server…)". */
  source?: string | { type?: string } | null;
  cliVersion?: string;
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
  /** generated/v2/ThreadSourceKind.ts. Omitted means "interactive sources". */
  sourceKinds?: ThreadSourceKind[] | null;
  /** "return from the state DB without scanning JSONL rollouts to repair thread metadata" */
  useStateDbOnly?: boolean;
}
export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

/** generated/v2/ThreadSourceKind.ts */
export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

/** generated/v2/ThreadLoadedListParams.ts / ThreadLoadedListResponse.ts */
export interface ThreadLoadedListParams {
  cursor?: string | null;
  limit?: number | null;
}
export interface ThreadLoadedListResponse {
  /** Thread ids for sessions currently loaded in the server's memory. */
  data: string[];
  nextCursor: string | null;
}

/** generated/v2/ThreadReadParams.ts / ThreadReadResponse.ts */
export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}
export interface ThreadReadResponse {
  thread: Thread;
}

/** generated/v2/ThreadUnsubscribeParams.ts / ThreadUnsubscribeResponse.ts */
export interface ThreadUnsubscribeParams {
  threadId: string;
}
export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';
export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
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

/** generated/v2/PatchChangeKind.ts */
export type PatchChangeKind =
  | { type: 'add' }
  | { type: 'delete' }
  | { type: 'update'; move_path?: string | null };

/** generated/v2/FileUpdateChange.ts */
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  /** Unified diff for this one file, as the app-server rendered it. */
  diff: string;
}

/** generated/v2/CommandExecutionStatus.ts (the values this adapter branches on). */
export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'aborted';

/** generated/v2/McpToolCallResult.ts — only the shape the mapper reads. */
export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }> | null;
  isError?: boolean | null;
  structuredContent?: unknown;
}

/**
 * The items this adapter maps to frames, copied field for field from `generated/v2/ThreadItem.ts`.
 *
 * The final member is the open end of the real union (twenty-odd variants, most of which mean
 * nothing to a phone): an item this adapter has no mapping for is skipped, never guessed at.
 */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | { type: 'userMessage'; id: string; content?: UserInput[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd?: string;
      status: CommandExecutionStatus | string;
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: FileUpdateChange[];
      status?: string;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status?: string;
      arguments?: unknown;
      result?: McpToolCallResult | null;
      error?: { message?: string } | string | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace?: string | null;
      tool: string;
      arguments?: unknown;
      status?: string;
      contentItems?: Array<{ type?: string; text?: string }> | null;
      success?: boolean | null;
    }
  | {
      type: 'webSearch';
      id: string;
      action?: WebSearchAction | null;
    }
  | { type: string; id: string };

/** generated/v2/WebSearchAction.ts */
export type WebSearchAction =
  | { type: 'search'; query?: string | null; queries?: string[] | null }
  | { type: 'openPage'; url?: string | null }
  | { type: 'findInPage'; url?: string | null; pattern?: string | null }
  | { type: 'other' };

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

/** generated/v2/CommandExecutionOutputDeltaNotification.ts */
export interface CommandExecutionOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
/** generated/v2/ReasoningTextDeltaNotification.ts (summaryTextDelta has `summaryIndex`). */
export interface ReasoningTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex?: number;
  summaryIndex?: number;
}
/** generated/v2/FileChangePatchUpdatedNotification.ts */
export interface FileChangePatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[];
}
/** generated/v2/ServerRequestResolvedNotification.ts */
export interface ServerRequestResolvedNotification {
  threadId: string;
  requestId: RpcId;
}

// ---- questions (generated/v2/ToolRequestUserInput*.ts) ----

export interface ToolRequestUserInputOption {
  label: string;
  description: string;
}
export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
}
export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs?: number | null;
}
/** `answers` is keyed by question id; each answer is a list of option labels (or free text). */
export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

// ---- approval decisions (generated/v2/*ApprovalDecision.ts) ----

/**
 * The decisions the two approval enums actually offer. `acceptForSession` is Codex's own
 * "allow for the rest of this session"; there is no `rejectForSession` in either enum, which is
 * why `reject_always` is never offered for a Codex approval.
 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export const METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  threadLoadedList: 'thread/loaded/list',
  threadRead: 'thread/read',
  threadUnsubscribe: 'thread/unsubscribe',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  requestUserInput: 'item/tool/requestUserInput',
} as const;

export const NOTIFICATIONS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  serverRequestResolved: 'serverRequest/resolved',
  threadStatusChanged: 'thread/status/changed',
  accountUpdated: 'account/updated',
  error: 'error',
} as const;
