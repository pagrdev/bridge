import type { IpcServer } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

/**
 * Sessions the bridge did not start, as the person sees them.
 *
 * They have to be distinguishable from Pagr's own, because what can be done with them differs:
 * their approvals can be answered from the phone, but they cannot be sent an instruction, stopped
 * or resumed — the terminal they are running in owns them.
 */
let h: Harness;
let server: IpcServer | null = null;

const DEV = `dev_${'a'.repeat(32)}`;
const PROJ = `proj_${'p'.repeat(32)}`;

beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const out = () => plain(h.stdout);

const status = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: `usr_${'b'.repeat(32)}`,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 1,
  sessions: 3,
  adoptedSessions: 2,
  unregisteredSessions: 1,
  pendingApprovals: 0,
  socketPath: '/tmp/x.sock',
  pid: 123,
  startedAt: '2026-09-15T00:00:00.000Z',
  ...over,
});

const sessions = () => [
  {
    sessionId: `ses_${'1'.repeat(32)}`,
    provider: 'codex',
    projectId: PROJ,
    providerSessionId: 'thr',
    status: 'working',
    startedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
  {
    sessionId: `ses_${'2'.repeat(32)}`,
    provider: 'claude',
    projectId: PROJ,
    providerSessionId: 'their-claude-1',
    status: 'waiting_for_approval',
    adopted: true,
    adoptedAt: '2026-09-15T00:00:00.000Z',
    cwd: '/Users/jane/repo',
    startedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
  {
    sessionId: `ses_${'3'.repeat(32)}`,
    provider: 'claude',
    projectId: '',
    providerSessionId: 'their-claude-2',
    status: 'idle',
    adopted: true,
    adoptedAt: '2026-09-15T00:00:00.000Z',
    cwd: '/Users/jane/scratch',
    startedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
];

describe('pagr sessions', () => {
  beforeEach(async () => {
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'sessions.list': () => sessions(),
      'projects.list': () => [{ projectId: PROJ, displayName: 'repo', path: '/Users/jane/repo' }],
    });
  });

  it('marks the ones Pagr did not start, and says what it cannot do with them', async () => {
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    const text = out();
    expect(text).toContain('yours');
    expect(text).toMatch(/approvals only|cannot be steered|relay approvals/i);
  });

  it('names the directory of a session that is in no registered project, with the fix', async () => {
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    const text = out();
    expect(text).toContain('/Users/jane/scratch');
    expect(text).toContain('pagr projects add');
  });

  it('passes the raw records through untouched with --json', async () => {
    expect(await h.run(['sessions', '--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toEqual(sessions());
  });
});

describe('pagr status', () => {
  it('counts the adopted sessions separately from the ones Pagr started', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(out()).toMatch(/3 .*2 (of them are |)your own/i);
  });

  it('reports them in --json too', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['status', '--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({ sessions: 3, adoptedSessions: 2, unregisteredSessions: 1 });
  });

  it('says nothing about adopted sessions when an older daemon does not report them', async () => {
    server = await fakeDaemon(h.home, {
      status: () => {
        const s = status() as Record<string, unknown>;
        delete s.adoptedSessions;
        delete s.unregisteredSessions;
        return s;
      },
    });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(out()).not.toMatch(/your own/i);
  });
});
