import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { AdapterEvent, CodingAgentAdapter } from './adapters/types.js';
import { referencedIds } from './commandGuard.js';
import { Dispatcher } from './dispatcher.js';
import { decodeFrameBody, type FrameQuestion } from './frames.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const QUESTIONS: FrameQuestion[] = [
  {
    question: 'Which environment should I deploy to?',
    header: 'Deploy target',
    multiSelect: false,
    options: [
      { label: 'staging', description: 'safe' },
      { label: 'production', description: 'careful', preview: 'app.example.com' },
    ],
  },
  {
    question: 'Which checks should run first?',
    header: 'Checks',
    multiSelect: true,
    options: [{ label: 'lint' }, { label: 'test' }],
  },
];

/**
 * MOB-036 at the dispatcher: what `question.asked` says in the clear, what the frame carries,
 * which answers are refused, and what the agent is actually handed.
 */
describe('questions through the dispatcher', () => {
  const t = useTempHome('pagr-questions-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();
  const now = new Date('2026-09-17T12:00:00.000Z');

  let codex: FakeAdapter;
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let events: DeviceEvent[];
  let projectId: string;
  let home: string;
  let journalDir: string;
  let questionChanges: number[];
  let d: Dispatcher;

  beforeEach(() => {
    codex = new FakeAdapter('codex');
    home = join(t.home, `home-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    sessions = new SessionStore();
    events = [];
    questionChanges = [];
    journalDir = join(home, 'journal');
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
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
      onQuestionsChange: () => questionChanges.push(d.questions.list().length),
      frames: {
        journal: new JournalStore({ dir: journalDir, now: () => now }),
        cursors: new OutboxCursors({ file: join(journalDir, 'outbox.json'), writeDelayMs: 0 }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });

  const body = <T extends Parameters<typeof makeBody>[0]>(
    type: T,
    payload: Parameters<typeof makeBody<T>>[1],
  ) => makeBody(type, payload, { deviceId, now });

  const ofType = (type: DeviceEvent['type']) => events.filter((e) => e.type === type);
  const asked = () => ofType('question.asked')[0]?.payload as EventPayload<'question.asked'>;
  const answered = () =>
    ofType('question.answered').map((e) => e.payload as EventPayload<'question.answered'>);
  const relayed = () => codex.calls.filter((c) => c.method === 'answerQuestion').map((c) => c.args);

  /** Start a session and have the agent ask. */
  const ask = async (over: Partial<Extract<AdapterEvent, { kind: 'question_asked' }>> = {}) => {
    const sessionId = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'deploy something',
        sessionId,
        attachments: [],
        readOnly: false,
      }),
    );
    codex.push({
      kind: 'question_asked',
      sessionId,
      projectId,
      providerRequestId: 'item_1',
      questions: QUESTIONS,
      answerable: true,
      secret: [false, false],
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      providerRecordId: 'item_1',
      meta: { source: 'app_server' },
      ...over,
    });
    await Promise.resolve();
    return sessionId;
  };

  it('announces the shape in the clear and seals the words into a question frame', async () => {
    const sessionId = await ask();
    const ev = asked();
    expect(ev).toMatchObject({
      sessionId,
      projectId,
      provider: 'codex',
      providerRequestId: 'item_1',
      seq: 1,
      meta: {
        answerable: true,
        multiSelect: [false, true],
        optionCount: [2, 2],
        secret: [false, false],
      },
      expiresAt: '2026-09-17T12:10:00.000Z',
    });
    expect(ev.questionId).toMatch(/^qst_[0-9a-f]{32}$/);
    // Nothing the person reads is on the event; it is all inside the frame at `seq`.
    expect(JSON.stringify(ev)).not.toContain('production');

    const frame = ofType('session.frame')[0]?.payload as EventPayload<'session.frame'>;
    expect(frame.kind).toBe('question');
    expect(frame.seq).toBe(ev.seq);
    const opened = openFrame(frame.sealed, sealAadFor(frame.sealed.aad), phone.privateKeyRaw);
    expect(decodeFrameBody(opened)).toEqual({ kind: 'question', questions: QUESTIONS });
  });

  it('answers by index, relays it to the adapter and reports it answered', async () => {
    const sessionId = await ask();
    const ev = asked();
    const ack = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId,
        providerRequestId: 'item_1',
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, optionIndexes: [0, 1], freeText: 'and be quick' },
        ],
      }),
    );
    expect(ack.payload).toMatchObject({ status: 'completed' });
    expect(relayed()).toEqual([
      {
        providerRequestId: 'item_1',
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, optionIndexes: [0, 1], freeText: 'and be quick' },
        ],
      },
    ]);
    expect(answered()).toEqual([{ questionId: ev.questionId }]);
    // Single use: the same command again finds nothing pending.
    const again = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId,
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    );
    expect(again.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_question' });
  });

  it('an unknown question id is unknown_question, never unknown_session', async () => {
    const sessionId = await ask();
    const ack = await d.handle(
      body('agent.answer_question', {
        questionId: ids.qst(),
        sessionId,
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    );
    expect(ack.payload).toMatchObject({
      status: 'failed',
      errorCode: 'unknown_question',
      message: 'no pending question (expired or already answered)',
    });
    expect(relayed()).toEqual([]);
  });

  it('a session or request that does not match the retained question is invalid_payload', async () => {
    await ask();
    const ev = asked();
    const other = ids.ses();
    sessions.upsert({
      sessionId: other,
      provider: 'codex',
      projectId,
      providerSessionId: other,
      status: 'working',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const wrongSession = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId: other,
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    );
    expect(wrongSession.payload).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_payload',
      message: 'question belongs to another session',
    });
    const wrongRequest = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId: ev.sessionId,
        providerRequestId: 'item_9',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    );
    expect(wrongRequest.payload).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_payload',
      message: 'provider request id mismatch',
    });
    // Neither attempt consumed it, and the agent heard nothing.
    expect(relayed()).toEqual([]);
    expect(d.questions.list()).toHaveLength(1);
  });

  it('refuses an option index the question never offered', async () => {
    const sessionId = await ask();
    const ev = asked();
    const ack = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId,
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [4] }],
      }),
    );
    expect(ack.payload).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_payload',
      message: 'optionIndex 4 is out of range for question 0',
    });
    expect(relayed()).toEqual([]);
    expect(d.questions.list()).toHaveLength(1);
  });

  it('a mirrored thread says so, and refuses to be answered from the phone', async () => {
    const sessionId = await ask({ answerable: false, reason: 'mirror_only' });
    const ev = asked();
    expect(ev.meta).toMatchObject({ answerable: false, reason: 'mirror_only' });
    const ack = await d.handle(
      body('agent.answer_question', {
        questionId: ev.questionId,
        sessionId,
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    );
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });
    expect(relayed()).toEqual([]);
  });

  it('an answer given on the Mac ends it as answeredElsewhere, with nothing relayed', async () => {
    const sessionId = await ask();
    const ev = asked();
    codex.push({
      kind: 'question_resolved_locally',
      sessionId,
      providerRequestId: 'item_1',
      resolution: 'answered',
      source: 'terminal',
      answeredElsewhere: true,
    });
    await Promise.resolve();
    expect(answered()).toEqual([
      { questionId: ev.questionId, answeredElsewhere: true, reason: 'answered_elsewhere' },
    ]);
    expect(relayed()).toEqual([]);
    expect(d.questions.list()).toEqual([]);
  });

  it('a withdrawn question is reported with its reason and never relayed', async () => {
    const sessionId = await ask();
    const ev = asked();
    codex.push({
      kind: 'question_resolved_locally',
      sessionId,
      providerRequestId: 'item_1',
      resolution: 'timed_out',
      reason: 'timed_out',
    });
    await Promise.resolve();
    expect(answered()).toEqual([{ questionId: ev.questionId, reason: 'timed_out' }]);
    expect(relayed()).toEqual([]);
  });

  it('counts the pending set for keep-awake, and clears it on shutdown', async () => {
    await ask();
    expect(questionChanges).toEqual([1]);
    expect(d.questions.list()).toHaveLength(1);
    await d.shutdown();
    expect(questionChanges).toEqual([1, 0]);
    expect(answered().at(-1)).toMatchObject({ reason: 'shutdown' });
  });

  it('names the session it must find before dispatch', () => {
    const cmd = makeBody(
      'agent.answer_question',
      {
        questionId: ids.qst(),
        sessionId: 'ses_00000000000000000000000000000001',
        providerRequestId: 'item_1',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      },
      { deviceId, now },
    );
    expect(referencedIds(cmd)).toEqual({ sessionId: 'ses_00000000000000000000000000000001' });
  });
});
