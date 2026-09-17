import { spawn as nodeSpawn } from 'node:child_process';
import { type Logger, silentLogger } from './logging.js';

/**
 * Keep the Mac awake exactly as long as Pagr is actually doing something.
 *
 * A Mac that falls asleep mid-turn is the single most confusing failure this product has: the
 * phone shows a session "working", nothing moves, and nothing is wrong. macOS gives one honest
 * way to prevent that without lying about what the machine is doing — `caffeinate` — so the
 * bridge holds one, and only while work is live.
 *
 * Three deliberate limits:
 *
 *  - **Idle sleep only (`-i`).** Never `-s` (system sleep) and never `-d` (display). Closing the
 *    lid still sleeps the Mac, because a clamshell sleep is a user instruction, not an idle
 *    timeout, and no assertion should override it. `pagr doctor` says so out loud rather than
 *    letting people discover it at 2am.
 *  - **Tied to this process (`-w <pid>`).** The assertion dies with the daemon even if the daemon
 *    is killed, crashes, or is force-quit without running `dispose()`. An orphaned `caffeinate`
 *    that keeps a laptop awake forever is worse than no keep-awake at all.
 *  - **Reference counted, with hysteresis.** Sessions finish and start again seconds apart
 *    (one turn ends, the next instruction arrives). Spawning and killing a child on each of those
 *    is pointless churn, so the last release waits out `hysteresisMs` first and a new hold inside
 *    that window cancels the stop.
 *
 * `PAGR_KEEP_AWAKE=0` turns the whole thing off, and every non-darwin platform is off by
 * definition (there is no `caffeinate` to run).
 */

/** Absolute path, never resolved through `$PATH`: this runs a system binary, not a user one. */
export const CAFFEINATE = '/usr/bin/caffeinate';
export const KEEP_AWAKE_ENV = 'PAGR_KEEP_AWAKE';
/** How long the assertion outlives the last release, so back-to-back turns do not churn it. */
export const DEFAULT_KEEP_AWAKE_HYSTERESIS_MS = 60_000;

/** The slice of a `ChildProcess` this module uses — so a test can hand it an EventEmitter. */
export interface KeepAwakeChild {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref?(): void;
}

export type KeepAwakeSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore' },
) => KeepAwakeChild;

export type KeepAwakeTimer = ReturnType<typeof setTimeout>;

/** Why keep-awake is off. `null` while it is on. */
export type KeepAwakeDisabledReason = 'opt_out' | 'platform';

export interface KeepAwakeStatus {
  /** True while a `caffeinate` child is actually alive — not merely while a reason is held. */
  active: boolean;
  /** Reason key → hold count. Only reasons currently held above zero appear. */
  reasons: Record<string, number>;
  disabled: boolean;
  disabledReason?: KeepAwakeDisabledReason;
}

export interface KeepAwakeOptions {
  /** Injected so tests never run a real `caffeinate`. Defaults to `child_process.spawn`. */
  spawn?: KeepAwakeSpawn;
  env: NodeJS.ProcessEnv;
  logger?: Logger;
  clock?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => KeepAwakeTimer;
  clearTimeout?: (timer: KeepAwakeTimer) => void;
  hysteresisMs?: number;
  /** The process the assertion is tied to. Defaults to this daemon. */
  pid?: number;
  platform?: NodeJS.Platform;
}

const defaultSpawn: KeepAwakeSpawn = (command, args, options) => nodeSpawn(command, args, options);

export class KeepAwake {
  readonly disabled: boolean;
  readonly disabledReason: KeepAwakeDisabledReason | null;
  private readonly counts = new Map<string, number>();
  private readonly spawn: KeepAwakeSpawn;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => KeepAwakeTimer;
  private readonly clearTimer: (timer: KeepAwakeTimer) => void;
  private readonly hysteresisMs: number;
  private readonly pid: number;
  private child: KeepAwakeChild | null = null;
  private stopTimer: KeepAwakeTimer | null = null;
  private since: string | null = null;
  private disposed = false;

  constructor(o: KeepAwakeOptions) {
    this.spawn = o.spawn ?? defaultSpawn;
    this.logger = o.logger ?? silentLogger;
    this.clock = o.clock ?? (() => new Date());
    this.setTimer = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimeout ?? ((t) => clearTimeout(t));
    this.hysteresisMs = o.hysteresisMs ?? DEFAULT_KEEP_AWAKE_HYSTERESIS_MS;
    this.pid = o.pid ?? process.pid;
    const platform = o.platform ?? process.platform;
    this.disabledReason =
      o.env[KEEP_AWAKE_ENV] === '0' ? 'opt_out' : platform === 'darwin' ? null : 'platform';
    this.disabled = this.disabledReason !== null;
  }

  /** ISO timestamp of the live assertion, or null. */
  get heldSince(): string | null {
    return this.since;
  }

  /**
   * Take one hold for `reason` (`sessions`, `approvals`, `questions`, `backfill`, …). Reasons are
   * opaque keys on purpose: a future source of work holds its own without touching this class.
   */
  hold(reason: string): void {
    if (this.disposed || this.disabled) return;
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    this.cancelStop();
    this.ensureChild();
  }

  /** Drop one hold. The last one starts the hysteresis wait, it does not kill the child. */
  release(reason: string): void {
    if (this.disposed || this.disabled) return;
    const next = (this.counts.get(reason) ?? 0) - 1;
    if (next > 0) this.counts.set(reason, next);
    else this.counts.delete(reason);
    if (this.total() === 0) this.scheduleStop();
  }

  /**
   * Reconcile one reason to an exact count. Idempotent, which is what a *derived* source needs:
   * the daemon recomputes "how many sessions are live" after every change and states it, rather
   * than trying to pair a hold with a release across every code path that can end a session.
   */
  setCount(reason: string, count: number): void {
    if (this.disposed || this.disabled) return;
    const want = Math.max(0, Math.trunc(count));
    const have = this.counts.get(reason) ?? 0;
    if (want === have) return;
    for (let i = have; i < want; i++) this.hold(reason);
    for (let i = have; i > want; i--) this.release(reason);
  }

  status(): KeepAwakeStatus {
    return {
      active: this.child !== null,
      reasons: Object.fromEntries([...this.counts.entries()].filter(([, n]) => n > 0)),
      disabled: this.disabled,
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {}),
    };
  }

  /** Daemon shutdown: the assertion goes now, not one hysteresis window from now. */
  dispose(): void {
    this.disposed = true;
    this.counts.clear();
    this.cancelStop();
    this.stopChild('dispose');
  }

  private total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  private ensureChild(): void {
    if (this.disabled || this.child !== null) return;
    let child: KeepAwakeChild;
    try {
      child = this.spawn(CAFFEINATE, ['-i', '-w', String(this.pid)], { stdio: 'ignore' });
    } catch (err) {
      // A missing or refused `caffeinate` is a degraded Mac, not a broken bridge: everything
      // else keeps working and the Mac simply sleeps as it did before.
      this.logger.warn('keep-awake could not start caffeinate', { error: String(err) });
      return;
    }
    this.child = child;
    this.since = this.clock().toISOString();
    child.unref?.();
    // Either way the child is gone; drop it so the next hold takes a fresh assertion rather than
    // holding a reference to a dead process forever. Deliberately no auto-respawn here — a
    // caffeinate that cannot run would otherwise become a spawn loop.
    child.on('exit', (code, signal) => {
      if (this.child === child) this.forget();
      this.logger.debug('keep-awake child exited', { code, signal });
    });
    child.on('error', (err) => {
      if (this.child === child) this.forget();
      this.logger.warn('keep-awake child failed', { error: String(err) });
    });
    this.logger.debug('keep-awake asserted', { pid: this.pid, reasons: this.total() });
  }

  private forget(): void {
    this.child = null;
    this.since = null;
    this.cancelStop();
  }

  private scheduleStop(): void {
    if (this.child === null || this.stopTimer !== null) return;
    const timer = this.setTimer(() => {
      this.stopTimer = null;
      if (this.total() === 0) this.stopChild('idle');
    }, this.hysteresisMs);
    timer.unref?.();
    this.stopTimer = timer;
  }

  private cancelStop(): void {
    if (this.stopTimer === null) return;
    this.clearTimer(this.stopTimer);
    this.stopTimer = null;
  }

  private stopChild(why: 'idle' | 'dispose'): void {
    const child = this.child;
    if (child === null) return;
    this.forget();
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this.logger.warn('keep-awake could not stop caffeinate', { error: String(err) });
    }
    this.logger.debug('keep-awake released', { why });
  }
}

/** Fixed order so the doctor line reads the same way every time. */
const REASON_LABELS: Array<[string, string, string]> = [
  ['sessions', 'session', 'sessions'],
  ['approvals', 'approval', 'approvals'],
  ['questions', 'question', 'questions'],
  ['backfill', 'backfill', 'backfill'],
];

/** One line for `pagr doctor` / `pagr status`: `active (2 sessions, 1 approval)`. */
export function describeKeepAwake(status: KeepAwakeStatus): string {
  if (status.disabled)
    return status.disabledReason === 'platform'
      ? 'disabled (not macOS)'
      : `disabled (${KEEP_AWAKE_ENV}=0)`;
  if (!status.active) return 'idle';
  const known = new Set(REASON_LABELS.map(([key]) => key));
  const parts = [
    ...REASON_LABELS.filter(([key]) => (status.reasons[key] ?? 0) > 0).map(
      ([key, one, many]) => `${status.reasons[key]} ${status.reasons[key] === 1 ? one : many}`,
    ),
    ...Object.entries(status.reasons)
      .filter(([key, n]) => !known.has(key) && n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, n]) => `${n} ${key}`),
  ];
  return parts.length > 0 ? `active (${parts.join(', ')})` : 'active (releasing)';
}
