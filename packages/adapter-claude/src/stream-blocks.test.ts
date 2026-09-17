import { describe, expect, it } from 'vitest';
import { legacyEvent, mapToolKind, parseStreamLine, parseStreamRecord } from './stream-json.js';

/**
 * MOB-033: the parser stopped throwing away the parts of a line it had no use for.
 *
 * The old parser answered one question per line — "what one thing should the status summary say?"
 * — and dropped the rest: a message's second tool call, its thinking, the body of a result. These
 * tests are about the other question, the one a transcript asks: what actually happened.
 */
describe('parseStreamRecord', () => {
  it('returns every block of an assistant message, in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-09-17T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Weigh it up.', signature: 'sig-is-noise' },
          { type: 'text', text: 'Looking now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/p/a.ts' } },
        ],
      },
    });
    expect(parseStreamRecord(line)).toMatchObject({
      type: 'assistant_blocks',
      uuid: 'u1',
      at: '2026-09-17T12:00:00.000Z',
      blocks: [
        { type: 'thinking', text: 'Weigh it up.' },
        { type: 'text', text: 'Looking now.' },
        { type: 'tool_use', toolUseId: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', toolUseId: 'toolu_2', name: 'Read', input: { file_path: '/p/a.ts' } },
      ],
    });
  });

  it('keeps an unknown block instead of dropping it', () => {
    const rec = parseStreamRecord(
      '{"type":"assistant","message":{"content":[{"type":"redacted_thinking","data":"x"}]}}',
    );
    expect(rec).toMatchObject({
      type: 'assistant_blocks',
      blocks: [{ type: 'other', blockType: 'redacted_thinking' }],
    });
  });

  it('returns user blocks with the tool_use_result sidecar', () => {
    // Verified 2026-09-17 against Claude Code 2.1.220 with `--verbose`: `tool_use_result` rides on
    // the stream-json `user` line, the same object the transcript writes as `toolUseResult`.
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello', is_error: false },
        ],
      },
      tool_use_result: { stdout: 'hello', stderr: '', interrupted: false },
    });
    expect(parseStreamRecord(line)).toMatchObject({
      type: 'user_blocks',
      uuid: 'u2',
      blocks: [{ type: 'tool_result', toolUseId: 'toolu_1', isError: false, content: 'hello' }],
      toolUseResult: { stdout: 'hello', stderr: '', interrupted: false },
    });
  });

  it('accepts the transcript spelling of the sidecar too', () => {
    const rec = parseStreamRecord(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"stdout":"x"}}',
    );
    expect(rec).toMatchObject({ toolUseResult: { stdout: 'x' } });
  });

  it('records text and image blocks on a user line without carrying image bytes', () => {
    const rec = parseStreamRecord(
      '{"type":"user","message":{"content":[{"type":"text","text":"look"},{"type":"image","source":{"data":"BIGBASE64"}}]}}',
    );
    expect(rec).toMatchObject({
      type: 'user_blocks',
      blocks: [{ type: 'text', text: 'look' }, { type: 'image' }],
    });
    expect(JSON.stringify(rec.type === 'user_blocks' ? rec.blocks : [])).not.toContain('BIGBASE64');
  });

  it('names system subtypes other than init', () => {
    expect(
      parseStreamRecord('{"type":"system","subtype":"hook_started","hook_name":"Stop"}'),
    ).toMatchObject({ type: 'system', subtype: 'hook_started', text: 'Stop' });
    expect(
      parseStreamRecord('{"type":"system","subtype":"init","session_id":"abc","cwd":"/p"}'),
    ).toMatchObject({ type: 'init', sessionId: 'abc' });
  });
});

describe('legacyEvent', () => {
  it('is exactly what parseStreamLine returns', () => {
    for (const line of [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"system","subtype":"hook_started"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"t"},{"type":"text","text":"hi"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{}},{"type":"tool_use","id":"b","name":"Read","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"x"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"D","session_id":"s"}',
      '{"type":"control_cancel_request","request_id":"r"}',
      'not json',
    ]) {
      expect(legacyEvent(parseStreamRecord(line))).toEqual(parseStreamLine(line));
    }
  });

  it('still collapses a multi-tool message to the first tool, as the summaries expect', () => {
    expect(
      parseStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","id":"b","name":"Read","input":{}}]}}',
      ),
    ).toEqual({ type: 'tool_use', toolUseId: 'a', name: 'Bash', input: { command: 'ls' } });
  });
});

describe('mapToolKind', () => {
  it('maps Claude tool names to ACP kinds', () => {
    expect(mapToolKind('Read')).toBe('read');
    expect(mapToolKind('Glob')).toBe('search');
    expect(mapToolKind('Grep')).toBe('search');
    expect(mapToolKind('Edit')).toBe('edit');
    expect(mapToolKind('Write')).toBe('edit');
    expect(mapToolKind('MultiEdit')).toBe('edit');
    expect(mapToolKind('NotebookEdit')).toBe('edit');
    expect(mapToolKind('Bash')).toBe('execute');
    expect(mapToolKind('KillShell')).toBe('execute');
    expect(mapToolKind('WebFetch')).toBe('fetch');
    expect(mapToolKind('WebSearch')).toBe('fetch');
    expect(mapToolKind('ExitPlanMode')).toBe('switch_mode');
  });

  it('is honest about what it does not recognise', () => {
    expect(mapToolKind('Task')).toBe('other');
    expect(mapToolKind('AskUserQuestion')).toBe('other');
    expect(mapToolKind('mcp__linear__create_issue')).toBe('other');
  });
});
