import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessions.js';
import { useTempHome } from './testUtil.js';

describe('SessionStore', () => {
  const t = useTempHome();

  it('persists and reloads records', () => {
    const file = join(t.home, 'sessions.json');
    const s = new SessionStore(file, () => new Date('2026-01-01T00:00:00Z'));
    s.upsert({
      sessionId: 'ses_1',
      provider: 'codex',
      projectId: 'proj_1',
      providerSessionId: 'thr_1',
      status: 'working',
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(s.get('ses_1')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    const s2 = new SessionStore(file);
    expect(s2.has('ses_1')).toBe(true);
    expect(s2.setStatus('ses_1', 'completed')?.status).toBe('completed');
    expect(s2.setStatus('ses_nope', 'completed')).toBeNull();
    s2.remove('ses_1');
    expect(new SessionStore(file).list()).toEqual([]);
  });

  it('keeps completed sessions for at least 24h; pruneTerminal only drops old terminal ones (item 17)', () => {
    const file = join(t.home, 'sessions.json');
    const base = new Date('2026-01-02T00:00:00Z');
    let clock = base;
    const s = new SessionStore(file, () => clock);
    const rec = (id: string, status: 'completed' | 'working' | 'stopped', ageH: number) =>
      s.upsert({
        sessionId: id,
        provider: 'claude',
        projectId: 'proj_1',
        providerSessionId: id,
        status,
        startedAt: base.toISOString(),
        updatedAt: new Date(base.getTime() - ageH * 3600_000).toISOString(),
      });
    rec('ses_done_fresh', 'completed', 23);
    rec('ses_done_old', 'completed', 25);
    rec('ses_stopped_old', 'stopped', 200);
    rec('ses_working_old', 'working', 200);
    clock = base;
    expect(s.pruneTerminal(24 * 3600_000)).toBe(2);
    expect(
      new SessionStore(file)
        .list()
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual(['ses_done_fresh', 'ses_working_old']);
    // a completed session is still usable (resumable) after reload
    expect(new SessionStore(file).get('ses_done_fresh')?.status).toBe('completed');
  });

  it('caps the file at a fixed number of records, oldest terminal first', () => {
    const file = join(t.home, 'sessions.json');
    const base = new Date('2026-01-02T00:00:00Z');
    const s = new SessionStore(file, () => base);
    for (let i = 0; i < 10; i++)
      s.upsert({
        sessionId: `ses_${i}`,
        provider: 'codex',
        projectId: 'proj_1',
        providerSessionId: `t${i}`,
        status: i < 8 ? 'completed' : 'working',
        startedAt: base.toISOString(),
        updatedAt: new Date(base.getTime() - (10 - i) * 60_000).toISOString(),
      });
    expect(s.capEntries(4)).toBe(6);
    expect(s.size).toBe(4);
    // the live ones survived; the oldest completed ones went first
    const ids = s
      .list()
      .map((r) => r.sessionId)
      .sort();
    expect(ids).toEqual(['ses_6', 'ses_7', 'ses_8', 'ses_9']);
    expect(new SessionStore(file).size).toBe(4);
  });

  it('evicts live records only when terminal ones cannot free enough room', () => {
    const base = new Date('2026-01-02T00:00:00Z');
    const s = new SessionStore(undefined, () => base);
    for (let i = 0; i < 4; i++)
      s.upsert({
        sessionId: `ses_${i}`,
        provider: 'codex',
        projectId: 'proj_1',
        providerSessionId: `t${i}`,
        status: 'working',
        startedAt: base.toISOString(),
        updatedAt: new Date(base.getTime() - (4 - i) * 60_000).toISOString(),
      });
    expect(s.capEntries(2)).toBe(2);
    expect(s.list().map((r) => r.sessionId)).toEqual(['ses_2', 'ses_3']);
  });

  it('is a no-op when already under the ceiling', () => {
    const s = new SessionStore();
    expect(s.capEntries(10)).toBe(0);
  });

  it('prune applies retention and the ceiling together', () => {
    const base = new Date('2026-01-10T00:00:00Z');
    const s = new SessionStore(undefined, () => base);
    for (let i = 0; i < 6; i++)
      s.upsert({
        sessionId: `ses_${i}`,
        provider: 'claude',
        projectId: 'proj_1',
        providerSessionId: `t${i}`,
        status: 'completed',
        startedAt: base.toISOString(),
        // three of them are older than a day
        updatedAt: new Date(base.getTime() - (i < 3 ? 48 : 1) * 3600_000).toISOString(),
      });
    expect(s.prune({ retentionMs: 24 * 3600_000, maxEntries: 2 })).toEqual({
      expired: 3,
      evicted: 1,
    });
    expect(s.size).toBe(2);
  });
});
