import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
  isLiveTranscriptName,
  pidOfSessionFile,
  sessionFile,
  sessionIdOfTranscript,
  sessionsDir,
  spillDir,
  subagentIdOfFile,
  subagentMetaFile,
  subagentsDir,
} from './paths.js';
import {
  IGNORED_RECORD_TYPES,
  parseSubagentMeta,
  parseTranscriptRecord,
  readSpilledOutput,
  UnknownRecordTypes,
} from './records.js';

describe('paths', () => {
  it('encodes /, space and . to - and never decodes', () => {
    expect(encodeProjectDir('/Users/me/my app/v1.2')).toBe('-Users-me-my-app-v1-2');
  });

  it('places the transcript, the spill directory and the subagents where Claude does', () => {
    const home = '/h';
    expect(sessionFile(home, '/w/app', 'sid')).toBe('/h/.claude/projects/-w-app/sid.jsonl');
    expect(spillDir(home, '/w/app', 'sid')).toBe('/h/.claude/projects/-w-app/sid/tool-results');
    expect(subagentsDir(home, '/w/app', 'sid')).toBe('/h/.claude/projects/-w-app/sid/subagents');
    expect(sessionsDir(home)).toBe('/h/.claude/sessions');
  });

  it('reads a session id off a live transcript and off a superseded one', () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    expect(sessionIdOfTranscript(`${sid}.jsonl`)).toBe(sid);
    expect(sessionIdOfTranscript(`${sid}.jsonl.superseded-1758103200000`)).toBe(sid);
    expect(sessionIdOfTranscript('notes.txt')).toBeNull();
    expect(isLiveTranscriptName(`${sid}.jsonl`)).toBe(true);
    expect(isLiveTranscriptName(`${sid}.jsonl.superseded-1`)).toBe(false);
  });

  it('never treats a 0600 .key file as a session file', () => {
    expect(pidOfSessionFile('4242.json')).toBe(4242);
    expect(pidOfSessionFile('4242.01850786eb6bfa91.key')).toBeNull();
    expect(pidOfSessionFile('notes.json')).toBeNull();
  });

  it('finds a subagent id and its sidecar', () => {
    expect(subagentIdOfFile('agent-a1345cf605555d6d6.jsonl')).toBe('a1345cf605555d6d6');
    expect(subagentIdOfFile('agent-a1345cf605555d6d6.meta.json')).toBeNull();
    expect(subagentMetaFile('/x/agent-a1.jsonl')).toBe('/x/agent-a1.meta.json');
  });
});

describe('parseTranscriptRecord', () => {
  it('reads the envelope every record carries', () => {
    const r = parseTranscriptRecord(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 'sid',
        cwd: '/w/app',
        timestamp: '2026-09-17T10:00:00.000Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    );
    expect(r).toMatchObject({
      type: 'assistant',
      uuid: 'u2',
      parentUuid: 'u1',
      sessionId: 'sid',
      cwd: '/w/app',
      isSidechain: true,
      isMeta: false,
      isCompactSummary: false,
      isVisibleInTranscriptOnly: false,
    });
    expect(r?.body).toEqual({ kind: 'assistant', blocks: [{ type: 'text', text: 'hi' }] });
  });

  it('shares the stream parser block semantics, including the camelCase sidecar', () => {
    const r = parseTranscriptRecord(
      JSON.stringify({
        type: 'user',
        uuid: 'u3',
        toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      }),
    );
    expect(r?.body).toEqual({
      kind: 'user',
      blocks: [{ type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' }],
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
    });
  });

  it('narrows the small record types', () => {
    const of = (o: unknown) => parseTranscriptRecord(JSON.stringify(o))?.body;
    expect(of({ type: 'summary', summary: 'a run', leafUuid: 'u9' })).toEqual({
      kind: 'summary',
      summary: 'a run',
      leafUuid: 'u9',
    });
    expect(of({ type: 'custom-title', title: 'Health' })).toEqual({
      kind: 'custom-title',
      title: 'Health',
    });
    expect(of({ type: 'agent-name', name: 'Explore' })).toEqual({
      kind: 'agent-name',
      name: 'Explore',
    });
    expect(of({ type: 'queue-operation', operation: 'enqueue' })).toEqual({
      kind: 'queue-operation',
      operation: 'enqueue',
    });
  });

  it('marks a known no-frame type ignored and an unheard-of one unknown', () => {
    for (const type of IGNORED_RECORD_TYPES)
      expect(parseTranscriptRecord(JSON.stringify({ type }))?.body).toEqual({ kind: 'ignored' });
    expect(parseTranscriptRecord(JSON.stringify({ type: 'quantum-entangle' }))?.body).toEqual({
      kind: 'unknown',
    });
  });

  it('is null for anything that is not a record, and never throws', () => {
    for (const line of ['', '   ', '{ not json', '[]', '"a string"', '{"no":"type"}', '{"type":1}'])
      expect(parseTranscriptRecord(line)).toBeNull();
  });
});

describe('UnknownRecordTypes', () => {
  it('reports a type as news exactly once and keeps counting it', () => {
    const seen = new UnknownRecordTypes();
    expect(seen.note('quantum-entangle')).toBe(true);
    expect(seen.note('quantum-entangle')).toBe(false);
    expect(seen.note('quantum-entangle')).toBe(false);
    expect(seen.note('warp-field')).toBe(true);
    expect(seen.size).toBe(2);
    expect(seen.counts()).toEqual({ 'quantum-entangle': 3, 'warp-field': 1 });
  });
});

describe('parseSubagentMeta', () => {
  it('reads the fields the mirror needs and tolerates the rest', () => {
    expect(
      parseSubagentMeta('{"agentType":"Explore","toolUseId":"toolu_1","spawnDepth":2,"x":1}'),
    ).toMatchObject({ agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 2 });
    expect(parseSubagentMeta('not json')).toBeNull();
    expect(parseSubagentMeta('{"spawnDepth":-1}')).toBeNull();
  });
});

describe('readSpilledOutput', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-spill-'));
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads a spill inside ~/.claude/projects', () => {
    const file = path.join(home, '.claude', 'projects', 'p', 'out.txt');
    fs.writeFileSync(file, 'all of it');
    expect(readSpilledOutput(file, home)).toBe('all of it');
  });

  it('refuses a path that escapes the transcript tree', () => {
    const outside = path.join(home, 'secret.txt');
    fs.writeFileSync(outside, 'nope');
    expect(readSpilledOutput(outside, home)).toBeNull();
    const link = path.join(home, '.claude', 'projects', 'p', 'link.txt');
    fs.symlinkSync(outside, link);
    expect(readSpilledOutput(link, home)).toBeNull();
  });
});
