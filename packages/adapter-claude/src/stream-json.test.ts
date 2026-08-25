import { describe, expect, it } from 'vitest';
import {
  actionTypeForTool,
  controlResponseLine,
  parseStreamLine,
  previewForTool,
  userMessageLine,
} from './stream-json.js';

describe('parseStreamLine', () => {
  it('parses system/init', () => {
    expect(
      parseStreamLine('{"type":"system","subtype":"init","session_id":"abc","cwd":"/p"}'),
    ).toEqual({
      type: 'init',
      sessionId: 'abc',
    });
    expect(parseStreamLine('{"type":"system","subtype":"hook_started"}')).toMatchObject({
      type: 'other',
    });
  });

  it('parses assistant text and tool_use', () => {
    expect(
      parseStreamLine(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"PAGR_HOOK_OK"}]}}',
      ),
    ).toEqual({ type: 'assistant_text', text: 'PAGR_HOOK_OK' });
    expect(
      parseStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi"}}]}}',
      ),
    ).toEqual({
      type: 'tool_use',
      toolUseId: 'toolu_1',
      name: 'Bash',
      input: { command: 'echo hi' },
    });
  });

  it('parses tool_result and result', () => {
    expect(
      parseStreamLine(
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"PAGR_HOOK_OK","is_error":false}]}}',
      ),
    ).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      isError: false,
      content: 'PAGR_HOOK_OK',
    });
    expect(
      parseStreamLine(
        '{"is_error":false,"subtype":"success","result":"DONE","session_id":"s","type":"result"}',
      ),
    ).toEqual({ type: 'result', ok: true, subtype: 'success', text: 'DONE', sessionId: 's' });
    expect(
      parseStreamLine('{"type":"result","subtype":"error_during_execution","is_error":true}'),
    ).toMatchObject({
      type: 'result',
      ok: false,
    });
  });

  it('parses control_request can_use_tool and cancel', () => {
    const line =
      '{"type":"control_request","request_id":"74023d01","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/p/hello.txt","content":"hi\\n"},"permission_suggestions":[{"type":"setMode","mode":"acceptEdits"}],"tool_use_id":"toolu_01Tu"}}';
    expect(parseStreamLine(line)).toEqual({
      type: 'permission_request',
      requestId: '74023d01',
      toolUseId: 'toolu_01Tu',
      toolName: 'Write',
      input: { file_path: '/p/hello.txt', content: 'hi\n' },
    });
    expect(parseStreamLine('{"type":"control_cancel_request","request_id":"x"}')).toEqual({
      type: 'permission_cancel',
      requestId: 'x',
    });
  });

  it('is robust to garbage', () => {
    expect(parseStreamLine('')).toMatchObject({ type: 'invalid' });
    expect(parseStreamLine('nope')).toMatchObject({ type: 'invalid' });
    expect(parseStreamLine('{"type":"rate_limit_event"}')).toMatchObject({ type: 'other' });
  });
});

describe('encoders', () => {
  it('builds user and control_response lines', () => {
    expect(JSON.parse(userMessageLine('hi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
    expect(
      JSON.parse(controlResponseLine('r1', { behavior: 'allow', updatedInput: { a: 1 } })),
    ).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { a: 1 } },
      },
    });
    expect(
      JSON.parse(controlResponseLine('r1', { behavior: 'deny', message: 'no' })).response.response,
    ).toEqual({
      behavior: 'deny',
      message: 'no',
    });
  });
});

describe('previews', () => {
  it('summarises tools without leaking file contents', () => {
    expect(previewForTool('Bash', { command: 'npm test' })).toBe('$ npm test');
    expect(previewForTool('Write', { file_path: '/p/a.ts', content: 'SECRET' })).toBe(
      'Write /p/a.ts',
    );
    expect(previewForTool('Read', { file_path: '/p/a.ts' })).toBe('Read /p/a.ts');
    // project-relative when the project path is known (item 15)
    expect(previewForTool('Write', { file_path: '/p/a.ts', content: 'x' }, '/p')).toBe(
      'Write a.ts',
    );
    expect(previewForTool('Edit', { file_path: '/p/src/b.ts' }, '/p')).toBe('Edit src/b.ts');
    expect(previewForTool('Bash', { command: 'cat /p/x /q/y' }, '/p')).toBe('$ cat x /q/y');
    expect(previewForTool('mcp__x__y', { q: 'z' })).toBe('mcp__x__y q="z"');
    expect(actionTypeForTool('Bash')).toBe('command_execution');
    expect(actionTypeForTool('Edit')).toBe('file_change');
    expect(actionTypeForTool('WebFetch')).toBe('tool_use');
  });
});
