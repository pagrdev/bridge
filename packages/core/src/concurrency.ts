import { resolve, sep } from 'node:path';
import type { Provider, SessionStatus } from '@pagr/protocol';

/**
 * Rules for running many sessions at once.
 *
 * Two things can go wrong when the cloud starts sessions faster than a Mac can absorb them:
 *
 *  1. **Two write-capable agents in one working tree.** Codex (`workspace-write`) and Claude Code
 *     both edit files in place with no locking. Two of them in the same checkout interleave
 *     edits, and the loser silently overwrites the winner. Neither provider isolates the other,
 *     so the bridge refuses instead of racing — and says exactly which session holds the tree.
 *     Separate checkouts (including `git worktree` copies) are different trees and are allowed.
 *  2. **Unbounded processes.** Each Claude session is one `claude` child; each Codex session is a
 *     thread on the shared `codex app-server`. Without a ceiling a runaway cloud loop can fork
 *     until the Mac swaps. The guard caps live sessions per provider and in total, and refuses
 *     with a clear message rather than starting something that will fail later.
 */

/** Per provider: enough for a few parallel projects, far below what would thrash a laptop. */
export const DEFAULT_MAX_LIVE_SESSIONS_PER_PROVIDER = 4;
export const DEFAULT_MAX_LIVE_SESSIONS = 8;

const LIVE_STATUSES = new Set<SessionStatus>([
  'starting',
  'working',
  'waiting_for_approval',
  'waiting_for_user',
]);

/** A session that is doing something right now, i.e. one that owns resources. */
export function isLiveStatus(status: SessionStatus): boolean {
  return LIVE_STATUSES.has(status);
}

export interface WorkspaceClaim {
  sessionId: string;
  provider: Provider;
  projectId: string;
  /**
   * Realpath of the project root, or null when it can no longer be resolved (the project was
   * unregistered while the session ran). A null path takes part in the resource budget but never
   * in the working-tree rule: refusing on a path we cannot name would be a guess.
   */
  projectPath: string | null;
  /**
   * False for read-only sessions, which cannot corrupt anyone else's edits.
   *
   * This has to be true of the session, not just recorded about it. Codex enforces it with a real
   * sandbox (`sandbox: 'read-only'`). Claude Code has no sandbox, so the adapter must withhold
   * every tool that can write — `Bash` included, since `sed -i` is a write and `Bash` was once
   * left enabled here (SEC-6/BR-9). See `READ_ONLY_DISALLOWED_TOOLS` in the Claude adapter, which
   * is what makes this flag honest.
   */
  writeCapable: boolean;
}

export type RefusalCode = 'workspace_busy' | 'provider_limit' | 'session_limit';

export interface ConcurrencyRefusal {
  code: RefusalCode;
  message: string;
  conflictingSessionId?: string;
}

export interface SessionLimits {
  maxLiveSessions: number;
  maxLiveSessionsPerProvider: number;
  /** Local, explicit opt-in to sharing one working tree between two writers. */
  allowConcurrentWriters: boolean;
}

const OPT_IN_ENV = 'PAGR_ALLOW_CONCURRENT_WRITERS';

const sharesTree = (a: string, b: string): boolean => {
  const x = resolve(a);
  const y = resolve(b);
  if (x === y) return true;
  const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep);
  return x.startsWith(withSep(y)) || y.startsWith(withSep(x));
};

export class SessionGuard {
  readonly limits: SessionLimits;

  constructor(limits: Partial<SessionLimits> = {}) {
    this.limits = {
      maxLiveSessions: limits.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS,
      maxLiveSessionsPerProvider:
        limits.maxLiveSessionsPerProvider ?? DEFAULT_MAX_LIVE_SESSIONS_PER_PROVIDER,
      allowConcurrentWriters: limits.allowConcurrentWriters ?? false,
    };
  }

  /** Limits from the environment; unset or unparseable values fall back to the defaults. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SessionGuard {
    return new SessionGuard({
      allowConcurrentWriters: env[OPT_IN_ENV] === '1',
      ...num(env.PAGR_MAX_SESSIONS, 'maxLiveSessions'),
      ...num(env.PAGR_MAX_SESSIONS_PER_PROVIDER, 'maxLiveSessionsPerProvider'),
    });
  }

  /**
   * `null` when `next` may start. Otherwise the reason, phrased for a user reading it in a text
   * message. `live` is every session currently holding resources (see `isLiveStatus`).
   */
  check(next: WorkspaceClaim, live: WorkspaceClaim[]): ConcurrencyRefusal | null {
    const others = live.filter((s) => s.sessionId !== next.sessionId);

    const nextPath = next.projectPath;
    if (nextPath !== null && next.writeCapable && !this.limits.allowConcurrentWriters) {
      const holder = others.find(
        (s) => s.writeCapable && s.projectPath !== null && sharesTree(s.projectPath, nextPath),
      );
      if (holder) {
        return {
          code: 'workspace_busy',
          conflictingSessionId: holder.sessionId,
          message:
            `a ${holder.provider} session (${holder.sessionId}) is already running in the same ` +
            'working tree, and neither provider isolates the other — two agents editing one ' +
            'checkout overwrite each other. Stop that session, start this one read-only, use a ' +
            `separate git worktree, or set ${OPT_IN_ENV}=1 on the daemon to allow it anyway.`,
        };
      }
    }

    const perProvider = others.filter((s) => s.provider === next.provider).length;
    if (perProvider >= this.limits.maxLiveSessionsPerProvider) {
      return {
        code: 'provider_limit',
        message:
          `${perProvider} ${next.provider} sessions are already running, which is this device's ` +
          `limit of ${this.limits.maxLiveSessionsPerProvider}. Stop one first, or raise ` +
          'PAGR_MAX_SESSIONS_PER_PROVIDER on the daemon.',
      };
    }

    if (others.length >= this.limits.maxLiveSessions) {
      return {
        code: 'session_limit',
        message:
          `${others.length} sessions are already running, which is this device's limit of ` +
          `${this.limits.maxLiveSessions}. Stop one first, or raise PAGR_MAX_SESSIONS on the daemon.`,
      };
    }
    return null;
  }
}

function num(raw: string | undefined, key: keyof SessionLimits): Partial<SessionLimits> {
  if (raw === undefined) return {};
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return {};
  return { [key]: n };
}
