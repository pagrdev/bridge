import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplayCache } from './replay.js';
import { useTempHome } from './testUtil.js';

describe('ReplayCache', () => {
  const t = useTempHome();

  it('rejects duplicates until expiry', () => {
    let now = 1000;
    const c = new ReplayCache({ now: () => now });
    expect(c.add('a', 2000)).toBe(true);
    expect(c.add('a', 2000)).toBe(false);
    expect(c.has('a')).toBe(true);
    now = 2001;
    expect(c.has('a')).toBe(false);
    expect(c.add('a', 3000)).toBe(true);
  });

  it('evicts oldest when bounded', () => {
    const c = new ReplayCache({ maxEntries: 2, now: () => 0 });
    c.add('a', 10);
    c.add('b', 10);
    c.add('c', 10);
    expect(c.size).toBe(2);
    expect(c.has('a')).toBe(false);
    expect(c.has('c')).toBe(true);
  });

  it('persists and reloads', () => {
    const file = join(t.home, 'replay.json');
    const c = new ReplayCache({ file, now: () => 0 });
    c.add('n1', 5000);
    const c2 = new ReplayCache({ file, now: () => 0 });
    expect(c2.has('n1')).toBe(true);
    const c3 = new ReplayCache({ file, now: () => 6000 });
    expect(c3.has('n1')).toBe(false);
  });
});
