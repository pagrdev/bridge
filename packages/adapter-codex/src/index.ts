import os from 'node:os';
import path from 'node:path';
import type { CodingAgentAdapter } from '@pagr/bridge-core';
import { CodexAdapter, type CodexAdapterOptions } from './adapter.js';
import { MockCodexAdapter, type MockCodexOptions } from './mock.js';

export {
  buildInput,
  CodexAdapter,
  type CodexAdapterOptions,
  MIRROR_READ_ONLY,
  mirrorStatus,
  newApprovalId,
} from './adapter.js';
export {
  AppServerClient,
  type AppServerOptions,
  type AppServerTransportSpec,
} from './app-server.js';
export {
  commandApprovalOptions,
  decisionForOption,
  fileChangeApprovalOptions,
  OPTION_LABELS,
  permissionsApprovalOptions,
  scopeForOption,
} from './approvals.js';
export {
  CONTROL_SOCKET_FILE,
  type CodexMode,
  codexHomeDir,
  controlSocketPath,
  controlSocketPresent,
  DAEMON_PROBE_TIMEOUT_MS,
  DAEMON_START_HINT,
  type DaemonProbeResult,
  type DoctorLine,
  daemonDoctorLine,
  probeDaemon,
  versionFromUserAgent,
} from './daemon.js';
export { clip, type Hints, hintsForCommand, hintsForFiles } from './heuristics.js';
export {
  DeltaCoalescer,
  framesForItem,
  framesForTurns,
  type MappedFrame,
  parseUnifiedDiff,
  STREAM_FLUSH_BYTES,
  STREAM_FLUSH_MS,
} from './items.js';
export { classifyLine, encode, LineBuffer } from './jsonrpc.js';
export {
  IDLE_UNSUBSCRIBE_MS,
  type MirroredThread,
  READ_POLL_INTERVAL_MS,
  TerminalThreadMirror,
} from './mirror.js';
export { MockCodexAdapter, type MockCodexOptions } from './mock.js';
export * as CodexProtocol from './protocol.js';
export {
  RUN_ONCE_APPROVAL_POLICY,
  runOnceThreadParams,
  runOnceTurnParams,
} from './run-once.js';

export interface CreateCodexAdapterOptions extends Partial<Omit<CodexAdapterOptions, 'home'>> {
  /** PAGR_HOME. Defaults to `$PAGR_HOME` or `~/.pagr`. */
  home?: string;
  /** Use the scripted in-process mock (no Codex needed). Defaults to `PAGR_MOCK_AGENTS=1`. */
  mock?: boolean;
  mockOptions?: MockCodexOptions;
}

export function defaultPagrHome(): string {
  return process.env.PAGR_HOME || path.join(os.homedir(), '.pagr');
}

export function createCodexAdapter(opts: CreateCodexAdapterOptions = {}): CodingAgentAdapter {
  const mock = opts.mock ?? process.env.PAGR_MOCK_AGENTS === '1';
  if (mock) return new MockCodexAdapter(opts.mockOptions);
  const { home, mock: _m, mockOptions: _mo, ...rest } = opts;
  return new CodexAdapter({ home: home ?? defaultPagrHome(), ...rest });
}
