import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Dispatcher,
  decodeFrameBody,
  generateRecipientKeyPair,
  JournalStore,
  OutboxCursors,
  openFrame,
  ProjectRegistry,
  SessionStore,
  sealAadFor,
} from '@pagr/bridge-core';
import type { CodingAgentAdapter, DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const hex32 = () => randomBytes(16).toString('hex');

const until = async (pred: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * MOB-036 end to end: an `AskUserQuestion` from a bridge-spawned `claude`, through a real
 * dispatcher, answered from the "phone", and back down the same control request.
 *
 * The fake binary encodes spike MOB-044's measured behaviour exactly — answers keyed by the full
 * question text work, a bare allow does not — so the regression this file is really guarding is
 * the one the spike found: Pagr used to answer these prompts as approvals, which ended the turn
 * with "The user did not answer the questions." before anyone saw the question.
 */
describe('Claude questions', () => {
  const phone = generateRecipientKeyPair();
  const SES = `ses_${hex32()}`;

  let home: string;
  let project: string;
  let journalDir: string;
  let controlFile: string;
  let adapter: ClaudeAdapter;
  let dispatcher: Dispatcher;
  let events: DeviceEvent[];
  let projectId: string;

  const build = (approvalTimeoutMs = 20_000) => {
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      approvalTimeoutMs,
      transcriptLookupMs: 0,
      env: { HOME: home, FAKE_CLAUDE_CONTROL_FILE: controlFile },
    });
    const registry = new ProjectRegistry({ home, pagrHome: path.join(home, '.pagr') });
    projectId = registry.add(project).projectId;
    dispatcher = new Dispatcher({
      deviceId: `dev_${hex32()}`,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['claude', adapter as unknown as CodingAgentAdapter],
      ]),
      registry,
      sessions: new SessionStore(),
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: path.join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: path.join(home, '.pagr', 'policy.json'),
      frames: {
        journal: new JournalStore({ dir: journalDir }),
        cursors: new OutboxCursors({ file: path.join(journalDir, 'outbox.json'), writeDelayMs: 0 }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-q-')));
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-q-')));
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    journalDir = path.join(home, 'journal');
    controlFile = path.join(home, 'control.jsonl');
    events = [];
    build();
  });
  afterEach(async () => {
    await dispatcher.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const ofType = (type: DeviceEvent['type']) => events.filter((e) => e.type === type);
  const asked = () => ofType('question.asked')[0]?.payload as EventPayload<'question.asked'>;
  const answeredEvents = () =>
    ofType('question.answered').map((e) => e.payload as EventPayload<'question.answered'>);

  const controlLines = (): Array<Record<string, unknown>> =>
    fs.existsSync(controlFile)
      ? fs
          .readFileSync(controlFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  /** The stdout line the fake wrote as the tool's result, once it has one. */
  const toolResultText = (): string | null => {
    const frame = ofType('session.event')
      .map((e) => e.payload as EventPayload<'session.event'>)
      .find((p) => p.kind === 'agent_message' || p.kind === 'completed');
    return frame?.summary ?? null;
  };

  const startAsk = async (instruction: string) => {
    await adapter.startSession({
      sessionId: SES,
      project: { projectId, path: project, displayName: 'demo' },
      instruction,
      localImagePaths: [],
      readOnly: false,
    });
    await until(() => asked() !== undefined);
    return asked();
  };

  const answer = (
    ev: EventPayload<'question.asked'>,
    answers: Array<{ questionIndex: number; optionIndexes: number[]; freeText?: string }>,
  ) =>
    dispatcher.handle({
      version: 2,
      commandId: `cmd_${hex32()}`,
      deviceId: (ofType('question.asked')[0] as DeviceEvent).deviceId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: hex32(),
      type: 'agent.answer_question',
      payload: {
        questionId: ev.questionId,
        sessionId: ev.sessionId,
        providerRequestId: ev.providerRequestId,
        answers,
      },
    } as never);

  it('relays the question as a sealed frame, answers it on the same control request, and Claude reads the answer', async () => {
    const ev = await startAsk('ask me something');
    expect(ev.meta).toEqual({
      answerable: true,
      multiSelect: [false],
      optionCount: [2],
      secret: [false],
    });
    expect(ev.providerRequestId).toMatch(/^toolu_/);

    // The words travel sealed, in the frame at `seq` — never on the event.
    const frame = ofType('session.frame')
      .map((e) => e.payload as EventPayload<'session.frame'>)
      .find((p) => p.kind === 'question');
    expect(frame?.seq).toBe(ev.seq);
    const sealed = frame?.sealed;
    if (!sealed) throw new Error('no question frame');
    const body = decodeFrameBody(openFrame(sealed, sealAadFor(sealed.aad), phone.privateKeyRaw));
    expect(body).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Do you prefer option A or option B?',
          header: 'Preference',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'Choose option A' },
            { label: 'Option B', description: 'Choose option B' },
          ],
        },
      ],
    });
    expect(JSON.stringify(ev)).not.toContain('Option B');

    const ack = await answer(ev, [{ questionIndex: 0, optionIndexes: [1] }]);
    expect(ack.payload).toMatchObject({ status: 'completed' });

    // The exact line written to Claude's stdin, asserted whole: this is the shape spike MOB-044
    // measured as the only one that works.
    await until(() => controlLines().length > 0);
    const line = controlLines()[0] as {
      type: string;
      response: { subtype: string; request_id: string; response: Record<string, unknown> };
    };
    expect(line.type).toBe('control_response');
    expect(line.response.subtype).toBe('success');
    expect(line.response.request_id).toMatch(/^req_/);
    expect(line.response.response).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            question: 'Do you prefer option A or option B?',
            header: 'Preference',
            multiSelect: false,
            options: [
              { label: 'Option A', description: 'Choose option A' },
              { label: 'Option B', description: 'Choose option B' },
            ],
          },
        ],
        answers: { 'Do you prefer option A or option B?': 'Option B' },
      },
    });

    expect(answeredEvents()).toEqual([{ questionId: ev.questionId }]);

    // …and Claude accepted it: the turn continues rather than ending on "did not answer".
    await until(() => (toolResultText() ?? '').includes('Your questions have been answered'));
    expect(toolResultText()).not.toContain('did not answer');
  }, 30_000);

  it('never sends a bare allow for AskUserQuestion (the bug spike MOB-044 found)', async () => {
    const ev = await startAsk('ask me something');
    await answer(ev, [{ questionIndex: 0, optionIndexes: [0] }]);
    await until(() => controlLines().length > 0);
    for (const l of controlLines()) {
      const decision = (l.response as { response: Record<string, unknown> }).response;
      if (decision.behavior !== 'allow') continue;
      const updated = decision.updatedInput as Record<string, unknown> | undefined;
      // A plain allow — or one whose `updatedInput` is just the original input — is exactly what
      // made the CLI report "The user did not answer the questions." and end the turn.
      expect(updated).toBeDefined();
      const hasAnswer =
        Object.keys((updated?.answers ?? {}) as object).length > 0 ||
        typeof updated?.response === 'string';
      expect(hasAnswer).toBe(true);
    }
    await until(() => (toolResultText() ?? '').includes('Your questions have been answered'));
  }, 30_000);

  it('joins a multi-select answer with ", " (spec-derived: Agent SDK docs, unverified in the spike)', async () => {
    const ev = await startAsk('ask multi please');
    expect(ev.meta.multiSelect).toEqual([true]);
    expect(ev.meta.optionCount).toEqual([3]);
    await answer(ev, [{ questionIndex: 0, optionIndexes: [0, 2] }]);
    await until(() => controlLines().length > 0);
    const updated = (
      controlLines()[0] as { response: { response: { updatedInput: Record<string, unknown> } } }
    ).response.response.updatedInput;
    expect(updated.answers).toEqual({
      'Which checks should run before I push?': 'lint, test',
    });
    await until(() => (toolResultText() ?? '').includes('Your questions have been answered'));
  }, 30_000);

  it('free text becomes `response`, and Claude reports it as what the user said', async () => {
    const ev = await startAsk('ask me something');
    await answer(ev, [
      { questionIndex: 0, optionIndexes: [], freeText: 'A please, and stop after that' },
    ]);
    await until(() => controlLines().length > 0);
    const updated = (
      controlLines()[0] as { response: { response: { updatedInput: Record<string, unknown> } } }
    ).response.response.updatedInput;
    expect(updated.answers).toEqual({});
    expect(updated.response).toBe('A please, and stop after that');
    await until(() =>
      (toolResultText() ?? '').includes('The user responded: A please, and stop after that'),
    );
  }, 30_000);

  it('denies on timeout rather than leaving the process blocked forever', async () => {
    await dispatcher.shutdown();
    events = [];
    build(300);
    const ev = await startAsk('ask me something');
    await until(() => controlLines().length > 0);
    expect((controlLines()[0] as { response: { response: unknown } }).response.response).toEqual({
      behavior: 'deny',
      message: 'No answer received from the user in time (Pagr)',
    });
    await until(() => answeredEvents().length > 0);
    expect(answeredEvents()[0]).toMatchObject({ questionId: ev.questionId, reason: 'timed_out' });
    // A late answer from a phone finds nothing to answer.
    const ack = await answer(ev, [{ questionIndex: 0, optionIndexes: [0] }]);
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_question' });
  }, 30_000);

  it('a question answered in the terminal is reported as answeredElsewhere, with nothing written', async () => {
    const ev = await startAsk('ask me something');
    // What the transcript of a terminal answer looks like on the wire: the tool_result for the
    // AskUserQuestion tool_use arrives without Pagr ever writing a control response.
    const blocks = [
      { type: 'tool_result', toolUseId: ev.providerRequestId, content: 'answered', isError: false },
    ];
    (
      adapter as unknown as {
        noteExternalAnswers: (r: { type: 'user_blocks'; blocks: typeof blocks }) => void;
      }
    ).noteExternalAnswers({ type: 'user_blocks', blocks: blocks as never });
    await until(() => answeredEvents().length > 0);
    expect(answeredEvents()[0]).toEqual({
      questionId: ev.questionId,
      answeredElsewhere: true,
      reason: 'answered_elsewhere',
    });
    expect(controlLines()).toEqual([]);
  }, 30_000);
});
