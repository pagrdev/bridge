import os from 'node:os';
import path from 'node:path';
import type { CodingAgentAdapter } from '@pagr/bridge-core';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.js';
import { channelModeEnabled } from './channel-mode.js';
import { MockClaudeAdapter, type MockClaudeOptions } from './mock.js';

export { ClaudeAdapter, type ClaudeAdapterOptions, newApprovalId } from './adapter.js';
export {
  CHANNEL_FLAG_ENV,
  CHANNEL_PROBE_DETAIL,
  ChannelMode,
  type ChannelTarget,
  channelCapabilities,
  channelModeEnabled,
  channelStatus,
} from './channel-mode.js';
export {
  ClaudeProcess,
  type ClaudeProcessOptions,
  DEFAULT_SETTING_SOURCES,
  READ_ONLY_DISALLOWED_TOOLS,
  SEALED_MODE_ENV,
  SEALED_SETTING_SOURCES,
  sealedModeEnabled,
} from './claude-process.js';
export {
  asToolUseResult,
  type ClaudeToolUseResult,
  diffBodyFor,
  EDIT_TOOLS,
  encodeProjectDir,
  MAX_PERSISTED_OUTPUT_BYTES,
  normalizeHunks,
  readPersistedOutput,
  TranscriptResultLookup,
  terminalBodyFor,
  transcriptPathFor,
  unifiedFromReplace,
} from './diffs.js';
export { clip, type Hints, hintsForCommand, hintsForFiles } from './heuristics.js';
export {
  bundledHookPath,
  claudeHookState,
  type HookInstallReport,
  type HookRemovalReport,
  type HookState,
  hookSettings,
  installClaudeHook,
  installedHookPath,
  installHooks,
  SETTINGS_BACKUP_SUFFIX,
  uninstallClaudeHook,
} from './hooks/install.js';
export {
  ClaudeSettingsUnreadableError,
  claudeUserSettingsPath,
  HOOK_TIMEOUT_SECONDS,
  isPagrHookCommand,
  PERMISSION_REQUEST_EVENT,
  pagrHookCommand,
  pagrHookGroup,
  planHookInstall,
  planHookRemoval,
} from './hooks/settings.js';
export { MockClaudeAdapter, type MockClaudeOptions } from './mock.js';
export {
  type AssistantBlock,
  actionTypeForTool,
  controlResponseLine,
  legacyEvent,
  mapToolKind,
  parseStreamLine,
  parseStreamRecord,
  previewForTool,
  type StreamEvent,
  type StreamRecord,
  type UserBlock,
  userMessageLine,
} from './stream-json.js';
export {
  type ClaudeProcessInfo,
  ClaudeProcessWatch,
  type ClaudeProcessWatchOptions,
  cwdOfTranscript,
  type DiscoveryEvent,
  isProcessAlive,
  ORPHAN_WINDOW_MS,
  readPidFile,
} from './transcript/discovery.js';
export {
  ClaudeMirror,
  type ClaudeMirrorOptions,
  originOf,
  syntheticClaudeSessionId,
} from './transcript/mirror.js';
export {
  encodeProjectDir as encodeClaudeProjectDir,
  isLiveTranscriptName,
  pidOfSessionFile,
  projectDirFor,
  projectsDir,
  sessionFile,
  sessionIdOfTranscript,
  sessionsDir,
  spillDir,
  subagentIdOfFile,
  subagentMetaFile,
  subagentsDir,
} from './transcript/paths.js';
export {
  IGNORED_RECORD_TYPES,
  parseSubagentMeta,
  parseTranscriptRecord,
  readSpilledOutput,
  type SubagentMeta,
  type TranscriptBody,
  type TranscriptRecord,
  UnknownRecordTypes,
} from './transcript/records.js';
export {
  type TailedRecord,
  type TailerFileState,
  TailerStateStore,
  TranscriptTailer,
  type TranscriptTailerOptions,
} from './transcript/tailer.js';

export interface CreateClaudeAdapterOptions extends Partial<Omit<ClaudeAdapterOptions, 'home'>> {
  home?: string;
  /** Use the scripted in-process mock. Defaults to `PAGR_MOCK_AGENTS=1`. */
  mock?: boolean;
  mockOptions?: MockClaudeOptions;
  /** Environment consulted for `PAGR_CLAUDE_CHANNEL`; defaults to `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
}

export function defaultPagrHome(): string {
  return process.env.PAGR_HOME || path.join(os.homedir(), '.pagr');
}

export function createClaudeAdapter(opts: CreateClaudeAdapterOptions = {}): CodingAgentAdapter {
  const env = opts.processEnv ?? process.env;
  const mock = opts.mock ?? env.PAGR_MOCK_AGENTS === '1';
  if (mock) return new MockClaudeAdapter(opts.mockOptions);
  const { home, mock: _m, mockOptions: _mo, processEnv: _pe, ...rest } = opts;
  // ADR 0001: `approved-channel` is feature-flagged and off unless the operator opts in.
  return new ClaudeAdapter({
    ...rest,
    home: home ?? defaultPagrHome(),
    channel: opts.channel ?? channelModeEnabled(env),
  });
}
