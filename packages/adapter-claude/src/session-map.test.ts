import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SESSION_ENTRIES,
  DEFAULT_SESSION_RETENTION_MS,
  type PersistedSession,
  SessionMap,
} from './session-map.js';

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 8, 1);

describe('SessionMap retention (BR-3)', () => {
  let home: string;
  let file: string;

  const entry = (i: number, lastStatus: string, ageDays: number): PersistedSession => ({
    claudeSessionId: `uuid-${i}`,
    projectId: 'proj_0000000000000000000000000000000a',
    projectPath: '/tmp/repo',
    startedAt: new Date(NOW - ageDays * DAY).toISOString(),
    updatedAt: new Date(NOW - ageDays * DAY).toISOString(),
    lastStatus,
  });
  const id = (i: number) => `ses_${i.toString(16).padStart(32, '0')}`;

  beforeEach(() => {
    // Never the real PAGR_HOME: everything here is a throwaway temp dir.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-map-'));
    file = path.join(home, 'claude-sessions.json');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('ages out terminal entries and keeps everything else', () => {
    const map = new SessionMap(file);
    map.set(id(1), entry(1, 'completed', 30));
    map.set(id(2), entry(2, 'failed', 8));
    map.set(id(3), entry(3, 'completed', 2));
    map.set(id(4), entry(4, 'working', 400));
    expect(map.prune({ nowMs: NOW })).toEqual({ expired: 2, evicted: 0 });
    expect(
      map
        .entries()
        .map(([k]) => k)
        .sort(),
    ).toEqual([id(3), id(4)].sort());
    // Survives a reload: the sweep is persisted, not just in memory.
    expect(new SessionMap(file).size).toBe(2);
  });

  it('caps a 1200-entry map, oldest terminal first, and never drops a live session', () => {
    const map = new SessionMap(file);
    for (let i = 0; i < 1200; i++) map.set(id(i), entry(i, 'completed', 1 + (1200 - i) / 1000));
    const live = id(9999);
    map.set(live, entry(9999, 'working', 365));
    expect(map.size).toBe(1201);
    const dropped = map.prune({ nowMs: NOW, protect: new Set([live]) });
    expect(map.size).toBe(DEFAULT_MAX_SESSION_ENTRIES);
    expect(dropped.expired + dropped.evicted).toBe(1201 - DEFAULT_MAX_SESSION_ENTRIES);
    // The oldest live session is worth more than the newest dead one.
    expect(map.get(live)).toBeTruthy();
    expect(map.get(id(1199))).toBeTruthy();
    expect(map.get(id(0))).toBeUndefined();
  });

  it('evicts a non-terminal entry only when terminal ones cannot get under the ceiling', () => {
    const map = new SessionMap(file);
    for (let i = 0; i < 10; i++) map.set(id(i), entry(i, 'working', 10 - i));
    map.prune({ nowMs: NOW, maxEntries: 4, protect: new Set([id(9)]) });
    expect(map.size).toBe(4);
    expect(map.get(id(9))).toBeTruthy(); // protected
    expect(map.get(id(0))).toBeUndefined(); // oldest goes first
  });

  it('retains terminal sessions for a week by default', () => {
    const map = new SessionMap(file);
    map.set(id(1), entry(1, 'completed', 6));
    map.prune({ nowMs: NOW });
    expect(map.size).toBe(1);
    map.prune({ nowMs: NOW + DEFAULT_SESSION_RETENTION_MS });
    expect(map.size).toBe(0);
  });
});
