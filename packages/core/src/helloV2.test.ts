import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { BackfillGuard } from './backfill.js';
import { DeviceFloor } from './deviceFloor.js';
import {
  Dispatcher,
  type DispatcherOptions,
  HELLO_CAPABILITIES,
  MAX_HELLO_BYTES,
} from './dispatcher.js';
import { makeEvent } from './events.js';
import { JournalStore, OutboxCursors } from './journal.js';
import { ProjectRegistry } from './projects.js';
import { SessionStore } from './sessions.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

/**
 * `device.hello` v2.
 *
 * Two promises are under test and they pull in opposite directions. A v2 gateway must be told
 * everything it needs to gate features on facts — what this daemon can do, what the user has
 * lifted off the floor, what the channel is, which phones are sealed to. A v1 gateway must get
 * the byte-identical frame it got before any of this existed, because it has never heard of the
 * fields and a hello is sent on every single connect.
 */
describe('device.hello v2', () => {
  const t = useTempHome('pagr-hello-v2-');
  const deviceId = ids.dev();
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let events: DeviceEvent[];
  let home: string;
  let projectId: string;
  let claude: FakeAdapter;

  // `Record<string, unknown>` rather than `Partial<DispatcherOptions>` so a row of the matrix
  // below can say `{ frames: undefined }` — switching a capability OFF — which
  // `exactOptionalPropertyTypes` forbids as a typed partial.
  type Over = Record<string, unknown>;

  const build = (over: Over = {}): Dispatcher =>
    new Dispatcher({
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
      ...over,
    } as DispatcherOptions);

  /** Everything switched on: the hello a real, fully-configured daemon sends. */
  const everything = (over: Over = {}): Dispatcher =>
    build({
      negotiatedVersion: () => 2,
      recipientKeyIds: () => ['aabb:ccdd:eeff:0011'],
      keepAwakeEnabled: () => true,
      channelHello: () => ({
        serverInstalled: true,
        registered: true,
        boundSessions: 2,
        mode: 'queued_next_turn',
      }),
      frames: {
        journal: new JournalStore({ dir: join(home, '.pagr', 'journal') }),
        cursors: new OutboxCursors({ file: join(home, '.pagr', 'journal', 'outbox.json') }),
        recipientKeys: () => ({}),
        protocolVersion: () => 2,
      },
      backfill: { guard: new BackfillGuard() },
      env: { PAGR_REMOTE_PROJECT_PICK: '1' },
      ...over,
    });

  beforeEach(() => {
    events = [];
    home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    sessions = new SessionStore();
    claude = new FakeAdapter('claude');
  });

  it('reports the negotiated version, not a hard-coded 1', async () => {
    expect((await build().probe()).protocolVersion).toBe(1);
    expect((await build({ negotiatedVersion: () => 2 }).probe()).protocolVersion).toBe(2);
    // A gateway cannot promote us past what the transport settled on, so anything the transport
    // reports above 2 is still 2 to a bridge that only knows how to speak 2.
    expect((await build({ negotiatedVersion: () => 3 }).probe()).protocolVersion).toBe(2);
  });

  it('advertises exactly the capabilities this daemon actually has on', async () => {
    const hello = await everything().probe();
    expect(hello.capabilities).toEqual([
      HELLO_CAPABILITIES.frames,
      HELLO_CAPABILITIES.seal,
      HELLO_CAPABILITIES.questions,
      HELLO_CAPABILITIES.approvalOptions,
      HELLO_CAPABILITIES.backfill,
      HELLO_CAPABILITIES.repoScan,
      HELLO_CAPABILITIES.keepAwake,
      HELLO_CAPABILITIES.channel,
    ]);
  });

  /**
   * The gating matrix, one switch at a time. Each row turns exactly one thing off and asserts
   * that exactly one name disappears: a capability that survives its own off switch is a lie the
   * cloud would build a button on.
   */
  const matrix: Array<[string, Over, string[]]> = [
    [
      'no journal wired up',
      { frames: undefined },
      [HELLO_CAPABILITIES.frames, HELLO_CAPABILITIES.seal],
    ],
    ['no way to learn phone keys', { recipientKeyIds: undefined }, [HELLO_CAPABILITIES.seal]],
    ['no history source', { backfill: undefined }, [HELLO_CAPABILITIES.backfill]],
    [
      'remote project pick off',
      { env: { PAGR_REMOTE_PROJECT_PICK: '0' } },
      [HELLO_CAPABILITIES.repoScan],
    ],
    ['keep-awake disabled', { keepAwakeEnabled: () => false }, [HELLO_CAPABILITIES.keepAwake]],
    [
      'channel not registered',
      {
        channelHello: () => ({
          serverInstalled: false,
          registered: false,
          boundSessions: 0,
          mode: 'off' as const,
        }),
      },
      [HELLO_CAPABILITIES.channel],
    ],
  ];

  it.each(matrix)('drops the right capability when %s', async (_what, over, gone) => {
    const hello = await everything(over).probe();
    const full = await everything().probe();
    expect(hello.capabilities).toEqual((full.capabilities ?? []).filter((c) => !gone.includes(c)));
  });

  it('drops questions.v1 when no adapter can write an answer back', async () => {
    // An adapter with no `answerQuestion` is not a hypothetical: that is every adapter this
    // bridge had before questions existed, and a mirrored thread's adapter can still be one.
    const mute = new Proxy(new FakeAdapter('claude'), {
      get: (target, key, receiver) =>
        key === 'answerQuestion' ? undefined : Reflect.get(target, key, receiver),
    }) as CodingAgentAdapter;
    const hello = await everything({
      adapters: new Map<Provider, CodingAgentAdapter>([['claude', mute]]),
    }).probe();
    expect(hello.capabilities).not.toContain(HELLO_CAPABILITIES.questions);
    // …and the rest is untouched: one switch, one name.
    expect(hello.capabilities).toContain(HELLO_CAPABILITIES.approvalOptions);
  });

  it('carries the floor the user lifted on this Mac, by class name only', async () => {
    const floor = DeviceFloor.fromFile(undefined, { PAGR_DEVICE_FLOOR: 'network,destructive' });
    const hello = await everything({ deviceFloor: floor }).probe();
    expect(hello.floor).toEqual({ lifted: ['network', 'destructive'] });
    // Nothing lifted is a FACT the app's Security screen states, so the field is present and
    // empty rather than absent, which would read as "this bridge cannot say".
    expect((await everything().probe()).floor).toEqual({ lifted: [] });
  });

  it('describes the channel as four separate truths, and never says "steered"', async () => {
    const hello = await everything().probe();
    expect(hello.channel).toEqual({
      serverInstalled: true,
      registered: true,
      boundSessions: 2,
      mode: 'queued_next_turn',
    });
    const off = await everything({
      channelHello: () => ({
        serverInstalled: true,
        registered: false,
        boundSessions: 0,
        mode: 'off' as const,
      }),
    }).probe();
    expect(off.channel?.mode).toBe('off');
  });

  it('describes sessions as SessionSummaryV2: control, origin, project status, lastSeq', async () => {
    const ours = `ses_${'1'.repeat(32)}`;
    const theirs = `ses_${'2'.repeat(32)}`;
    claude.sessions.set(ours, {
      sessionId: ours,
      projectId,
      provider: 'claude',
      status: 'idle',
      activeTurn: false,
      startedAt: '2026-09-17T10:00:00.000Z',
      updatedAt: '2026-09-17T10:00:00.000Z',
    });
    sessions.upsert({
      sessionId: theirs,
      provider: 'claude',
      projectId,
      providerSessionId: theirs,
      status: 'idle',
      adopted: true,
      startedAt: '2026-09-17T09:00:00.000Z',
    });
    const d = everything();
    // A frame gives the adopted session a journal, which is the number the phone backfills from.
    d.emitFrame(
      theirs,
      { kind: 'assistant', text: 'hello' },
      { projectId, provider: 'claude', meta: { source: 'transcript' } },
    );
    const hello = await d.probe();
    const mine = hello.sessions.find((s) => s.sessionId === ours);
    const yours = hello.sessions.find((s) => s.sessionId === theirs);
    expect(mine).toMatchObject({
      controlLevel: 'full',
      origin: 'pagr',
      projectStatus: 'registered',
    });
    // Pagr did not start it and no channel is bound to it: its prompts can be answered and
    // nothing else, which is exactly what `assertOurSession` enforces.
    expect(yours).toMatchObject({
      controlLevel: 'approvals_only',
      origin: 'terminal',
      projectStatus: 'registered',
      lastSeq: 1,
    });
  });

  it('keeps a v1 hello byte-identical to the one a pre-v2 bridge sent', async () => {
    // Same daemon, same everything, two links. On v1 the added fields are simply not there: a
    // gateway that answered 1 has told us it has never heard of them.
    const v1 = await everything({ negotiatedVersion: () => 1 }).probe();
    expect(v1.protocolVersion).toBe(1);
    expect(v1.floor).toBeUndefined();
    expect(v1.channel).toBeUndefined();
    // The one name v1 ever carried, and nothing else.
    expect(v1.capabilities).toEqual([HELLO_CAPABILITIES.repoScan]);
    for (const s of v1.sessions) {
      expect(s.controlLevel).toBeUndefined();
      expect(s.origin).toBeUndefined();
    }
  });

  it('stays inside the frame cap with every v2 field set and 1200 sessions', async () => {
    for (let i = 0; i < 1200; i++) {
      const id = `ses_${i.toString(16).padStart(32, '0')}`;
      claude.sessions.set(id, {
        sessionId: id,
        projectId,
        provider: 'claude',
        status: 'completed',
        activeTurn: false,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        displayName: `session ${i} ${'n'.repeat(100)}`,
        taskSummary: 'x'.repeat(500),
      });
    }
    const hello = await everything({
      // 32 phones is the schema's ceiling, and every fingerprint is in the payload.
      recipientKeyIds: () =>
        Array.from({ length: 32 }, (_v, i) => `${i.toString(16).padStart(4, '0')}:1111:2222:3333`),
      deviceFloor: DeviceFloor.fromFile(undefined, { PAGR_DEVICE_FLOOR: 'all' }),
    }).probe();
    expect(Buffer.byteLength(JSON.stringify(hello), 'utf8')).toBeLessThanOrEqual(MAX_HELLO_BYTES);
    // Trimmed, but still describing the sessions a person opening the app would look at first.
    expect(hello.sessions.length).toBeGreaterThan(0);
    expect(hello.recipientKeyIds).toHaveLength(32);
    expect(hello.capabilities).toContain(HELLO_CAPABILITIES.seal);
  });

  it('the hello it sends parses as a DeviceEvent, so the gateway will accept it', async () => {
    const d = everything();
    const hello: EventPayload<'device.hello'> = await d.probe();
    expect(() => DeviceEventSchema.parse(makeEvent(deviceId, 'device.hello', hello))).not.toThrow();
  });
});
