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
import { CodexAdapter } from './adapter.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const hex32 = () => randomBytes(16).toString('hex');
const SES = `ses_${hex32()}`;

const until = async (pred: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * MOB-036 for Codex: `item/tool/requestUserInput` all the way to `question.asked`, answered with
 * the same `agent.answer_question` command the Claude path takes, and written back to the
 * app-server by option index.
 */
describe('Codex questions through the dispatcher', () => {
  const phone = generateRecipientKeyPair();
  let home: string;
  let project: string;
  let adapter: CodexAdapter;
  let dispatcher: Dispatcher;
  let events: DeviceEvent[];
  let projectId: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-q-')));
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-proj-q-')));
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    events = [];
    adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      codexHome: path.join(home, 'codex-home'),
      attachDaemon: false,
      log: false,
    });
    const registry = new ProjectRegistry({ home, pagrHome: path.join(home, '.pagr') });
    projectId = registry.add(project).projectId;
    const journalDir = path.join(home, 'journal');
    dispatcher = new Dispatcher({
      deviceId: `dev_${hex32()}`,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['codex', adapter as unknown as CodingAgentAdapter],
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
  });
  afterEach(async () => {
    await dispatcher.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const ofType = (type: DeviceEvent['type']) => events.filter((e) => e.type === type);
  const asked = () => ofType('question.asked')[0]?.payload as EventPayload<'question.asked'>;

  it('relays requestUserInput as a sealed question and answers it by index', async () => {
    await adapter.startSession({
      sessionId: SES,
      project: { projectId, path: project, displayName: 'demo' },
      instruction: 'ask me something',
      localImagePaths: [],
      readOnly: false,
    });
    await until(() => asked() !== undefined);
    const ev = asked();
    expect(ev.meta).toMatchObject({
      answerable: true,
      multiSelect: [false, false],
      optionCount: [2, 0],
      // The fake's second question is a secret (a deploy token), and that travels in the clear
      // as a flag so the phone can mask the field before it has decrypted anything.
      secret: [false, true],
    });

    // Exactly one `question` frame, even though the adapter emits its own for the item stream.
    const questionFrames = ofType('session.frame')
      .map((e) => e.payload as EventPayload<'session.frame'>)
      .filter((p) => p.kind === 'question');
    expect(questionFrames).toHaveLength(1);
    expect(questionFrames[0]?.seq).toBe(ev.seq);
    const sealed = questionFrames[0]?.sealed;
    if (!sealed) throw new Error('no question frame');
    const body = decodeFrameBody(
      openFrame(sealed, sealAadFor(sealed.aad), phone.privateKeyRaw),
    ) as { kind: 'question'; questions: Array<{ header: string }> };
    expect(body.questions[0]?.header).toBe('Deploy target');

    const ack = await dispatcher.handle({
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
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, optionIndexes: [], freeText: 'sk-secret' },
        ],
      },
    } as never);
    expect(ack.payload).toMatchObject({ status: 'completed' });
    expect(ofType('question.answered')[0]?.payload).toEqual({ questionId: ev.questionId });

    // The agent got the labels it wrote itself, plus the typed answer for the free-text question.
    await until(() =>
      ofType('session.event').some((e) => {
        const p = e.payload as EventPayload<'session.event'>;
        return p.kind === 'agent_message' && p.summary.includes('Answered');
      }),
    );
    const message = ofType('session.event')
      .map((e) => e.payload as EventPayload<'session.event'>)
      .find((p) => p.kind === 'agent_message' && p.summary.includes('Answered'));
    expect(message?.summary).toContain('production');
    expect(message?.summary).toContain('sk-secret');
  }, 30_000);
});
