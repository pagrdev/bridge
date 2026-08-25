import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, redactPaths } from './logging.js';
import { useTempHome } from './testUtil.js';

describe('logging', () => {
  const t = useTempHome();

  it('redacts home paths recursively', () => {
    expect(redactPaths({ a: '/Users/w/x', b: ['/Users/w/y'], c: 1 }, '/Users/w')).toEqual({
      a: '~/x',
      b: ['~/y'],
      c: 1,
    });
  });

  it('writes JSON lines to file with redaction and level filtering', () => {
    const file = join(t.home, 'logs', 'daemon.log');
    const log = createLogger({
      file,
      stderr: false,
      home: '/Users/w',
      level: 'info',
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    log.debug('hidden');
    log.child({ mod: 'x' }).info('hello', { path: '/Users/w/proj' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      t: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'hello',
      mod: 'x',
      path: '~/proj',
    });
  });
});
