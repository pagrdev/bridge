import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandBody, DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter, SendInstructionInput } from './adapters/types.js';
import { Dispatcher } from './dispatcher.js';
import { type FrameBody, joinFrameParts } from './frames.js';
import { handoffFilePath } from './handoff/capture.js';
import { type FakeRepo, fakeGit, gitCalls, newFakeRepo } from './handoff/fakeGit.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
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

  it('refuses a session it cannot steer until the receiver-writes path exists (HND-012)', async () => {
    sessions.upsert({
      ...(sessions.get(sessionId) ?? { sessionId }),
      provider: 'claude',
      projectId,
      providerSessionId: sessionId,
      status: 'working',
      adopted: true,
      cwd: repo.root,
      startedAt: now.toISOString(),
    });

    const ack = (await capture()).payload as Ack;

    expect(ack.status).toBe('failed');
    expect(ack.message).toContain('cannot write this handoff');
    expect(updates().at(-1)?.state).toBe('failed');
    expect(gitCalls(repo, 'commit')).toBe(0);
  });

  it('is a v2 command, and an unknown session is an unknown session', async () => {
    const v1 = (await capture({}, 1)).payload as Ack;
    expect(v1).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });

    const gone = (await capture({ sessionId: ids.ses() })).payload as Ack;
    expect(gone).toMatchObject({ status: 'failed', errorCode: 'unknown_session' });
    expect(acks()).toHaveLength(2);
  });
});
