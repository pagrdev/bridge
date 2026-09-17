import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { Dispatcher, IMESSAGE_CLIP } from './dispatcher.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

/**
 * The plaintext `imessage` field.
 *
 * Everything else a v2 bridge sends about a session's CONTENT is sealed for the user's phones.
 * This one field is not, by design: it is the line the iMessage thread shows, and iMessage is
 * plaintext by nature. So the rule it has to obey is narrow and absolute — it exists only when
 * the account actually has a thread linked, it is re-read on every event so that linking or
 * unlinking takes effect mid-connection, and nothing composes one speculatively.
 */
describe('iMessage summaries', () => {
  const t = useTempHome('pagr-imessage-');
  const deviceId = ids.dev();
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let events: DeviceEvent[];
  let home: string;
  let projectId: string;
  let claude: FakeAdapter;
  let linked: boolean;
  let d: Dispatcher;
  const sessionId = `ses_${'7'.repeat(32)}`;

  const frames = () =>
    events
      .filter((e) => e.type === 'session.frame')
      .map((e) => e.payload as EventPayload<'session.frame'>)
      // The approval preview travels as its own frame; these tests are about the assistant's own
      // words, so the two are kept apart rather than read off the tail of one list.
      .filter((f) => f.kind === 'assistant');
  const approvals = () =>
    events
      .filter((e) => e.type === 'approval.requested')
      .map((e) => e.payload as EventPayload<'approval.requested'>);
  const questions = () =>
    events
      .filter((e) => e.type === 'question.asked')
      .map((e) => e.payload as EventPayload<'question.asked'>);

  const assistant = (text: string, endsTurn: boolean) =>
    d.emitFrame(
      sessionId,
      { kind: 'assistant', text },
      {
        projectId,
        provider: 'claude',
        meta: { source: 'stdio' },
        providerRecordId: `rec-${events.length}`,
        ...(endsTurn ? { endsTurn: true } : {}),
      },
    );

  const askApproval = () =>
    d.requestApproval({
      approvalId: ids.apr(),
      sessionId,
      projectId,
      provider: 'claude',
      providerRequestId: `req-${events.length}`,
      actionType: 'command_execution',
      preview: '$ pnpm test',
      hints: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      onDecision: () => {},
    });

  const askQuestion = () =>
    d.requestQuestion({
      sessionId,
      projectId,
      provider: 'claude',
      providerRequestId: `q-${events.length}`,
      questions: [
        {
          question: 'Which database should this use?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        },
      ],
      answerable: true,
      secret: [false],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      onAnswer: () => {},
    });

  beforeEach(() => {
    events = [];
    linked = false;
    home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    sessions = new SessionStore();
    claude = new FakeAdapter('claude');
    const phone = generateRecipientKeyPair();
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
      bridgeVersion: '0.2.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      osVersion: '25.0.0',
      env: {},
      frames: {
        journal: new JournalStore({ dir: join(home, '.pagr', 'journal') }),
        cursors: new OutboxCursors({ file: join(home, '.pagr', 'journal', 'outbox.json') }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
        // Read on every single event, never captured: that is what makes the flip below work.
        imessageLinked: () => linked,
      },
    });
  });

  describe('with no iMessage thread linked', () => {
    it('sends no plaintext line anywhere', () => {
      assistant('All done — the tests pass.', true);
      askApproval();
      askQuestion();
      expect(frames().every((f) => f.imessage === undefined)).toBe(true);
      expect(approvals()[0]?.imessage).toBeUndefined();
      expect(questions()[0]?.imessage).toBeUndefined();
    });
  });

  describe('with a thread linked', () => {
    beforeEach(() => {
      linked = true;
    });

    it('puts the agent’s final message on the frame that ends the turn', () => {
      assistant('Reading the config…', false);
      assistant('All done — the tests pass.', true);
      const [mid, last] = frames();
      // A message the agent sent on its way through the turn is not the answer, and one line per
      // paragraph would be one iMessage per paragraph.
      expect(mid?.imessage).toBeUndefined();
      expect(last?.imessage).toBe('All done — the tests pass.');
    });

    it('clips a long final message to the iMessage budget', () => {
      assistant('x'.repeat(2000), true);
      const line = frames().at(-1)?.imessage ?? '';
      expect(line).toHaveLength(IMESSAGE_CLIP);
      expect(line.endsWith('…')).toBe(true);
    });

    it('sends nothing for an empty or whitespace-only final message', () => {
      assistant('   \n  ', true);
      expect(frames().at(-1)?.imessage).toBeUndefined();
    });

    it('names the agent on an approval, and carries the same one-liner the thread always had', () => {
      askApproval();
      expect(approvals()[0]?.imessage).toBe('Claude: $ pnpm test');
    });

    it('says who asked and what, on a question', () => {
      askQuestion();
      // The header, not the whole question: the thread is a nudge to open the app, and the
      // options are never included because answering happens where they are legible.
      expect(questions()[0]?.imessage).toBe('Claude asked: Database');
    });
  });

  it('follows a runtime flip in both directions (settings.updated)', () => {
    assistant('Before linking.', true);
    expect(frames().at(-1)?.imessage).toBeUndefined();

    linked = true;
    assistant('After linking.', true);
    askApproval();
    expect(frames().at(-1)?.imessage).toBe('After linking.');
    expect(approvals().at(-1)?.imessage).toBe('Claude: $ pnpm test');

    // Unlinking is the direction that matters for privacy: the very next event must stop
    // carrying plaintext, without a reconnect.
    linked = false;
    assistant('After unlinking.', true);
    askApproval();
    askQuestion();
    expect(frames().at(-1)?.imessage).toBeUndefined();
    expect(approvals().at(-1)?.imessage).toBeUndefined();
    expect(questions().at(-1)?.imessage).toBeUndefined();
  });
});
