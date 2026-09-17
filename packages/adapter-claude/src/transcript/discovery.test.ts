import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLines,
  FIXTURE_CWD,
  FIXTURE_PID,
  FIXTURE_SESSION_ID,
  type InstalledFixtures,
  installTranscriptFixtures,
} from '../__fixtures__/transcripts/install.js';
import {
  ClaudeProcessWatch,
  cwdOfTranscript,
  type DiscoveryEvent,
  readPidFile,
} from './discovery.js';

let home: string;
let fx: InstalledFixtures;
let events: DiscoveryEvent[];
let alive: Set<number>;
let nowMs: number;

const watcher = (opts: { orphans?: boolean; orphanWindowMs?: number } = {}) =>
  new ClaudeProcessWatch({
    home,
    onEvent: (e) => events.push(e),
    isAlive: (pid) => alive.has(pid),
    pollMs: 60_000, // the tests call `poll()` themselves
    orphanSweepMs: 0,
    now: () => nowMs,
    orphans: opts.orphans ?? false,
    ...(opts.orphanWindowMs !== undefined ? { orphanWindowMs: opts.orphanWindowMs } : {}),
  });

const writePid = (pid: number, patch: Record<string, unknown> = {}) => {
  const file = path.join(fx.sessionsDir, `${pid}.json`);
  const base = JSON.parse(fs.readFileSync(fx.pidFile, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...base, pid, ...patch }, null, 2));
  alive.add(pid);
  return file;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-discovery-'));
  fx = installTranscriptFixtures(home);
  events = [];
  alive = new Set([FIXTURE_PID]);
  nowMs = Date.parse('2026-09-17T10:05:00.000Z');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('readPidFile', () => {
  it('reads what Claude records about a live process', () => {
    expect(readPidFile(fx.pidFile)).toEqual({
      pid: FIXTURE_PID,
      sessionId: FIXTURE_SESSION_ID,
      cwd: FIXTURE_CWD,
      entrypoint: 'claude',
      name: 'health endpoint',
      version: '2.1.220',
      liveness: 'live',
    });
  });

  it('is null for a file that is missing, unparsable or the wrong shape', () => {
    expect(readPidFile(path.join(fx.sessionsDir, 'nope.json'))).toBeNull();
    const bad = path.join(fx.sessionsDir, '99.json');
    fs.writeFileSync(bad, '{ not json');
    expect(readPidFile(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ pid: 99 }));
    expect(readPidFile(bad)).toBeNull();
  });
});

describe('ClaudeProcessWatch', () => {
  it('discovers a live process from its pid file', () => {
    const w = watcher();
    w.poll();
    w.stop();
    expect(events).toEqual([
      {
        kind: 'discovered',
        session: {
          pid: FIXTURE_PID,
          sessionId: FIXTURE_SESSION_ID,
          cwd: FIXTURE_CWD,
          entrypoint: 'claude',
          name: 'health endpoint',
          version: '2.1.220',
          liveness: 'live',
        },
      },
    ]);
  });

  it('never opens the 0600 .key beside the pid file', () => {
    // The key file has a session-shaped name and is unreadable JSON; a walk that looked at it
    // would either throw or produce a session. Neither happens.
    const w = watcher();
    w.poll();
    w.stop();
    expect(events).toHaveLength(1);
    expect(fs.readdirSync(fx.sessionsDir).some((n) => n.endsWith('.key'))).toBe(true);
  });

  it('ignores a pid file whose process is gone, and reports one that goes away', () => {
    const w = watcher();
    w.poll();
    expect(events.map((e) => e.kind)).toEqual(['discovered']);
    alive.delete(FIXTURE_PID);
    w.poll();
    expect(events.map((e) => e.kind)).toEqual(['discovered', 'ended']);
    expect(w.size).toBe(0);
    w.poll();
    expect(events).toHaveLength(2);
    w.stop();
  });

  it('counts EPERM as alive — that pid belongs to somebody, so it has not ended', () => {
    const w = new ClaudeProcessWatch({
      home,
      onEvent: (e) => events.push(e),
      isAlive: (pid) => {
        expect(pid).toBe(FIXTURE_PID);
        return true; // what `isProcessAlive` answers for EPERM
      },
      pollMs: 60_000,
      orphans: false,
      now: () => nowMs,
    });
    w.poll();
    w.stop();
    expect(events.map((e) => e.kind)).toEqual(['discovered']);
  });

  it('reports a rename without re-discovering the session', () => {
    const w = watcher();
    w.poll();
    writePid(FIXTURE_PID, { name: 'health endpoint, take two' });
    w.poll();
    w.stop();
    expect(events.map((e) => e.kind)).toEqual(['discovered', 'renamed']);
    const renamed = events[1];
    expect(renamed?.kind === 'renamed' && renamed.previousName).toBe('health endpoint');
    expect(renamed?.kind === 'renamed' && renamed.session.name).toBe('health endpoint, take two');
  });

  it('finds several live sessions at once', () => {
    writePid(5150, {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      entrypoint: 'claude-vscode',
    });
    const w = watcher();
    w.poll();
    w.stop();
    expect(w.size).toBe(2);
    expect(events.map((e) => e.session.entrypoint).sort()).toEqual(['claude', 'claude-vscode']);
  });

  it('seeds a session from a recent transcript whose pid file is gone, as unknown', () => {
    fs.rmSync(fx.pidFile);
    appendLines(fx.transcript, fx.mainLines.slice(0, 2));
    fs.utimesSync(fx.transcript, new Date(nowMs), new Date(nowMs));
    const w = watcher({ orphans: true });
    w.poll();
    w.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.session).toEqual({
      sessionId: FIXTURE_SESSION_ID,
      cwd: FIXTURE_CWD,
      liveness: 'unknown',
    });
  });

  it('leaves a transcript older than the window alone', () => {
    fs.rmSync(fx.pidFile);
    appendLines(fx.transcript, fx.mainLines.slice(0, 2));
    const old = new Date(nowMs - 60 * 60_000);
    fs.utimesSync(fx.transcript, old, old);
    const w = watcher({ orphans: true });
    w.poll();
    w.stop();
    expect(events).toEqual([]);
  });

  it('prefers the pid file: a session with one is never also seeded as unknown', () => {
    appendLines(fx.transcript, fx.mainLines.slice(0, 2));
    fs.utimesSync(fx.transcript, new Date(nowMs), new Date(nowMs));
    const w = watcher({ orphans: true });
    w.poll();
    w.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.session.liveness).toBe('live');
  });
});

describe('cwdOfTranscript', () => {
  it('takes the working directory from the record, not from the directory name', () => {
    appendLines(fx.transcript, fx.mainLines.slice(0, 1));
    expect(cwdOfTranscript(fx.transcript)).toBe(FIXTURE_CWD);
  });

  it('is null for a file with no record that names one', () => {
    fs.writeFileSync(fx.transcript, '{"type":"mode","mode":"plan"}\n');
    expect(cwdOfTranscript(fx.transcript)).toBeNull();
    expect(cwdOfTranscript(path.join(fx.projectDir, 'gone.jsonl'))).toBeNull();
  });
});
