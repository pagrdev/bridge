import { describe, expect, it } from 'vitest';
import { classifyLine, encode, LineBuffer } from './jsonrpc.js';

describe('classifyLine', () => {
  it('classifies responses, requests and notifications (no jsonrpc field)', () => {
    expect(classifyLine('{"id":1,"result":{"ok":true}}')).toMatchObject({ kind: 'response' });
    expect(classifyLine('{"id":2,"error":{"code":-1,"message":"x"}}')).toMatchObject({
      kind: 'response',
    });
    expect(
      classifyLine('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}'),
    ).toMatchObject({ kind: 'request', msg: { id: 7 } });
    expect(classifyLine('{"method":"turn/completed","params":{},"emittedAtMs":1}')).toMatchObject({
      kind: 'notification',
      msg: { method: 'turn/completed' },
    });
  });

  it('never throws on garbage', () => {
    expect(classifyLine('')).toMatchObject({ kind: 'invalid', reason: 'empty' });
    expect(classifyLine('not json')).toMatchObject({ kind: 'invalid', reason: 'not json' });
    expect(classifyLine('[1,2]')).toMatchObject({ kind: 'invalid' });
    expect(classifyLine('{"foo":1}')).toMatchObject({ kind: 'invalid' });
  });
});

describe('LineBuffer', () => {
  it('splits partial chunks into whole lines', () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(b.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}', '']);
    expect(b.flush()).toBe('{"c":3}');
    expect(b.flush()).toBeNull();
  });
});

describe('encode', () => {
  it('emits one JSON line without a jsonrpc header', () => {
    const line = encode({ id: 1, method: 'initialize', params: {} });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: 1, method: 'initialize', params: {} });
    expect(line).not.toContain('jsonrpc');
  });
});
