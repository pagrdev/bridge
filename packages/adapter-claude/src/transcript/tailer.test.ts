import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLines,
  FIXTURE_CWD,
  FIXTURE_SESSION_ID,
  type InstalledFixtures,
  installTranscriptFixtures,
} from '../__fixtures__/transcripts/install.js';
import { type TailedRecord, TailerStateStore, TranscriptTailer } from './tailer.js';

/**
 * The tailer, fed the way a transcript actually arrives: a few lines at a time, with the file
 * replaced underneath it halfway through.
 */

let home: string;
let fx: InstalledFixtures;
let state: TailerStateStore;
let seen: TailedRecord[];

const collect = (opts: { pollMs?: number } = {}) =>
  new TranscriptTailer({
    home,
    cwd: FIXTURE_CWD,
    claudeSessionId: FIXTURE_SESSION_ID,
    state,
    onRecord: (r) => seen.push(r),
    pollMs: opts.pollMs ?? 60_000, // tests drive `poll()` themselves; no timer racing them
  });

/** `<type>:<uuid>` for every record the tailer handed out, in order. */
const trace = () => seen.map((s) => `${s.record.type}:${s.record.uuid ?? '-'}`);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-tailer-'));
  fx = installTranscriptFixtures(home);
  state = new TailerStateStore(path.join(home, '.pagr', 'tailer-state.json'));
  seen = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('TranscriptTailer', () => {
  it('reads a file written in 1-3 line slices, each record exactly once', () => {
    const tailer = collect();
    fs.writeFileSync(fx.transcript, '');
    tailer.poll();
    let i = 0;
    let slice = 1;
    while (i < fx.mainLines.length) {
      appendLines(fx.transcript, fx.mainLines.slice(i, i + slice));
      i += slice;
      slice = (slice % 3) + 1;
      tailer.poll();
    }
    tailer.stop();
    expect(trace()).toEqual(fx.mainLines.map((l) => `${JSON.parse(l).type}:${JSON.parse(l).uuid}`));
    expect(new Set(trace()).size).toBe(trace().length);
  });

  it('holds back a half-written line until its newline arrives', () => {
    const tailer = collect();
    const [first, second] = fx.mainLines;
    fs.writeFileSync(fx.transcript, `${first}\n${(second as string).slice(0, 20)}`);
    tailer.poll();
    expect(trace()).toEqual(['user:u1']);
    fs.appendFileSync(fx.transcript, `${(second as string).slice(20)}\n`);
    tailer.poll();
    tailer.stop();
    expect(trace()).toEqual(['user:u1', 'assistant:u2']);
  });

  it('reopens from zero when the file is replaced, and emits nothing it already emitted', () => {
    const tailer = collect();
    appendLines(fx.transcript, fx.mainLines.slice(0, 4));
    tailer.poll();
    expect(trace()).toEqual(['user:u1', 'assistant:u2', 'user:u3', 'assistant:u4']);

    // Claude rewrites the transcript: the old one becomes `.superseded-…` and a NEW inode takes
    // the live name. The first four records are in it again.
    fs.renameSync(fx.transcript, fx.supersededSource);
    fs.writeFileSync(`${fx.transcript}.tmp`, `${fx.mainLines.slice(0, 6).join('\n')}\n`);
    fs.renameSync(`${fx.transcript}.tmp`, fx.transcript);
    tailer.poll();
    tailer.stop();
    // The superseded file is tailed too — it is the same session — but only its unread tail, and
    // the rewritten live file contributes only the two records that are genuinely new.
    expect(trace()).toEqual([
      'user:u1',
      'assistant:u2',
      'user:u3',
      'assistant:u4',
      'user:u5',
      'assistant:u6',
    ]);
  });

  it('starts over when the file is truncated', () => {
    const tailer = collect();
    appendLines(fx.transcript, fx.mainLines.slice(0, 3));
    tailer.poll();
    fs.truncateSync(fx.transcript, 0);
    appendLines(fx.transcript, fx.mainLines.slice(0, 2));
    seen = [];
    tailer.poll();
    tailer.stop();
    // Re-read from zero, and suppressed by uuid: a truncation costs a read, never a duplicate.
    expect(trace()).toEqual([]);
    expect(state.get(fx.transcript)?.offset).toBe(fs.statSync(fx.transcript).size);
  });

  it('unifies superseded and orphaned variants by the session id in the records', () => {
    fs.writeFileSync(fx.supersededSource, `${fx.supersededLines.join('\n')}\n`);
    appendLines(fx.transcript, fx.mainLines.slice(0, 1));
    const tailer = collect();
    tailer.poll();
    tailer.stop();
    expect(trace().sort()).toEqual(['assistant:u91', 'user:u1', 'user:u90']);
    for (const s of seen) expect(s.record.sessionId).toBe(FIXTURE_SESSION_ID);
  });

  it('tails subagent transcripts with their id, depth and the Task call they hang from', () => {
    appendLines(path.join(fx.subagentDir, 'agent-a1.jsonl'), fx.subagentLines);
    const tailer = collect();
    tailer.poll();
    tailer.stop();
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.subagent).toEqual({ id: 'a1', depth: 1 });
      expect(s.parentFrameId).toBe('toolu_task1');
    }
  });

  it('defaults a subagent with no sidecar to depth 1 and no parent call', () => {
    fs.rmSync(path.join(fx.subagentDir, 'agent-a1.meta.json'));
    appendLines(path.join(fx.subagentDir, 'agent-a1.jsonl'), fx.subagentLines);
    const tailer = collect();
    tailer.poll();
    tailer.stop();
    expect(seen[0]?.subagent).toEqual({ id: 'a1', depth: 1 });
    expect(seen[0]?.parentFrameId).toBeUndefined();
  });

  it('persists inode and offset, so a fresh tailer resumes instead of replaying', () => {
    const first = collect();
    appendLines(fx.transcript, fx.mainLines.slice(0, 3));
    first.poll();
    first.stop();
    expect(fs.existsSync(path.join(home, '.pagr', 'tailer-state.json'))).toBe(true);

    seen = [];
    const resumed = new TailerStateStore(path.join(home, '.pagr', 'tailer-state.json'));
    const second = new TranscriptTailer({
      home,
      cwd: FIXTURE_CWD,
      claudeSessionId: FIXTURE_SESSION_ID,
      state: resumed,
      onRecord: (r) => seen.push(r),
      pollMs: 60_000,
    });
    second.poll();
    expect(trace()).toEqual([]);
    appendLines(fx.transcript, fx.mainLines.slice(3, 4));
    second.poll();
    second.stop();
    expect(trace()).toEqual(['assistant:u4']);
  });

  it('never leaves the transcript tree, and survives a directory that is not there yet', () => {
    const tailer = collect();
    fs.rmSync(fx.projectDir, { recursive: true, force: true });
    expect(() => tailer.poll()).not.toThrow();
    expect(tailer.watchedFiles).toEqual([]);
    tailer.stop();
  });
});

describe('TailerStateStore', () => {
  it('forgets files that are gone, so the state file cannot grow without bound', () => {
    const store = new TailerStateStore(path.join(home, '.pagr', 'tailer-state.json'));
    store.set(fx.transcript, { inode: 1, offset: 0, partialLine: '' });
    store.set(path.join(fx.projectDir, 'vanished.jsonl'), {
      inode: 2,
      offset: 5,
      partialLine: '',
    });
    fs.writeFileSync(fx.transcript, '');
    expect(store.size).toBe(2);
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);
  });

  it('is written 0600 and survives being corrupted', () => {
    const file = path.join(home, '.pagr', 'tailer-state.json');
    const store = new TailerStateStore(file);
    store.set(fx.transcript, { inode: 1, offset: 7, partialLine: '' });
    store.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, '{ not json');
    expect(new TailerStateStore(file).size).toBe(0);
  });
});
