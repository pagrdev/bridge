import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePaths, getPaths, resolvePagrHome } from './paths.js';
import { useTempHome } from './testUtil.js';

describe('paths', () => {
  const t = useTempHome();

  it('honours PAGR_HOME override', () => {
    expect(resolvePagrHome({ PAGR_HOME: '/x/y' })).toBe('/x/y');
    expect(resolvePagrHome({})).toMatch(/\.pagr$/);
  });

  it('lays out files and creates 0700 dirs', () => {
    const home = join(t.home, 'pagr');
    const p = ensurePaths(home);
    expect(p.socketPath).toBe(join(home, 'run', 'daemon.sock'));
    expect(p.configFile).toBe(join(home, 'config.json'));
    for (const d of [p.home, p.runDir, p.tmpDir, p.logsDir]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(getPaths(home)).toEqual(p);
  });
});
