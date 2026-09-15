import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPaths, type IpcServer } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;
let repo = '';

const DEV = `dev_${'a'.repeat(32)}`;

const status = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: `usr_${'b'.repeat(32)}`,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 1,
  sessions: 1,
  pendingApprovals: 0,
  socketPath: 'x',
  pid: 4242,
  startedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  h = harness();
  repo = join(h.home, '..', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

/**
 * The `--json` contract, asserted for every command: stdout is exactly one parseable JSON
 * document and nothing else. Anything a human would want to read goes to stderr.
 */
async function jsonRun(argv: string[]): Promise<{ code: number; json: unknown }> {
  h.stdout.length = 0;
  h.stderr.length = 0;
  const code = await h.run(argv);
  const text = h.stdout.join('\n');
  expect(text.trim(), `stdout for \`${argv.join(' ')}\` was empty`).not.toBe('');
  let parsed: unknown;
  expect(
    () => {
      parsed = JSON.parse(text);
    },
    `stdout for \`${argv.join(' ')}\` was not pure JSON:\n${text}`,
  ).not.toThrow();
  return { code, json: parsed };
}

describe('--json emits one JSON document on stdout and nothing else', () => {
  it('status', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    const { code, json } = await jsonRun(['status', '--json']);
    expect(code).toBe(EXIT.ok);
    expect(json).toMatchObject({ paired: true, deviceId: DEV });
  });

  it('doctor', async () => {
    // A fresh, unpaired home is a healthy install, not a broken one (BR-24).
    const { code, json } = await jsonRun(['doctor', '--json', '--offline']);
    expect(code).toBe(EXIT.ok);
    expect(json).toMatchObject({ ok: true, paired: false, failures: 0 });
    expect(Array.isArray((json as { checks: unknown }).checks)).toBe(true);
  });

  it('projects (empty and populated)', async () => {
    expect((await jsonRun(['projects', '--json'])).json).toEqual([]);
    await h.run(['project', 'add', repo, '--name', 'Tonight']);
    const { json } = await jsonRun(['projects', '--json']);
    expect((json as Array<{ displayName: string }>)[0]?.displayName).toBe('Tonight');
  });

  it('project add / project remove', async () => {
    const added = await jsonRun(['project', 'add', repo, '--name', 'Tonight', '--json']);
    expect(added.code).toBe(EXIT.ok);
    expect(added.json).toMatchObject({ displayName: 'Tonight' });
    // the human narration ("registered …") must not have leaked onto stdout
    expect(plain(h.stdout)).not.toContain('registered');
    const removed = await jsonRun(['project', 'remove', 'Tonight', '--json']);
    expect(removed.json).toMatchObject({ removed: expect.stringMatching(/^proj_/) as unknown });
  });

  it('sessions', async () => {
    server = await fakeDaemon(h.home, { status: () => status(), 'sessions.list': () => [] });
    const { code, json } = await jsonRun(['sessions', '--json']);
    expect(code).toBe(EXIT.ok);
    expect(json).toEqual([]);
  });

  it('daemon install / status / uninstall', async () => {
    const installed = await jsonRun(['daemon', 'install', '--json']);
    expect(installed.json).toMatchObject({ installed: true });
    const st = await jsonRun(['daemon', 'status', '--json']);
    expect(st.json).toMatchObject({ installed: true, running: false });
    const removed = await jsonRun(['daemon', 'uninstall', '--json']);
    expect(removed.json).toMatchObject({ removed: true });
  });

  it('daemon logs', async () => {
    const p = getPaths(h.home);
    mkdirSync(p.logsDir, { recursive: true });
    writeFileSync(p.logFile, ['a', 'b', 'c'].join('\n'));
    const { json } = await jsonRun(['daemon', 'logs', '-n', '2', '--json']);
    expect(json).toMatchObject({ lines: ['b', 'c'] });
  });

  it('billing', async () => {
    const { json } = await jsonRun([
      'billing',
      'upgrade',
      '--web-url',
      'https://app.test',
      '--json',
    ]);
    expect(json).toEqual({ action: 'upgrade', url: 'https://app.test/app/billing?action=upgrade' });
  });

  it('logout', async () => {
    writeFileSync(getPaths(h.home).configFile, JSON.stringify({ deviceId: DEV }));
    const { json } = await jsonRun(['logout', '--json']);
    expect(json).toMatchObject({ deviceId: DEV });
  });

  it('uninstall', async () => {
    const { json } = await jsonRun(['uninstall', '--yes', '--json']);
    expect(json).toMatchObject({ removed: h.home });
  });
});

describe('--json failures are JSON too', () => {
  const cases: Array<[string, string[], number, string]> = [
    ['sessions with no daemon', ['sessions', '--json'], EXIT.daemonDown, 'daemon_down'],
    [
      'project add on a non-git folder',
      ['project', 'add', '__PLAIN__', '--json'],
      EXIT.precondition,
      'error',
    ],
    [
      'daemon logs before the daemon ran',
      ['daemon', 'logs', '--json'],
      EXIT.precondition,
      'no_log_file',
    ],
    ['an unknown billing action', ['billing', 'nope', '--json'], EXIT.usage, 'usage'],
  ];
  for (const [name, argv, exit, code] of cases) {
    it(name, async () => {
      const plainDir = join(h.home, '..', 'plain');
      mkdirSync(plainDir, { recursive: true });
      const { code: got, json } = await jsonRun(
        argv.map((a) => (a === '__PLAIN__' ? plainDir : a)),
      );
      expect(got).toBe(exit);
      expect(json).toMatchObject({ ok: false });
      const error = (json as { error: Record<string, unknown> }).error;
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(exit);
      expect(typeof error.message).toBe('string');
    });
  }

  it('doctor failing prints its report, not a second error document', async () => {
    // A real fault, not merely an unfinished setup: config.json exists and cannot be parsed.
    writeFileSync(getPaths(h.home).configFile, '{"deviceId":');
    const { code, json } = await jsonRun(['doctor', '--json', '--offline']);
    expect(code).toBe(EXIT.precondition);
    expect(json).toHaveProperty('checks');
    expect(json).not.toHaveProperty('error');
  });
});

describe('global flags work before and after the command name', () => {
  it('`pagr --json status` and `pagr status --json` agree', async () => {
    server = await fakeDaemon(h.home, { status: () => status() });
    const a = await jsonRun(['--json', 'status']);
    const b = await jsonRun(['status', '--json']);
    expect(a.json).toEqual(b.json);
  });

  it('`--home` after the command name takes effect', async () => {
    const other = join(h.home, '..', 'other');
    const { json } = await jsonRun(['status', '--home', other, '--json']);
    expect(json).toMatchObject({ home: other });
  });

  it('`--home` on a nested subcommand takes effect', async () => {
    const other = join(h.home, '..', 'other2');
    const { json } = await jsonRun(['daemon', 'status', '--home', other, '--json']);
    expect((json as { plist: string }).plist).toContain('dev.pagr.bridge.plist');
  });
});
