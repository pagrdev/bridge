import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandBody, DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { RunOnceInput, RunOnceResult } from './adapters/runOnce.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { Dispatcher, REVIEW_FIX_SESSION_NAME } from './dispatcher.js';
import { decodeFrameBody } from './frames.js';
import type { ExecFileLike } from './git.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { reviewApplyInstruction } from './review/run.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const REVIEW_ID = `rev_${'d'.repeat(32)}`;
const RANGE = 'HEAD~1..HEAD';
const HEAD_SHA = '7'.repeat(40);

type AckPayload = EventPayload<'command.ack'>;
type CompletedPayload = EventPayload<'review.completed'>;
type FramePayload = EventPayload<'session.frame'>;

/**
 * git, faked at its `execFile` seam.
 *
 * Only `git.ts` may spawn git (a grep test enforces it), so the dispatcher's review path is
 * exercised against a runner rather than a real repository: no test here has an index, a hook or
 * a reflog to corrupt. The tree is reported dirty once so the WIP commit really runs.
 */
function fakeGit(root: string, log: string[]): ExecFileLike {
  let committed = false;
  return (_file, args, _options, cb) => {
    const argv = args.join(' ');
    log.push(`git ${argv}`);
    const done = (stdout: string): undefined => {
      queueMicrotask(() => cb(null, stdout, ''));
      return undefined;
    };
    if (argv === 'rev-parse --show-toplevel') return done(`${root}\n`);
    if (argv === 'rev-parse --absolute-git-dir') return done(`${join(root, '.git')}\n`);
    if (argv === 'rev-parse HEAD') return done(`${HEAD_SHA}\n`);
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
      stderr: `unexpected: git ${argv}`,
      stdout: '',
    });
    queueMicrotask(() => cb(err, '', `unexpected: git ${argv}`));
    return undefined;
  };
}

describe('review.start / review.apply', () => {
  const t = useTempHome('pagr-review-cmd-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();

  let codex: FakeAdapter;
  let claude: FakeAdapter;
  let events: DeviceEvent[];
  let gitLog: string[];
  let runs: RunOnceInput[];
  let projectId: string;
  let repo: string;
  let now: Date;
  let d: Dispatcher;
  /** What the reviewing agent writes into `review.md`, and when. */
  let report: { body: string; afterMs: number } | null;

  beforeEach(() => {
    now = new Date('2026-09-20T09:00:00.000Z');
    events = [];
    gitLog = [];
    runs = [];
    report = {
      body: 'verdict: block — the retry never terminates\n\n### src/send.ts:12\n',
      afterMs: 5,
    };
    codex = new FakeAdapter('codex');
    claude = new FakeAdapter('claude');
    const home = join(t.home, 'home');
    repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(repo).projectId;
    const journalDir = join(t.home, 'journal');

    // The reviewer: a headless run that writes the report and then waits to be told to stop,
    // which is exactly what a real one does (the prompt ends "write the file, then stop").
    const runOnce = async (input: RunOnceInput): Promise<RunOnceResult> => {
      runs.push(input);
      const pending = report;
      let aborted = false;
      const timer = pending
        ? setTimeout(() => {
            const file = join(input.cwd, '.pagr', 'review', REVIEW_ID, 'review.md');
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, pending.body);
          }, pending.afterMs)
        : null;
      await new Promise<void>((resolve) => {
        const finish = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        if (!pending) setTimeout(finish, 5);
        input.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            finish();
          },
          { once: true },
        );
      });
      return {
        runId: input.runId ?? 'run_fake',
        sessionId: 'ses_fake',
        outcome: aborted ? 'canceled' : 'completed',
        output: '',
        durationMs: 1,
      };
    };
    Object.assign(codex, { runOnce });

    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['codex', codex],
        ['claude', claude],
      ]),
      registry,
      sessions: new SessionStore(),
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      env: {},
      git: { execFile: fakeGit(repo, gitLog) },
      review: { timeoutMs: 2_000, pollIntervalMs: 5, reReadGraceMs: 40 },
      frames: {
        journal: new JournalStore({ dir: journalDir, now: () => now }),
        cursors: new OutboxCursors({ file: join(journalDir, 'outbox.json'), writeDelayMs: 0 }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });

  /** A verified command body, as the guard would hand one to the dispatcher. */
  const command = (type: CommandBody['type'], payload: unknown, version = 2): CommandBody =>
    ({
      ...makeBody(type as 'device.probe', payload as Record<string, never>, { deviceId, now }),
      version,
    }) as CommandBody;

  const ack = (e: DeviceEvent) => e.payload as AckPayload;
  const completed = (): CompletedPayload[] =>
    events.filter((e) => e.type === 'review.completed').map((e) => e.payload as CompletedPayload);
  const reviewFrames = (): FramePayload[] =>
    events
      .filter((e) => e.type === 'session.frame')
      .map((e) => e.payload as FramePayload)
      .filter((p) => p.kind === 'review');

  const start = (over: Record<string, unknown> = {}) =>
    d.handle(
      command('review.start', {
        reviewId: REVIEW_ID,
        projectId,
        reviewer: 'codex',
        range: RANGE,
        intent: 'add a retry to the webhook sender',
        ...over,
      }),
    );

  const startBuilder = async (provider: Provider = 'claude'): Promise<string> => {
    const sessionId = ids.ses();
    await d.handle(
      command('agent.start_session', {
        provider,
        projectId,
        instruction: 'make the webhook retry',
        sessionId,
        attachments: [],
        readOnly: false,
      }),
    );
    return sessionId;
  };

  // ---------- review.start ----------

  it('acks with the review id, then emits the parsed verdict and seals the report', async () => {
    const acked = await start();
    expect(ack(acked)).toMatchObject({ status: 'completed', result: { reviewId: REVIEW_ID } });
    // The verdict is not in the ack: it is minutes away and arrives as its own event.
    expect(completed()).toEqual([]);

    await d.settleReviews();

    expect(completed()).toEqual([
      {
        reviewId: REVIEW_ID,
        verdict: 'block',
        summary: 'the retry never terminates',
      },
    ]);

    // The findings themselves travel sealed; only the one line reaches the cloud in the clear.
    const frames = reviewFrames();
    expect(frames).toHaveLength(1);
    const payload = frames[0] as FramePayload;
    const body = decodeFrameBody(
      openFrame(payload.sealed, sealAadFor(payload.sealed.aad), phone.privateKeyRaw),
    );
    expect(body).toEqual({
      kind: 'review',
      reviewId: REVIEW_ID,
      verdict: 'block',
      summary: 'the retry never terminates',
      text: 'verdict: block — the retry never terminates\n\n### src/send.ts:12\n',
    });
    expect(JSON.stringify(completed())).not.toContain('src/send.ts:12');
  });

  it('commits the dirty tree and hands the reviewer the packet, read-only', async () => {
    await start();
    await d.settleReviews();

    expect(gitLog.some((l) => l.startsWith('git commit -m wip(pagr): review by codex'))).toBe(true);
    expect(runs).toHaveLength(1);
    const run = runs[0] as RunOnceInput;
    expect(run.cwd).toBe(repo);
    expect(run.prompt).toContain(join(repo, '.pagr', 'review', REVIEW_ID, 'packet.md'));
    expect(run.projectId).toBe(projectId);
  });

  it('degrades a misformatted verdict to comment and says which line it could not read', async () => {
    report = { body: 'Looks good to me overall.\n\nI would add a test.\n', afterMs: 5 };
    await start();
    await d.settleReviews();

    const [event] = completed();
    expect(event?.verdict).toBe('comment');
    expect(event?.note).toContain('Looks good to me overall.');
    // The report is still sealed and sent: a reviewer that formatted its answer badly has still
    // done the work.
    expect(reviewFrames()).toHaveLength(1);
  });

  it('says nothing about a verdict when the reviewer writes no report', async () => {
    report = null;
    await start();
    await d.settleReviews();

    expect(completed()).toEqual([]);
    const failures = events
      .filter((e) => e.type === 'session.event')
      .map((e) => e.payload as EventPayload<'session.event'>)
      .filter((p) => p.kind === 'failed');
    expect(failures[0]?.summary).toContain('without writing a review');
  });

  it('refuses a reviewer that cannot be run headlessly, and a v1 link', async () => {
    const noRunOnce = await start({ reviewer: 'claude' });
    expect(ack(noRunOnce)).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });

    const v1 = await d.handle(
      command(
        'review.start',
        {
          reviewId: REVIEW_ID,
          projectId,
          reviewer: 'codex',
          range: RANGE,
          intent: 'add a retry',
        },
        1,
      ),
    );
    expect(ack(v1)).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });
    expect(runs).toEqual([]);
  });

  // ---------- review.apply ----------

  it('steers the live builder session when it can still take a turn', async () => {
    const sessionId = await startBuilder('claude');
    await start();
    await d.settleReviews();

    const applied = await d.handle(command('review.apply', { reviewId: REVIEW_ID, sessionId }));
    expect(ack(applied)).toMatchObject({
      status: 'completed',
      result: { reviewId: REVIEW_ID, sessionId, applied: 'instructed' },
    });

    const sent = claude.calls.filter((c) => c.method === 'sendInstruction');
    expect(sent).toHaveLength(1);
    const instructed = sent[0]?.args as { instruction: string } | undefined;
    expect(instructed?.instruction).toBe(reviewApplyInstruction(REVIEW_ID));
    // Nothing started a second agent on the same tree.
    expect(claude.calls.filter((c) => c.method === 'startSession')).toHaveLength(1);
  });

  it('starts a fresh session on the same tree when the builder is gone', async () => {
    const sessionId = await startBuilder('claude');
    await d.handle(command('agent.stop_session', { sessionId }));
    await start();
    await d.settleReviews();

    const applied = await d.handle(command('review.apply', { reviewId: REVIEW_ID, sessionId }));
    const result = ack(applied).result as { sessionId: string; applied: string };
    expect(ack(applied).status).toBe('completed');
    expect(result.applied).toBe('started');
    expect(result.sessionId).not.toBe(sessionId);

    const started = claude.calls.filter((c) => c.method === 'startSession');
    expect(started).toHaveLength(2);
    const fresh = started[1]?.args as
      | { instruction: string; project: { projectId: string } }
      | undefined;
    expect(fresh).toMatchObject({
      instruction: reviewApplyInstruction(REVIEW_ID),
      displayName: REVIEW_FIX_SESSION_NAME,
      readOnly: false,
    });
    expect(fresh?.project.projectId).toBe(projectId);
    // The findings are never read by Pagr, let alone applied by it: all it sends is the path.
    expect(claude.calls.filter((c) => c.method === 'sendInstruction')).toHaveLength(0);
  });

  it('falls back to the review’s own project, and not to the agent that wrote the review', async () => {
    await start();
    await d.settleReviews();

    const applied = await d.handle(command('review.apply', { reviewId: REVIEW_ID }));
    expect(ack(applied)).toMatchObject({ status: 'completed', result: { applied: 'started' } });
    // Codex wrote the review, so Codex does not get to act on its own findings.
    expect(claude.calls.filter((c) => c.method === 'startSession')).toHaveLength(1);
    expect(codex.calls.filter((c) => c.method === 'startSession')).toHaveLength(0);
  });

  it('refuses a review it has never heard of rather than guessing a project', async () => {
    const applied = await d.handle(command('review.apply', { reviewId: `rev_${'e'.repeat(32)}` }));
    expect(ack(applied)).toMatchObject({ status: 'failed', errorCode: 'unknown_session' });
  });
});
