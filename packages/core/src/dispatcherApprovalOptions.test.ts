import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { AdapterEvent, CodingAgentAdapter } from './adapters/types.js';
import { ALLOW_ALWAYS_ENV } from './approvalOptions.js';
import { sha256Hex } from './approvals.js';
import { DEVICE_FLOOR_ENV, DEVICE_FLOOR_HOSTS_ENV } from './deviceFloor.js';
import { Dispatcher } from './dispatcher.js';
import { decodeFrameBody } from './frames.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

type RelayedCall = { approvalId: string; providerRequestId: string; decision: string };

/**
 * MOB-035. Approval options v2: what the phone is offered, what the agent is actually told, and
 * what `approval.applied` reports back. The v1 shape — `decision` alone — has to keep behaving
 * byte for byte as it did, which is what the older dispatcher tests pin down.
 */
describe('approval options v2', () => {
  const t = useTempHome('pagr-approval-opts-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();
  let codex: FakeAdapter;
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let events: DeviceEvent[];
  let projectId: string;
  let projectPath: string;
  let home: string;
  let protocolVersion: number;
  const now = new Date('2026-09-17T12:00:00.000Z');

  beforeEach(() => {
    codex = new FakeAdapter('codex');
    home = join(t.home, 'home');
    projectPath = join(home, 'repo');
    mkdirSync(join(projectPath, '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(projectPath).projectId;
    sessions = new SessionStore();
    events = [];
    protocolVersion = 1;
  });

  const dispatcher = (env: NodeJS.ProcessEnv = {}, opts: { frames?: boolean } = {}): Dispatcher => {
    const journalDir = join(t.home, `journal-${Math.random().toString(16).slice(2)}`);
    return new Dispatcher({
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
      policyFile: join(t.home, `policy-${Math.random().toString(16).slice(2)}.json`),
      devicePolicyFile: join(t.home, `device-policy-${Math.random().toString(16).slice(2)}.json`),
      env,
      now: () => now,
      ...(opts.frames
        ? {
            frames: {
              journal: new JournalStore({ dir: journalDir, now: () => now }),
              cursors: new OutboxCursors({ file: join(journalDir, 'outbox.json'), writeDelayMs: 0 }),
              recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
              protocolVersion: () => protocolVersion,
            },
          }
        : {}),
    });
  };

  const body = <T extends Parameters<typeof makeBody>[0]>(
    type: T,
    payload: Parameters<typeof makeBody<T>>[1],
  ) => makeBody(type, payload, { deviceId, now });
  const ofType = (type: DeviceEvent['type']) => events.filter((e) => e.type === type);
  const relayed = () =>
    codex.calls.filter((c) => c.method === 'respondToApproval').map((c) => c.args) as RelayedCall[];

  const OPTIONS: NonNullable<Extract<AdapterEvent, { kind: 'approval_requested' }>['options']> = [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
    { optionId: 'allow_session', kind: 'allow_session', label: 'Allow for this session' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
  ];

  /** Start a session, then have the provider raise a prompt for `command` with `options`. */
  const raise = async (
    d: Dispatcher,
    command: string,
    over: Partial<Extract<AdapterEvent, { kind: 'approval_requested' }>> = {},
  ) => {
    const sessionId = ids.ses();
    const approvalId = ids.apr();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: `run: ${command}`,
        sessionId,
        attachments: [],
        readOnly: false,
      }),
    );
    const preview = `$ ${command}`;
    codex.push({
      kind: 'approval_requested',
      approvalId,
      sessionId,
      projectId,
      providerRequestId: 'req-1',
      actionType: 'command_execution',
      preview,
      hints: {},
      local: { toolName: 'shell', command, cwd: projectPath, projectPath },
      options: OPTIONS,
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      ...over,
    });
    await vi.waitFor(() => expect(ofType('approval.requested').length).toBeGreaterThan(0));
    return { sessionId, approvalId, previewHash: sha256Hex(preview) };
  };

  const answer = (
    d: Dispatcher,
    r: { sessionId: string; approvalId: string; previewHash: string },
    decision: 'allow' | 'deny',
    optionId?: string,
  ) =>
    d.handle(
      body('agent.respond_to_approval', {
        approvalId: r.approvalId,
        sessionId: r.sessionId,
        providerRequestId: 'req-1',
        previewHash: r.previewHash,
        decision,
        ...(optionId ? { optionId } : {}),
      }),
    );

  const applied = () =>
    ofType('approval.applied').map((e) => e.payload as EventPayload<'approval.applied'>);

  it('publishes the agent’s options on approval.requested, in the agent’s order', async () => {
    const d = dispatcher();
    await raise(d, 'ls');
    const payload = ofType('approval.requested')[0]?.payload as EventPayload<'approval.requested'>;
    expect(payload.options).toEqual(OPTIONS);
    // v1 fields are untouched: the preview still travels in the clear to a v1 gateway.
    expect(payload.preview).toBe('$ ls');
    expect(payload.frameSeq).toBeUndefined();
  });

  it('PAGR_ALLOW_ALWAYS=0 strips the persistent option even if an adapter published it', async () => {
    const d = dispatcher({ [ALLOW_ALWAYS_ENV]: '0' });
    const r = await raise(d, 'ls', {
      options: [
        { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
        { optionId: 'allow_always', kind: 'allow_always', label: 'Allow always' },
        { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
      ],
    });
    const payload = ofType('approval.requested')[0]?.payload as EventPayload<'approval.requested'>;
    expect(payload.options?.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    // …and choosing it anyway is refused rather than quietly downgraded to an allow: the option
    // is not one this prompt offered any more.
    const ack = await answer(d, r, 'allow', 'allow_always');
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'invalid_payload' });
    expect(relayed()).toEqual([]);

    // Same answer for a prompt whose adapter published no options at all, where the id would
    // otherwise be taken at face value: the switch is off, so there is no such answer to give.
    const bare = await raise(d, 'ls', { options: [] });
    const ack2 = await answer(d, bare, 'allow', 'allow_always');
    expect(ack2.payload).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });
    expect((ack2.payload as { message: string }).message).toContain(ALLOW_ALWAYS_ENV);
    expect(relayed()).toEqual([]);
  });

  it('relays the chosen option to the adapter and reports it as applied', async () => {
    const d = dispatcher();
    const r = await raise(d, 'ls');
    const ack = await answer(d, r, 'allow', 'allow_session');
    expect(ack.payload).toMatchObject({ status: 'completed' });
    expect(relayed()).toEqual([
      {
        approvalId: r.approvalId,
        providerRequestId: 'req-1',
        decision: 'allow',
        optionId: 'allow_session',
      },
    ]);
    expect(applied()).toEqual([
      {
        approvalId: r.approvalId,
        sessionId: r.sessionId,
        optionId: 'allow_session',
        applied: true,
        // What the agent was told. Codex's own enum value for it is the adapter's business.
        appliedAs: 'allow',
      },
    ]);
  });

  it('answers a v1 row exactly as before, and still says it was applied', async () => {
    const d = dispatcher();
    const r = await raise(d, 'ls');
    await answer(d, r, 'allow');
    expect(relayed()).toEqual([
      { approvalId: r.approvalId, providerRequestId: 'req-1', decision: 'allow' },
    ]);
    expect(applied()[0]).toMatchObject({ optionId: 'allow_once', applied: true });
  });

  it('refuses an optionId that does not agree with the decision, or that was never offered', async () => {
    const d = dispatcher();
    const mismatch = await raise(d, 'ls');
    const ack = await answer(d, mismatch, 'deny', 'allow_session');
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'invalid_payload' });
    expect((ack.payload as { message: string }).message).toContain('does not agree');
    // Nothing was relayed and the prompt is still answerable: a malformed command is not an answer.
    expect(relayed()).toEqual([]);
    expect(d.approvals.get(mismatch.approvalId)).not.toBeNull();
    expect(applied()).toEqual([]);

    const unknown = await answer(d, mismatch, 'allow', 'allow_always');
    expect(unknown.payload).toMatchObject({ status: 'failed', errorCode: 'invalid_payload' });
    expect((unknown.payload as { message: string }).message).toContain('not an option');

    // The same prompt still answers normally afterwards.
    expect((await answer(d, mismatch, 'allow', 'allow_once')).payload).toMatchObject({
      status: 'completed',
    });
  });

  it('reports approval.applied {applied:false} when the agent could not be told', async () => {
    const d = dispatcher();
    const r = await raise(d, 'ls');
    codex.failNext = new Error('app server went away');
    const ack = await answer(d, r, 'allow', 'allow_once');
    expect(ack.payload).toMatchObject({ status: 'failed' });
    expect(applied()).toEqual([
      {
        approvalId: r.approvalId,
        sessionId: r.sessionId,
        optionId: 'allow_once',
        applied: false,
        error: 'app server went away',
      },
    ]);
    // The phone is not left thinking the agent was told: no "resolved" claim was made.
    expect(ofType('approval.resolved_locally')).toHaveLength(0);
  });

  it('seals the preview into its own frame on v2 and points approval.requested at it', async () => {
    protocolVersion = 2;
    const d = dispatcher({}, { frames: true });
    const r = await raise(d, 'ls');
    const payload = ofType('approval.requested')[0]?.payload as EventPayload<'approval.requested'>;
    expect(payload.frameSeq).toBe(1);
    // The words are gone from the plaintext event; only the previewHash binds the answer.
    expect(payload.preview).toBe('');
    expect(payload.previewHash).toBe(r.previewHash);

    const frame = ofType('session.frame')[0]?.payload as EventPayload<'session.frame'>;
    expect(frame).toMatchObject({ sessionId: r.sessionId, seq: 1, kind: 'approval_preview' });
    const opened = openFrame(
      frame.sealed,
      sealAadFor({ sessionId: r.sessionId, seq: 1, kind: 'approval_preview' }),
      phone.privateKeyRaw,
    );
    expect(decodeFrameBody(opened)).toEqual({ kind: 'approval_preview', preview: '$ ls' });
  });

  it('keeps sending the plaintext preview to a v1 gateway', async () => {
    protocolVersion = 1;
    const d = dispatcher({}, { frames: true });
    await raise(d, 'ls');
    const payload = ofType('approval.requested')[0]?.payload as EventPayload<'approval.requested'>;
    expect(payload.preview).toBe('$ ls');
    expect(payload.frameSeq).toBeUndefined();
    expect(ofType('session.frame')).toHaveLength(0);
  });

  describe('the floor and persistent grants', () => {
    it('refuses allow_session for a floored class the host list only lifted per action', async () => {
      const d = dispatcher({ [DEVICE_FLOOR_HOSTS_ENV]: 'api.example.com' });
      const r = await raise(d, 'curl https://api.example.com/v1');

      // Once is fine: the host is on this Mac's list, and the list is about this one action.
      const persistent = await answer(d, r, 'allow', 'allow_session');
      expect(persistent.payload).toMatchObject({
        status: 'failed',
        errorCode: 'capability_unsupported',
      });
      const message = (persistent.payload as { message: string }).message;
      expect(message).toContain('reach a host over the network');
      expect(message).toContain('host allow-list does not lift it');

      // The agent was told deny — never the allow the phone asked for.
      expect(relayed()).toEqual([
        { approvalId: r.approvalId, providerRequestId: 'req-1', decision: 'deny' },
      ]);
      expect(ofType('approval.resolved_locally')[0]?.payload).toMatchObject({
        approvalId: r.approvalId,
        resolution: 'denied',
      });
      expect(applied()).toEqual([
        {
          approvalId: r.approvalId,
          sessionId: r.sessionId,
          optionId: 'allow_session',
          applied: false,
          appliedAs: 'deny',
          error: message,
        },
      ]);
      // …and the person can see why on their phone, not only in the daemon log.
      expect(
        ofType('session.event').find((e) => (e.payload as { kind: string }).kind === 'needs_input'),
      ).toBeDefined();
    });

    it('lets the same action through once, with the same host list', async () => {
      const d = dispatcher({ [DEVICE_FLOOR_HOSTS_ENV]: 'api.example.com' });
      const r = await raise(d, 'curl https://api.example.com/v1');
      expect((await answer(d, r, 'allow', 'allow_once')).payload).toMatchObject({
        status: 'completed',
      });
      expect(relayed().at(-1)).toMatchObject({ decision: 'allow', optionId: 'allow_once' });
    });

    it('carries a persistent grant once the class itself is lifted by hand', async () => {
      const d = dispatcher({
        [DEVICE_FLOOR_ENV]: 'network',
        [DEVICE_FLOOR_HOSTS_ENV]: 'api.example.com',
      });
      const r = await raise(d, 'curl https://api.example.com/v1');
      expect((await answer(d, r, 'allow', 'allow_session')).payload).toMatchObject({
        status: 'completed',
      });
      expect(relayed().at(-1)).toMatchObject({ decision: 'allow', optionId: 'allow_session' });
      expect(applied()[0]).toMatchObject({ applied: true, appliedAs: 'allow' });
    });
  });

  it('reports an approval somebody answered in the terminal as answeredElsewhere', async () => {
    const d = dispatcher();
    const r = await raise(d, 'ls');
    codex.push({
      kind: 'approval_resolved_locally',
      approvalId: r.approvalId,
      resolution: 'allowed',
      source: 'terminal',
      answeredElsewhere: true,
    });
    await vi.waitFor(() => expect(ofType('approval.resolved_locally')).toHaveLength(1));
    expect(ofType('approval.resolved_locally')[0]?.payload).toMatchObject({
      approvalId: r.approvalId,
      resolution: 'allowed',
      source: 'terminal',
      answeredElsewhere: true,
    });
    // It was applied — by the person, in their terminal — and never relayed back to the agent.
    expect(applied()[0]).toMatchObject({ approvalId: r.approvalId, applied: true });
    expect(relayed()).toEqual([]);
    expect(d.approvals.get(r.approvalId)).toBeNull();
  });

  it('resolveExternally is what the transcript tailer calls, and it consumes the entry once', async () => {
    const d = dispatcher();
    const r = await raise(d, 'ls');
    expect(await d.approvals.resolveExternally(r.approvalId, 'terminal')).toBe(true);
    expect(await d.approvals.resolveExternally(r.approvalId, 'terminal')).toBe(false);
    expect(ofType('approval.resolved_locally')[0]?.payload).toMatchObject({
      resolution: 'allowed',
      source: 'terminal',
      answeredElsewhere: true,
    });
    expect(relayed()).toEqual([]);
  });
});
