import { writeFileSync } from 'node:fs';
import { getPaths, type IpcServer } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;

const DEV = `dev_${'a'.repeat(32)}`;
const KID_A = 'aabb:ccdd:eeff:0011';
const KID_B = '0011:2233:4455:6677';

const status = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.2.0',
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
  socketPath: 'x',
  pid: 4242,
  startedAt: '2026-09-17T00:00:00.000Z',
  remoteProjectPick: { enabled: true, handles: 0 },
  protocolVersion: 2,
  recipientKeyIds: [KID_B, KID_A],
  keepAwake: {
    held: true,
    reasons: ['sessions'],
    since: '2026-09-17T00:00:00.000Z',
    disabled: false,
  },
  channel: { serverInstalled: true, registered: true, boundSessions: 1, mode: 'queued_next_turn' },
  mirror: {
    enabled: true,
    sessions: 3,
    filesWatched: 4,
    unknownRecordTypes: 0,
    lastFrameAt: new Date().toISOString(),
  },
  journalBytes: 3 * 1024 * 1024,
  ...over,
});

beforeEach(() => {
  h = harness();
  writeFileSync(getPaths(h.home).configFile, JSON.stringify({ deviceId: DEV }));
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const out = () => plain(h.stdout);

/**
 * `pagr status` after v2.
 *
 * Six facts decide whether the phone half of Pagr works at all, and until now none of them were
 * visible without running `pagr doctor`: what version the link settled on, which phones can read
 * what this Mac sends, whether the Mac will stay awake, whether a terminal can be given a turn,
 * whether your own sessions are mirrored, and how much plaintext transcript is on this disk.
 */
describe('pagr status · the phone link', () => {
  it('prints one line each, in the order a person would ask about them', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    const text = out();
    const block = text.slice(text.indexOf('Phone link'));
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines[0]).toBe('Phone link');
    expect(lines.slice(1, 7).map((l) => l.split(/\s{2,}|:/)[0]?.trim())).toEqual([
      'protocol',
      'phone keys',
      'keep-awake',
      'channel',
      'mirror',
      'journal',
    ]);
  });

  it('says v2 in words, and shows every fingerprint rather than a count', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(out()).toContain('v2 — sealed transcript frames, questions, backfill');
    // Sorted as the daemon reports them, and printed in full: a fingerprint is the thing a
    // person compares against what their phone shows, and one you cannot read is one you
    // cannot check.
    expect(out()).toContain(`2 phone(s): ${KID_B}, ${KID_A}`);
    expect(out()).toContain('3.0 MB of plaintext transcript');
    expect(out()).toContain('registered, 1 session(s) bound');
  });

  it('is honest when there is nothing to report rather than implying "none"', async () => {
    server = await fakeDaemon(h.home, {
      status: () =>
        status({
          protocolVersion: 1,
          recipientKeyIds: [],
          channel: {
            serverInstalled: false,
            registered: false,
            boundSessions: 0,
            mode: 'off',
          },
          journalBytes: 0,
          mirror: undefined,
        }),
    });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(out()).toContain('v1 — summaries only; this gateway has not accepted v2');
    expect(out()).toContain('none — nothing can be sealed');
    expect(out()).toContain('not registered — terminal sessions stay approvals-only');
    expect(out()).toContain('nothing mirrored yet');
  });

  it('says nothing about the link at all when the daemon is not running', async () => {
    expect(await h.run(['status'])).toBe(EXIT.ok);
    // Absent, not guessed at: a stopped daemon knows nothing about a connection.
    expect(out()).not.toContain('Phone link');
  });

  it('--json carries the same six facts for scripts', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    expect(await h.run(['status', '--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      protocolVersion: 2,
      recipientKeyIds: [KID_B, KID_A],
      channel: { registered: true, mode: 'queued_next_turn' },
      journalBytes: 3 * 1024 * 1024,
    });
  });
});
