import os from 'node:os';
import path from 'node:path';
import type { CodingAgentAdapter } from '@pagr/bridge-core';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.js';
import { MockClaudeAdapter, type MockClaudeOptions } from './mock.js';

export { ClaudeAdapter, type ClaudeAdapterOptions, newApprovalId } from './adapter.js';
export { ClaudeProcess, type ClaudeProcessOptions } from './claude-process.js';
export { clip, type Hints, hintsForCommand, hintsForFiles } from './heuristics.js';
export { bundledHookPath, hookSettings, installHooks } from './hooks/install.js';
export { MockClaudeAdapter, type MockClaudeOptions } from './mock.js';
export {
  actionTypeForTool,
  controlResponseLine,
  parseStreamLine,
  previewForTool,
  type StreamEvent,
  userMessageLine,
} from './stream-json.js';

export interface CreateClaudeAdapterOptions extends Partial<Omit<ClaudeAdapterOptions, 'home'>> {
  home?: string;
  /** Use the scripted in-process mock. Defaults to `PAGR_MOCK_AGENTS=1`. */
  mock?: boolean;
  mockOptions?: MockClaudeOptions;
}

export function defaultPagrHome(): string {
  return process.env.PAGR_HOME || path.join(os.homedir(), '.pagr');
}

export function createClaudeAdapter(opts: CreateClaudeAdapterOptions = {}): CodingAgentAdapter {
  const mock = opts.mock ?? process.env.PAGR_MOCK_AGENTS === '1';
  if (mock) return new MockClaudeAdapter(opts.mockOptions);
  const { home, mock: _m, mockOptions: _mo, ...rest } = opts;
  return new ClaudeAdapter({ home: home ?? defaultPagrHome(), ...rest });
}
