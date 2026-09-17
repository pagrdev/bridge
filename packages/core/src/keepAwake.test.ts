import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAFFEINATE,
  DEFAULT_KEEP_AWAKE_HYSTERESIS_MS,
  describeKeepAwake,
  KEEP_AWAKE_ENV,
  KeepAwake,
  type KeepAwakeChild,
  type KeepAwakeSpawn,
} from './keepAwake.js';
import { silentLogger } from './logging.js';

class FakeChild extends EventEmitter implements KeepAwakeChild {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  killed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
  unref(): void {}
}

interface Spawned {
  spawn: KeepAwakeSpawn;
  calls: Array<[string, string[]]>;
  children: FakeChild[];
}

/** A spawn that never touches a real process: records argv, hands back a controllable child. */
function fakeSpawn(): Spawned {
  const calls: Array<[string, string[]]> = [];
  const children: FakeChild[] = [];
  const spawn: KeepAwakeSpawn = (command, args) => {
    calls.push([command, args]);
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

const PID = 4242;

const make = (o: Partial<ConstructorParameters<typeof KeepAwake>[0]> & { spawn: KeepAwakeSpawn }) =>
  new KeepAwake({
    env: {},
    logger: silentLogger,
    platform: 'darwin',
    pid: PID,
    ...o,
  });

describe('KeepAwake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns exactly one caffeinate for the whole hold window, with idle-only argv tied to our pid', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });

    k.hold('sessions');
    k.hold('sessions');
    k.hold('approvals');

    expect(s.calls).toHaveLength(1);
    // `-i` asserts against IDLE sleep only (never `-s`/`-d`), and `-w <pid>` makes the assertion
    // die with the daemon rather than outliving it as an orphan.
    expect(s.calls[0]).toEqual([CAFFEINATE, ['-i', '-w', String(PID)]]);
    expect(k.status()).toEqual({
      active: true,
      disabled: false,
      reasons: { sessions: 2, approvals: 1 },
    });
  });

  it('keeps the assertion while any reason is still held', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.hold('sessions');
    k.hold('approvals');

    k.release('sessions');
    vi.advanceTimersByTime(DEFAULT_KEEP_AWAKE_HYSTERESIS_MS * 2);

    expect(s.children[0]?.killed).toBe(false);
    expect(k.status().reasons).toEqual({ approvals: 1 });
  });

  it('kills the child only after the hysteresis window following the last release', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn, hysteresisMs: 60_000 });
    k.hold('sessions');

    k.release('sessions');
    expect(k.status().active).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(s.children[0]?.killed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(s.children[0]?.signals).toEqual(['SIGTERM']);
    expect(k.status()).toEqual({ active: false, disabled: false, reasons: {} });
  });

  it('a hold during the hysteresis window cancels the stop and reuses the same child', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn, hysteresisMs: 60_000 });
    k.hold('sessions');
    k.release('sessions');

    vi.advanceTimersByTime(30_000);
    k.hold('approvals');
    vi.advanceTimersByTime(60_000);

    expect(s.calls).toHaveLength(1);
    expect(s.children[0]?.killed).toBe(false);
    expect(k.status().active).toBe(true);
  });

  it('release below zero is a no-op, not a negative count', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.release('sessions');
    expect(s.calls).toHaveLength(0);
    expect(k.status()).toEqual({ active: false, disabled: false, reasons: {} });
  });

  it('a child that exits on its own resets the state, and the next hold respawns', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.hold('sessions');
    s.children[0]?.emit('exit', 0, null);

    expect(k.status().active).toBe(false);
    // The reason is still held — the assertion was lost, not released.
    expect(k.status().reasons).toEqual({ sessions: 1 });

    k.hold('approvals');
    expect(s.calls).toHaveLength(2);
    expect(k.status().active).toBe(true);
  });

  it('a spawn error resets the state instead of leaving a dead child held', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.hold('sessions');
    s.children[0]?.emit('error', new Error('ENOENT'));

    expect(k.status().active).toBe(false);
    k.release('sessions');
    k.hold('sessions');
    expect(s.calls).toHaveLength(2);
  });

  it('a spawn that throws is logged, not fatal', () => {
    const warnings: string[] = [];
    const k = make({
      spawn: () => {
        throw new Error('no such file');
      },
      logger: { ...silentLogger, warn: (m) => warnings.push(m), child: () => silentLogger },
    });
    expect(() => k.hold('sessions')).not.toThrow();
    expect(k.status().active).toBe(false);
    expect(warnings.join()).toContain('keep-awake');
  });

  it(`${KEEP_AWAKE_ENV}=0 disables everything and spawns nothing`, () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn, env: { [KEEP_AWAKE_ENV]: '0' } });
    k.hold('sessions');
    k.hold('approvals');

    expect(s.calls).toHaveLength(0);
    expect(k.status()).toEqual({
      active: false,
      disabled: true,
      disabledReason: 'opt_out',
      reasons: {},
    });
    expect(k.disabledReason).toBe('opt_out');
  });

  it('is disabled off macOS, where caffeinate does not exist', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn, platform: 'linux' });
    k.hold('sessions');

    expect(s.calls).toHaveLength(0);
    expect(k.status().disabled).toBe(true);
    expect(k.disabledReason).toBe('platform');
  });

  it('dispose kills the child immediately, without waiting out the hysteresis', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.hold('sessions');

    k.dispose();

    expect(s.children[0]?.signals).toEqual(['SIGTERM']);
    expect(k.status()).toEqual({ active: false, disabled: false, reasons: {} });
    // A pending stop timer must not fire into a disposed instance either.
    vi.advanceTimersByTime(DEFAULT_KEEP_AWAKE_HYSTERESIS_MS * 2);
    expect(s.children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('dispose during the hysteresis window cancels the timer and kills now', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });
    k.hold('sessions');
    k.release('sessions');

    k.dispose();
    expect(s.children[0]?.killed).toBe(true);
  });

  it('setCount reconciles a derived count to an exact value, idempotently', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn });

    k.setCount('sessions', 2);
    k.setCount('sessions', 2);
    expect(k.status().reasons).toEqual({ sessions: 2 });
    expect(s.calls).toHaveLength(1);

    k.setCount('sessions', 1);
    expect(k.status().reasons).toEqual({ sessions: 1 });

    k.setCount('sessions', 0);
    expect(k.status().reasons).toEqual({});
    expect(k.status().active).toBe(true); // still inside the hysteresis window
  });

  it('records when the assertion was taken, from the injected clock', () => {
    const s = fakeSpawn();
    const k = make({ spawn: s.spawn, clock: () => new Date('2026-09-17T10:00:00.000Z') });
    k.hold('backfill');
    expect(k.heldSince).toBe('2026-09-17T10:00:00.000Z');
    k.dispose();
    expect(k.heldSince).toBeNull();
  });
});

describe('describeKeepAwake', () => {
  it('names the reasons in plain words', () => {
    expect(
      describeKeepAwake({
        active: true,
        disabled: false,
        reasons: { sessions: 2, approvals: 1 },
      }),
    ).toBe('active (2 sessions, 1 approval)');
  });

  it('counts questions and backfill too, in a stable order', () => {
    expect(
      describeKeepAwake({
        active: true,
        disabled: false,
        reasons: { backfill: 1, questions: 2, sessions: 1 },
      }),
    ).toBe('active (1 session, 2 questions, 1 backfill)');
  });

  it('says idle when nothing is held', () => {
    expect(describeKeepAwake({ active: false, disabled: false, reasons: {} })).toBe('idle');
  });

  it('says releasing while the assertion outlives the last hold', () => {
    expect(describeKeepAwake({ active: true, disabled: false, reasons: {} })).toBe(
      'active (releasing)',
    );
  });

  it('names the opt-out by its exact variable', () => {
    expect(
      describeKeepAwake({ active: false, disabled: true, reasons: {}, disabledReason: 'opt_out' }),
    ).toBe(`disabled (${KEEP_AWAKE_ENV}=0)`);
  });

  it('says why it is off on a machine that has no caffeinate', () => {
    expect(
      describeKeepAwake({ active: false, disabled: true, reasons: {}, disabledReason: 'platform' }),
    ).toBe('disabled (not macOS)');
  });
});
