import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandBody, DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CodingAgentAdapter } from './adapters/types.js';
import {
  BackfillGuard,
  type DiscoveredSession,
  historySessionId,
  type ReplayFrame,
  scanClaudeTranscripts,
} from './backfill.js';
import { syntheticSessionId } from './daemon.js';
import { Dispatcher } from './dispatcher.js';
import { decodeFrameBody } from './frames.js';
import { JournalStore, OutboxCursors } from './journal.js';
import type { MirrorProject } from './mirrorBridge.js';
import { ProjectRegistry } from './projects.js';
import { generateRecipientKeyPair, openFrame, sealAadFor } from './seal.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

type FramePayload = EventPayload<'session.frame'>;
type SessionEventPayload = EventPayload<'session.event'>;

const CLAUDE_SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER_SESSION = '99999999-8888-7777-6666-555555555555';

/** One transcript line, as Claude Code writes them. */
const line = (o: Record<string, unknown>): string => JSON.stringify(o);

/**
 * A synthetic `~/.claude/projects` tree.
 *
 * Deliberately built by hand rather than copied from a real one: the point of these tests is the
 * SHAPES — a superseded variant beside a live file, a subagent transcript that is not a session,
 * a `memory/` directory that is not a project — and each has to be present on purpose.
 */
function claudeTree(home: string, cwd: string): void {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[/ .]/g, '-'));
  mkdirSync(join(dir, CLAUDE_SESSION, 'subagents'), { recursive: true });
  mkdirSync(join(home, '.claude', 'projects', 'memory'), { recursive: true });

  writeFileSync(
    join(dir, `${CLAUDE_SESSION}.jsonl`),
    `${[
      line({
        uuid: 'u1',
        type: 'user',
        sessionId: CLAUDE_SESSION,
        cwd,
        message: { role: 'user', content: 'hello' },
      }),
      line({ type: 'summary', summary: 'A summary Claude wrote itself' }),
      line({ type: 'custom-title', title: 'The name I gave it' }),
    ].join('\n')}\n`,
  );
  // The same session, rewritten. One conversation, two files.
  writeFileSync(
    join(dir, `${CLAUDE_SESSION}.jsonl.superseded-1758103200000`),
    `${line({ uuid: 'u0', type: 'user', sessionId: CLAUDE_SESSION, cwd, message: { role: 'user', content: 'earlier' } })}\n`,
  );
  // A subagent's own transcript. Part of its parent session, never a session of its own.
  writeFileSync(
    join(dir, CLAUDE_SESSION, 'subagents', 'agent-a1.jsonl'),
    `${line({ uuid: 'a1', type: 'user', sessionId: CLAUDE_SESSION, cwd, message: { role: 'user', content: 'sub' } })}\n`,
  );
  // A second session, named by an `agent-name` record rather than a title.
  writeFileSync(
    join(dir, `${OTHER_SESSION}.jsonl`),
    `${[
      line({
        uuid: 'v1',
        type: 'user',
        sessionId: OTHER_SESSION,
        cwd,
        message: { role: 'user', content: 'hi' },
      }),
      line({ type: 'agent-name', name: 'reviewer' }),
    ].join('\n')}\n`,
  );
  // Claude's own notes, which are not a project directory at all.
  writeFileSync(join(home, '.claude', 'projects', 'memory', 'MEMORY.md'), '# notes\n');
}

const age = (file: string, daysAgo: number): void => {
  const t = Date.now() / 1000 - daysAgo * 86_400;
  utimesSync(file, t, t);
};

describe('scanClaudeTranscripts', () => {
  const t = useTempHome('pagr-history-');
  const cwd = '/tmp/pagr-history-fixture';

  beforeEach(() => claudeTree(t.home, cwd));

  it('folds the superseded variant into one session and skips agent files and memory', () => {
    const found = scanClaudeTranscripts(t.home, new Date(0));
    expect(found.map((f) => f.claudeSessionId).sort()).toEqual(
      [CLAUDE_SESSION, OTHER_SESSION].sort(),
    );
    const main = found.find((f) => f.claudeSessionId === CLAUDE_SESSION);
    expect(main?.files).toHaveLength(2);
    expect(main?.cwd).toBe(cwd);
  });

  it('prefers a title the person set over the model’s own summary', () => {
    const found = scanClaudeTranscripts(t.home, new Date(0));
    expect(found.find((f) => f.claudeSessionId === CLAUDE_SESSION)?.title).toBe(
      'The name I gave it',
    );
    expect(found.find((f) => f.claudeSessionId === OTHER_SESSION)?.title).toBe('reviewer');
  });

  it('leaves out transcripts older than the window', () => {
    const dir = join(t.home, '.claude', 'projects', cwd.replace(/[/ .]/g, '-'));
    age(join(dir, `${OTHER_SESSION}.jsonl`), 90);
    const found = scanClaudeTranscripts(t.home, new Date(Date.now() - 30 * 86_400_000));
    expect(found.map((f) => f.claudeSessionId)).toEqual([CLAUDE_SESSION]);
  });
});

describe('the synthetic session id', () => {
  it('is the same one the daemon and the mirror mint, or a session shows up twice', () => {
    expect(historySessionId('claude', CLAUDE_SESSION)).toBe(
      syntheticSessionId('claude', CLAUDE_SESSION),
    );
    expect(historySessionId('codex', 'thread-7')).toBe(syntheticSessionId('codex', 'thread-7'));
  });
});

describe('session.list_history and session.backfill', () => {
  const t = useTempHome('pagr-backfill-');
  const deviceId = ids.dev();
  const phone = generateRecipientKeyPair();
  const cwd = '/tmp/pagr-history-fixture';
  const sessionId = historySessionId('claude', CLAUDE_SESSION);

  let events: DeviceEvent[];
  let journal: JournalStore;
  let cursors: OutboxCursors;
  let sessions: SessionStore;
  let projectId: string;
  let recipientKeys: Record<string, string>;
  let protocolVersion: number;
  let now: Date;
  let d: Dispatcher;
  let replayed: ReplayFrame[];
  let replayCalls: DiscoveredSession[];
  let holds: string[];
  let guard: BackfillGuard;

  const journalDir = () => join(t.home, 'pagr', 'journal');
  const frames = (): FramePayload[] =>
    events.filter((e) => e.type === 'session.frame').map((e) => e.payload as FramePayload);
  const progress = (): SessionEventPayload[] =>
    events
      .filter((e) => e.type === 'session.event')
      .map((e) => e.payload as SessionEventPayload)
      .filter((p) => p.kind === 'progress');

  beforeEach(() => {
    now = new Date('2026-09-17T12:00:00.000Z');
    events = [];
    holds = [];
    replayCalls = [];
    recipientKeys = { [phone.kid]: phone.publicKeyB64u };
    protocolVersion = 2;
    guard = new BackfillGuard();
    const home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    const registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    claudeTree(t.home, cwd);
    journal = new JournalStore({ dir: journalDir(), now: () => now });
    cursors = new OutboxCursors({ file: join(journalDir(), 'outbox.json'), writeDelayMs: 0 });
    sessions = new SessionStore();
    replayed = [
      { body: { kind: 'user', text: 'hello' }, meta: {}, providerRecordId: 'u1' },
      { body: { kind: 'assistant', text: 'hi back' }, meta: {}, providerRecordId: 'u2' },
      { body: { kind: 'assistant', text: 'and again' }, meta: {}, providerRecordId: 'u3' },
    ];
    const project: MirrorProject = {
      projectId,
      path: join(home, 'repo'),
      displayName: 'repo',
      status: 'registered',
    };
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      frames: {
        journal,
        cursors,
        recipientKeys: () => recipientKeys,
        protocolVersion: () => protocolVersion,
      },
      backfill: {
        claudeHome: t.home,
        projectFor: () => project,
        guard,
        hold: (reason) => {
          holds.push(`hold:${reason}`);
          return () => holds.push(`release:${reason}`);
        },
        replayTranscript: async (s) => {
          replayCalls.push(s);
          return replayed;
        },
      },
    });
  });

  /** A verified command body, as the guard would hand one to the dispatcher. */
  const command = (type: CommandBody['type'], payload: unknown, version = 2): CommandBody =>
    ({
      ...makeBody(type as 'device.probe', payload as Record<string, never>, { deviceId, now }),
      version,
    }) as CommandBody;

  const ack = (e: DeviceEvent) => e.payload as EventPayload<'command.ack'>;

  // ---------- history ----------

  it('lists a session from its transcript alone, with the title and control none', async () => {
    const list = await d.listHistory({ sinceDays: 30, limit: 50 });
    const row = list.find((s) => s.sessionId === sessionId);
    expect(row).toMatchObject({
      sessionId,
      projectId,
      provider: 'claude',
      displayName: 'The name I gave it',
      origin: 'terminal',
      controlLevel: 'none',
      projectStatus: 'registered',
      status: 'idle',
    });
    // One row for the session, not one per transcript file.
    expect(list.filter((s) => s.sessionId === sessionId)).toHaveLength(1);
  });

  it('answers the command with the sessions, and refuses it on a v1 link', async () => {
    const good = await d.handle(command('session.list_history', { sinceDays: 30, limit: 50 }));
    expect(ack(good).status).toBe('completed');
    const result = ack(good).result as { sessions: Array<{ sessionId: string }> };
    expect(result.sessions.map((s) => s.sessionId)).toContain(sessionId);

    const bad = await d.handle(command('session.list_history', { sinceDays: 30, limit: 50 }, 1));
    expect(ack(bad)).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });
  });

  it('honours the provider filter and the limit', async () => {
    expect(await d.listHistory({ provider: 'codex' })).toEqual([]);
    expect(await d.listHistory({ limit: 1 })).toHaveLength(1);
  });

  // ---------- backfill from the journal ----------

  const seed = (n: number, text = 'x'): void => {
    for (let i = 0; i < n; i++)
      d.emitFrame(
        sessionId,
        { kind: 'assistant', text: `${text}${i}` },
        {
          projectId,
          provider: 'claude',
          meta: { source: 'transcript' },
          providerRecordId: `seed-${i}`,
        },
      );
  };

  it('re-seals journaled frames with the same seqs and the same bodies', async () => {
    seed(3);
    const live = frames();
    events = [];

    const result = await d.runBackfill({ sessionId, fromSeq: 1, maxBytes: 1024 * 1024 });
    expect(result).toEqual({ frames: 3, bytes: expect.any(Number), lastSeq: 3, truncated: false });

    const replay = frames();
    expect(replay.map((f) => f.seq)).toEqual([1, 2, 3]);
    // Same numbers, same bodies — and the only difference in the metadata is where it came from.
    for (const [i, f] of replay.entries()) {
      expect(f.meta.source).toBe('backfill');
      expect(live[i]?.meta.source).toBe('transcript');
      const opened = openFrame(
        f.sealed,
        sealAadFor({ sessionId, seq: f.seq, kind: f.kind }),
        phone.privateKeyRaw,
      );
      expect(decodeFrameBody(opened)).toEqual({ kind: 'assistant', text: `x${i}` });
    }
  });

  it('stops on the byte budget and says the rest is still there', async () => {
    seed(6, 'a-reasonably-long-body-so-the-budget-bites-');
    events = [];
    const result = await d.runBackfill({ sessionId, fromSeq: 1, maxBytes: 600 });
    expect(result.truncated).toBe(true);
    expect(result.frames).toBeGreaterThan(0);
    expect(result.frames).toBeLessThan(6);
    expect(result.lastSeq).toBe(result.frames);
    expect(frames()).toHaveLength(result.frames);
  });

  it('reports progress every hundred frames, and once at the end', async () => {
    seed(250);
    events = [];
    await d.runBackfill({ sessionId, fromSeq: 1, maxBytes: 16 * 1024 * 1024 });
    expect(progress().map((p) => p.summary)).toEqual([
      'backfilled 100 frame(s) up to #100',
      'backfilled 200 frame(s) up to #200',
      'backfilled 250 frame(s) up to #250',
    ]);
  });

  it('holds the Mac awake for the duration and lets go afterwards', async () => {
    seed(2);
    expect(guard.busy).toBe(false);
    await d.runBackfill({ sessionId, fromSeq: 1 });
    // Taken before any work, released after all of it — and the slot is free again either way.
    expect(holds).toEqual(['hold:backfill', 'release:backfill']);
    expect(guard.busy).toBe(false);
  });

  it('lets go of the slot and the power assertion when a backfill fails', async () => {
    await expect(d.runBackfill({ sessionId: ids.ses(), fromSeq: 1 })).rejects.toThrow();
    expect(holds).toEqual(['hold:backfill', 'release:backfill']);
    expect(guard.busy).toBe(false);
  });

  it('refuses a second backfill while one is running', async () => {
    seed(2);
    const release = guard.take('ses_someone_else');
    expect(release).not.toBeNull();
    const failed = await d.handle(
      command('session.backfill', { sessionId, fromSeq: 1, maxBytes: 1024 * 1024 }),
    );
    expect(ack(failed)).toMatchObject({ status: 'failed', errorCode: 'rate_limited' });
    release?.();
    const good = await d.handle(
      command('session.backfill', { sessionId, fromSeq: 1, maxBytes: 1024 * 1024 }),
    );
    expect(ack(good).status).toBe('completed');
  });

  // ---------- backfill that has to build the journal first ----------

  it('replays the transcript into the journal, then streams it', async () => {
    expect(journal.lastSeq(sessionId)).toBe(0);
    const result = await d.runBackfill({ sessionId, fromSeq: 1 });

    expect(replayCalls.map((s) => s.providerSessionId)).toEqual([CLAUDE_SESSION]);
    expect(result).toMatchObject({ frames: 3, lastSeq: 3, truncated: false });
    expect(journal.lastSeq(sessionId)).toBe(3);
    expect(frames().map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(frames().every((f) => f.meta.source === 'backfill')).toBe(true);

    // Asking again costs no second replay and no second set of seqs: the journal has it now.
    events = [];
    const again = await d.runBackfill({ sessionId, fromSeq: 1 });
    expect(replayCalls).toHaveLength(1);
    expect(again).toMatchObject({ frames: 3, lastSeq: 3 });
    expect(journal.lastSeq(sessionId)).toBe(3);
  });

  it('does not renumber frames the live path already journaled', async () => {
    seed(1);
    // The replay carries the record the live path already saw, plus two it did not.
    replayed = [
      { body: { kind: 'assistant', text: 'x0' }, meta: {}, providerRecordId: 'seed-0' },
      ...replayed.slice(1),
    ];
    await d.runBackfill({ sessionId, fromSeq: 1 });
    // Nothing is replayed at all: the journal is not empty, so it is served as it stands.
    expect(replayCalls).toEqual([]);
    expect(journal.lastSeq(sessionId)).toBe(1);
  });

  it('is unknown_session when nothing on this Mac can produce the frames', async () => {
    const unknown = ids.ses();
    const failed = await d.handle(
      command('session.backfill', { sessionId: unknown, fromSeq: 1, maxBytes: 1024 * 1024 }),
    );
    expect(ack(failed)).toMatchObject({ status: 'failed', errorCode: 'unknown_session' });
  });

  it('is v2 only', async () => {
    const bad = await d.handle(
      command('session.backfill', { sessionId, fromSeq: 1, maxBytes: 1024 * 1024 }, 1),
    );
    expect(ack(bad)).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });
  });

  it('journals a replay even with no phone key pinned, and sends nothing', async () => {
    recipientKeys = {};
    const result = await d.runBackfill({ sessionId, fromSeq: 1 });
    expect(journal.lastSeq(sessionId)).toBe(3);
    expect(frames()).toEqual([]);
    // The frames exist and were counted; what is missing is somebody to seal them for.
    expect(result.frames).toBe(3);
  });
});

describe('purging journals', () => {
  const t = useTempHome('pagr-purge-');
  const cwd = '/tmp/pagr-history-fixture';

  /**
   * Retention deletes transcripts Pagr wrote and nothing else.
   *
   * The distinction is the whole reason a purge is safe to run: `~/.pagr/journal` is Pagr's own
   * cache of what it already sealed, and `~/.claude/projects` is Claude Code's record of the work.
   * Deleting the first costs a re-replay; deleting the second would lose the conversation.
   */
  it('respects the age, and never touches ~/.claude', () => {
    claudeTree(t.home, cwd);
    const dir = join(t.home, 'pagr', 'journal');
    const journal = new JournalStore({ dir });
    const old = ids.ses();
    const fresh = ids.ses();
    for (const sessionId of [old, fresh])
      journal.append(
        sessionId,
        { kind: 'assistant', text: 'hi' },
        {
          projectId: `proj_${'a'.repeat(32)}`,
          provider: 'claude',
          meta: { source: 'stdio' },
        },
      );
    journal.closeAll();
    const stale = Date.now() / 1000 - 60 * 86_400;
    for (const suffix of ['.log', '.idx']) utimesSync(join(dir, `${old}${suffix}`), stale, stale);

    const result = new JournalStore({ dir }).prune({ days: 30 });
    expect(result.removed).toEqual([old]);
    expect(existsSync(join(dir, `${old}.log`))).toBe(false);
    expect(existsSync(join(dir, `${fresh}.log`))).toBe(true);
    // Every transcript is still where Claude Code left it.
    expect(
      scanClaudeTranscripts(t.home, new Date(0))
        .map((f) => f.claudeSessionId)
        .sort(),
    ).toEqual([CLAUDE_SESSION, OTHER_SESSION].sort());
  });

  it('keeps everything when the window is wide enough', () => {
    const dir = join(t.home, 'pagr', 'journal');
    const journal = new JournalStore({ dir });
    const sessionId = ids.ses();
    journal.append(
      sessionId,
      { kind: 'assistant', text: 'hi' },
      {
        projectId: `proj_${'a'.repeat(32)}`,
        provider: 'claude',
        meta: { source: 'stdio' },
      },
    );
    journal.closeAll();
    expect(new JournalStore({ dir }).prune({ days: 365 }).removed).toEqual([]);
  });
});
