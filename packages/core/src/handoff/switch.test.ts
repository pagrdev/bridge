import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SendInstructionInput } from '../adapters/types.js';
import type { GitOptions } from '../git.js';
import { useTempHome } from '../testUtil.js';
import { handoffFilePath } from './capture.js';
import { type FakeRepo, fakeGit, gitCalls, newFakeRepo } from './fakeGit.js';
import { parse } from './format.js';
import {
  type HandoffCaptureRunInput,
  type HandoffUpdate,
  type ReceiverCapture,
  type ReceiverCaptureInput,
  receiverNotAvailable,
  runHandoffCapture,
  wipCommitMessage,
} from './switch.js';

const HANDOFF_ID = 'hnd_0123456789abcdef0123456789abcdef';
const SESSION_ID = 'ses_sender';
const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';

/** A handoff exactly as an agent writes it — `wipCommit: null`, because it cannot know yet. */
const handoffFile = (goal = 'Make partial refunds idempotent.') => `---
pagr: handoff/1
id: ${HANDOFF_ID}
from: { provider: claude, sessionId: ${SESSION_ID}, origin: pagr }
to: { provider: codex }
project: { id: prj_checkout, name: checkout-api }
git: { branch: feat/refunds, head: 3f9c1d2, wipCommit: null, dirtyBefore: false }
writer: sender
previous: null
created: 2026-09-20T05:41:12Z
---

# Goal
${goal}

# Done
- Added the idempotency key column

# Not done
- [ ] Wire the key through the handler ← next

# Decisions and why
- Key on (order_id, amount) — a client UUID was rejected as unverifiable

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

describe('runHandoffCapture', () => {
  const t = useTempHome('pagr-switch-');
  let repo: FakeRepo;
  let git: GitOptions;
  let updates: HandoffUpdate[];
  let sent: SendInstructionInput[];
  let stops: number;
  let path: string;

  /** A sender that writes the file the moment it is steered — a well-behaved agent. */
  const writingSender = (text: string = handoffFile()) => ({
    sendInstruction: async (input: SendInstructionInput) => {
      sent.push(input);
      writeFileSync(path, text);
      return { delivered: 'steered' as const };
    },
  });

  /** A sender that takes the instruction and never writes anything. */
  const silentSender = () => ({
    sendInstruction: async (input: SendInstructionInput) => {
      sent.push(input);
      return { delivered: 'queued' as const };
    },
  });

  /** A stand-in for HND-012 that writes the file the receiving agent would have written. */
  const writingReceiver = (): { fn: ReceiverCapture; calls: ReceiverCaptureInput[] } => {
    const calls: ReceiverCaptureInput[] = [];
    return {
      calls,
      fn: async (input) => {
        calls.push(input);
        writeFileSync(path, handoffFile());
        const parsed = parse(readFileSync(path, 'utf8'));
        if (!parsed.ok) throw new Error(parsed.problem.message);
        return {
          outcome: 'written',
          writer: 'receiver',
          path,
          doc: parsed.doc,
          summary: 'Make partial refunds idempotent.',
          problems: [],
        };
      },
    };
  };

  const run = (over: Partial<HandoffCaptureRunInput> = {}) =>
    runHandoffCapture({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      from: 'claude',
      to: 'codex',
      repo: repo.root,
      controlLevel: 'full',
      sender: writingSender(),
      stop: async () => {
        stops++;
      },
      onUpdate: (u) => updates.push(u),
      git,
      timeoutMs: 2_000,
      pollIntervalMs: 10,
      ...over,
    });

  const states = () => updates.map((u) => u.state);
  const onDisk = () => {
    const parsed = parse(readFileSync(path, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.problem.message);
    return parsed.doc;
  };

  beforeEach(() => {
    const root = join(t.home, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    repo = newFakeRepo(root, { nextSha: SHA });
    git = { execFile: fakeGit(repo) };
    updates = [];
    sent = [];
    stops = 0;
    path = handoffFilePath(root, HANDOFF_ID);
  });

  // ---------- the whole sequence ----------

  it('captures, commits, stamps the file, stops the sender, and answers with all of it', async () => {
    repo.dirty = [' M src/payments/refund.ts', '?? src/payments/guard.ts'];

    const out = await run();

    expect(out.outcome).toBe('captured');
    if (out.outcome !== 'captured') return;
    expect(out.result).toEqual({
      writer: 'sender',
      summary: 'Make partial refunds idempotent.',
      wipCommit: SHA,
      filesChanged: 2,
      truncated: false,
    });
    // The sender was the one asked, and it was asked with the file's own path.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.instruction).toContain(path);
    expect(stops).toBe(1);
    // `.pagr/` is excluded before anything is written into the work tree.
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.pagr/');
    // The path the phone gets is repo-relative: no home directory rides the frame.
    expect(out.relativePath).toBe(join('.pagr', 'handoff', `${HANDOFF_ID}.md`));
    expect(out.text).toBe(readFileSync(path, 'utf8'));
  });

  it('emits one update per state the bridge actually enters', async () => {
    repo.dirty = [' M a.ts'];
    await run();
    expect(states()).toEqual(['capturing', 'committing', 'stopping']);
    expect(updates[0]).toMatchObject({ writer: 'sender' });
    expect(updates[1]).toMatchObject({ summary: 'Make partial refunds idempotent.' });
    // The commit's facts ride the transition into `stopping`, where they are first true.
    expect(updates[2]).toMatchObject({ wipCommit: SHA, filesChanged: 1, truncated: false });
    // `starting` and `running` are the cloud's next command, never announced from here.
    expect(states()).not.toContain('starting');
  });

  // ---------- the commit ----------

  it('makes exactly one WIP commit for a dirty tree, with the message from the spec', async () => {
    repo.dirty = [' M a.ts', ' M b.ts', '?? c.ts'];

    const out = await run();

    expect(gitCalls(repo, 'commit')).toBe(1);
    expect(repo.log).toContain(`commit -m ${wipCommitMessage('claude', 'codex')}`);
    expect(repo.log).toContain('add -A');
    expect(wipCommitMessage('claude', 'codex')).toBe('wip(pagr): handoff claude → codex');
    if (out.outcome !== 'captured') throw new Error(out.message);
    expect(out.result.filesChanged).toBe(3);
    // Nothing pushed, nothing fetched: this module never reaches a remote.
    expect(repo.log.some((l) => /push|fetch|pull/.test(l))).toBe(false);
  });

  it('makes no commit at all when the tree is clean', async () => {
    const out = await run();

    expect(gitCalls(repo, 'commit')).toBe(0);
    expect(gitCalls(repo, 'add')).toBe(0);
    if (out.outcome !== 'captured') throw new Error(out.message);
    expect(out.result.wipCommit).toBeUndefined();
    expect(out.result.filesChanged).toBe(0);
    expect(onDisk().frontmatter.git).toMatchObject({ wipCommit: null, dirtyBefore: false });
    expect(stops).toBe(1);
  });

  it('records the commit in the file the receiving agent reads', async () => {
    repo.dirty = [' M a.ts'];

    await run();

    const doc = onDisk();
    expect(doc.frontmatter.git.wipCommit).toBe(SHA);
    expect(doc.frontmatter.git.dirtyBefore).toBe(true);
    expect(doc.frontmatter.writer).toBe('sender');
    // The rewrite is a rewrite, not an append: the body survives it intact.
    expect(doc.goal).toContain('Make partial refunds idempotent.');
    expect(doc.notDone[0]).toEqual({ text: 'Wire the key through the handler', next: true });
  });

  // ---------- the hook ----------

  it("fails the switch loudly with the hook's own first line, and leaves the sender running", async () => {
    repo.dirty = [' M a.ts'];
    repo.commitError = 'pre-commit: 3 lint errors in src/payments/refund.ts\nrun pnpm lint --fix\n';
    // git only names a hook failure when there is an executable hook to blame.
    const hooks = join(repo.root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const out = await run();

    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.reason).toBe('hook_failed');
    expect(out.message).toBe('pre-commit: 3 lint errors in src/payments/refund.ts');
    // The file is kept and named, so the text can say where the work went (spec §9).
    expect(out.path).toBe(path);
    expect(out.writer).toBe('sender');
    // Nothing was stopped and nothing was committed: the tree is exactly as the person left it.
    expect(stops).toBe(0);
    expect(states()).toEqual(['capturing', 'committing', 'failed']);
    expect(updates.at(-1)?.error).toContain('pre-commit: 3 lint errors');
    expect(onDisk().frontmatter.git.wipCommit).toBeNull();
  });

  it('reports a commit that failed for any other reason as a failed switch', async () => {
    repo.dirty = [' M a.ts'];
    repo.commitError = 'fatal: unable to write new index file';

    const out = await run();

    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.reason).toBe('commit_failed');
    expect(stops).toBe(0);
  });

  // ---------- who writes, and who gets stopped ----------

  it('skips the stop for a mirrored session and says so rather than failing', async () => {
    const receiver = writingReceiver();
    repo.dirty = [' M a.ts'];

    const out = await run({ controlLevel: 'mirror_only', captureFromReceiver: receiver.fn });

    expect(out.outcome).toBe('captured');
    if (out.outcome !== 'captured') return;
    expect(out.stop).toEqual({
      stopped: false,
      reason: 'mirror_only',
      message: expect.stringContaining('keeps running'),
    });
    expect(stops).toBe(0);
    // The switch still did its job: the file is written, stamped, and the work is committed.
    expect(out.result).toMatchObject({ writer: 'receiver', wipCommit: SHA });
    expect(onDisk().frontmatter.writer).toBe('receiver');
    // A mirrored session is never steered — the sender path was not even attempted.
    expect(sent).toEqual([]);
    expect(receiver.calls[0]).toMatchObject({ because: 'control_level', repo: repo.root });
  });

  it('skips the stop for a read-only session and for one the bridge did not start', async () => {
    const receiver = writingReceiver();

    const ro = await run({ readOnly: true, captureFromReceiver: receiver.fn });
    expect(ro.outcome === 'captured' && ro.stop).toMatchObject({ reason: 'read_only' });

    updates = [];
    stops = 0;
    const adopted = await run({
      adopted: true,
      controlLevel: 'approvals_only',
      captureFromReceiver: receiver.fn,
    });
    expect(adopted.outcome === 'captured' && adopted.stop).toMatchObject({
      reason: 'not_controllable',
    });
    expect(stops).toBe(0);
  });

  it('treats a stop refused as "somebody else owns it" only when it says so', async () => {
    const refuse = (message: string) => ({
      stop: async () => {
        throw new Error(message);
      },
    });

    const mirrored = await run(
      refuse(
        'this Codex thread belongs to a terminal session; Pagr mirrors it and relays its approvals, but cannot steer or stop it',
      ),
    );
    expect(mirrored.outcome === 'captured' && mirrored.stop).toMatchObject({
      stopped: false,
      reason: 'mirror_only',
    });

    const broken = await run(refuse('the process is wedged'));
    expect(broken.outcome).toBe('failed');
    if (broken.outcome !== 'failed') return;
    // A sender that can be stopped and will not is a failed switch: the cloud's next step starts
    // a second write-capable agent on the same tree.
    expect(broken.reason).toBe('stop_failed');
    expect(broken.message).toContain('the process is wedged');
  });

  // ---------- falling through to the receiver ----------

  it('falls through to the receiver when the sender never writes the file', async () => {
    const receiver = writingReceiver();

    const out = await run({
      sender: silentSender(),
      captureFromReceiver: receiver.fn,
      timeoutMs: 40,
      pollIntervalMs: 10,
    });

    expect(sent).toHaveLength(1); // it WAS asked first
    expect(receiver.calls[0]?.because).toBe('timeout');
    expect(out.outcome === 'captured' && out.result.writer).toBe('receiver');
    expect(states()).toEqual(['capturing', 'capturing', 'committing', 'stopping']);
  });

  it('falls through when the adapter refuses the instruction outright', async () => {
    const receiver = writingReceiver();

    await run({
      sender: {
        sendInstruction: async () => {
          throw new Error('session ses_sender has ended');
        },
      },
      captureFromReceiver: receiver.fn,
    });

    expect(receiver.calls[0]?.because).toBe('send_failed');
  });

  it('says so plainly when this bridge has no receiver path yet', async () => {
    repo.dirty = [' M a.ts'];

    const out = await run({ controlLevel: 'mirror_only' });

    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.reason).toBe('no_handoff');
    expect(out.message).toContain('codex cannot write this handoff');
    expect(out.writer).toBe('receiver');
    // Nothing was committed and nothing was stopped: a switch that did not happen changes
    // nothing about the repository.
    expect(gitCalls(repo, 'commit')).toBe(0);
    expect(stops).toBe(0);
    expect(states()).toEqual(['capturing', 'failed']);
  });

  it('keeps a malformed handoff on the sender rather than spending a second agent on it', async () => {
    const receiver = writingReceiver();

    const out = await run({
      sender: writingSender('not a handoff at all'),
      captureFromReceiver: receiver.fn,
      timeoutMs: 200,
      pollIntervalMs: 10,
    });

    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.reason).toBe('no_handoff');
    expect(out.message).toContain('not readable');
    expect(receiver.calls).toEqual([]);
  });

  // ---------- the seams ----------

  it('the receiver stub refuses in the shape a real capture answers in', async () => {
    const refused = await receiverNotAvailable({
      handoffId: HANDOFF_ID,
      sessionId: SESSION_ID,
      repo: repo.root,
      from: 'claude',
      to: 'codex',
      because: 'timeout',
    });
    expect(refused).toMatchObject({
      outcome: 'refused',
      writer: 'receiver',
      path: null,
      reason: 'receiver_not_available',
    });
  });

  it('asks the rules hook once, between the file and the commit, and survives one that throws', async () => {
    repo.dirty = [' M a.ts'];
    const seen: string[] = [];

    const out = await run({
      migrateRules: async (input) => {
        seen.push(`${input.from}->${input.to}@${input.repo}`);
        // The file exists by now; the commit has not happened yet.
        expect(readFileSync(path, 'utf8')).toContain('# Goal');
        expect(gitCalls(repo, 'commit')).toBe(0);
        return { action: 'already_present' as const };
      },
    });

    expect(seen).toEqual([`claude->codex@${repo.root}`]);
    expect(out.outcome === 'captured' && out.rules.action).toBe('already_present');

    const survived = await run({
      migrateRules: async () => {
        throw new Error('the converter blew up');
      },
    });
    // A rules conversion that fails is not a switch that fails: the handoff carries the rules.
    expect(survived.outcome).toBe('captured');
    expect(survived.outcome === 'captured' && survived.rules.action).toBe('skipped');
  });

  it('refuses before anything is written when the directory is not a repository', async () => {
    const out = await run({
      repo: join(t.home, 'not-a-repo'),
      git: { execFile: fakeGit(newFakeRepo(join(t.home, 'not-a-repo'))) },
    });

    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.reason).toBe('not_excluded');
    expect(sent).toEqual([]);
  });
});
