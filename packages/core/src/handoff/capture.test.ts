import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendInstructionInput } from '../adapters/types.js';
import type { ExecFileLike } from '../git.js';
import { useTempHome } from '../testUtil.js';
import {
  type CaptureProgress,
  captureFromSender,
  HANDOFF_CAPTURE_TIMEOUT_ENV,
  HANDOFF_CAPTURE_TIMEOUT_MS,
  handoffCaptureTimeoutMs,
  handoffFilePath,
  type InstructionDelivery,
} from './capture.js';

const HANDOFF_ID = 'hnd_0123456789abcdef0123456789abcdef';
const SESSION_ID = 'ses_sender';

/**
 * A handoff file exactly as a well-behaved agent writes it. Kept as literal text rather than
 * built with `serialize`, so that a change to the serializer that broke real agents' output
 * would fail here instead of quietly agreeing with itself.
 */
const VALID_FILE = `---
pagr: handoff/1
id: ${HANDOFF_ID}
from: { provider: claude, sessionId: ses_sender, origin: pagr }
to: { provider: codex }
project: { id: prj_checkout, name: checkout-api }
git: { branch: feat/refunds, head: 3f9c1d2, wipCommit: null, dirtyBefore: true }
writer: sender
previous: null
created: 2026-09-20T05:41:12Z
---

# Goal
Make partial refunds idempotent on the payments route.

# Done
- Added the idempotency key column

# Not done
- [ ] Wire the key through the handler ← next
- [ ] Backfill the existing rows

# Decisions and why
- Key on (order_id, amount) — a UUID from the client was rejected as unverifiable

# Files touched
- src/payments/refund.ts — new guard

# Commands to run
\`\`\`
pnpm test payments
\`\`\`

# Known failures

# Rules in force
- No schema change without a migration

# Open questions
- Does the ledger need the same guard?
`;

/**
 * Git, faked at the process boundary.
 *
 * `git.ts` is the only module allowed to spawn git (there is a test that enforces it), so the
 * capture's two git calls are answered by substituting the runner rather than by building a real
 * repository. `ensureExcluded` still writes a real `.git/info/exclude`, which is the part these
 * tests actually assert on.
 */
/** `git.ts` keeps its failure shape private; take it from the callback it hands the runner. */
type GitFailure = NonNullable<Parameters<Parameters<ExecFileLike>[3]>[0]>;

/** `execFile`'s failure is an Error carrying the exit code and the child's stderr. */
const gitFailure = (stderr: string, code = 128): GitFailure =>
  Object.assign(new Error(`Command failed: git`), { code, stderr, stdout: '' });

function fakeGit(home: string, log: string[]): ExecFileLike {
  const gitDir = join(home, '.git');
  return (_file, args, _options, callback) => {
    const argv = args.join(' ');
    log.push(`git ${argv}`);
    if (argv === 'rev-parse --show-toplevel') return callback(null, `${home}\n`, '');
    if (argv === 'rev-parse --absolute-git-dir') return callback(null, `${gitDir}\n`, '');
    return callback(gitFailure(`unexpected: git ${argv}`), '', `unexpected: git ${argv}`);
  };
}

/**
 * A live agent, as far as a capture can tell: something that takes an instruction and may put a
 * file on disk because of it. `writes` is consumed one entry per instruction, so a test spells
 * out what the agent does on the first ask and on the re-ask.
 */
class FakeSender {
  readonly instructions: SendInstructionInput[] = [];
  delivered: InstructionDelivery = 'steered';
  throwOnSend: Error | null = null;
  /** Runs after the entry for this instruction has been written. */
  afterSend: (() => void) | null = null;

  constructor(
    private readonly file: string,
    private readonly writes: Array<string | null>,
    private readonly log: string[] = [],
  ) {}

  async sendInstruction(input: SendInstructionInput): Promise<{ delivered: InstructionDelivery }> {
    this.log.push('sendInstruction');
    if (this.throwOnSend) throw this.throwOnSend;
    this.instructions.push(input);
    const body = this.writes.shift() ?? null;
    if (body !== null) {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, body);
    }
    this.afterSend?.();
    return { delivered: this.delivered };
  }
}

/**
 * Hand control back to the event loop until the capture has installed its poll and its deadline.
 *
 * `captureFromSender` does real I/O (the exclude file, the handoff directory) before it starts
 * waiting, so a test that advances the clock the instant it is called advances a clock with no
 * timers on it and then waits forever for a deadline that was scheduled afterwards.
 */
async function untilWaiting(): Promise<void> {
  for (let i = 0; i < 100 && vi.getTimerCount() === 0; i++) await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

describe('handoff capture · the bound', () => {
  it('defaults to 90 s and is overridable by env', () => {
    expect(handoffCaptureTimeoutMs({})).toBe(HANDOFF_CAPTURE_TIMEOUT_MS);
    expect(handoffCaptureTimeoutMs({ [HANDOFF_CAPTURE_TIMEOUT_ENV]: '4500' })).toBe(4500);
  });

  it('ignores an unusable override rather than capturing for zero milliseconds', () => {
    for (const bad of ['', 'soon', '0', '-1'])
      expect(handoffCaptureTimeoutMs({ [HANDOFF_CAPTURE_TIMEOUT_ENV]: bad })).toBe(
        HANDOFF_CAPTURE_TIMEOUT_MS,
      );
  });
});

describe('handoff capture · sender writes', () => {
  const tmp = useTempHome('pagr-capture-');
  // Unconditional, not a `finally`: a test that hangs never reaches its own cleanup, and fake
  // timers left installed would take the rest of the file down with it.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the file on the instruction and reports the summary', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [VALID_FILE], log);
    const progress: CaptureProgress[] = [];

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      note: 'focus on the refund path',
      onProgress: (e) => progress.push(e),
      pollIntervalMs: 10,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    expect(outcome.outcome).toBe('written');
    if (outcome.outcome !== 'written') throw new Error('unreachable');
    expect(outcome.writer).toBe('sender');
    expect(outcome.path).toBe(file);
    expect(outcome.summary).toBe('Make partial refunds idempotent on the payments route.');
    expect(outcome.doc.frontmatter.id).toBe(HANDOFF_ID);
    expect(outcome.doc.notDone.find((i) => i.next)?.text).toBe('Wire the key through the handler');
    expect(outcome.problems).toEqual([]);
    expect(outcome.delivery).toBe('steered');

    // One instruction, steered, carrying the absolute path and the person's note.
    expect(adapter.instructions).toHaveLength(1);
    expect(adapter.instructions[0]?.mode).toBe('steer');
    expect(adapter.instructions[0]?.sessionId).toBe(SESSION_ID);
    expect(adapter.instructions[0]?.instruction).toContain(file);
    expect(adapter.instructions[0]?.instruction).toContain('focus on the refund path');

    expect(progress.map((p) => p.phase)).toEqual(['capturing', 'captured']);
    expect(progress.at(-1)).toMatchObject({ phase: 'captured', writer: 'sender' });
  });

  it('accepts a queued delivery — it only means waiting longer', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [VALID_FILE], log);
    adapter.delivered = 'queued';

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      pollIntervalMs: 10,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    expect(outcome.outcome).toBe('written');
    if (outcome.outcome !== 'written') throw new Error('unreachable');
    expect(outcome.delivery).toBe('queued');
  });

  it('excludes .pagr/ before the instruction is ever sent', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [VALID_FILE], log);

    await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      pollIntervalMs: 10,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    const exclude = join(tmp.home, '.git', 'info', 'exclude');
    expect(existsSync(exclude)).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toContain('.pagr/');

    const excludeAt = log.indexOf('git rev-parse --absolute-git-dir');
    const sendAt = log.indexOf('sendInstruction');
    expect(excludeAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThan(excludeAt);
  });

  it('times out at the configured bound without a file', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [null], log);

    let settled: unknown = null;
    const pending = captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      // The bound comes from the environment, exactly as the daemon would supply it.
      env: { [HANDOFF_CAPTURE_TIMEOUT_ENV]: '5000' },
      git: { execFile: fakeGit(tmp.home, log) },
    }).then((o) => {
      settled = o;
      return o;
    });
    await untilWaiting();

    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBeNull(); // still waiting: the bound has not elapsed

    await vi.advanceTimersByTimeAsync(200);
    const outcome = await pending;
    expect(outcome.outcome).toBe('timeout');
    if (outcome.outcome !== 'timeout') throw new Error('unreachable');
    expect(outcome.writer).toBe('sender');
    expect(outcome.waitedMs).toBe(5_000);
    expect(outcome.path).toBe(file);
    expect(existsSync(file)).toBe(false);
    expect(adapter.instructions).toHaveLength(1); // asked once, never re-asked
  });

  it('re-asks exactly once for a malformed file, then gives up', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, ['not a handoff at all\n', 'still not one\n'], log);
    const progress: CaptureProgress[] = [];

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      onProgress: (e) => progress.push(e),
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    expect(outcome.outcome).toBe('malformed');
    if (outcome.outcome !== 'malformed') throw new Error('unreachable');
    expect(outcome.reAsked).toBe(true);
    expect(outcome.problem.code).toBe('no_frontmatter');

    expect(adapter.instructions).toHaveLength(2);
    const second = adapter.instructions[1]?.instruction ?? '';
    expect(second).toContain('is not a valid handoff');
    expect(second).toContain('# Not done'); // the format, restated in full
    expect(progress.map((p) => p.phase)).toEqual(['capturing', 'reasked', 'failed']);
  });

  it('takes the corrected file when the re-ask works', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, ['nope\n', VALID_FILE], log);

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    expect(outcome.outcome).toBe('written');
    expect(adapter.instructions).toHaveLength(2);
  });

  it('is not fooled by a file it is reading while the agent is still writing it', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    // The first instruction lands half a handoff; the agent finishes it a moment later, well
    // inside one poll interval, so the half-written bytes are never seen twice.
    const adapter = new FakeSender(file, [VALID_FILE.slice(0, 40)], log);
    adapter.afterSend = () => {
      setTimeout(() => writeFileSync(file, VALID_FILE), 5);
    };

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      // A whole second of slack: the half-written bytes must survive a poll interval before
      // they are believed, and this test is asserting that they never get one.
      pollIntervalMs: 1_000,
      timeoutMs: 10_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });
    expect(outcome.outcome).toBe('written');
    expect(adapter.instructions).toHaveLength(1); // never re-asked over a partial write
  });
});

describe('handoff capture · refusals', () => {
  const tmp = useTempHome('pagr-capture-');
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a session that cannot take an instruction, without waiting out the bound', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [], log);
    adapter.throwOnSend = new Error('session ses_sender is not active');
    const progress: CaptureProgress[] = [];

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      onProgress: (e) => progress.push(e),
      git: { execFile: fakeGit(tmp.home, log) },
    });

    // Resolved with the clock never advanced: nothing waited for the 90 s bound, and no poll or
    // deadline was ever scheduled.
    expect(vi.getTimerCount()).toBe(0);
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('send_failed');
    expect(outcome.message).toContain('not active');
    expect(outcome.path).toBe(file);
    expect(progress).toEqual([
      {
        phase: 'failed',
        writer: 'sender',
        path: file,
        reason: 'send_failed',
        message: outcome.message,
      },
    ]);
  });

  it('refuses anything that is not controlLevel full and touches nothing', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [VALID_FILE], log);

    for (const level of ['approvals_only', 'mirror_only', 'none'] as const) {
      const outcome = await captureFromSender({
        handoffId: HANDOFF_ID,
        sessionId: SESSION_ID,
        repo: tmp.home,
        to: 'codex',
        controlLevel: level,
        adapter,
        git: { execFile: fakeGit(tmp.home, log) },
      });
      expect(outcome.outcome).toBe('refused');
      if (outcome.outcome !== 'refused') throw new Error('unreachable');
      expect(outcome.reason).toBe('control_level');
      expect(outcome.path).toBeNull();
    }
    expect(log).toEqual([]); // no git, no instruction
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a directory that is not a git work tree', async () => {
    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter: new FakeSender(handoffFilePath(tmp.home, HANDOFF_ID), []),
      git: {
        execFile: (_file, _args, _options, callback) =>
          callback(gitFailure('fatal: not a git repository'), '', ''),
      },
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('not_excluded');
    expect(outcome.message).toContain('not a git repository');
  });

  it('survives a progress callback that throws', async () => {
    const log: string[] = [];
    const file = handoffFilePath(tmp.home, HANDOFF_ID);
    const adapter = new FakeSender(file, [VALID_FILE], log);

    const outcome = await captureFromSender({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: tmp.home,
      to: 'codex',
      controlLevel: 'full',
      adapter,
      onProgress: () => {
        throw new Error('the phone is unreachable');
      },
      pollIntervalMs: 10,
      timeoutMs: 5_000,
      git: { execFile: fakeGit(tmp.home, log) },
    });

    expect(outcome.outcome).toBe('written');
  });
});
