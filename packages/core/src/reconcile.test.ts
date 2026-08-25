import type { Provider, SessionSummary } from '@pagr/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { reconcileSessions } from './reconcile.js';
import { SessionStore } from './sessions.js';

const at = '2026-08-25T10:00:00.000Z';

const store = (
  ...recs: Array<{ sessionId: string; provider?: Provider; status: SessionSummary['status'] }>
): SessionStore => {
  const s = new SessionStore();
  for (const r of recs)
    s.upsert({
      sessionId: r.sessionId,
      provider: r.provider ?? 'codex',
      projectId: 'proj_a',
      providerSessionId: r.sessionId,
      status: r.status,
      startedAt: at,
      updatedAt: at,
    });
  return s;
};

const adapters = (...a: CodingAgentAdapter[]) =>
  new Map<Provider, CodingAgentAdapter>(a.map((x) => [x.provider, x]));

describe('reconcileSessions', () => {
  it('leaves terminal sessions alone', async () => {
    const sessions = store({ sessionId: 'ses_done', status: 'completed' });
    const changed = await reconcileSessions({ sessions, adapters: adapters(new FakeAdapter()) });
    expect(changed).toEqual([]);
    expect(sessions.get('ses_done')?.status).toBe('completed');
  });

  it('marks a resumable session idle rather than leaving it "working"', async () => {
    const sessions = store({ sessionId: 'ses_live', status: 'working' });
    const fake = new FakeAdapter('codex');
    fake.sessions.set('ses_live', {
      sessionId: 'ses_live',
      projectId: 'proj_a',
      provider: 'codex',
      status: 'idle',
      activeTurn: false,
      startedAt: at,
      updatedAt: at,
    });
    const changed = await reconcileSessions({ sessions, adapters: adapters(fake) });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.outcome).toBe('resumable');
    expect(sessions.get('ses_live')?.status).toBe('idle');
  });

  it('marks a session the provider has forgotten as stopped', async () => {
    const sessions = store({ sessionId: 'ses_gone', status: 'waiting_for_approval' });
    const changed = await reconcileSessions({ sessions, adapters: adapters(new FakeAdapter()) });
    expect(changed[0]?.outcome).toBe('terminated');
    expect(sessions.get('ses_gone')?.status).toBe('stopped');
  });

  it('marks a session failed when the adapter cannot be asked', async () => {
    const sessions = store({ sessionId: 'ses_x', status: 'starting' });
    const fake = new FakeAdapter('codex');
    fake.getStatus = vi.fn().mockRejectedValue(new Error('app-server unreachable'));
    const changed = await reconcileSessions({ sessions, adapters: adapters(fake) });
    expect(changed[0]?.outcome).toBe('failed');
    expect(sessions.get('ses_x')?.status).toBe('failed');
  });

  it('terminates sessions whose provider has no adapter loaded', async () => {
    const sessions = store({ sessionId: 'ses_c', provider: 'claude', status: 'working' });
    const changed = await reconcileSessions({ sessions, adapters: adapters(new FakeAdapter()) });
    expect(changed[0]?.outcome).toBe('terminated');
    expect(changed[0]?.reason).toMatch(/no adapter/);
  });

  it('reports every change so the cloud can be told', async () => {
    const sessions = store(
      { sessionId: 'ses_1', status: 'working' },
      { sessionId: 'ses_2', status: 'waiting_for_user' },
      { sessionId: 'ses_3', status: 'completed' },
    );
    const seen: string[] = [];
    await reconcileSessions({
      sessions,
      adapters: adapters(new FakeAdapter()),
      onChange: (c) => seen.push(c.record.sessionId),
    });
    expect(seen).toEqual(['ses_1', 'ses_2']);
  });

  it('leaves no session claiming to be live afterwards', async () => {
    const sessions = store(
      { sessionId: 'ses_1', status: 'working' },
      { sessionId: 'ses_2', status: 'starting' },
      { sessionId: 'ses_3', status: 'waiting_for_approval' },
      { sessionId: 'ses_4', status: 'waiting_for_user' },
    );
    await reconcileSessions({ sessions, adapters: adapters(new FakeAdapter()) });
    for (const s of sessions.list())
      expect(['idle', 'completed', 'failed', 'stopped']).toContain(s.status);
  });
});

describe('reconcileSessions on a running daemon', () => {
  it('leaves a session alone when its provider says the turn is still running', async () => {
    const sessions = store({ sessionId: 'ses_busy', status: 'working' });
    const fake = new FakeAdapter('codex');
    fake.sessions.set('ses_busy', {
      sessionId: 'ses_busy',
      projectId: 'proj_a',
      provider: 'codex',
      status: 'working',
      activeTurn: true,
      startedAt: at,
      updatedAt: at,
    });
    const changed = await reconcileSessions({ sessions, adapters: adapters(fake) });
    // Reporting "stopped" here would both lie to the user and release the working tree the
    // session is still writing to.
    expect(changed).toEqual([]);
    expect(sessions.get('ses_busy')?.status).toBe('working');
  });

  it('still clears a session the provider only remembers as idle', async () => {
    const sessions = store({ sessionId: 'ses_idle', status: 'working' });
    const fake = new FakeAdapter('codex');
    fake.sessions.set('ses_idle', {
      sessionId: 'ses_idle',
      projectId: 'proj_a',
      provider: 'codex',
      status: 'idle',
      activeTurn: false,
      startedAt: at,
      updatedAt: at,
    });
    const changed = await reconcileSessions({ sessions, adapters: adapters(fake) });
    expect(changed[0]?.outcome).toBe('resumable');
    expect(sessions.get('ses_idle')?.status).toBe('idle');
  });
});
