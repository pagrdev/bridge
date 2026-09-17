import { describe, expect, it, vi } from 'vitest';
import type { FrameQuestion } from './frames.js';
import {
  askUserQuestionUpdatedInput,
  MAX_QUESTION_FREE_TEXT,
  PendingQuestionRegistry,
  type QuestionAnswer,
  type QuestionOutcome,
  type QuestionResolution,
  type QuestionSource,
  questionBodyFor,
} from './questions.js';
import { ids } from './testFixtures.js';

const CLAUDE_INPUT = {
  questions: [
    {
      question: 'Do you prefer option A or option B?',
      header: 'Preference',
      multiSelect: false,
      options: [
        { label: 'Option A', description: 'Choose option A' },
        { label: 'Option B', description: 'Choose option B', preview: 'b.ts +3 -1' },
      ],
    },
  ],
};

const questionsOf = (input: unknown): FrameQuestion[] => questionBodyFor(input).questions;

interface Resolved {
  resolution: QuestionResolution;
  answers: QuestionAnswer[] | null;
  source: QuestionSource;
  outcome: QuestionOutcome;
}

function make(
  over: Partial<{ questions: FrameQuestion[]; answerable: boolean; reason: string }> = {},
) {
  const resolved: Resolved[] = [];
  const registry = new PendingQuestionRegistry();
  const record = registry.register(
    {
      sessionId: ids.ses(),
      projectId: ids.proj(),
      provider: 'claude',
      providerRequestId: 'toolu_01',
      questions: over.questions ?? questionsOf(CLAUDE_INPUT),
      answerable: over.answerable ?? true,
      ...(over.reason ? { reason: over.reason } : {}),
      onResolve: (resolution, answers, source, outcome) => {
        resolved.push({ resolution, answers, source, outcome });
      },
    },
    60_000,
  );
  return { registry, record, resolved };
}

describe('PendingQuestionRegistry', () => {
  it('registers a qst_ id and derives the layout the phone needs from the questions', () => {
    const { registry, record } = make();
    expect(record.questionId).toMatch(/^qst_[0-9a-f]{32}$/);
    expect(record.multiSelect).toEqual([false]);
    expect(record.optionCount).toEqual([2]);
    expect(record.secret).toEqual([false]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(record.questionId)).toEqual(record);
    expect(registry.findByRequest(record.sessionId, 'toolu_01')).toEqual(record);
    expect(registry.findByRequest(ids.ses(), 'toolu_01')).toBeNull();
  });

  it('is single use: a second answer finds nothing', async () => {
    const { registry, record, resolved } = make();
    const answers = [{ questionIndex: 0, optionIndexes: [1] }];
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_01',
        answers,
      }),
    ).toEqual({ ok: true });
    expect(resolved).toEqual([
      { resolution: 'answered', answers, source: 'cloud', outcome: { answeredElsewhere: false } },
    ]);
    expect(registry.list()).toEqual([]);
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_01',
        answers,
      }),
    ).toEqual({ ok: false, error: 'unknown' });
  });

  it('refuses an answer bound to another session or another provider request', async () => {
    const { registry, record } = make();
    const answers = [{ questionIndex: 0, optionIndexes: [0] }];
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: ids.ses(),
        providerRequestId: 'toolu_01',
        answers,
      }),
    ).toEqual({ ok: false, error: 'session_mismatch' });
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_zz',
        answers,
      }),
    ).toEqual({ ok: false, error: 'request_mismatch' });
    // Neither attempt consumed it.
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses every answer that does not fit the prompt it claims to answer', async () => {
    const { registry, record } = make({
      questions: questionsOf({
        questions: [
          { question: 'one?', header: 'One', multiSelect: false, options: [{ label: 'a' }] },
          {
            question: 'two?',
            header: 'Two',
            multiSelect: true,
            options: [{ label: 'x' }, { label: 'y' }],
          },
        ],
      }),
    });
    const bad = async (answers: QuestionAnswer[]) =>
      registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_01',
        answers,
      });

    expect(await bad([{ questionIndex: 9, optionIndexes: [0] }])).toMatchObject({
      ok: false,
      error: 'invalid_answer',
      message: /questionIndex 9 is out of range/,
    });
    expect(await bad([{ questionIndex: 0, optionIndexes: [7] }])).toMatchObject({
      message: /optionIndex 7 is out of range/,
    });
    expect(await bad([{ questionIndex: 1, optionIndexes: [0, 0] }])).toMatchObject({
      message: /same option twice/,
    });
    // Question 0 is single-select; two options is not an answer it could ever have produced.
    expect(await bad([{ questionIndex: 0, optionIndexes: [0, 0] }])).toMatchObject({
      message: /same option twice/,
    });
    expect(await bad([{ questionIndex: 0, optionIndexes: [] }])).toMatchObject({
      message: /has no answer/,
    });
    expect(await bad([])).toMatchObject({ message: 'no answers' });
    expect(
      await bad([
        { questionIndex: 0, optionIndexes: [0] },
        { questionIndex: 0, optionIndexes: [0] },
      ]),
    ).toMatchObject({ message: /answered twice/ });
    expect(
      await bad([{ questionIndex: 0, optionIndexes: [], freeText: 'x'.repeat(2001) }]),
    ).toMatchObject({ message: /longer than 2000/ });
    // Multi-select really does take two.
    expect(await bad([{ questionIndex: 1, optionIndexes: [0, 1] }])).toEqual({ ok: true });
  });

  it('single-select refuses two options', async () => {
    const { registry, record } = make({
      questions: questionsOf({
        questions: [
          {
            question: 'one?',
            header: 'One',
            multiSelect: false,
            options: [{ label: 'a' }, { label: 'b' }],
          },
        ],
      }),
    });
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_01',
        answers: [{ questionIndex: 0, optionIndexes: [0, 1] }],
      }),
    ).toMatchObject({ error: 'invalid_answer', message: /single-select/ });
  });

  it('a question only the Mac can answer is never answered from here', async () => {
    const { registry, record, resolved } = make({ answerable: false, reason: 'terminal_dialog' });
    expect(record.reason).toBe('terminal_dialog');
    expect(
      await registry.answer({
        questionId: record.questionId,
        sessionId: record.sessionId,
        providerRequestId: 'toolu_01',
        answers: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    ).toMatchObject({ error: 'not_answerable' });
    expect(resolved).toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });

  it('times out on the sooner of the policy timeout and the provider deadline', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-09-17T12:00:00.000Z');
      vi.setSystemTime(now);
      const resolved: Resolved[] = [];
      const timedOut: string[] = [];
      const registry = new PendingQuestionRegistry({
        now: () => now,
        onTimeout: (r) => timedOut.push(r.questionId),
      });
      const record = registry.register(
        {
          sessionId: ids.ses(),
          projectId: ids.proj(),
          provider: 'claude',
          providerRequestId: 'toolu_01',
          questions: questionsOf(CLAUDE_INPUT),
          answerable: true,
          expiresAt: new Date(now.getTime() + 5_000).toISOString(),
          onResolve: (resolution, answers, source, outcome) => {
            resolved.push({ resolution, answers, source, outcome });
          },
        },
        600_000,
      );
      expect(record.expiresAt).toBe('2026-09-17T12:00:05.000Z');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(timedOut).toEqual([record.questionId]);
      expect(resolved).toEqual([
        {
          resolution: 'timed_out',
          answers: null,
          source: 'timeout',
          outcome: { answeredElsewhere: false, reason: 'timed_out' },
        },
      ]);
      expect(registry.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an answer given in the terminal as answeredElsewhere, and relays nothing', async () => {
    const { registry, record, resolved } = make();
    expect(await registry.resolveExternally(record.questionId, 'terminal')).toBe(true);
    expect(resolved).toEqual([
      {
        resolution: 'answered',
        answers: null,
        source: 'terminal',
        outcome: { answeredElsewhere: true, reason: 'answered_elsewhere' },
      },
    ]);
    expect(await registry.resolveExternally(record.questionId, 'terminal')).toBe(false);
  });

  it('the provider withdrawing it, and shutdown, both consume it once', async () => {
    const a = make();
    expect(await a.registry.resolveLocally(a.record.questionId, 'canceled', 'canceled')).toBe(true);
    expect(a.resolved[0]).toMatchObject({ resolution: 'canceled', source: 'provider' });

    const b = make();
    await b.registry.cancelAll();
    expect(b.resolved[0]).toMatchObject({
      resolution: 'canceled',
      source: 'shutdown',
      outcome: { answeredElsewhere: false, reason: 'shutdown' },
    });
    expect(b.registry.list()).toEqual([]);
  });

  it('counts the pending set through onChange, once per change', () => {
    const counts: number[] = [];
    const registry = new PendingQuestionRegistry({
      onChange: () => counts.push(registry.list().length),
    });
    const record = registry.register(
      {
        sessionId: ids.ses(),
        projectId: ids.proj(),
        provider: 'claude',
        providerRequestId: 'toolu_01',
        questions: questionsOf(CLAUDE_INPUT),
        answerable: true,
        onResolve: () => {},
      },
      60_000,
    );
    return registry.resolveLocally(record.questionId).then(() => {
      expect(counts).toEqual([1, 0]);
    });
  });
});

describe('questionBodyFor', () => {
  it("keeps Claude's shape, including an option preview", () => {
    expect(questionBodyFor(CLAUDE_INPUT)).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Do you prefer option A or option B?',
          header: 'Preference',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'Choose option A' },
            { label: 'Option B', description: 'Choose option B', preview: 'b.ts +3 -1' },
          ],
        },
      ],
    });
  });

  it("reads Codex's per-question ids and no multi-select", () => {
    expect(
      questionBodyFor({
        questions: [
          {
            id: 'q1',
            question: 'Which environment?',
            header: 'Deploy target',
            isSecret: false,
            options: [{ label: 'staging', description: 'safe' }],
          },
        ],
      }),
    ).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Which environment?',
          header: 'Deploy target',
          multiSelect: false,
          options: [{ label: 'staging', description: 'safe' }],
        },
      ],
    });
  });

  it('drops anything that is not a question rather than inventing one', () => {
    expect(questionBodyFor({ questions: [null, 7, {}, { header: 'no text' }] })).toEqual({
      kind: 'question',
      questions: [],
    });
    expect(questionBodyFor(undefined)).toEqual({ kind: 'question', questions: [] });
    expect(questionBodyFor({ questions: 'nope' })).toEqual({ kind: 'question', questions: [] });
    // An option with no label is not an option; a question with none is still a question.
    expect(
      questionBodyFor({ questions: [{ question: 'q?', options: [{ description: 'x' }] }] }),
    ).toEqual({
      kind: 'question',
      questions: [{ question: 'q?', header: '', multiSelect: false, options: [] }],
    });
  });
});

describe('askUserQuestionUpdatedInput', () => {
  const questions = questionsOf(CLAUDE_INPUT);

  it('keys answers by the full question text and passes the questions back verbatim', () => {
    expect(
      askUserQuestionUpdatedInput(CLAUDE_INPUT, questions, [
        { questionIndex: 0, optionIndexes: [1] },
      ]),
    ).toEqual({
      questions: CLAUDE_INPUT.questions,
      answers: { 'Do you prefer option A or option B?': 'Option B' },
    });
  });

  it('joins a multi-select answer with ", " (spec-derived: the Agent SDK docs, not the spike)', () => {
    const multi = questionsOf({
      questions: [
        {
          question: 'Which checks should run?',
          header: 'Checks',
          multiSelect: true,
          options: [{ label: 'lint' }, { label: 'typecheck' }, { label: 'test' }],
        },
      ],
    });
    expect(
      askUserQuestionUpdatedInput({ questions: [] }, multi, [
        { questionIndex: 0, optionIndexes: [0, 2] },
      ]),
    ).toMatchObject({ answers: { 'Which checks should run?': 'lint, test' } });
  });

  it('puts free text in `response`, capped, and leaves `answers` present but empty', () => {
    expect(
      askUserQuestionUpdatedInput(CLAUDE_INPUT, questions, [
        { questionIndex: 0, optionIndexes: [], freeText: '  A please, and stop after that  ' },
      ]),
    ).toEqual({
      questions: CLAUDE_INPUT.questions,
      answers: {},
      response: 'A please, and stop after that',
    });
    const long = askUserQuestionUpdatedInput(CLAUDE_INPUT, questions, [
      { questionIndex: 0, optionIndexes: [], freeText: 'x'.repeat(MAX_QUESTION_FREE_TEXT + 500) },
    ]);
    expect((long.response as string).length).toBe(MAX_QUESTION_FREE_TEXT);
  });

  it('resolves indexes against the retained questions and never against anything sent to it', () => {
    // An index the prompt never had contributes nothing: no key, no invented label.
    expect(
      askUserQuestionUpdatedInput(CLAUDE_INPUT, questions, [
        { questionIndex: 5, optionIndexes: [0] },
      ]),
    ).toEqual({ questions: CLAUDE_INPUT.questions, answers: {} });
  });
});
