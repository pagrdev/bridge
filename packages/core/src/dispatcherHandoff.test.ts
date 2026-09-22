import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandBody, DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { RunOnceInput, RunOnceResult } from './adapters/runOnce.js';
import type { CodingAgentAdapter, SendInstructionInput } from './adapters/types.js';
import { Dispatcher } from './dispatcher.js';
import { type FrameBody, joinFrameParts } from './frames.js';
import { handoffFilePath } from './handoff/capture.js';
import { type FakeRepo, fakeGit, gitCalls, newFakeRepo } from './handoff/fakeGit.js';
import { codexDumpPath } from './handoff/receiver.js';
import type { HandoffCaptureAck } from './handoff/switch.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { type SessionRecord, SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

type Ack = EventPayload<'command.ack'>;
type Updated = EventPayload<'handoff.updated'>;
type Frame = EventPayload<'session.frame'>;

const HANDOFF_ID = 'hnd_0123456789abcdef0123456789abcdef';
const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';

const FILE = `---
pagr: handoff/1
id: ${HANDOFF_ID}
from: { provider: claude, sessionId: ses_x, origin: pagr }
to: { provider: codex }
project: { id: prj_checkout, name: checkout-api }
git: { branch: feat/refunds, head: 3f9c1d2, wipCommit: null, dirtyBefore: false }
writer: sender
previous: null
created: 2026-09-20T05:41:12Z
---

# Goal
Make partial refunds idempotent.

# Done
- Added the idempotency key column

# Not done
- [ ] Wire the key through the handler ← next

# Decisions and why
- Key on (order_id, amount) — a client UUID was rejected as unverifiable

# Files touched

# Commands to run

# Known failures

# Rules in force

# Open questions
`;

describe('session.handoff.capture', () => {
  const t = useTempHome('pagr-handoff-cmd-');
  const deviceId = ids.dev();
  const sessionId = ids.ses();
  const phone = generateRecipientKeyPair();

  let events: DeviceEvent[];
  let claude: FakeAdapter;
  let sessions: SessionStore;
  let projectId: string;
  let repo: FakeRepo;
  let journal: JournalStore;
  let d: Dispatcher;
  let now: Date;
  let path: string;

  const journalDir = () => join(t.home, 'pagr', 'journal');
  const acks = () => events.filter((e) => e.type === 'command.ack').map((e) => e.payload as Ack);
  const updates = () =>
    events.filter((e) => e.type === 'handoff.updated').map((e) => e.payload as Updated);
  const frames = () =>
    events.filter((e) => e.type === 'session.frame').map((e) => e.payload as Frame);

  beforeEach(() => {
    now = new Date('2026-09-20T05:41:12.000Z');
    events = [];
    const home = join(t.home, 'home');
    const repoPath = join(home, 'repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(repoPath).projectId;
    repo = newFakeRepo(repoPath, { nextSha: SHA });
    path = handoffFilePath(repoPath, HANDOFF_ID);

    claude = new FakeAdapter('claude');
    // A well-behaved sender: the steer arrives, the file appears.
    claude.sendInstruction = async (input: SendInstructionInput) => {
      claude.calls.push({ method: 'sendInstruction', args: input });
      writeFileSync(path, FILE);
      return { delivered: 'steered' as const };
    };

    sessions = new SessionStore();
    sessions.upsert({
      sessionId,
      provider: 'claude',
      projectId,
      providerSessionId: sessionId,
      status: 'working',
      projectPath: repoPath,
      startedAt: now.toISOString(),
    });

    journal = new JournalStore({ dir: journalDir(), now: () => now });
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([['claude', claude]]),
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      git: { execFile: fakeGit(repo) },
      env: { PAGR_HANDOFF_CAPTURE_TIMEOUT_MS: '2000' },
      frames: {
        journal,
        cursors: new OutboxCursors({ file: join(journalDir(), 'outbox.json'), writeDelayMs: 0 }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });

  const capture = (over: Record<string, unknown> = {}, version = 2): Promise<DeviceEvent> =>
    d.handle({
      ...makeBody(
        'session.handoff.capture',
        { handoffId: HANDOFF_ID, sessionId, to: 'codex', ...over } as never,
        { deviceId, now },
      ),
      version,
    } as CommandBody);

  it('runs the whole switch and acks what the cloud needs to text', async () => {
    repo.dirty = [' M src/payments/refund.ts', '?? src/payments/guard.ts'];

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('completed');
    expect(ack.result).toEqual({
      writer: 'sender',
      summary: 'Make partial refunds idempotent.',
      wipCommit: SHA,
      filesChanged: 2,
      truncated: false,
    });
    // One WIP commit, and the sender was stopped before anything else could touch the tree.
    expect(gitCalls(repo, 'commit')).toBe(1);
    expect(claude.calls.filter((c) => c.method === 'stopSession')).toHaveLength(1);
    expect(sessions.get(sessionId)?.status).toBe('stopped');
  });

  it('emits handoff.updated at every state it enters, all naming the handoff', async () => {
    repo.dirty = [' M a.ts'];

    await capture();

    expect(updates().map((u) => u.state)).toEqual(['capturing', 'committing', 'stopping']);
    expect(updates().every((u) => u.handoffId === HANDOFF_ID)).toBe(true);
    expect(updates().at(-1)).toMatchObject({ wipCommit: SHA, filesChanged: 1, writer: 'sender' });
  });

  it('seals the file as a handoff frame, journals it, and keeps the path repo-relative', async () => {
    await capture();

    const frame = frames().at(-1);
    expect(frame).toMatchObject({ sessionId, projectId, provider: 'claude', kind: 'handoff' });
    const sealed = frame?.sealed as NonNullable<typeof frame>['sealed'];
    const body = joinFrameParts([
      { body: openFrame(sealed, sealAadFor(sealed.aad), phone.privateKeyRaw) },
    ]) as Extract<FrameBody, { kind: 'handoff' }>;
    expect(body.kind).toBe('handoff');
    expect(body.handoffId).toBe(HANDOFF_ID);
    expect(body.path).toBe(join('.pagr', 'handoff', `${HANDOFF_ID}.md`));
    expect(body.path).not.toContain(t.home);
    expect(body.text).toBe(readFileSync(path, 'utf8'));
    // The journal holds the same body, in the clear, on the user's own disk.
    const line = readFileSync(join(journalDir(), `${sessionId}.log`), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { kind: string; body: { handoffId: string } });
    expect(line.at(-1)?.kind).toBe('handoff');
    expect(line.at(-1)?.body.handoffId).toBe(HANDOFF_ID);
  });

  it("fails the command with the hook's own words, and leaves the session alone", async () => {
    repo.dirty = [' M a.ts'];
    repo.commitError = 'pre-commit: 3 lint errors\nrun pnpm lint --fix\n';
    const hooks = join(repo.root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const ack = (await capture()).payload as Ack;

    expect(ack).toMatchObject({
      status: 'failed',
      errorCode: 'provider_error',
      message: 'pre-commit: 3 lint errors',
    });
    expect(updates().at(-1)).toMatchObject({ state: 'failed', error: 'pre-commit: 3 lint errors' });
    expect(claude.calls.filter((c) => c.method === 'stopSession')).toHaveLength(0);
    expect(sessions.get(sessionId)?.status).toBe('working');
    // A failed switch produces no frame: there is nothing final to show the phone.
    expect(frames()).toEqual([]);
  });

  it('refuses honestly when the receiving agent has no adapter on this Mac', async () => {
    // The receiver-writes path is wired (HND-012a), but this bridge has no codex adapter at all,
    // so there is nothing to spawn. It is a refusal, not a throw and not a silence.
    sessions.upsert({
      ...(sessions.get(sessionId) ?? { sessionId }),
      provider: 'claude',
      projectId,
      providerSessionId: 'ba3e0f5c-2e2b-4f3a-9a7d-0c1b2a3d4e5f',
      status: 'working',
      adopted: true,
      cwd: repo.root,
      startedAt: now.toISOString(),
    });

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('failed');
    expect(ack.message).toContain('there is no codex adapter on this Mac');
    expect(updates().at(-1)?.state).toBe('failed');
    expect(gitCalls(repo, 'commit')).toBe(0);
    expect(claude.calls.filter((c) => c.method === 'sendInstruction')).toHaveLength(0);
  });

  it('is a v2 command, and an unknown session is an unknown session', async () => {
    const v1 = (await capture({}, 1)).payload as Ack;
    expect(v1).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });

    const gone = (await capture({ sessionId: ids.ses() })).payload as Ack;
    expect(gone).toMatchObject({ status: 'failed', errorCode: 'unknown_session' });
    expect(acks()).toHaveLength(2);
  });
});

/**
 * The other half of spec §3, end to end through the dispatcher (HND-012a).
 *
 * This is the path the feature mostly exists for and the one nothing exercised whole until the
 * wiring landed: the sending session cannot be steered (or was steered and never answered), so
 * the RECEIVING agent is spawned headless over the sender's transcript and writes the note
 * itself. Everything here is a fake — a fake git runner, a fake adapter, a transcript written
 * into a temporary home — so no test touches a real repository, a real `~/.claude`, or a real
 * `~/.codex`.
 */
describe('session.handoff.capture — the receiver writes', () => {
  const t = useTempHome('pagr-handoff-recv-');
  const deviceId = ids.dev();
  const sessionId = ids.ses();
  /** Claude's OWN id for the sending session — what names its transcript on disk. */
  const CLAUDE_UUID = '9f1c0f4a-6f21-4a1b-9d6e-2f0a1b2c3d4e';
  /** Codex's own id for a sending thread. */
  const CODEX_THREAD = 'thr_7b1d2e3f4a5b6c7d';

  let events: DeviceEvent[];
  let claude: FakeAdapter;
  let codex: FakeAdapter;
  let sessions: SessionStore;
  let projectId: string;
  let repo: FakeRepo;
  let home: string;
  let pagrHome: string;
  let d: Dispatcher;
  let now: Date;
  let path: string;
  let runs: RunOnceInput[];

  const phone = generateRecipientKeyPair();
  const acks = () => events.filter((e) => e.type === 'command.ack').map((e) => e.payload as Ack);
  const updates = () =>
    events.filter((e) => e.type === 'handoff.updated').map((e) => e.payload as Updated);
  const frames = () => events.filter((e) => e.type === 'session.frame');

  /** A run that behaves: it writes the note it was asked for and says it finished. */
  const writingRun =
    (text = FILE) =>
    async (input: RunOnceInput): Promise<RunOnceResult> => {
      runs.push(input);
      writeFileSync(path, text);
      return {
        runId: 'run_0123456789abcdef0123456789abcdef',
        sessionId: ids.ses(),
        outcome: 'completed',
        output: 'wrote the handoff',
        durationMs: 12,
      };
    };

  /** Claude's transcript, where `~/.claude/projects/<anything>/<uuid>.jsonl` puts it. */
  const writeClaudeTranscript = (uuid = CLAUDE_UUID): string => {
    const dir = join(home, '.claude', 'projects', '-Users-fake-repo');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${uuid}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'user', text: 'partial refunds' })}\n`);
    return file;
  };

  /** The sending session, as the store holds it. Adopted means "cannot be steered". */
  const sending = (over: Partial<SessionRecord> = {}): void => {
    sessions.upsert({
      sessionId,
      provider: 'claude',
      projectId,
      providerSessionId: CLAUDE_UUID,
      status: 'working',
      adopted: true,
      cwd: repo.root,
      projectPath: repo.root,
      startedAt: now.toISOString(),
      ...over,
    });
  };

  beforeEach(() => {
    now = new Date('2026-09-20T05:41:12.000Z');
    events = [];
    runs = [];
    home = join(t.home, 'home');
    pagrHome = join(home, '.pagr');
    const repoPath = join(home, 'repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome });
    projectId = registry.add(repoPath).projectId;
    repo = newFakeRepo(repoPath, { nextSha: SHA });
    path = handoffFilePath(repoPath, HANDOFF_ID);

    claude = new FakeAdapter('claude');
    codex = new FakeAdapter('codex');
    sessions = new SessionStore();

    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['claude', claude],
        ['codex', codex],
      ]),
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(pagrHome, 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(pagrHome, 'policy.json'),
      now: () => now,
      git: { execFile: fakeGit(repo) },
      // Short, because one test lets the sender run out of time on purpose.
      env: { PAGR_HANDOFF_CAPTURE_TIMEOUT_MS: '150' },
      frames: {
        journal: new JournalStore({ dir: join(pagrHome, 'journal'), now: () => now }),
        cursors: new OutboxCursors({
          file: join(pagrHome, 'journal', 'outbox.json'),
          writeDelayMs: 0,
        }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });

  const capture = (over: Record<string, unknown> = {}): Promise<DeviceEvent> =>
    d.handle({
      ...makeBody(
        'session.handoff.capture',
        { handoffId: HANDOFF_ID, sessionId, to: 'codex', ...over } as never,
        { deviceId, now },
      ),
      version: 2,
    } as CommandBody);

  it('hands a session it cannot steer to the receiving agent, which writes the file', async () => {
    const transcript = writeClaudeTranscript();
    sending();
    Object.assign(codex, { runOnce: writingRun() });
    repo.dirty = [' M src/payments/refund.ts'];

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('completed');
    expect(ack.result).toEqual({
      writer: 'receiver',
      summary: 'Make partial refunds idempotent.',
      wipCommit: SHA,
      filesChanged: 1,
      truncated: false,
    });
    // The sender was never asked for anything: it cannot be steered, so it was not steered.
    expect(claude.calls.filter((c) => c.method === 'sendInstruction')).toHaveLength(0);
    // The RECEIVING agent ran, in the repository, over the SENDER's transcript.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.cwd).toBe(repo.root);
    expect(runs[0]?.prompt).toContain(transcript);
    expect(runs[0]?.projectId).toBe(projectId);
    // The file exists, it was committed, and it says who really wrote it.
    expect(gitCalls(repo, 'commit')).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain('writer: receiver');
    expect(updates().some((u) => u.state === 'capturing' && u.writer === 'receiver')).toBe(true);
    expect(frames()).toHaveLength(1);
    // An adopted session is not Pagr's to stop, and the switch says so rather than trying.
    expect(claude.calls.filter((c) => c.method === 'stopSession')).toHaveLength(0);
  });

  it('falls through to the receiver when the sender was steered and never answered', async () => {
    writeClaudeTranscript();
    // A session the bridge started: `full` control, so the sender is asked first.
    sending({ adopted: false, providerSessionId: sessionId });
    Object.assign(claude, { providerSessionId: () => CLAUDE_UUID });
    Object.assign(codex, { runOnce: writingRun() });

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('completed');
    expect((ack.result as HandoffCaptureAck).writer).toBe('receiver');
    expect(sessions.get(sessionId)?.providerSessionId).toBe(CLAUDE_UUID);
    // Asked first, and only then handed over.
    expect(claude.calls.filter((c) => c.method === 'sendInstruction')).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(updates().map((u) => u.writer)).toContain('sender');
    expect(updates().some((u) => u.state === 'capturing' && u.writer === 'receiver')).toBe(true);
    // This one IS Pagr's to stop, and two agents never share a work tree.
    expect(claude.calls.filter((c) => c.method === 'stopSession')).toHaveLength(1);
    expect(sessions.get(sessionId)?.status).toBe('stopped');
  });

  it('dumps a Codex thread for the receiver, and deletes it afterwards', async () => {
    let sawDump: string | null = null;
    sending({ provider: 'codex', providerSessionId: CODEX_THREAD });
    Object.assign(codex, {
      readThread: async (threadId: string) => ({
        id: threadId,
        turns: [{ id: 'turn_1', items: [{ type: 'agent_message', text: 'refactored the guard' }] }],
      }),
    });
    Object.assign(claude, {
      runOnce: async (input: RunOnceInput): Promise<RunOnceResult> => {
        sawDump = readFileSync(codexDumpPath(pagrHome, HANDOFF_ID), 'utf8');
        return writingRun(FILE.replace('to: { provider: codex }', 'to: { provider: claude }'))(
          input,
        );
      },
    });

    const ack = (await capture({ to: 'claude' })).payload as Ack;

    expect(ack.status).toBe('completed');
    expect((ack.result as HandoffCaptureAck).writer).toBe('receiver');
    // The dump existed while the run did: NDJSON, the marker first, one line per item.
    expect(sawDump).toContain('pagr/codex-thread-1');
    expect(sawDump).toContain('refactored the guard');
    expect(runs[0]?.prompt).toContain(codexDumpPath(pagrHome, HANDOFF_ID));
    // And a plaintext transcript is not left lying in a temp directory.
    expect(existsSync(codexDumpPath(pagrHome, HANDOFF_ID))).toBe(false);
  });

  it('refuses honestly when the receiving adapter cannot be run headlessly', async () => {
    writeClaudeTranscript();
    sending();
    // `codex` has no `runOnce` — a perfectly good adapter that cannot be the writer.

    const ack = (await capture()).payload as Ack;

    expect(ack).toMatchObject({ status: 'failed', errorCode: 'provider_error' });
    expect(ack.message).toContain('cannot run headlessly');
    expect(gitCalls(repo, 'commit')).toBe(0);
    expect(frames()).toEqual([]);
    expect(updates().at(-1)?.state).toBe('failed');
  });

  it("refuses honestly when Pagr never learned the sender's own session id", async () => {
    writeClaudeTranscript();
    // What `agent.start_session` records: Pagr's own id standing in for the provider's.
    sending({ adopted: false, providerSessionId: sessionId });
    Object.assign(codex, { runOnce: writingRun() });

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('failed');
    expect(ack.message).toContain('never learned');
    expect(runs).toEqual([]);
    expect(gitCalls(repo, 'commit')).toBe(0);
  });

  /**
   * HND-019. The handoff writer is a session too: visible while it runs, stoppable, and — the
   * part that needed a decision rather than wiring — a stop leaves NOTHING behind.
   */
  describe('the handoff writer is a session', () => {
    /**
     * A run that hangs until it is stopped, and — like a real killed agent — leaves the bytes it
     * had already flushed on disk. A note written top-down can parse while missing `# Not done`
     * and `# Known failures`, so reading this would start the receiver on a confidently wrong
     * picture of the work. That is why the stop path deletes it.
     */
    const hangingRun =
      (partial: string) =>
      async (input: RunOnceInput): Promise<RunOnceResult> => {
        runs.push(input);
        const runId = input.runId ?? 'run_0123456789abcdef0123456789abcdef';
        const tracked = codex.trackOneShot(
          { runId, kind: input.kind, cwd: input.cwd, projectId: input.projectId },
          { onStop: () => undefined },
        );
        await new Promise<void>((resolve) => {
          const stop = () => {
            writeFileSync(path, partial);
            resolve();
          };
          if (input.signal?.aborted) stop();
          else input.signal?.addEventListener('abort', stop, { once: true });
        });
        tracked.finish('canceled');
        return {
          runId,
          sessionId: tracked.sessionId,
          outcome: 'canceled',
          output: '',
          durationMs: 3,
        };
      };

    /** The `ses_…` the writer is listed under, once it is live. */
    const writerSession = async (): Promise<string> => {
      const until = Date.now() + 2_000;
      while (codex.oneShots().length === 0) {
        if (Date.now() > until) throw new Error('the handoff writer never became visible');
        await new Promise((r) => setTimeout(r, 2));
      }
      return codex.oneShots()[0]?.sessionId ?? '';
    };

    it('is listed while it writes, says what it is doing, and can be stopped', async () => {
      writeClaudeTranscript();
      sending();
      Object.assign(codex, { runOnce: hangingRun(FILE) });
      const pending = capture();
      const runSession = await writerSession();

      const hello = await d.probe();
      const row = hello.sessions.find((s) => s.sessionId === runSession);
      expect(row).toMatchObject({
        provider: 'codex',
        projectId,
        status: 'working',
        displayName: 'Writing the handoff',
        controlLevel: 'full',
        origin: 'pagr',
      });
      expect(row?.oneShot?.kind).toBe('handoff');

      await d.handle({
        ...makeBody('agent.stop_session', { sessionId: runSession } as never, { deviceId, now }),
        version: 2,
      } as CommandBody);
      await pending;
    });

    it('resolves the switch as canceled — not failed, not a timeout', async () => {
      writeClaudeTranscript();
      sending();
      Object.assign(codex, { runOnce: hangingRun(FILE) });
      repo.dirty = [' M src/payments/refund.ts'];
      const pending = capture();
      const runSession = await writerSession();

      await d.handle({
        ...makeBody('agent.stop_session', { sessionId: runSession } as never, { deviceId, now }),
        version: 2,
      } as CommandBody);
      await pending;

      const states = updates().map((u) => u.state);
      expect(states).toContain('canceled');
      expect(states).not.toContain('failed');
      // `canceled` is terminal and carries no error: nothing broke.
      const last = updates().at(-1);
      expect(last?.state).toBe('canceled');
      expect(last?.error).toBeUndefined();
      // Nothing was committed and the sender was never stopped: a canceled switch leaves the
      // person exactly where they were.
      expect(repo.log.some((l) => l.startsWith('commit'))).toBe(false);
      expect(repo.head).toBe('a'.repeat(40));
      expect(claude.calls.filter((c) => c.method === 'stopSession')).toHaveLength(0);
      expect(frames().filter((e) => (e.payload as { kind: string }).kind === 'handoff')).toEqual(
        [],
      );
    });

    it('deletes the half-written note rather than handing it on', async () => {
      writeClaudeTranscript();
      sending();
      // Everything down to "Not done" — parseable, and missing the half that matters.
      Object.assign(codex, {
        runOnce: hangingRun(FILE.slice(0, FILE.indexOf('# Not done'))),
      });
      const pending = capture();
      const runSession = await writerSession();

      await d.handle({
        ...makeBody('agent.stop_session', { sessionId: runSession } as never, { deviceId, now }),
        version: 2,
      } as CommandBody);
      await pending;

      expect(existsSync(path)).toBe(false);
    });
  });

  it('refuses honestly when the sending session left no transcript on this Mac', async () => {
    // No transcript written: the session ended long ago, or Claude never wrote one.
    sending();
    Object.assign(codex, { runOnce: writingRun() });

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('failed');
    expect(ack.message).toContain('no transcript on this Mac');
    expect(runs).toEqual([]);
    expect(gitCalls(repo, 'commit')).toBe(0);
    expect(acks()).toHaveLength(1);
  });
});
