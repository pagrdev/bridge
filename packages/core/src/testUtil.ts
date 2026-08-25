import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** Create an isolated temp dir; returns the realpath and a cleanup fn. */
export function tempHome(prefix = 'pagr-test-'): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Per-test temp dir. Read `.home` inside tests only. */
export function useTempHome(prefix = 'pagr-test-'): { readonly home: string } {
  let cur: ReturnType<typeof tempHome> | null = null;
  beforeEach(() => {
    cur = tempHome(prefix);
  });
  afterEach(() => {
    cur?.cleanup();
    cur = null;
  });
  return {
    get home() {
      if (!cur) throw new Error('useTempHome: not inside a test');
      return cur.home;
    },
  };
}
