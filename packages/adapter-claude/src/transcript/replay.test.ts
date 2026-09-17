import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterEvent, MirrorBridge, MirrorProject, MirrorStatus } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLines,
  FIXTURE_CWD,
  FIXTURE_PID,
  FIXTURE_SESSION_ID,
  type InstalledFixtures,
  installTranscriptFixtures,
} from '../__fixtures__/transcripts/install.js';
import { ClaudeMirror } from './mirror.js';
import { replayTranscript } from './replay.js';

/**
 * A replay is a mirror that already happened.
 *
 * The property that actually matters is not "the replay produces frames" — it is that it produces
 * the SAME frames, with the same `providerRecordId`s, as the live mirror would have. That is what
 * makes backfilling a session the bridge already streamed cost nothing: the journal dedupes every
 * frame on that id. So the tests below run both readers over one fixture and compare.
 */

let home: string;
let fx: InstalledFixtures;
let reported: MirrorStatus | null;

const PROJECT: MirrorProject = {
  projectId: `proj_${'a'.repeat(32)}`,
  path: FIXTURE_CWD,
  displayName: 'pagr-mirror-fixture',
  status: 'registered',
};

const bridge: MirrorBridge = {
  wired: true,
  projectFor: () => PROJECT,
  report: (s) => {
    reported = s;
  },
  status: () => reported,
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-replay-'));
  fx = installTranscriptFixtures(home);
  reported = null;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const replay = () =>
  replayTranscript({
    home,
    cwd: FIXTURE_CWD,
    claudeSessionId: FIXTURE_SESSION_ID,
    projectPath: PROJECT.path,
  });

/** What the live mirror makes of the same files, for comparison. */
function mirrored(): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const m = new ClaudeMirror({
    home,
    pagrHome: null,
    emit: (e) => events.push(e),
    bridge,
    env: {},
    isAlive: (pid) => pid === FIXTURE_PID,
    discoveryPollMs: 60_000,
    tailPollMs: 60_000,
    refreshMs: 60_000,
    orphans: false,
    hookInstalled: () => true,
  });
  m.start();
  m.tick();
  m.tick();
  m.stop();
  return events;
}

describe('replayTranscript', () => {
  it('reads the whole session in one pass, superseded variants and subagents included', () => {
    appendLines(fx.transcript, fx.mainLines);
    fs.writeFileSync(fx.supersededSource, `${fx.supersededLines.join('\n')}\n`);
    fs.writeFileSync(
      path.join(fx.subagentDir, 'agent-a1.jsonl'),
      `${fx.subagentLines.join('\n')}\n`,
    );

    const frames = replay();
    expect(frames.length).toBeGreaterThan(0);
    // Every frame says it is a replay, whatever file it came out of.
    expect(frames.every((f) => f.meta.source === 'backfill')).toBe(true);
    // The superseded file is part of the session, so its user turn is in there…
    expect(frames.some((f) => f.body.kind === 'user' && f.body.text === 'Earlier attempt')).toBe(
      true,
    );
    // …and a subagent's ids are scoped, exactly as the mirror scopes them.
    expect(frames.some((f) => f.providerRecordId?.startsWith('agent:a1:'))).toBe(true);
  });

  it('produces the same bodies and record ids the live mirror would have', () => {
    appendLines(fx.transcript, fx.mainLines);
    const live = mirrored().flatMap((e) => (e.kind === 'frame' ? [e] : []));
    const frames = replay();

    expect(live.length).toBeGreaterThan(0);
    expect(frames.map((f) => f.body)).toEqual(live.map((f) => f.body));
    expect(frames.map((f) => f.providerRecordId)).toEqual(live.map((f) => f.providerRecordId));
    // Same metadata but for where it came from — which is the whole difference.
    expect(frames.map((f) => ({ ...f.meta, source: 'transcript' }))).toEqual(
      live.map((f) => f.meta),
    );
  });

  it('reads a command’s spilled output back, as the live path does', () => {
    appendLines(fx.transcript, fx.mainLines);
    const terminal = replay().find((f) => f.body.kind === 'terminal');
    expect(terminal?.body.kind === 'terminal' && terminal.body.stdout).toContain(
      fs
        .readFileSync(
          path.join(
            home,
            '.claude',
            'projects',
            '-tmp-pagr-mirror-fixture',
            FIXTURE_SESSION_ID,
            'tool-results',
            'bash1.txt',
          ),
          'utf8',
        )
        .trim()
        .split('\n')[0] as string,
    );
  });

  it('leaves the live tailer’s offsets alone: a replay is not a read', () => {
    appendLines(fx.transcript, fx.mainLines);
    const stateFile = path.join(home, '.pagr', 'tailer-state.json');
    replay();
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('is empty, not an error, for a session with no transcript at all', () => {
    expect(
      replayTranscript({ home, cwd: FIXTURE_CWD, claudeSessionId: 'no-such-session-id' }),
    ).toEqual([]);
  });
});
