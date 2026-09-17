import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterEvent, MirrorProject } from '@pagr/bridge-core';
import { resetMirrorBridge, setMirrorBridge } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLines,
  FIXTURE_CWD,
  FIXTURE_PID,
  FIXTURE_SESSION_ID,
  type InstalledFixtures,
  installTranscriptFixtures,
} from '../__fixtures__/transcripts/install.js';
import { ClaudeAdapter } from '../adapter.js';

/**
 * The mirror as the adapter owns it: same emitter, same shutdown, and off entirely when the
 * bridge has nobody to answer "which project is this?".
 */

let home: string;
let fx: InstalledFixtures;
let events: AdapterEvent[];

const PROJECT: MirrorProject = {
  projectId: `proj_${'a'.repeat(32)}`,
  path: FIXTURE_CWD,
  displayName: 'pagr-mirror-fixture',
  status: 'registered',
};

const adapter = (over: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}) => {
  const a = new ClaudeAdapter({
    home: path.join(home, '.pagr'),
    log: false,
    env: { HOME: home },
    mirrorOptions: {
      isAlive: (pid) => pid === FIXTURE_PID,
      discoveryPollMs: 60_000,
      tailPollMs: 60_000,
      refreshMs: 60_000,
      orphans: false,
      hookInstalled: () => true,
      env: {},
    },
    ...over,
  });
  a.subscribe((e) => events.push(e));
  return a;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-adapter-mirror-'));
  fx = installTranscriptFixtures(home);
  appendLines(fx.transcript, fx.mainLines.slice(0, 3));
  events = [];
  setMirrorBridge({ wired: true, projectFor: () => PROJECT, report: () => {}, status: () => null });
});
afterEach(() => {
  resetMirrorBridge();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ClaudeAdapter and the mirror', () => {
  it('emits mirrored sessions and frames through the adapter’s own listeners', async () => {
    const a = adapter();
    a.mirror?.tick();
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'frame').map((e) => e.body.kind)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool_call',
      'tool_result',
      'terminal',
    ]);
    await a.shutdown();
  });

  it('reads nothing at all until a daemon has wired the bridge', async () => {
    resetMirrorBridge();
    const a = adapter();
    a.mirror?.tick();
    expect(events).toEqual([]);
    expect(a.mirror?.status()).toMatchObject({ sessions: 0, filesWatched: 0 });
    await a.shutdown();
  });

  it('has no mirror at all under PAGR_MIRROR=0', async () => {
    const a = adapter({ mirrorOptions: { env: { PAGR_MIRROR: '0' } } });
    a.mirror?.tick();
    expect(events).toEqual([]);
    expect(a.mirror?.enabled).toBe(false);
    await a.shutdown();
  });

  it('can be turned off by the embedder outright', async () => {
    const a = adapter({ mirror: false });
    expect(a.mirror).toBeNull();
    await a.shutdown();
  });

  it('leaves alone a Claude session it is driving itself', async () => {
    const a = adapter();
    expect(a.ownsClaudeSession(FIXTURE_SESSION_ID)).toBe(false);
    // Stand in for a live session the adapter spawned.
    // biome-ignore lint/suspicious/noExplicitAny: reaching the adapter's private session map
    (a as any).sessions.set('ses_x', { claudeSessionId: FIXTURE_SESSION_ID });
    expect(a.ownsClaudeSession(FIXTURE_SESSION_ID)).toBe(true);
    a.mirror?.tick();
    expect(events).toEqual([]);
    await a.shutdown();
  });

  it('stops the mirror when the adapter shuts down', async () => {
    const a = adapter();
    a.mirror?.tick();
    expect(a.mirror?.status().sessions).toBe(1);
    await a.shutdown();
    expect(a.mirror?.status().sessions).toBe(0);
    events = [];
    a.mirror?.tick();
    expect(events).toEqual([]);
  });
});
