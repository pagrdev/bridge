import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Provider } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { RunOnceInput, RunOnceResult } from './adapters/runOnce.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { createDaemon, type Daemon } from './daemon.js';
import type { ExecFileLike } from './git.js';
import { IpcClient } from './ipc.js';
import { MemorySecretStore } from './keychain.js';
import type { ResolvedReviewRange } from './review/range.js';
import { useTempHome } from './testUtil.js';

/**
 * The daemon's local front door for `pagr review` — `review.range` and `review.run`.
 *
 * What is under test is the wiring, not the review: that a command minted on this Mac runs
 * through the same dispatcher a signed one does, that a local caller can WAIT for a verdict the
 * cloud only ever hears about as an event, and that a reviewer which produced nothing comes back
 * as a failure rather than as a verdict.
 *
 * git is faked at its `execFile` seam and the reviewing agent is a function that writes a file,
 * so nothing here touches a real repository, a real `~/.codex` or a real agent.
 */

const HEAD_SHA = '7'.repeat(40);

/** Just enough git for `resolveReviewRange` and `prepareReview`: dirty once, then committed. */
function fakeGit(root: string): ExecFileLike {
  let committed = false;
  return (_file, args, _options, cb) => {
    const argv = args.join(' ');
    const done = (stdout: string): undefined => {
      queueMicrotask(() => cb(null, stdout, ''));
      return undefined;
    };
    if (argv === 'rev-parse --show-toplevel') return done(`${root}\n`);
    if (argv === 'rev-parse --absolute-git-dir') return done(`${join(root, '.git')}\n`);
    if (argv === 'rev-parse HEAD') return done(`${HEAD_SHA}\n`);
    if (argv === 'branch --show-current') return done('feat/retry\n');
    if (args[0] === 'status') return done(committed ? '' : ' M src/send.ts\0');
    if (argv === 'add -A') return done('');
    if (args[0] === 'commit') {
      committed = true;
      return done('');
    }
    if (args[0] === 'log') return done('abc1234 feat: retry the webhook\n');
    if (args[0] === 'diff' && args[1] === '--stat') return done(' src/send.ts | 2 +-\n');
    if (args[0] === 'diff' && args[1] === '--name-only') return done('src/send.ts\0');
    if (args[0] === 'diff') return done('diff --git a/src/send.ts b/src/send.ts\n+new\n');
    const err = Object.assign(new Error('Command failed: git'), {
      code: 128,
      stdout: '',
      stderr: `unexpected: git ${argv}`,
    });
    queueMicrotask(() => cb(err, '', `unexpected: git ${argv}`));
    return undefined;
  };
}

describe('daemon · review over IPC', () => {
  const t = useTempHome('pagr-review-ipc-');
  let daemon: Daemon | null = null;
  let codex: FakeAdapter;
  let client: IpcClient;
  let projectId: string;
  let repo: string;
  /** What the reviewing agent writes into `review.md`. Null means it writes nothing at all. */
  let report: string | null;

  beforeEach(async () => {
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    report = 'verdict: block — the retry never terminates\n\n### src/send.ts:12\n';

    codex = new FakeAdapter('codex');
    const runOnce = async (input: RunOnceInput): Promise<RunOnceResult> => {
      if (report !== null) {
        // The prompt names the file to write, absolutely; a real reviewer reads it from there.
        const file = /\S+review\.md/.exec(input.prompt)?.[0] ?? join(input.cwd, 'review.md');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, report);
      }
      return {
        runId: input.runId ?? 'run_fake',
        sessionId: 'ses_fake',
        outcome: 'completed',
        output: '',
        durationMs: 1,
      };
    };
    Object.assign(codex, { runOnce });

    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
      env: {},
      git: { execFile: fakeGit(repo) },
      review: { timeoutMs: 4_000, pollIntervalMs: 5, reReadGraceMs: 30 },
    });
    projectId = daemon.registry.add(repo).projectId;
    // Unpaired on purpose: this is the offline Mac `pagr review` is meant to work on.
    await daemon.start();
    client = new IpcClient(daemon.paths.socketPath);
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
  });

  const run = (over: Record<string, unknown> = {}) =>
    client.call<Record<string, unknown>>(
      'review.run',
      {
        projectId,
        reviewer: 'codex',
        range: 'HEAD~1..HEAD',
        intent: 'add a retry to the webhook sender',
        ...over,
      },
      20_000,
    );

  // ---------- review.range ----------

  it('answers which commits, and why those, before anything is started', async () => {
    const r = await client.call<ResolvedReviewRange>('review.range', { projectId });
    expect(r).toMatchObject({
      repo,
      range: 'HEAD~1..HEAD',
      basis: 'uncommitted',
      dirtyFiles: 1,
      branch: 'feat/retry',
    });
    expect(codex.calls.some((c) => c.method === 'startSession')).toBe(false);
  });

  it('refuses a project this Mac does not have', async () => {
    await expect(
      client.call('review.range', { projectId: `prj_${'f'.repeat(32)}` }),
    ).rejects.toMatchObject({ code: 'unknown_project' });
  });

  it('refuses a range that is not one, as a usage problem and not a review failure', async () => {
    await expect(
      client.call('review.range', { projectId, range: '--upload-pack=x' }),
    ).rejects.toMatchObject({ code: 'bad_range' });
  });

  // ---------- review.run ----------

  it('waits for the verdict and answers with the reviewer’s own line', async () => {
    const result = await run();
    expect(result).toMatchObject({
      reviewer: 'codex',
      range: 'HEAD~1..HEAD',
      verdict: 'block',
      summary: 'the retry never terminates',
      verdictLine: 'verdict: block — the retry never terminates',
    });
    expect(String(result.reviewId)).toMatch(/^rev_[0-9a-f]{32}$/);
    expect(result.path).toBe(join(repo, '.pagr', 'review', String(result.reviewId), 'review.md'));
    expect(result.instruction).toBe(
      `Read .pagr/review/${String(result.reviewId)}/review.md and fix the blocking findings`,
    );
  });

  it('hands back the line verbatim even when the reviewer wrote it badly', async () => {
    report = '**Verdict:** BLOCK – the migration drops the column first\n';
    const result = await run();
    // The protocol gets the parsed verdict; the person gets the sentence their reviewer wrote.
    expect(result.verdict).toBe('block');
    expect(result.verdictLine).toBe('**Verdict:** BLOCK – the migration drops the column first');
  });

  it('reports a reviewer that wrote nothing as a failure, not as a verdict', async () => {
    report = null;
    await expect(run()).rejects.toMatchObject({ code: 'no_report' });
  });

  it('refuses to review a project this Mac does not have', async () => {
    await expect(run({ projectId: `prj_${'f'.repeat(32)}` })).rejects.toMatchObject({
      code: 'unknown_project',
    });
  });

  it('refuses an agent it cannot run headlessly, without starting anything', async () => {
    await expect(run({ reviewer: 'claude' })).rejects.toMatchObject({
      code: 'capability_unsupported',
    });
  });
});
