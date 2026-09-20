import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOnceInput, RunOnceResult } from '../adapters/runOnce.js';
import type { ExecFileLike } from '../git.js';
import { useTempHome } from '../testUtil.js';
import { type CaptureProgress, handoffFilePath } from './capture.js';
import {
  type CaptureFromReceiverInput,
  CODEX_DUMP_FORMAT,
  captureFromReceiver,
  claudeTranscriptSource,
  codexDumpPath,
  codexTranscriptSource,
  receiverWritePrompt,
  type TranscriptSource,
} from './receiver.js';

const HANDOFF_ID = 'hnd_0123456789abcdef0123456789abcdef';
const SESSION_ID = 'ses_sender';
/** Claude's own id for the session, and therefore its transcript's file name. */
const CLAUDE_SESSION = '9f3b7c2a-1d4e-4a55-8c60-2b17de905311';
/** Codex's own id for the thread. */
const CODEX_THREAD = 'thr_7b1c';

/**
 * A handoff file exactly as a well-behaved receiver writes it — `writer: receiver`, which is
 * the one field that differs from the sender path's fixture. Literal text, not `serialize`
 * output, so a serializer that drifted from what agents actually write fails here.
 */
const VALID_FILE = `---
pagr: handoff/1
id: ${HANDOFF_ID}
from: { provider: claude, sessionId: ses_sender, origin: terminal }
to: { provider: codex }
project: { id: prj_checkout, name: checkout-api }
git: { branch: feat/refunds, head: 3f9c1d2, wipCommit: null, dirtyBefore: true }
writer: receiver
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

// ---------- git, faked at the process boundary ----------

/** `git.ts` keeps its failure shape private; take it from the callback it hands the runner. */
type GitFailure = NonNullable<Parameters<Parameters<ExecFileLike>[3]>[0]>;

const gitFailure = (stderr: string, code = 128): GitFailure =>
  Object.assign(new Error('Command failed: git'), { code, stderr, stdout: '' });

/**
 * `git.ts` is the only module allowed to spawn git (a repo-wide test enforces it), so the two
 * calls a receiver capture makes are answered by substituting the runner. `ensureExcluded` still
 * writes a real `.git/info/exclude`, which is the part these tests assert on.
 */
function fakeGit(repo: string, log: string[]): ExecFileLike {
  const gitDir = join(repo, '.git');
  return (_file, args, _options, callback) => {
    const argv = args.join(' ');
    log.push(`git ${argv}`);
    if (argv === 'rev-parse --show-toplevel') return callback(null, `${repo}\n`, '');
    if (argv === 'rev-parse --absolute-git-dir') return callback(null, `${gitDir}\n`, '');
    return callback(gitFailure(`unexpected: git ${argv}`), '', `unexpected: git ${argv}`);
  };
}

/** A repository that is not a git work tree as far as the runner is concerned. */
const notARepo: ExecFileLike = (_file, _args, _options, callback) =>
  callback(gitFailure('fatal: not a git repository'), '', 'fatal: not a git repository');

// ---------- the receiving agent, faked ----------

/**
 * A headless agent: something that takes a prompt and may leave a file behind.
 *
 * `body` is what it writes (null: it writes nothing), `outcome` how the run ended. `onRun` sees
 * the world exactly as the agent would — which is how the dump-still-exists assertion is made.
 */
class FakeRunner {
  readonly runs: RunOnceInput[] = [];
  body: string | null = VALID_FILE;
  outcome: RunOnceResult['outcome'] = 'completed';
  error: RunOnceResult['error'] | undefined;
  output = '';
  throwOnRun: Error | null = null;
  onRun: ((input: RunOnceInput) => void) | null = null;

  constructor(private readonly file: string) {}

  async runOnce(input: RunOnceInput): Promise<RunOnceResult> {
    this.runs.push(input);
    if (this.throwOnRun) throw this.throwOnRun;
    this.onRun?.(input);
    if (this.body !== null) {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, this.body);
    }
    return {
      runId: 'run_0123456789abcdef0123456789abcdef',
      sessionId: 'ses_runonce',
      outcome: this.outcome,
      output: this.output,
      durationMs: 12,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

// ---------- fixtures ----------

/**
 * `~/.claude/projects/<encoded cwd>/<session>.jsonl`, as Claude Code leaves it behind for a
 * session the person started in their own terminal. The directory name is Claude's lossy
 * encoding of the cwd and is never decoded, here or in the code under test.
 */
function adoptedClaudeSession(
  home: string,
  o: { cwd: string; sessionId?: string; spill?: boolean; superseded?: boolean } = {
    cwd: '/tmp/checkout-api',
  },
): { transcript: string; spillDir: string; projectDir: string } {
  const sessionId = o.sessionId ?? CLAUDE_SESSION;
  const projectDir = join(home, '.claude', 'projects', o.cwd.replace(/[/ .]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const name = o.superseded
    ? `${sessionId}.jsonl.superseded-2026-09-19T11-02-04`
    : `${sessionId}.jsonl`;
  const transcript = join(projectDir, name);
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', cwd: o.cwd, sessionId, message: { role: 'user' } }),
      JSON.stringify({ type: 'assistant', cwd: o.cwd, sessionId, message: { role: 'assistant' } }),
      '',
    ].join('\n'),
  );
  const spillDir = join(projectDir, sessionId, 'tool-results');
  if (o.spill !== false) {
    mkdirSync(spillDir, { recursive: true });
    writeFileSync(join(spillDir, 'toolu_01.txt'), 'a very long tool result\n');
  }
  return { transcript, spillDir, projectDir };
}

/** A Codex TUI thread, as `thread/read` answers for one Pagr only ever mirrored. */
const codexMirrorThread = () => ({
  id: CODEX_THREAD,
  turns: [
    {
      id: 'turn_1',
      items: [
        { id: 'item-1', type: 'userMessage', text: 'make refunds idempotent' },
        { id: 'item-2', type: 'commandExecution', command: 'pnpm test payments' },
      ],
    },
    { id: 'turn_2', items: [{ id: 'item-1', type: 'agentMessage', text: 'added the column' }] },
  ],
});

// ---------- the call, with the boring arguments filled in ----------

function receiverInput(
  o: {
    repo: string;
    runner: FakeRunner;
    transcript: TranscriptSource;
    log: string[];
    progress?: CaptureProgress[];
    providerSessionId?: string;
    note?: string;
  } & Partial<CaptureFromReceiverInput>,
): CaptureFromReceiverInput {
  const { repo, runner, transcript, log, progress, ...rest } = o;
  return {
    handoffId: HANDOFF_ID,
    sessionId: SESSION_ID,
    providerSessionId: o.providerSessionId ?? CLAUDE_SESSION,
    repo,
    to: 'codex',
    receiver: runner,
    transcript,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    git: { execFile: fakeGit(repo, log) },
    ...(progress ? { onProgress: (e: CaptureProgress) => progress.push(e) } : {}),
    ...rest,
  };
}

describe('handoff capture · receiver writes · Claude', () => {
  const tmp = useTempHome('pagr-receiver-claude-');

  it('an adopted terminal session becomes a handoff the receiver wrote', async () => {
    const repo = join(tmp.home, 'repo');
    mkdirSync(repo, { recursive: true });
    const fixture = adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const file = handoffFilePath(repo, HANDOFF_ID);
    const runner = new FakeRunner(file);
    const log: string[] = [];
    const progress: CaptureProgress[] = [];

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log,
        progress,
        note: 'focus on the refund path',
      }),
    );

    expect(outcome.outcome).toBe('written');
    if (outcome.outcome !== 'written') throw new Error('unreachable');
    expect(outcome.writer).toBe('receiver');
    expect(outcome.path).toBe(file);
    expect(outcome.summary).toBe('Make partial refunds idempotent on the payments route.');
    expect(outcome.doc.frontmatter.writer).toBe('receiver');
    expect(outcome.problems).toEqual([]);
    // No live session was involved, so there is nothing to say about delivery.
    expect('delivery' in outcome).toBe(false);

    // One headless run, about the repository, allowed to write only under `.pagr/`.
    expect(runner.runs).toHaveLength(1);
    const run = runner.runs[0];
    expect(run?.cwd).toBe(repo);
    expect(run?.allowedWrites).toEqual(['.pagr/**']);
    // HND-015: `cwd` says which repository, not where the process runs — a Codex run is started
    // inside `<repo>/.pagr` — so the prompt names the tree and every path in it is absolute.
    expect(run?.prompt).toContain(`The repository is at ${repo}.`);
    expect(run?.timeoutMs).toBe(5_000);
    // The prompt names the transcript, the spill directory, the file and the person's note.
    expect(run?.prompt).toContain(fixture.transcript);
    expect(run?.prompt).toContain(fixture.spillDir);
    expect(run?.prompt).toContain(file);
    expect(run?.prompt).toContain('focus on the refund path');
    // The transcript is pointed at, never read into this process and never sent anywhere.
    expect(run?.prompt).not.toContain('make refunds idempotent');

    expect(progress.map((p) => p.phase)).toEqual(['capturing', 'captured']);
    expect(progress.at(-1)).toMatchObject({ phase: 'captured', writer: 'receiver' });

    // `.pagr/` was excluded before the agent was allowed near the tree.
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.pagr/');
  });

  it('finds the transcript whatever directory Claude filed it under', async () => {
    // The session's own cwd was a subdirectory, so the encoded project directory is not the one
    // the repository root would produce. The session id is what identifies it.
    const repo = join(tmp.home, 'repo');
    mkdirSync(repo, { recursive: true });
    const fixture = adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api/packages/core' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    const log: string[] = [];

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log,
      }),
    );

    expect(outcome.outcome).toBe('written');
    expect(runner.runs[0]?.prompt).toContain(fixture.transcript);
  });

  it('falls back to a superseded transcript rather than to nothing', async () => {
    const repo = join(tmp.home, 'repo');
    mkdirSync(repo, { recursive: true });
    const fixture = adoptedClaudeSession(tmp.home, {
      cwd: '/tmp/checkout-api',
      superseded: true,
      spill: false,
    });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
    );

    expect(outcome.outcome).toBe('written');
    expect(runner.runs[0]?.prompt).toContain(fixture.transcript);
    // No spill directory exists, so the prompt does not invent one.
    expect(runner.runs[0]?.prompt).not.toContain('were too large to store inline');
  });

  it('never looks outside the projects directory for a session id', async () => {
    const repo = join(tmp.home, 'repo');
    mkdirSync(repo, { recursive: true });
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const source = claudeTranscriptSource({ home: tmp.home });
    for (const id of ['../../../etc/passwd', '..', '', 'a/b'])
      await expect(
        source({ sessionId: SESSION_ID, providerSessionId: id, handoffId: HANDOFF_ID }),
      ).resolves.toBeNull();
  });
});

describe('handoff capture · receiver writes · Codex', () => {
  const tmp = useTempHome('pagr-receiver-codex-');

  it('a mirrored terminal thread is dumped, read and then deleted', async () => {
    const repo = join(tmp.home, 'repo');
    const pagrHome = join(tmp.home, 'pagr');
    mkdirSync(repo, { recursive: true });
    const file = handoffFilePath(repo, HANDOFF_ID);
    const runner = new FakeRunner(file);
    const dump = codexDumpPath(pagrHome, HANDOFF_ID);

    /** What the agent could see while it was running. Asserted after, read during. */
    let seen: { existed: boolean; text: string } | null = null;
    runner.onRun = (input) => {
      seen = { existed: existsSync(dump), text: readFileSync(dump, 'utf8') };
      expect(input.prompt).toContain(dump);
    };

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        providerSessionId: CODEX_THREAD,
        transcript: codexTranscriptSource({
          pagrHome,
          readThread: async (id) => (id === CODEX_THREAD ? codexMirrorThread() : null),
        }),
        log: [],
      }),
    );

    expect(outcome.outcome).toBe('written');
    if (outcome.outcome !== 'written') throw new Error('unreachable');
    expect(outcome.writer).toBe('receiver');

    // The dump was there, was NDJSON, and carried every item of every turn.
    const dumped = seen as unknown as { existed: boolean; text: string };
    expect(dumped.existed).toBe(true);
    const lines = dumped.text.trimEnd().split('\n');
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      format: CODEX_DUMP_FORMAT,
      threadId: CODEX_THREAD,
      turns: 2,
    });
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ turn: 'turn_1', index: 0 });
    expect(dumped.text).toContain('make refunds idempotent');

    // And it is gone. A plaintext transcript does not outlive the run that needed it.
    expect(existsSync(dump)).toBe(false);
  });

  it('deletes the dump when the run fails, not only when it succeeds', async () => {
    const repo = join(tmp.home, 'repo');
    const pagrHome = join(tmp.home, 'pagr');
    mkdirSync(repo, { recursive: true });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.body = null;
    runner.outcome = 'failed';
    runner.error = { code: 'start_failed', message: 'codex app-server is not running' };
    const dump = codexDumpPath(pagrHome, HANDOFF_ID);
    runner.onRun = () => expect(existsSync(dump)).toBe(true);

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        providerSessionId: CODEX_THREAD,
        transcript: codexTranscriptSource({
          pagrHome,
          readThread: async () => codexMirrorThread(),
        }),
        log: [],
      }),
    );

    expect(outcome).toMatchObject({
      outcome: 'refused',
      writer: 'receiver',
      reason: 'run_failed',
      message: 'codex app-server is not running',
    });
    expect(existsSync(dump)).toBe(false);
  });

  it('deletes the dump when the adapter throws out of the run', async () => {
    const repo = join(tmp.home, 'repo');
    const pagrHome = join(tmp.home, 'pagr');
    mkdirSync(repo, { recursive: true });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.throwOnRun = new Error('app-server socket closed');

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        providerSessionId: CODEX_THREAD,
        transcript: codexTranscriptSource({
          pagrHome,
          readThread: async () => codexMirrorThread(),
        }),
        log: [],
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'run_failed' });
    expect(existsSync(codexDumpPath(pagrHome, HANDOFF_ID))).toBe(false);
  });

  it('an empty thread is no transcript, not an empty dump', async () => {
    const repo = join(tmp.home, 'repo');
    const pagrHome = join(tmp.home, 'pagr');
    mkdirSync(repo, { recursive: true });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        providerSessionId: CODEX_THREAD,
        transcript: codexTranscriptSource({
          pagrHome,
          readThread: async () => ({ id: CODEX_THREAD, turns: [] }),
        }),
        log: [],
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'no_transcript' });
    expect(runner.runs).toHaveLength(0);
    expect(existsSync(codexDumpPath(pagrHome, HANDOFF_ID))).toBe(false);
  });
});

describe('handoff capture · receiver writes · what can go wrong', () => {
  const tmp = useTempHome('pagr-receiver-fail-');

  const repoWith = (): string => {
    const repo = join(tmp.home, 'repo');
    mkdirSync(repo, { recursive: true });
    return repo;
  };

  it('refuses no_transcript, and leaves the repository untouched', async () => {
    const repo = repoWith();
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    const progress: CaptureProgress[] = [];

    // A real `~/.claude` with no transcript for this session, not a missing directory.
    adoptedClaudeSession(tmp.home, {
      cwd: '/tmp/other-repo',
      sessionId: '11111111-2222-3333-4444-555555555555',
    });

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
        progress,
      }),
    );

    expect(outcome).toMatchObject({
      outcome: 'refused',
      writer: 'receiver',
      reason: 'no_transcript',
    });
    if (outcome.outcome !== 'refused') throw new Error('unreachable');
    expect(outcome.message).toContain(SESSION_ID);
    expect(outcome.path).toBe(handoffFilePath(repo, HANDOFF_ID));

    expect(runner.runs).toHaveLength(0);
    // Nothing was written: no exclude line, no `.pagr/` directory for a handoff that cannot happen.
    expect(existsSync(join(repo, '.git', 'info', 'exclude'))).toBe(false);
    expect(existsSync(join(repo, '.pagr'))).toBe(false);
    expect(progress).toEqual([
      {
        phase: 'failed',
        writer: 'receiver',
        path: outcome.path,
        reason: 'no_transcript',
        message: outcome.message,
      },
    ]);
  });

  it('refuses no_transcript when the source itself throws', async () => {
    const repo = repoWith();
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: async () => {
          throw new Error('thread/read failed: thread is not materialized');
        },
        log: [],
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'no_transcript' });
    if (outcome.outcome !== 'refused') throw new Error('unreachable');
    expect(outcome.message).toContain('not materialized');
  });

  it('refuses no_runner rather than pretending an adapter can be spawned', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner: new FakeRunner(handoffFilePath(repo, HANDOFF_ID)),
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
        receiver: {},
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'refused', writer: 'receiver', reason: 'no_runner' });
  });

  it('refuses not_a_repo before it looks for a transcript', async () => {
    const repo = repoWith();
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    let asked = false;
    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: async () => {
          asked = true;
          return null;
        },
        log: [],
        git: { execFile: notARepo },
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'not_a_repo', path: null });
    expect(asked).toBe(false);
  });

  it('reports a timeout as a timeout, so the dispatcher can say how long it waited', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.body = null;
    runner.outcome = 'timeout';
    const progress: CaptureProgress[] = [];

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
        progress,
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'timeout', writer: 'receiver', waitedMs: 5_000 });
    expect(progress.map((p) => p.phase)).toEqual(['capturing', 'failed']);
  });

  it('keeps a file the agent wrote before it ran out of time', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    // The note was written; the agent then kept going until it was killed.
    runner.outcome = 'timeout';

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
    );

    expect(outcome.outcome).toBe('written');
  });

  it('reports a file that is not a handoff as malformed, with no re-ask', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.body = 'Sure! I wrote the handoff for you.\n';

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
    );

    expect(outcome.outcome).toBe('malformed');
    if (outcome.outcome !== 'malformed') throw new Error('unreachable');
    expect(outcome.writer).toBe('receiver');
    // There is no live conversation to re-ask, and a second attempt is the dispatcher's call.
    expect(outcome.reAsked).toBe(false);
    expect(outcome.problem.message).toBeTruthy();
  });

  it('reports a run that finished and wrote nothing, quoting the agent', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.body = null;
    runner.output = "I couldn't read the transcript: permission denied.\nStopping.";

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'refused', writer: 'receiver', reason: 'no_file' });
    if (outcome.outcome !== 'refused') throw new Error('unreachable');
    expect(outcome.message).toContain("I couldn't read the transcript");
    expect(outcome.message).not.toContain('Stopping.');
  });

  it('reports a cancelled run as cancelled, not as a failure of the agent', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));
    runner.body = null;
    runner.outcome = 'canceled';

    const outcome = await captureFromReceiver(
      receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
    );

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'run_canceled' });
  });

  it('survives a progress callback that throws', async () => {
    const repo = repoWith();
    adoptedClaudeSession(tmp.home, { cwd: '/tmp/checkout-api' });
    const runner = new FakeRunner(handoffFilePath(repo, HANDOFF_ID));

    const outcome = await captureFromReceiver({
      ...receiverInput({
        repo,
        runner,
        transcript: claudeTranscriptSource({ home: tmp.home }),
        log: [],
      }),
      onProgress: () => {
        throw new Error('the phone is unreachable');
      },
    });

    expect(outcome.outcome).toBe('written');
  });
});

describe('handoff capture · the receiver prompt', () => {
  it('is the one shared prompt, plus the spill directory when there is one', () => {
    const base = receiverWritePrompt({
      path: '/repo/.pagr/handoff/x.md',
      to: 'codex',
      transcript: { path: '/home/.claude/projects/-repo/s.jsonl', temporary: false },
      repo: '/repo',
    });
    expect(base).toContain('/home/.claude/projects/-repo/s.jsonl');
    expect(base).toContain('# Goal');
    expect(base).not.toContain('spilled');
    // The prompt's last instruction stays last: nothing is appended after "then stop".
    expect(base.trimEnd().endsWith('Write the file, then stop. Say nothing else.')).toBe(true);

    const withSpill = receiverWritePrompt({
      path: '/repo/.pagr/handoff/x.md',
      to: 'codex',
      transcript: {
        path: '/home/.claude/projects/-repo/s.jsonl',
        temporary: false,
        spillDir: '/home/.claude/projects/-repo/s/tool-results',
      },
      repo: '/repo',
    });
    expect(withSpill).toContain('/home/.claude/projects/-repo/s/tool-results');
    expect(withSpill.trimEnd().endsWith('Write the file, then stop. Say nothing else.')).toBe(true);
  });
});
