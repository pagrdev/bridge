import { describe, expect, it } from 'vitest';
import { isRunOnceFrame, newRunId, runOnceFrameMeta, runOnceSessionId } from './runOnce.js';

describe('run ids', () => {
  it('mints a local `run_` id and a stable `ses_` id from it', () => {
    const runId = newRunId();
    expect(runId).toMatch(/^run_[0-9a-f]{32}$/);
    const sessionId = runOnceSessionId('claude', runId);
    expect(sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    // Same run, same id: a retry that reuses the run id groups with its first attempt.
    expect(runOnceSessionId('claude', runId)).toBe(sessionId);
    // The provider is part of the seed, so the two agents' runs never collide.
    expect(runOnceSessionId('codex', runId)).not.toBe(sessionId);
  });
});

describe('the frame marker', () => {
  it('marks a run without touching what `source` means', () => {
    const meta = runOnceFrameMeta('run_abc', 'stdio');
    expect(meta.source).toBe('stdio');
    expect(meta.subagent).toEqual({ id: 'run_abc', depth: 0 });
    expect(isRunOnceFrame(meta)).toBe(true);
  });

  it('does not mistake an ordinary frame, or a real subagent, for a run', () => {
    expect(isRunOnceFrame({ source: 'stdio' })).toBe(false);
    expect(isRunOnceFrame({ source: 'transcript', subagent: { id: 'agent-7', depth: 1 } })).toBe(
      false,
    );
  });
});
