import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterEvent, MirrorBridge, MirrorProject, MirrorStatus } from '@pagr/bridge-core';
import { ChannelBridge, JournalStore, syntheticSessionId } from '@pagr/bridge-core';
import type { SessionSummaryV2 } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLines,
  FIXTURE_CWD,
  FIXTURE_PID,
  FIXTURE_SESSION_ID,
  type InstalledFixtures,
  installTranscriptFixtures,
} from '../__fixtures__/transcripts/install.js';
import { ChannelMode } from '../channel-mode.js';
import { ClaudeMirror, originOf, syntheticClaudeSessionId } from './mirror.js';

let home: string;
let fx: InstalledFixtures;
let events: AdapterEvent[];
let project: MirrorProject | null;
let reported: MirrorStatus | null;

const REGISTERED: MirrorProject = {
  projectId: `proj_${'a'.repeat(32)}`,
  path: FIXTURE_CWD,
  displayName: 'pagr-mirror-fixture',
  status: 'registered',
};
const UNREGISTERED: MirrorProject = {
  projectId: `proj_${'b'.repeat(32)}`,
  path: FIXTURE_CWD,
  displayName: 'pagr-mirror-fixture',
  status: 'unregistered',
  handle: `rh_${'c'.repeat(32)}`,
};

const bridge: MirrorBridge = {
  wired: true,
  projectFor: () => project,
  report: (s) => {
    reported = s;
  },
  status: () => reported,
};

const sessions = (): SessionSummaryV2[] =>
  events.flatMap((e) => (e.kind === 'session' ? [e.session] : []));
const frames = () => events.flatMap((e) => (e.kind === 'frame' ? [e] : []));
const latest = (): SessionSummaryV2 => sessions()[sessions().length - 1] as SessionSummaryV2;

function mirror(opts: Partial<ConstructorParameters<typeof ClaudeMirror>[0]> = {}): ClaudeMirror {
  return new ClaudeMirror({
    home,
    pagrHome: path.join(home, '.pagr'),
    emit: (e) => events.push(e),
    bridge,
    env: {},
    isAlive: (pid) => pid === FIXTURE_PID,
    discoveryPollMs: 60_000,
    tailPollMs: 60_000,
    refreshMs: 60_000,
    orphans: false,
    hookInstalled: () => true,
    ...opts,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-mirror-'));
  fx = installTranscriptFixtures(home);
  events = [];
  reported = null;
  project = REGISTERED;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('session identity', () => {
  it('mints the same ses_… the daemon adopts a hook session under', () => {
    expect(syntheticClaudeSessionId(FIXTURE_SESSION_ID)).toBe(
      syntheticSessionId('claude', FIXTURE_SESSION_ID),
    );
  });

  it('calls the plain CLI a terminal and anything else an IDE', () => {
    expect(originOf(undefined)).toBe('terminal');
    expect(originOf('claude')).toBe('terminal');
    expect(originOf('claude-vscode')).toBe('ide');
    expect(originOf('claude-jetbrains')).toBe('ide');
  });
});

describe('control levels', () => {
  it('is approvals_only for a registered project with the hook installed', () => {
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    expect(latest()).toMatchObject({
      sessionId: syntheticSessionId('claude', FIXTURE_SESSION_ID),
      projectId: REGISTERED.projectId,
      controlLevel: 'approvals_only',
      origin: 'terminal',
      projectStatus: 'registered',
      displayName: 'health endpoint',
    });
  });

  it('is mirror_only when the project is registered and the hook is not installed', () => {
    const m = mirror({ hookInstalled: () => false });
    m.start();
    m.tick();
    m.stop();
    expect(latest().controlLevel).toBe('mirror_only');
  });

  it('is full when a channel is bound to that session', () => {
    const attached = {
      bindingFor: () => ({ cwd: FIXTURE_CWD, projectId: REGISTERED.projectId }),
      isAttached: () => true,
    };
    const m = mirror({
      channel: new ChannelMode(attached as unknown as ConstructorParameters<typeof ChannelMode>[0]),
    });
    m.start();
    m.tick();
    m.stop();
    expect(latest().controlLevel).toBe('full');
  });

  /**
   * Binding is per Claude SESSION now, so "something in this directory is polling" is not enough.
   * Two `claude` windows in one repo and only one started with `pagr claude` must not both be
   * advertised as steerable, or a follow-up lands in the wrong terminal.
   */
  it('is NOT full for a session the channel has not bound, even in an attached project', () => {
    const attachedButUnbound = {
      bindingFor: () => undefined,
      isAttached: () => true,
    };
    const m = mirror({
      channel: new ChannelMode(
        attachedButUnbound as unknown as ConstructorParameters<typeof ChannelMode>[0],
      ),
    });
    m.start();
    m.tick();
    m.stop();
    expect(latest().controlLevel).toBe('approvals_only');
  });

  it('falls back to approvals_only when the channel stops polling (TTL expiry)', () => {
    let clock = 1_000_000;
    const ttl = new ChannelBridge(() => clock, 1000);
    const sessionId = syntheticSessionId('claude', FIXTURE_SESSION_ID);
    ttl.bindSession(sessionId, {
      cwd: FIXTURE_CWD,
      projectId: REGISTERED.projectId,
      claudeSessionId: FIXTURE_SESSION_ID,
    });
    ttl.attach(FIXTURE_CWD);
    const m = mirror({ channel: new ChannelMode(ttl) });
    m.start();
    m.tick();
    expect(latest().controlLevel).toBe('full');
    const before = sessions().length;
    // Two missed long polls: the `claude` that owned the channel is gone.
    clock += 2000;
    m.tick();
    m.stop();
    expect(latest().controlLevel).toBe('approvals_only');
    // And the phone was told: a card left showing "full" would offer a button that cannot work.
    expect(sessions().length).toBeGreaterThan(before);
  });

  it('calls an IDE session an IDE session', () => {
    fs.writeFileSync(
      fx.pidFile,
      JSON.stringify({
        ...(JSON.parse(fs.readFileSync(fx.pidFile, 'utf8')) as Record<string, unknown>),
        entrypoint: 'claude-vscode',
      }),
    );
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    expect(latest().origin).toBe('ide');
  });

  it('tells the phone when the level changes, and only then', () => {
    const m = mirror({ hookInstalled: () => hook });
    let hook = false;
    m.start();
    m.tick();
    expect(sessions()).toHaveLength(1);
    m.tick();
    expect(sessions()).toHaveLength(1);
    hook = true;
    m.tick();
    m.stop();
    expect(sessions()).toHaveLength(2);
    expect(sessions().map((s) => s.controlLevel)).toEqual(['mirror_only', 'approvals_only']);
  });

  it('restates a long-lived session hourly, so the daemon does not age it out', () => {
    let clock = Date.parse('2026-09-17T12:00:00.000Z');
    const m = mirror({ now: () => new Date(clock) });
    m.start();
    m.tick();
    expect(sessions()).toHaveLength(1);
    clock += 59 * 60_000;
    m.tick();
    expect(sessions()).toHaveLength(1);
    clock += 2 * 60_000;
    m.tick();
    m.stop();
    expect(sessions()).toHaveLength(2);
    expect(sessions()[1]?.updatedAt).toBe(new Date(clock).toISOString());
  });

  it('reports the session stopped when the process goes away', () => {
    let live = true;
    const m = mirror({ isAlive: () => live });
    m.start();
    m.tick();
    live = false;
    m.tick();
    m.stop();
    expect(latest()).toMatchObject({ status: 'stopped', endedAt: expect.any(String) });
  });
});

describe('an unregistered working directory', () => {
  beforeEach(() => {
    project = UNREGISTERED;
    appendLines(fx.transcript, fx.mainLines);
  });

  it('is reported with control none, a handle to register it, and no frames at all', () => {
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    expect(latest()).toMatchObject({
      projectId: UNREGISTERED.projectId,
      controlLevel: 'none',
      projectStatus: 'unregistered',
      repoHandle: UNREGISTERED.handle,
    });
    expect(frames()).toEqual([]);
  });

  it('is not reported at all under PAGR_MIRROR_UNREGISTERED=0', () => {
    const m = mirror({ env: { PAGR_MIRROR_UNREGISTERED: '0' } });
    m.start();
    m.tick();
    m.stop();
    expect(events).toEqual([]);
  });

  it('starts producing frames the moment the folder is registered', () => {
    const m = mirror();
    m.start();
    m.tick();
    expect(frames()).toEqual([]);
    project = REGISTERED; // one tap on the phone: `project.register_handle`
    m.tick();
    m.stop();
    expect(latest()).toMatchObject({
      projectId: REGISTERED.projectId,
      controlLevel: 'approvals_only',
      projectStatus: 'registered',
    });
    expect(frames().length).toBeGreaterThan(0);
    expect(latest().repoHandle).toBeUndefined();
  });
});

describe('the mirror is off', () => {
  it('does nothing at all under PAGR_MIRROR=0', () => {
    const m = mirror({ env: { PAGR_MIRROR: '0' } });
    m.start();
    m.tick();
    m.stop();
    expect(events).toEqual([]);
    expect(m.status()).toMatchObject({ enabled: false, sessions: 0 });
  });

  it('leaves a session the adapter is already driving to its own pipe', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror({ ownsClaudeSession: (id) => id === FIXTURE_SESSION_ID });
    m.start();
    m.tick();
    m.stop();
    expect(events).toEqual([]);
  });
});

describe('channel follow-up delivery', () => {
  const FOLLOWUP = 'fu_0123456789abcdef';
  const userLine = (uuid: string, text: string) =>
    JSON.stringify({
      uuid,
      parentUuid: null,
      sessionId: FIXTURE_SESSION_ID,
      cwd: FIXTURE_CWD,
      timestamp: '2026-09-17T10:05:00.000Z',
      type: 'user',
      message: { role: 'user', content: text },
    });

  const run = (line: string) => {
    appendLines(fx.transcript, [line]);
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
  };

  /**
   * The only proof the bridge ever gets that Claude Code really took a follow-up: the injected
   * event comes back as an ordinary `user` record wrapped in Claude Code's `<channel>` tag.
   */
  it('closes the delivery report when the injected turn appears in the transcript', () => {
    run(
      userLine(
        'chan1',
        `<channel source="pagr" origin="pagr" seq="1" followup="${FOLLOWUP}">rebase onto main</channel>`,
      ),
    );
    expect(events.some((e) => e.kind === 'session_event' && e.type === 'followup_delivered')).toBe(
      true,
    );
    const frame = frames().find((f) => f.meta?.delivery?.state === 'delivered');
    expect(frame?.meta?.delivery).toEqual({ state: 'delivered', followupId: FOLLOWUP });
    expect(frame?.body).toMatchObject({ kind: 'system', subtype: 'followup_delivered' });
    // And it is NOT echoed back as a user frame: the phone wrote that text, it does not need it
    // read back to it under a different id.
    expect(frames().some((f) => f.body.kind === 'user')).toBe(false);
  });

  it('reports delivery even when the event carried no follow-up id', () => {
    run(userLine('chan2', '<channel source="pagr" origin="pagr" seq="4">look at this</channel>'));
    const frame = frames().find((f) => f.meta?.delivery?.state === 'delivered');
    expect(frame?.meta?.delivery).toEqual({ state: 'delivered' });
  });

  it('leaves an ordinary typed turn alone', () => {
    run(userLine('typed1', 'what does this function do?'));
    expect(frames().some((f) => f.meta?.delivery)).toBe(false);
    expect(frames().some((f) => f.body.kind === 'user')).toBe(true);
  });

  it('ignores a channel tag from somebody else’s server', () => {
    run(userLine('other1', '<channel source="someone-else" seq="1">not ours</channel>'));
    expect(frames().some((f) => f.meta?.delivery)).toBe(false);
    expect(frames().some((f) => f.body.kind === 'user')).toBe(true);
  });
});

describe('frames', () => {
  /** The frames one full read of the fixture transcript produces, journalled in order. */
  function replay(m: ClaudeMirror, journal: JournalStore) {
    m.start();
    m.tick();
    m.stop();
    return frames().map((f) => {
      const { seq, duplicate } = journal.append(f.sessionId, f.body, {
        projectId: f.projectId,
        provider: 'claude',
        meta: f.meta,
        ...(f.providerRecordId ? { providerRecordId: f.providerRecordId } : {}),
        ...(f.at ? { at: f.at } : {}),
      });
      return { seq, duplicate, kind: f.body.kind, id: f.providerRecordId, meta: f.meta };
    });
  }

  it('produces the exact frame sequence the transcript describes', () => {
    appendLines(fx.transcript, fx.mainLines);
    appendLines(path.join(fx.subagentDir, 'agent-a1.jsonl'), fx.subagentLines);
    const journal = new JournalStore({ dir: path.join(home, 'journal') });
    const rows = replay(mirror(), journal);
    journal.closeAll();

    expect(rows.map((r) => [r.seq, r.kind, r.id])).toEqual([
      [1, 'user', 'u1:0'],
      [2, 'thinking', 'u2:0'],
      [3, 'assistant', 'u2:1'],
      [4, 'tool_call', 'toolu_bash1'],
      [5, 'tool_result', 'toolu_bash1:result'],
      [6, 'terminal', 'toolu_bash1:terminal'],
      [7, 'tool_call', 'toolu_write1'],
      [8, 'tool_result', 'toolu_write1:result'],
      [9, 'diff', 'toolu_write1:diff'],
      [10, 'tool_call', 'toolu_edit1'],
      [11, 'tool_result', 'toolu_edit1:result'],
      [12, 'diff', 'toolu_edit1:diff'],
      [13, 'tool_call', 'toolu_ask1'],
      [14, 'tool_result', 'toolu_ask1:result'],
      [15, 'tool_call', 'toolu_task1'],
      [16, 'tool_result', 'toolu_task1:result'],
      [17, 'system', 'u16'],
      [18, 'assistant', 'agent:a1:a1:0'],
      [19, 'tool_call', 'agent:a1:toolu_grep1'],
      [20, 'tool_result', 'agent:a1:toolu_grep1:result'],
    ]);
    // `source: 'transcript'` on every one of them: the phone is told where the bridge read it.
    expect(new Set(rows.map((r) => r.meta.source))).toEqual(new Set(['transcript']));
    expect(rows.find((r) => r.id === 'toolu_bash1')?.meta).toEqual({
      parentFrameId: 'toolu_bash1',
      actionType: 'command_execution',
      source: 'transcript',
    });
    expect(rows.find((r) => r.id === 'agent:a1:toolu_grep1')?.meta).toEqual({
      parentFrameId: 'toolu_grep1',
      actionType: 'tool_use',
      subagent: { id: 'a1', depth: 1 },
      source: 'transcript',
    });
    expect(rows.find((r) => r.id === 'agent:a1:a1:0')?.meta).toEqual({
      parentFrameId: 'toolu_task1',
      subagent: { id: 'a1', depth: 1 },
      source: 'transcript',
    });
  });

  it('reads the spilled Bash output back in full', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    const terminal = frames().find((f) => f.body.kind === 'terminal');
    expect(terminal?.body).toEqual({
      kind: 'terminal',
      command: 'npm test',
      stdout: fs.readFileSync(
        path.join(fx.projectDir, FIXTURE_SESSION_ID, 'tool-results', 'bash1.txt'),
        'utf8',
      ),
      stderr: '',
      interrupted: false,
    });
    expect(terminal?.body).toMatchObject({ stdout: expect.stringContaining('1 failing') });
  });

  it("carries Claude's own hunks for a Write and an Edit, never an approximation", () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    const diffs = frames().filter((f) => f.body.kind === 'diff');
    expect(diffs.map((d) => d.body)).toEqual([
      {
        kind: 'diff',
        path: `${FIXTURE_CWD}/src/health.ts`,
        changeKind: 'add',
        newText: "export const health = () => 'ok';\n",
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ["+export const health = () => 'ok';"],
          },
        ],
      },
      {
        kind: 'diff',
        path: `${FIXTURE_CWD}/src/server.ts`,
        changeKind: 'update',
        oldText: 'const routes = [];\n',
        newText: 'const routes = [health];\n',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-const routes = [];', '+const routes = [health];'],
          },
        ],
      },
    ]);
    for (const d of diffs) expect(d.body).not.toHaveProperty('approx');
  });

  it('makes an AskUserQuestion an ordinary tool call until B7 owns it', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    const ask = frames().find((f) => f.providerRecordId === 'toolu_ask1');
    expect(ask?.body).toMatchObject({
      kind: 'tool_call',
      toolName: 'AskUserQuestion',
      toolKind: 'other',
    });
    expect(frames().some((f) => f.body.kind === 'question')).toBe(false);
    // …and the answer arrives as the call's own result.
    expect(frames().find((f) => f.providerRecordId === 'toolu_ask1:result')?.body).toMatchObject({
      kind: 'tool_result',
      content: '3000',
      isError: false,
    });
  });

  it('turns a compact summary into a system frame and skips the meta lines', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    m.stop();
    expect(frames().find((f) => f.body.kind === 'system')?.body).toEqual({
      kind: 'system',
      subtype: 'compact_summary',
      text: 'Compacted: added a health endpoint and wired it into the router.',
    });
    // `isMeta` (`<command-name>/clear</command-name>`) produced nothing.
    expect(frames().some((f) => JSON.stringify(f.body).includes('command-name'))).toBe(false);
  });

  it('counts an unrecognised record type once and makes no frame for it', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    expect(m.status().unknownRecordTypes).toBe(1);
    expect(frames().some((f) => JSON.stringify(f.body).includes('quantum'))).toBe(false);
    m.stop();
  });

  it('replays the whole transcript a second time for zero new sequence numbers', () => {
    appendLines(fx.transcript, fx.mainLines);
    appendLines(path.join(fx.subagentDir, 'agent-a1.jsonl'), fx.subagentLines);
    const journal = new JournalStore({ dir: path.join(home, 'journal') });
    const first = replay(mirror(), journal);
    expect(first.every((r) => !r.duplicate)).toBe(true);
    const lastSeq = journal.lastSeq(syntheticSessionId('claude', FIXTURE_SESSION_ID));

    // A fresh mirror with a fresh tailer state: the same bytes, read from the start again.
    events = [];
    fs.rmSync(path.join(home, '.pagr', 'tailer-state.json'), { force: true });
    const second = replay(mirror(), journal);
    expect(second).toHaveLength(first.length);
    expect(second.every((r) => r.duplicate)).toBe(true);
    expect(journal.lastSeq(syntheticSessionId('claude', FIXTURE_SESSION_ID))).toBe(lastSeq);
    journal.closeAll();
  });

  it('publishes what it is watching for `pagr doctor`', () => {
    appendLines(fx.transcript, fx.mainLines);
    const m = mirror();
    m.start();
    m.tick();
    const status = m.status();
    expect(status).toMatchObject({ enabled: true, sessions: 1, filesWatched: 1 });
    expect(status.lastFrameAt).toEqual(expect.any(String));
    expect(reported).toEqual(status);
    m.stop();
    expect(reported).toMatchObject({ sessions: 0, filesWatched: 0 });
  });
});
