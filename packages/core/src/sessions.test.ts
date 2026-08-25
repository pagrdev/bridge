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
});
