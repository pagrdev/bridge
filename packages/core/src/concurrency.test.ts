import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LIVE_SESSIONS,
  DEFAULT_MAX_LIVE_SESSIONS_PER_PROVIDER,
  isLiveStatus,
  SessionGuard,
  type WorkspaceClaim,
} from './concurrency.js';

const claim = (over: Partial<WorkspaceClaim> = {}): WorkspaceClaim => ({
  sessionId: 'ses_1',
  provider: 'codex',
  projectId: 'proj_a',
  projectPath: '/work/alpha',
  writeCapable: true,
  ...over,
});

describe('isLiveStatus', () => {
  it('treats only non-terminal statuses as live', () => {
    for (const s of ['starting', 'working', 'waiting_for_approval', 'waiting_for_user'] as const)
      expect(isLiveStatus(s)).toBe(true);
    for (const s of ['idle', 'completed', 'failed', 'stopped', 'offline', 'unknown'] as const)
      expect(isLiveStatus(s)).toBe(false);
  });
});

describe('SessionGuard workspace rules', () => {
  const guard = new SessionGuard();

  it('allows two write-capable sessions in different working trees', () => {
    expect(
      guard.check(claim({ sessionId: 'ses_2', projectId: 'proj_b', projectPath: '/work/beta' }), [
        claim(),
      ]),
    ).toBeNull();
  });

  it('allows two Codex sessions in different projects', () => {
    const live = [claim({ provider: 'codex' })];
    const next = claim({
      sessionId: 'ses_2',
      provider: 'codex',
      projectId: 'proj_b',
      projectPath: '/work/beta',
    });
    expect(guard.check(next, live)).toBeNull();
  });

  it('refuses a second write-capable session in the same working tree', () => {
    const r = guard.check(claim({ sessionId: 'ses_2', provider: 'claude' }), [claim()]);
    expect(r?.code).toBe('workspace_busy');
    expect(r?.conflictingSessionId).toBe('ses_1');
    expect(r?.message).toMatch(/codex/);
    expect(r?.message).toMatch(/same working tree/);
  });

  it('refuses two write-capable sessions of the same provider in one project', () => {
    const r = guard.check(claim({ sessionId: 'ses_2' }), [claim()]);
    expect(r?.code).toBe('workspace_busy');
  });

  it('refuses when one working tree is nested inside the other', () => {
    const r = guard.check(claim({ sessionId: 'ses_2', projectPath: '/work/alpha/packages/api' }), [
      claim({ projectPath: '/work/alpha' }),
    ]);
    expect(r?.code).toBe('workspace_busy');
  });

  it('does not treat a sibling with a shared prefix as the same tree', () => {
    expect(
      guard.check(claim({ sessionId: 'ses_2', projectPath: '/work/alpha-2' }), [
        claim({ projectPath: '/work/alpha' }),
      ]),
    ).toBeNull();
  });

  it('allows a read-only session alongside a writer, and writers alongside readers', () => {
    expect(guard.check(claim({ sessionId: 'ses_2', writeCapable: false }), [claim()])).toBeNull();
    expect(guard.check(claim({ sessionId: 'ses_2' }), [claim({ writeCapable: false })])).toBeNull();
  });

  it('allows the same session id to restart in its own tree', () => {
    expect(guard.check(claim(), [claim()])).toBeNull();
  });

  it('never refuses on a working tree it can no longer name', () => {
    // The project was unregistered while its session ran: the path is unknown, so the tree rule
    // cannot apply — but the session still exists (see the budget tests).
    expect(guard.check(claim({ sessionId: 'ses_2' }), [claim({ projectPath: null })])).toBeNull();
    expect(guard.check(claim({ sessionId: 'ses_2', projectPath: null }), [claim()])).toBeNull();
  });

  it('allows concurrent writers when the operator opted in locally', () => {
    const permissive = new SessionGuard({ allowConcurrentWriters: true });
    expect(permissive.check(claim({ sessionId: 'ses_2' }), [claim()])).toBeNull();
  });

  it('explains how to opt in', () => {
    const r = guard.check(claim({ sessionId: 'ses_2' }), [claim()]);
    expect(r?.message).toMatch(/PAGR_ALLOW_CONCURRENT_WRITERS/);
  });
});

describe('SessionGuard resource limits', () => {
  const many = (n: number, provider: 'codex' | 'claude'): WorkspaceClaim[] =>
    Array.from({ length: n }, (_, i) =>
      claim({
        sessionId: `ses_${i}`,
        provider,
        projectId: `proj_${i}`,
        projectPath: `/work/p${i}`,
      }),
    );

  it('refuses past the per-provider process budget', () => {
    const guard = new SessionGuard({ maxLiveSessionsPerProvider: 2 });
    const live = many(2, 'claude');
    const r = guard.check(
      claim({
        sessionId: 'ses_x',
        provider: 'claude',
        projectId: 'proj_x',
        projectPath: '/work/x',
      }),
      live,
    );
    expect(r?.code).toBe('provider_limit');
    expect(r?.message).toMatch(/2/);
  });

  it('counts each provider separately', () => {
    const guard = new SessionGuard({ maxLiveSessionsPerProvider: 2 });
    const live = many(2, 'claude');
    expect(
      guard.check(
        claim({
          sessionId: 'ses_x',
          provider: 'codex',
          projectId: 'proj_x',
          projectPath: '/work/x',
        }),
        live,
      ),
    ).toBeNull();
  });

  it('still counts a session whose project was unregistered', () => {
    const guard = new SessionGuard({ maxLiveSessionsPerProvider: 2 });
    const live = many(2, 'claude').map((c) => ({ ...c, projectPath: null }));
    const r = guard.check(
      claim({
        sessionId: 'ses_x',
        provider: 'claude',
        projectId: 'proj_x',
        projectPath: '/work/x',
      }),
      live,
    );
    expect(r?.code).toBe('provider_limit');
  });

  it('refuses past the total budget', () => {
    const guard = new SessionGuard({ maxLiveSessions: 3, maxLiveSessionsPerProvider: 99 });
    const r = guard.check(
      claim({ sessionId: 'ses_x', projectId: 'proj_x', projectPath: '/work/x' }),
      many(3, 'claude'),
    );
    expect(r?.code).toBe('session_limit');
  });

  it('re-admits a session id that is already counted', () => {
    const guard = new SessionGuard({ maxLiveSessions: 2, maxLiveSessionsPerProvider: 2 });
    const live = many(2, 'codex');
    expect(guard.check({ ...(live[0] as WorkspaceClaim) }, live)).toBeNull();
  });

  it('has sane defaults', () => {
    expect(DEFAULT_MAX_LIVE_SESSIONS_PER_PROVIDER).toBeGreaterThan(1);
    expect(DEFAULT_MAX_LIVE_SESSIONS).toBeGreaterThanOrEqual(
      DEFAULT_MAX_LIVE_SESSIONS_PER_PROVIDER,
    );
  });

  it('reads the local opt-in from the environment', () => {
    const g = SessionGuard.fromEnv({ PAGR_ALLOW_CONCURRENT_WRITERS: '1' });
    expect(g.check(claim({ sessionId: 'ses_2' }), [claim()])).toBeNull();
    expect(SessionGuard.fromEnv({}).check(claim({ sessionId: 'ses_2' }), [claim()])?.code).toBe(
      'workspace_busy',
    );
  });

  it('reads limits from the environment', () => {
    const g = SessionGuard.fromEnv({ PAGR_MAX_SESSIONS: '1' });
    expect(
      g.check(claim({ sessionId: 'ses_2', projectId: 'proj_b', projectPath: '/b' }), [claim()])
        ?.code,
    ).toBe('session_limit');
  });

  it('ignores nonsense limit values', () => {
    const g = SessionGuard.fromEnv({ PAGR_MAX_SESSIONS: 'banana' });
    expect(g.limits.maxLiveSessions).toBe(DEFAULT_MAX_LIVE_SESSIONS);
  });
});
