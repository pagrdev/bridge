import type { Provider, SessionSummary } from '@pagr/protocol';
import type { CodingAgentAdapter } from './adapters/types.js';
import { isLiveStatus } from './concurrency.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';
import type { SessionRecord, SessionStore } from './sessions.js';

/**
 * Startup reconciliation.
 *
 * `sessions.json` survives a daemon crash, a `launchctl kickstart`, or a Mac reboot — but the
 * `claude` children and the `codex app-server` do not. Without this pass the store would still
 * say "working" for sessions whose process died with the daemon, so the cloud would keep telling
 * the user their agent is busy while nothing at all is running.
 *
 * For every session that claims to be live we ask its adapter what it knows:
 *
 *  - the adapter still has the thread (Codex `thread/resume`) or the Claude session id
 *    (`claude --resume`) → the session is **resumable**: it goes to `idle`, and the next
 *    instruction starts a fresh turn on the same history.
 *  - the adapter has never heard of it → the session is **terminated** (`stopped`).
 *  - the adapter throws → we could not verify it, so it is reported `failed` rather than left
 *    claiming to work.
 */

export type ReconcileOutcome = 'resumable' | 'terminated' | 'failed';

export interface ReconciledSession {
  record: SessionRecord;
  outcome: ReconcileOutcome;
  reason: string;
}

export interface ReconcileOptions {
  sessions: SessionStore;
  adapters: Map<Provider, CodingAgentAdapter>;
  logger?: Logger;
  /** Called once per changed session so the daemon can tell the cloud. */
  onChange?: (r: ReconciledSession) => void;
}

const REASONS = {
  resumable: 'the daemon restarted; this session was interrupted but can be resumed',
  terminated: 'the daemon restarted and the provider no longer knows this session',
  no_adapter: 'the daemon restarted and no adapter is loaded for this provider',
} as const;

export async function reconcileSessions(o: ReconcileOptions): Promise<ReconciledSession[]> {
  const logger = o.logger ?? silentLogger;
  const changed: ReconciledSession[] = [];

  for (const rec of o.sessions.list()) {
    if (!isLiveStatus(rec.status)) continue;
    const adapter = o.adapters.get(rec.provider);
    if (!adapter) {
      changed.push(record(o, rec, 'terminated', REASONS.no_adapter));
      continue;
    }
    let live: SessionSummary | null;
    try {
      live = await adapter.getStatus(rec.sessionId);
    } catch (err) {
      logger.warn('reconcile: adapter getStatus failed', {
        sessionId: rec.sessionId,
        provider: rec.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      changed.push(
        record(
          o,
          rec,
          'failed',
          `the daemon restarted and ${rec.provider} could not be asked about this session`,
        ),
      );
      continue;
    }
    if (!live) {
      changed.push(record(o, rec, 'terminated', REASONS.terminated));
      continue;
    }
    // `pagr sessions --reconcile` runs this against a *live* daemon too, so an adapter that
    // still reports a running turn is telling the truth: leave it alone. Telling the user their
    // agent stopped — and releasing the working tree it is still writing to — would be worse
    // than any zombie. On a cold start no adapter can report this: nothing is running yet.
    if (isLiveStatus(live.status) || live.activeTurn) {
      logger.debug('reconcile: session is genuinely running', { sessionId: rec.sessionId });
      continue;
    }
    changed.push(record(o, rec, 'resumable', REASONS.resumable));
  }

  if (changed.length)
    logger.info('reconciled sessions after restart', {
      resumable: changed.filter((c) => c.outcome === 'resumable').length,
      terminated: changed.filter((c) => c.outcome === 'terminated').length,
      failed: changed.filter((c) => c.outcome === 'failed').length,
    });
  return changed;
}

function record(
  o: ReconcileOptions,
  rec: SessionRecord,
  outcome: ReconcileOutcome,
  reason: string,
): ReconciledSession {
  const status = outcome === 'resumable' ? 'idle' : outcome === 'failed' ? 'failed' : 'stopped';
  const updated = o.sessions.setStatus(rec.sessionId, status) ?? { ...rec, status };
  const out: ReconciledSession = { record: updated, outcome, reason };
  o.onChange?.(out);
  return out;
}
