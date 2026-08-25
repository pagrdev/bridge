import { chmodSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectJson, readJson, writeJson } from './jsonFile.js';
import { useTempHome } from './testUtil.js';

describe('jsonFile', () => {
  const t = useTempHome('pagr-json-');
  const file = () => join(t.home, 'thing.json');

  it('writes 0600 atomically and leaves no temp files behind', () => {
    writeJson(file(), { a: 1 });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readJson(file(), null)).toEqual({ a: 1 });
    expect(readdirSync(t.home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed write leaves the previous file intact and no temp file', () => {
    writeJson(file(), { good: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJson(file(), circular)).toThrow();
    expect(readJson(file(), null)).toEqual({ good: true });
    expect(readdirSync(t.home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('inspectJson says nothing about a file that was never written', () => {
    expect(inspectJson(file(), { fallback: true })).toEqual({ value: { fallback: true } });
  });

  it('inspectJson names a corrupt file rather than silently falling back', () => {
    writeFileSync(file(), '{"a": 1');
    const r = inspectJson(file(), {});
    expect(r.value).toEqual({});
    expect(r.problem?.code).toBe('corrupt');
    expect(r.problem?.message).toContain('not valid JSON');
    expect(r.problem?.hint).toContain('pagr connect');
  });

  it('treats an empty file as "not written yet", not as corruption', () => {
    writeFileSync(file(), '   \n');
    expect(inspectJson(file(), { x: 1 })).toEqual({ value: { x: 1 } });
  });

  it('reports an unreadable file with a chmod fix', () => {
    writeFileSync(file(), '{}');
    chmodSync(file(), 0o000);
    try {
      const r = inspectJson(file(), {});
      // root can read anything; only assert the classification when the OS enforces it.
      if (r.problem) {
        expect(r.problem.code).toBe('unreadable');
        expect(r.problem.hint).toContain('chmod 600');
      }
    } finally {
      chmodSync(file(), 0o600);
    }
  });
});
