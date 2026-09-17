import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CodingAgentAdapter } from './adapters/types.js';
import { Dispatcher } from './dispatcher.js';
import { decodeFrameBody, type FrameBody, joinFrameParts } from './frames.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

type FramePayload = EventPayload<'session.frame'>;

const framePayloads = (events: DeviceEvent[]): FramePayload[] =>
  events.filter((e) => e.type === 'session.frame').map((e) => e.payload as FramePayload);

describe('Dispatcher.emitFrame', () => {
  const t = useTempHome('pagr-frames-');
  const deviceId = ids.dev();
  const sessionId = ids.ses();
  const phone = generateRecipientKeyPair();

  let events: DeviceEvent[];
  let journal: JournalStore;
  let cursors: OutboxCursors;
  let projectId: string;
  let recipientKeys: Record<string, string>;
  let protocolVersion: number;
  let now: Date;
  let d: Dispatcher;

  const journalDir = () => join(t.home, 'pagr', 'journal');

  beforeEach(() => {
    now = new Date('2026-09-17T12:00:00.000Z');
    events = [];
    recipientKeys = { [phone.kid]: phone.publicKeyB64u };
    protocolVersion = 2;
    const home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    journal = new JournalStore({ dir: journalDir(), now: () => now });
    cursors = new OutboxCursors({ file: join(journalDir(), 'outbox.json'), writeDelayMs: 0 });
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions: new SessionStore(),
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      frames: {
        journal,
        cursors,
        recipientKeys: () => recipientKeys,
        protocolVersion: () => protocolVersion,
      },
    });
  });

  const emit = (body: FrameBody, over: { providerRecordId?: string } = {}) =>
    d.emitFrame(sessionId, body, {
      projectId,
      provider: 'claude',
      meta: { source: 'stdio' },
      ...over,
    });

  const journalLines = (): unknown[] =>
    readFileSync(join(journalDir(), `${sessionId}.log`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it('journals the frame, then sends a sealed copy only the phone can open', () => {
    const body: FrameBody = { kind: 'assistant', text: 'done — two files changed' };
    expect(emit(body)).toEqual({ seq: 1, emitted: true });

    const [payload] = framePayloads(events);
    expect(payload).toMatchObject({
      sessionId,
      projectId,
      provider: 'claude',
      seq: 1,
      kind: 'assistant',
      at: now.toISOString(),
    });
    expect(payload?.meta).toMatchObject({ source: 'stdio', truncated: false });
    expect(payload?.meta.bytes).toBeGreaterThan(0);
    // The words are nowhere in the event: only the phone's key opens them.
    expect(JSON.stringify(payload)).not.toContain('two files changed');
    expect(payload?.sealed.aad).toEqual({ sessionId, seq: 1, kind: 'assistant' });
    const opened = openFrame(
      payload?.sealed as NonNullable<typeof payload>['sealed'],
      sealAadFor({ sessionId, seq: 1, kind: 'assistant' }),
      phone.privateKeyRaw,
    );
    expect(decodeFrameBody(opened)).toEqual(body);

    // …and the plaintext is on this Mac, where a backfill can still find it.
    expect(journalLines()).toHaveLength(1);
    expect(journalLines()[0]).toMatchObject({ seq: 1, kind: 'assistant', body });
    expect(cursors.get(sessionId)).toEqual({ sent: 1, acked: 0 });
  });

  it('numbers frames monotonically, never reusing a seq for a duplicate record', () => {
    expect(emit({ kind: 'assistant', text: 'a' }, { providerRecordId: 'rec-1' })).toMatchObject({
      seq: 1,
      emitted: true,
    });
    expect(emit({ kind: 'assistant', text: 'b' })).toMatchObject({ seq: 2, emitted: true });
    expect(emit({ kind: 'assistant', text: 'a' }, { providerRecordId: 'rec-1' })).toEqual({
      seq: 1,
      emitted: false,
      heldBack: 'duplicate',
    });
    expect(framePayloads(events).map((p) => p.seq)).toEqual([1, 2]);
    expect(journalLines()).toHaveLength(2);
  });

  it('journals but does not send when the gateway speaks v1', () => {
    protocolVersion = 1;
    expect(emit({ kind: 'assistant', text: 'held back' })).toEqual({
      seq: 1,
      emitted: false,
      heldBack: 'protocol_v1',
    });
    expect(framePayloads(events)).toEqual([]);
    expect(journalLines()).toHaveLength(1);
    // Nothing was sent, so nothing is claimed as sent.
    expect(cursors.get(sessionId)).toEqual({ sent: 0, acked: 0 });
    expect(d.pendingFrames()).toEqual([]);
  });

  it('journals but does not send when no phone key is pinned', () => {
    recipientKeys = {};
    expect(emit({ kind: 'assistant', text: 'nobody can read this' })).toEqual({
      seq: 1,
      emitted: false,
      heldBack: 'no_recipients',
    });
    expect(framePayloads(events)).toEqual([]);
    expect(journalLines()).toHaveLength(1);
  });

  it('refuses a recipient set that does not import, rather than sealing to something wrong', () => {
    recipientKeys = { 'dead:beef:dead:beef': 'not-a-key' };
    expect(emit({ kind: 'assistant', text: 'x' })?.heldBack).toBe('no_recipients');
    expect(framePayloads(events)).toEqual([]);
  });

  it('splits a body over the seal ceiling into chunks that share one seq', () => {
    const body: FrameBody = { kind: 'assistant', text: 'p'.repeat(400 * 1024) };
    expect(emit(body)).toEqual({ seq: 1, emitted: true });

    const payloads = framePayloads(events);
    expect(payloads.length).toBeGreaterThan(1);
    const groups = new Set(payloads.map((p) => p.meta.chunk?.group));
    expect(groups.size).toBe(1);
    expect(payloads.map((p) => p.seq)).toEqual(payloads.map(() => 1));
    expect(payloads.map((p) => p.meta.chunk?.index)).toEqual(payloads.map((_, i) => i));

    const parts = payloads.map((p) => ({
      body: openFrame(p.sealed, sealAadFor(p.sealed.aad), phone.privateKeyRaw),
      ...(p.meta.chunk ? { chunk: p.meta.chunk } : {}),
    }));
    expect(joinFrameParts(parts)).toEqual(body);
    // Every chunk's AAD names its own position, so a relay cannot shuffle them.
    for (const p of payloads) expect(p.sealed.aad.chunk).toEqual(p.meta.chunk);
  });

  it('caps a huge command output for the wire and keeps the whole thing in the journal', () => {
    const stdout = 'L'.repeat(900 * 1024);
    const body: FrameBody = {
      kind: 'terminal',
      command: 'pnpm test',
      stdout,
      stderr: '',
      exitCode: 1,
      interrupted: false,
    };
    emit(body);
    const [payload] = framePayloads(events);
    expect(payload?.meta.truncated).toBe(true);
    expect(payload?.meta.bytes).toBeGreaterThan(900 * 1024);
    const opened = decodeFrameBody(
      openFrame(
        payload?.sealed as NonNullable<typeof payload>['sealed'],
        sealAadFor({ sessionId, seq: 1, kind: 'terminal' }),
        phone.privateKeyRaw,
      ),
    );
    expect(opened.kind).toBe('terminal');
    if (opened.kind === 'terminal') expect(opened.stdout.length).toBeLessThan(stdout.length);
    // The journal still holds every byte.
    expect(journalLines()[0]).toMatchObject({ body: { stdout } });
  });

  it('is a no-op that reports nothing when no journal is wired up', () => {
    const bare = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry: new ProjectRegistry({ home: t.home, pagrHome: join(t.home, '.pagr') }),
      sessions: new SessionStore(),
      emit: (e) => events.push(e),
      tmpDir: join(t.home, 'tmp'),
      bridgeVersion: '0.1.0',
      now: () => now,
    });
    expect(
      bare.emitFrame(
        sessionId,
        { kind: 'assistant', text: 'x' },
        {
          projectId,
          provider: 'claude',
          meta: { source: 'stdio' },
        },
      ),
    ).toBeNull();
    expect(bare.pendingFrames()).toEqual([]);
  });
});

describe('Dispatcher.pendingFrames', () => {
  const t = useTempHome('pagr-resume-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();
  const sessionA = ids.ses();
  const sessionB = ids.ses();

  let journal: JournalStore;
  let cursors: OutboxCursors;
  let d: Dispatcher;
  let projectId: string;
  const now = new Date('2026-09-17T12:00:00.000Z');

  beforeEach(() => {
    const home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    journal = new JournalStore({ dir: join(t.home, 'journal'), now: () => now });
    cursors = new OutboxCursors({ file: join(t.home, 'journal', 'outbox.json'), writeDelayMs: 0 });
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions: new SessionStore(),
      emit: () => {},
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      now: () => now,
      frames: {
        journal,
        cursors,
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });

  const emitInto = (sessionId: string, text: string) =>
    d.emitFrame(
      sessionId,
      { kind: 'assistant', text },
      {
        projectId,
        provider: 'claude',
        meta: { source: 'stdio' },
      },
    );

  it('offers exactly the frames past the acked cursor, in seq order', () => {
    for (const text of ['one', 'two', 'three']) emitInto(sessionA, text);
    emitInto(sessionB, 'b-one');
    cursors.ack({ [sessionA]: 1, [sessionB]: 1 });

    const pending = d.pendingFrames();
    expect(pending.map((p) => [p.sessionId, p.seq])).toEqual([
      [sessionA, 2],
      [sessionA, 3],
    ]);
    expect(pending.every((p) => p.event.type === 'session.frame')).toBe(true);
  });

  it('offers nothing once the gateway has acked everything it was sent', () => {
    emitInto(sessionA, 'one');
    emitInto(sessionA, 'two');
    cursors.ack({ [sessionA]: 2 });
    expect(d.pendingFrames()).toEqual([]);
  });

  it('re-seals on resume, so a phone paired after the outage can still read the backlog', () => {
    emitInto(sessionA, 'said while you were away');
    const [pending] = d.pendingFrames();
    const payload = pending?.event.payload as FramePayload;
    const opened = decodeFrameBody(
      openFrame(payload.sealed, sealAadFor(payload.sealed.aad), phone.privateKeyRaw),
    );
    expect(opened).toEqual({ kind: 'assistant', text: 'said while you were away' });
  });

  it('caps one connection and leaves the rest for the next', () => {
    const capped = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry: new ProjectRegistry({ home: t.home, pagrHome: join(t.home, '.pagr2') }),
      sessions: new SessionStore(),
      emit: () => {},
      tmpDir: join(t.home, 'tmp'),
      bridgeVersion: '0.1.0',
      now: () => now,
      frames: {
        journal,
        cursors,
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
        maxResumeFrames: 2,
      },
    });
    for (const text of ['one', 'two', 'three', 'four']) emitInto(sessionA, text);
    const pending = capped.pendingFrames();
    expect(pending.map((p) => p.seq)).toEqual([1, 2]);
  });
});
