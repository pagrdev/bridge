import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffBodyFor,
  encodeProjectDir,
  readPersistedOutput,
  TranscriptResultLookup,
  terminalBodyFor,
  transcriptPathFor,
  unifiedFromReplace,
} from './diffs.js';

const EDIT_RESULT = {
  filePath: '/p/t.txt',
  oldString: 'bravo',
  newString: 'BRAVO',
  originalFile: 'alpha\nbravo\ncharlie\n',
  replaceAll: false,
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' alpha', '-bravo', '+BRAVO', ' charlie'],
    },
  ],
};

describe('diffBodyFor', () => {
  it("uses Claude's own structuredPatch and the file either side of the edit", () => {
    expect(
      diffBodyFor({
        toolName: 'Edit',
        input: { file_path: '/p/t.txt', old_string: 'bravo', new_string: 'BRAVO' },
        result: EDIT_RESULT,
      }),
    ).toEqual({
      kind: 'diff',
      path: '/p/t.txt',
      changeKind: 'update',
      oldText: 'alpha\nbravo\ncharlie\n',
      newText: 'alpha\nBRAVO\ncharlie\n',
      hunks: EDIT_RESULT.structuredPatch,
    });
  });

  it('honours replaceAll when reconstructing the new text', () => {
    const body = diffBodyFor({
      toolName: 'Edit',
      input: {},
      result: {
        filePath: '/p/x.txt',
        oldString: 'a',
        newString: 'b',
        originalFile: 'a-a-a',
        replaceAll: true,
        structuredPatch: [],
      },
    });
    expect(body?.newText).toBe('b-b-b');
  });

  it('reads a Write as an add, and an overwrite as an update', () => {
    expect(
      diffBodyFor({
        toolName: 'Write',
        input: { file_path: '/p/w.txt', content: 'written\n' },
        result: {
          type: 'create',
          filePath: '/p/w.txt',
          content: 'written\n',
          originalFile: null,
          structuredPatch: [],
        },
      }),
    ).toEqual({ kind: 'diff', path: '/p/w.txt', changeKind: 'add', newText: 'written\n' });

    expect(
      diffBodyFor({
        toolName: 'Write',
        input: { file_path: '/p/w.txt', content: 'new\n' },
        result: {
          filePath: '/p/w.txt',
          content: 'new\n',
          originalFile: 'old\n',
          structuredPatch: [],
        },
      }),
    ).toMatchObject({ changeKind: 'update', oldText: 'old\n', newText: 'new\n' });
  });

  it('marks a diff it had to compute itself', () => {
    const body = diffBodyFor({
      toolName: 'Edit',
      input: { file_path: '/p/t.txt', old_string: 'bravo', new_string: 'BRAVO' },
      result: null,
    });
    expect(body).toEqual({
      kind: 'diff',
      path: '/p/t.txt',
      changeKind: 'update',
      approx: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-bravo', '+BRAVO'] }],
    });
  });

  it('folds every replacement of a MultiEdit into the fallback', () => {
    const body = diffBodyFor({
      toolName: 'MultiEdit',
      input: {
        file_path: '/p/t.txt',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      },
      result: null,
    });
    expect(body?.approx).toBe(true);
    expect(body?.hunks).toHaveLength(2);
  });

  it('is null for a tool that changes no file, and for a change with no path', () => {
    expect(diffBodyFor({ toolName: 'Bash', input: { command: 'ls' }, result: null })).toBeNull();
    expect(diffBodyFor({ toolName: 'Edit', input: {}, result: null })).toBeNull();
  });

  it('discards hunks that are not shaped like hunks', () => {
    const body = diffBodyFor({
      toolName: 'Edit',
      input: { file_path: '/p/t.txt' },
      result: {
        filePath: '/p/t.txt',
        originalFile: 'x',
        structuredPatch: ['nope', { lines: 'no' }],
      },
    });
    expect(body?.hunks).toBeUndefined();
  });
});

describe('unifiedFromReplace', () => {
  it('removes every old line and adds every new one', () => {
    expect(unifiedFromReplace('a\nb\n', 'a\nc\n')).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a', '-b', '+a', '+c'] },
    ]);
  });
  it('is empty when there is nothing to say', () => {
    expect(unifiedFromReplace('', '')).toEqual([]);
  });
});

describe('terminalBodyFor', () => {
  it("keeps Claude's own split of the streams", () => {
    expect(
      terminalBodyFor({
        command: 'ls -a',
        content: 'combined',
        isError: false,
        result: { stdout: 'out', stderr: 'err', interrupted: false },
      }),
    ).toEqual({
      kind: 'terminal',
      command: 'ls -a',
      stdout: 'out',
      stderr: 'err',
      interrupted: false,
    });
  });

  it('prefers the spilled body when one was read', () => {
    const body = terminalBodyFor({
      command: 'cat big.log',
      content: 'head…',
      isError: false,
      result: { stdout: 'head…', stderr: '' },
      spilled: 'the whole thing',
    });
    expect(body.stdout).toBe('the whole thing');
  });

  it('does not invent a split when there is no structured result', () => {
    expect(
      terminalBodyFor({ command: 'ls', content: 'boom', isError: true, result: null }),
    ).toEqual({ kind: 'terminal', command: 'ls', stdout: '', stderr: 'boom', interrupted: false });
  });

  it('reports an interrupted command as interrupted', () => {
    expect(
      terminalBodyFor({
        command: 'sleep 99',
        content: '',
        isError: false,
        result: { stdout: '', stderr: '', interrupted: true },
      }).interrupted,
    ).toBe(true);
  });
});

/** Nothing here touches the real `~/.claude`: HOME is a temp directory for every case. */
describe('spill files and the transcript fallback', () => {
  let home: string;
  let projects: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-diffs-')));
    projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('encodes a working tree the way Claude Code names its transcript directory', () => {
    expect(encodeProjectDir('/Users/me/Desktop/My App.v2')).toBe('-Users-me-Desktop-My-App-v2');
    expect(transcriptPathFor('/h', '/p/x', 'sid')).toBe('/h/.claude/projects/-p-x/sid.jsonl');
  });

  it('reads a spilled Bash body from inside the transcript tree', () => {
    const spill = path.join(projects, 'tool-results', 'out.txt');
    fs.mkdirSync(path.dirname(spill), { recursive: true });
    fs.writeFileSync(spill, 'a lot of output');
    expect(readPersistedOutput(spill, { home })).toBe('a lot of output');
  });

  it('keeps the tail when a spill file is over the cap', () => {
    const spill = path.join(projects, 'big.txt');
    fs.writeFileSync(spill, `${'x'.repeat(100)}TAIL`);
    expect(readPersistedOutput(spill, { home, maxBytes: 4 })).toBe('TAIL');
  });

  it('refuses a path outside the transcript tree, symlinks included', () => {
    const outside = path.join(home, 'secret.txt');
    fs.writeFileSync(outside, 'not yours');
    expect(readPersistedOutput(outside, { home })).toBeNull();

    const link = path.join(projects, 'link.txt');
    fs.symlinkSync(outside, link);
    expect(readPersistedOutput(link, { home })).toBeNull();
    expect(readPersistedOutput(path.join(projects, 'missing.txt'), { home })).toBeNull();
  });

  it("finds Claude's own result for a tool call in the session transcript", async () => {
    const cwd = '/p/demo';
    const file = transcriptPathFor(home, cwd, 'sid-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'x' }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_other' }] },
          toolUseResult: { stdout: 'wrong one' },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
          toolUseResult: EDIT_RESULT,
        }),
        '{ half-written',
      ].join('\n'),
    );
    const lookup = new TranscriptResultLookup({ home, cwd, claudeSessionId: 'sid-1' });
    await expect(lookup.find('toolu_1')).resolves.toMatchObject({ oldString: 'bravo' });
  });

  it('gives up inside its budget when the record never arrives', async () => {
    const lookup = new TranscriptResultLookup({
      home,
      cwd: '/p/demo',
      claudeSessionId: 'missing',
      timeoutMs: 60,
      pollMs: 10,
    });
    const t0 = Date.now();
    await expect(lookup.find('toolu_1')).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('waits for a record that is written a moment later', async () => {
    const cwd = '/p/late';
    const file = transcriptPathFor(home, cwd, 'sid-2');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const lookup = new TranscriptResultLookup({ home, cwd, claudeSessionId: 'sid-2', pollMs: 10 });
    const pending = lookup.find('toolu_late');
    setTimeout(
      () =>
        fs.appendFileSync(
          file,
          `${JSON.stringify({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_late' }] },
            toolUseResult: { ...EDIT_RESULT, filePath: '/p/late/t.txt' },
          })}\n`,
        ),
      30,
    );
    await expect(pending).resolves.toMatchObject({ filePath: '/p/late/t.txt' });
  });
});
