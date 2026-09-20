import { describe, expect, it } from 'vitest';
import {
  isRunOnceFrame,
  newRunId,
  runOnceFrameMeta,
  runOnceSessionId,
  writableRootsFor,
} from './runOnce.js';

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

describe('writableRootsFor', () => {
  it('cuts a glob at its first magic segment and makes it absolute', () => {
    expect(writableRootsFor('/repo', ['.pagr/**'])).toEqual(['/repo/.pagr']);
    expect(writableRootsFor('/repo', ['.pagr/review/*/packet.md'])).toEqual(['/repo/.pagr/review']);
  });

  it('keeps an absolute glob absolute', () => {
    expect(writableRootsFor('/repo', ['/var/folders/x/**'])).toEqual(['/var/folders/x']);
  });

  it('collapses a root another root already contains, in either order', () => {
    expect(writableRootsFor('/repo', ['.pagr/**', '.pagr/handoff/**'])).toEqual(['/repo/.pagr']);
    expect(writableRootsFor('/repo', ['.pagr/handoff/**', '.pagr/**'])).toEqual(['/repo/.pagr']);
  });

  it('grants nothing for an empty list, and nothing extra for a bare `**`', () => {
    expect(writableRootsFor('/repo', [])).toEqual([]);
    // `**` has no literal prefix: the workspace is whatever the sandbox already grants, and this
    // must not quietly widen it to the filesystem root.
    expect(writableRootsFor('/repo', ['**'])).toEqual([]);
  });
});
