import type { IpcServer } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDuration } from '../commands/sessions.js';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

/**
 * `pagr sessions`, and the two things B12 added to it.
 *
 * The listing gained the columns the phone already had — where a session came from, how much of it
 * Pagr may drive, how much transcript is on this Mac — and two subcommands that exist so the
 * backfill path can be exercised, and the disk reclaimed, without a phone in the loop.
 */
let h: Harness;
let server: IpcServer | null = null;
let purgeCalls: unknown[];
let backfillCalls: unknown[];

const DEV = `dev_${'a'.repeat(32)}`;
const PROJ = `proj_${'p'.repeat(32)}`;
const PAGR_SESSION = `ses_${'1'.repeat(32)}`;
const MINE = `ses_${'2'.repeat(32)}`;

const status = () => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: `usr_${'b'.repeat(32)}`,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 1,
  sessions: 2,
  adoptedSessions: 1,
  unregisteredSessions: 0,
  pendingApprovals: 0,
  socketPath: '/tmp/x.sock',
  pid: 123,
  startedAt: '2026-09-15T00:00:00.000Z',
});

const sessions = () => [
  {
    sessionId: PAGR_SESSION,
    provider: 'codex',
    projectId: PROJ,
    providerSessionId: 'thr',
    status: 'working',
    startedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
  {
    sessionId: MINE,
    provider: 'claude',
    projectId: PROJ,
    providerSessionId: 'their-claude',
    status: 'idle',
    adopted: true,
    adoptedAt: '2026-09-15T00:00:00.000Z',
    cwd: '/Users/jane/repo',
    startedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
];

const journals = () => ({
  [PAGR_SESSION]: {
    lastSeq: 412,
    bytes: 2_500_000,
    sent: 412,
    acked: 400,
    updatedAt: '2026-09-15T00:00:00.000Z',
  },
  [MINE]: { lastSeq: 7, bytes: 900, sent: 7, acked: 7, updatedAt: '2026-09-15T00:00:00.000Z' },
});

beforeEach(async () => {
  h = harness();
  purgeCalls = [];
  backfillCalls = [];
  server = await fakeDaemon(h.home, {
    status: () => status(),
    'sessions.list': () => sessions(),
    'sessions.journal': () => journals(),
    'projects.list': () => [{ projectId: PROJ, displayName: 'repo', path: '/Users/jane/repo' }],
    'sessions.purge': (p) => {
      purgeCalls.push(p);
      return { removed: [MINE], bytesFreed: 900, totalBytes: 2_500_000 };
    },
    'sessions.backfill': (p) => {
      backfillCalls.push(p);
      return { frames: 412, bytes: 2_400_000, lastSeq: 412, truncated: true };
    },
  });
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const out = () => plain(h.stdout);

describe('pagr sessions', () => {
  it('shows origin, control level, last seq and journal size', async () => {
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    const text = out();
    expect(text).toContain('ORIGIN');
    expect(text).toContain('CONTROL');
    expect(text).toContain('SEQ');
    expect(text).toContain('JOURNAL');
    // The Pagr-started session: full control, 412 frames, 2.4M of transcript.
    expect(text).toMatch(/ses_1{32}\s+codex\s+working\s+repo\s+pagr\s+full\s+412\s+2\.4M/);
    // The one from their own terminal: approvals only.
    expect(text).toMatch(/ses_2{32}\s+claude\s+idle\s+repo\s+terminal\s+approvals\s+7\s+900B/);
    expect(text).toContain('`pagr sessions purge` frees what is past retention');
  });

  it('says nothing about the journal when there is none', async () => {
    await server?.close();
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'sessions.list': () => sessions(),
      'sessions.journal': () => ({}),
      'projects.list': () => [],
    });
    expect(await h.run(['sessions'])).toBe(EXIT.ok);
    expect(out()).not.toContain('pagr sessions purge');
  });
});

describe('pagr sessions purge', () => {
  it('refuses to delete anything without --yes, and says what it would not touch', async () => {
    expect(await h.run(['sessions', 'purge'])).toBe(EXIT.ok);
    expect(purgeCalls).toEqual([]);
    const text = out();
    expect(text).toContain('~/.pagr/journal');
    expect(text).toContain('nothing under ~/.claude is touched');
    expect(text).toContain('--yes');
  });

  it('passes --older-than through as days', async () => {
    expect(await h.run(['sessions', 'purge', '--older-than', '7d', '--yes'])).toBe(EXIT.ok);
    expect(purgeCalls).toEqual([{ days: 7 }]);
    expect(out()).toContain('purged 1 journal(s)');
  });

  it('defaults to the 30-day retention', async () => {
    expect(await h.run(['sessions', 'purge', '--yes'])).toBe(EXIT.ok);
    expect(purgeCalls).toEqual([{ days: 30 }]);
  });

  it('rejects an age it cannot read rather than guessing at one', async () => {
    expect(await h.run(['sessions', 'purge', '--older-than', 'a while', '--yes'])).toBe(EXIT.usage);
    expect(purgeCalls).toEqual([]);
  });

  it('still needs --yes in --json mode', async () => {
    expect(await h.run(['sessions', 'purge', '--json'])).toBe(EXIT.ok);
    expect(purgeCalls).toEqual([]);
    expect(lastJson(h)).toMatchObject({ purged: false, reason: 'needs --yes' });
  });
});

describe('pagr sessions backfill', () => {
  it('runs the same code path a phone would, and reports what came out', async () => {
    expect(await h.run(['sessions', 'backfill', PAGR_SESSION, '--from', '200'])).toBe(EXIT.ok);
    expect(backfillCalls).toEqual([
      { sessionId: PAGR_SESSION, fromSeq: 200, maxBytes: 16 * 1024 * 1024 },
    ]);
    const text = out();
    expect(text).toContain('backfilled 412 frame(s)');
    expect(text).toContain('up to #412');
    expect(text).toContain('more remains');
  });

  it('starts at the first frame when --from is not given', async () => {
    expect(await h.run(['sessions', 'backfill', PAGR_SESSION, '--json'])).toBe(EXIT.ok);
    expect(backfillCalls).toEqual([
      { sessionId: PAGR_SESSION, fromSeq: 1, maxBytes: 16 * 1024 * 1024 },
    ]);
    expect(lastJson(h)).toMatchObject({ frames: 412, lastSeq: 412, truncated: true });
  });

  it('refuses a --from that is not a number', async () => {
    expect(await h.run(['sessions', 'backfill', PAGR_SESSION, '--from', 'soon'])).toBe(EXIT.usage);
    expect(backfillCalls).toEqual([]);
  });
});

describe('parseDuration', () => {
  it('reads days, hours and minutes, and nothing else', () => {
    expect(parseDuration('30d')).toBe(30 * 86_400_000);
    expect(parseDuration('12h')).toBe(12 * 3_600_000);
    expect(parseDuration('45m')).toBe(45 * 60_000);
    expect(parseDuration('30')).toBeNull();
    expect(parseDuration('2w')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});
