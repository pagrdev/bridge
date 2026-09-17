import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FrameBody } from './frames.js';
import {
  type AppendInput,
  JournalStore,
  journalStats,
  OutboxCursors,
  SessionJournal,
} from './journal.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const body = (text: string): FrameBody => ({ kind: 'assistant', text });
const input = (over: Partial<AppendInput> = {}): AppendInput => ({
  projectId: 'proj_1',
  provider: 'claude',
  meta: { source: 'stdio' },
  ...over,
});

describe('SessionJournal', () => {
  const tmp = useTempHome('pagr-journal-');
  const dir = () => join(tmp.home, 'journal');
  const open = (sessionId: string) => new SessionJournal({ dir: dir(), sessionId });

  it('allocates a monotonic seq and reads back what it wrote', () => {
    const j = open('ses_a');
    expect(j.lastSeq()).toBe(0);
    expect(j.append(body('one'), input()).seq).toBe(1);
    expect(j.append(body('two'), input()).seq).toBe(2);
    expect(j.append(body('three'), input()).seq).toBe(3);
    expect(j.lastSeq()).toBe(3);

    expect(j.read(1).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(j.read(2).map((e) => (e.body.kind === 'assistant' ? e.body.text : ''))).toEqual([
      'two',
      'three',
    ]);
    expect(j.read(2, 2).map((e) => e.seq)).toEqual([2]);
    expect(j.read(9)).toEqual([]);
    const first = j.read(1, 1)[0];
    expect(first?.projectId).toBe('proj_1');
    expect(first?.provider).toBe('claude');
    expect(first?.meta).toEqual({ source: 'stdio' });
    j.close();
  });

  it('writes 0600 NDJSON in a 0700 directory', () => {
    const j = open('ses_modes');
    j.append(body('x'), input());
    j.close();
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(statSync(j.logPath).mode & 0o777).toBe(0o600);
    expect(statSync(j.indexPath).mode & 0o777).toBe(0o600);
    const lines = readFileSync(j.logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 1, kind: 'assistant' });
  });

  it('continues the sequence after a reopen', () => {
    const a = open('ses_reopen');
    a.append(body('one'), input());
    a.append(body('two'), input());
    a.close();
    const b = open('ses_reopen');
    expect(b.lastSeq()).toBe(2);
    expect(b.append(body('three'), input()).seq).toBe(3);
    expect(b.read(1).map((e) => e.seq)).toEqual([1, 2, 3]);
    b.close();
  });

  it('never allocates twice for the same providerRecordId', () => {
    const j = open('ses_dedupe');
    const one = j.append(body('one'), input({ providerRecordId: 'rec-1' }));
    const again = j.append(body('one'), input({ providerRecordId: 'rec-1' }));
    expect(one).toMatchObject({ seq: 1, duplicate: false });
    expect(again).toMatchObject({ seq: 1, duplicate: true });
    expect(j.lastSeq()).toBe(1);
    expect(j.read(1)).toHaveLength(1);
    j.close();
  });

  it('remembers providerRecordIds across a restart, so a re-tail adds nothing', () => {
    const a = open('ses_retail');
    for (const id of ['r1', 'r2', 'r3']) a.append(body(id), input({ providerRecordId: id }));
    a.close();
    const b = open('ses_retail');
    for (const id of ['r1', 'r2', 'r3'])
      expect(b.append(body(id), input({ providerRecordId: id })).duplicate).toBe(true);
    expect(b.lastSeq()).toBe(3);
    b.close();
  });

  it('bounds the dedupe window instead of remembering forever', () => {
    const j = new SessionJournal({ dir: dir(), sessionId: 'ses_window', dedupeWindow: 4 });
    for (let i = 1; i <= 10; i++) j.append(body(`m${i}`), input({ providerRecordId: `r${i}` }));
    // The oldest id has fallen out of the window, so it is journaled again.
    expect(j.append(body('m1'), input({ providerRecordId: 'r1' })).duplicate).toBe(false);
    // The newest is still remembered.
    expect(j.append(body('m10'), input({ providerRecordId: 'r10' })).duplicate).toBe(true);
    j.close();
  });

  it('rebuilds a corrupt index and still reads every frame', () => {
    const a = open('ses_corrupt');
    for (let i = 1; i <= 20; i++) a.append(body(`m${i}`), input());
    a.close();
    writeFileSync(join(dir(), 'ses_corrupt.idx'), 'garbage that is not 16-byte records');

    const b = open('ses_corrupt');
    expect(b.lastRebuild).toBe('ragged');
    expect(b.lastSeq()).toBe(20);
    expect(b.read(1).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(b.read(15).map((e) => e.seq)).toEqual([15, 16, 17, 18, 19, 20]);
    expect(b.append(body('m21'), input()).seq).toBe(21);
    b.close();
    // The rebuilt sidecar is usable on the next open without another rebuild.
    const c = open('ses_corrupt');
    expect(c.lastRebuild).toBeNull();
    expect(c.lastSeq()).toBe(21);
    c.close();
  });

  it('rebuilds when the index is missing entirely', () => {
    const a = open('ses_noidx');
    a.append(body('one'), input());
    a.close();
    truncateSync(join(dir(), 'ses_noidx.idx'), 0);
    const b = open('ses_noidx');
    expect(b.lastRebuild).toBe('missing');
    expect(b.lastSeq()).toBe(1);
    b.close();
  });

  it('rebuilds when the log grew without the index, and keeps the extra frame', () => {
    const a = open('ses_behind');
    a.append(body('one'), input());
    a.close();
    appendFileSync(
      join(dir(), 'ses_behind.log'),
      `${JSON.stringify({
        seq: 2,
        at: new Date().toISOString(),
        kind: 'assistant',
        projectId: 'proj_1',
        provider: 'claude',
        meta: { source: 'stdio' },
        body: { kind: 'assistant', text: 'two' },
      })}\n`,
    );
    const b = open('ses_behind');
    expect(b.lastRebuild).toBe('short');
    expect(b.lastSeq()).toBe(2);
    expect(b.read(1)).toHaveLength(2);
    b.close();
  });

  it('drops a half-written last line and truncates the log back to it', () => {
    const a = open('ses_torn');
    a.append(body('one'), input());
    a.append(body('two'), input());
    a.close();
    const goodSize = statSync(join(dir(), 'ses_torn.log')).size;
    appendFileSync(join(dir(), 'ses_torn.log'), '{"seq":3,"at":"2026-');

    const b = open('ses_torn');
    expect(b.lastSeq()).toBe(2);
    expect(statSync(b.logPath).size).toBe(goodSize);
    expect(b.append(body('three'), input()).seq).toBe(3);
    expect(b.read(1).map((e) => e.seq)).toEqual([1, 2, 3]);
    b.close();
  });

  it('fsyncs in batches and on demand without losing anything', () => {
    const j = new SessionJournal({
      dir: dir(),
      sessionId: 'ses_sync',
      fsyncEveryFrames: 3,
      fsyncEveryMs: 10_000,
    });
    for (let i = 0; i < 7; i++) j.append(body(`m${i}`), input());
    j.flush();
    j.close();
    expect(open('ses_sync').read(1)).toHaveLength(7);
  });
});

describe('JournalStore', () => {
  const tmp = useTempHome('pagr-journal-store-');
  const dir = () => join(tmp.home, 'journal');

  it('keeps sequences separate per session', () => {
    const store = new JournalStore({ dir: dir() });
    expect(store.append('ses_a', body('a1'), input()).seq).toBe(1);
    expect(store.append('ses_b', body('b1'), input()).seq).toBe(1);
    expect(store.append('ses_a', body('a2'), input()).seq).toBe(2);
    expect(store.lastSeq('ses_a')).toBe(2);
    expect(store.lastSeq('ses_b')).toBe(1);
    expect(store.sessionIds().sort()).toEqual(['ses_a', 'ses_b']);
    store.closeAll();
  });

  it('closes the least recently used handle and still continues its sequence', () => {
    const store = new JournalStore({ dir: dir(), maxOpen: 2 });
    store.append('s1', body('x'), input());
    store.append('s2', body('x'), input());
    store.append('s3', body('x'), input()); // evicts s1
    expect(store.append('s1', body('y'), input()).seq).toBe(2);
    store.closeAll();
  });

  it('prunes journals past the retention window', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const store = new JournalStore({ dir: dir(), now: () => now });
    store.append('ses_old', body('old'), input());
    store.append('ses_new', body('new'), input());
    store.closeAll();
    // Age `ses_old` past 30 days by hand; mtime is what retention reads.
    const old = new Date(now.getTime() - 40 * 24 * 3600_000);
    for (const ext of ['log', 'idx']) utimesSync(join(dir(), `ses_old.${ext}`), old, old);

    const result = store.prune({ days: 30 });
    expect(result.removed).toEqual(['ses_old']);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(store.sessionIds()).toEqual(['ses_new']);
  });

  it('prunes the oldest journals first when the total is over the byte ceiling', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const store = new JournalStore({ dir: dir(), now: () => now });
    for (const id of ['s1', 's2', 's3']) store.append(id, body('x'.repeat(2000)), input());
    store.closeAll();
    for (const [i, id] of ['s1', 's2', 's3'].entries()) {
      const t = new Date(now.getTime() - (3 - i) * 3600_000);
      utimesSync(join(dir(), `${id}.log`), t, t);
    }
    const before = store.prune({ days: 30, maxTotalBytes: Number.MAX_SAFE_INTEGER });
    const result = store.prune({ days: 30, maxTotalBytes: Math.floor(before.totalBytes / 2) });
    expect(result.removed[0]).toBe('s1');
    expect(result.totalBytes).toBeLessThan(before.totalBytes);
  });

  it('never prunes a journal that is still open', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const store = new JournalStore({ dir: dir(), now: () => now });
    store.append('ses_live', body('live'), input());
    const old = new Date(now.getTime() - 400 * 24 * 3600_000);
    utimesSync(join(dir(), 'ses_live.log'), old, old);
    expect(store.prune({ days: 1 }).removed).toEqual([]);
    store.closeAll();
    expect(store.prune({ days: 1 }).removed).toEqual(['ses_live']);
  });
});

describe('OutboxCursors', () => {
  const tmp = useTempHome('pagr-outbox-');
  const file = () => join(tmp.home, 'journal', 'outbox.json');

  it('tracks sent and acked per session and persists them', () => {
    const c = new OutboxCursors({ file: file(), writeDelayMs: 0 });
    c.noteSent('s1', 4);
    c.noteSent('s2', 2);
    c.ack({ s1: 3 });
    expect(c.get('s1')).toEqual({ sent: 4, acked: 3 });
    expect(c.get('s2')).toEqual({ sent: 2, acked: 0 });
    c.flush();

    const reopened = new OutboxCursors({ file: file() });
    expect(reopened.get('s1')).toEqual({ sent: 4, acked: 3 });
  });

  it('never lets an ack run ahead of what was sent', () => {
    const c = new OutboxCursors({ file: file(), writeDelayMs: 0 });
    c.noteSent('s1', 2);
    c.ack({ s1: 99 });
    expect(c.get('s1')).toEqual({ sent: 2, acked: 2 });
    // …and never moves backwards.
    c.ack({ s1: 1 });
    expect(c.get('s1').acked).toBe(2);
  });

  it('lists only the sessions the gateway is behind on', () => {
    const c = new OutboxCursors({ file: file(), writeDelayMs: 0 });
    c.noteSent('s1', 5);
    c.noteSent('s2', 3);
    c.ack({ s2: 3 });
    expect(c.pending()).toEqual([{ sessionId: 's1', fromSeq: 1, toSeq: 5 }]);
    c.ack({ s1: 5 });
    expect(c.pending()).toEqual([]);
  });

  it('ignores nonsense in the file rather than refusing to start', () => {
    mkdirSync(join(tmp.home, 'journal'), { recursive: true, mode: 0o700 });
    writeFileSync(file(), '{"s1":{"sent":"lots","acked":9},"s2":null}');
    const c = new OutboxCursors({ file: file() });
    expect(c.get('s1')).toEqual({ sent: 0, acked: 0 });
    expect(c.get('s2')).toEqual({ sent: 0, acked: 0 });
  });
});

describe('journalStats', () => {
  const tmp = useTempHome('pagr-journal-stats-');
  const dir = () => join(tmp.home, 'journal');

  it('reports size, oldest and cursor lag per session', () => {
    const store = new JournalStore({ dir: dir() });
    const a = ids.ses();
    const b = ids.ses();
    store.append(a, body('one'), input());
    store.append(a, body('two'), input());
    store.append(b, body('one'), input());
    store.closeAll();

    const cursors = new OutboxCursors({ file: join(dir(), 'outbox.json'), writeDelayMs: 0 });
    cursors.noteSent(a, 2);
    cursors.ack({ [a]: 1 });
    cursors.noteSent(b, 1);
    cursors.ack({ [b]: 1 });
    cursors.flush();

    const stats = journalStats(dir());
    expect(stats.exists).toBe(true);
    expect(stats.sessions).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.oldestAt).toBeTruthy();
    expect(stats.lagging).toHaveLength(1);
    expect(stats.lagging[0]).toMatchObject({ sessionId: a, sent: 2, acked: 1, behind: 1 });
  });

  it('is honest about a home that has never journaled anything', () => {
    const stats = journalStats(join(tmp.home, 'nothing-here'));
    expect(stats).toMatchObject({ exists: false, sessions: 0, bytes: 0, oldestAt: null });
    expect(stats.lagging).toEqual([]);
  });
});
