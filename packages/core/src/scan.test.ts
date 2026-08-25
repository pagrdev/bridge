import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultScanRoots,
  inferProjectNames,
  MAX_SCAN_DEPTH,
  resolveNameCollisions,
  ScanRootError,
  scanForRepos,
} from './scan.js';
import { withTempHome } from './testUtil.js';

const repo = (root: string, ...segments: string[]): string => {
  const dir = join(root, ...segments);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  return dir;
};

const plain = (root: string, ...segments: string[]): string => {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('scanForRepos', () => {
  it('finds git repositories under a root', async () => {
    await withTempHome(async (home) => {
      const a = repo(home, 'code', 'alpha');
      const b = repo(home, 'code', 'beta');
      plain(home, 'code', 'not-a-repo');
      const res = await scanForRepos([join(home, 'code')]);
      expect(res.repos.map((r) => r.path).sort()).toEqual([a, b].sort());
    });
  });

  it('does not descend into a repository once found', async () => {
    await withTempHome(async (home) => {
      const outer = repo(home, 'code', 'outer');
      repo(home, 'code', 'outer', 'vendor', 'inner');
      const res = await scanForRepos([join(home, 'code')]);
      expect(res.repos.map((r) => r.path)).toEqual([outer]);
    });
  });

  it('skips node_modules, caches, Library and hidden directories', async () => {
    await withTempHome(async (home) => {
      repo(home, 'code', 'node_modules', 'pkg');
      repo(home, 'code', '.cache', 'thing');
      repo(home, 'code', 'Library', 'thing');
      repo(home, 'code', 'target', 'thing');
      const keep = repo(home, 'code', 'keeper');
      const res = await scanForRepos([join(home, 'code')]);
      expect(res.repos.map((r) => r.path)).toEqual([keep]);
    });
  });

  it('honours a bounded depth', async () => {
    await withTempHome(async (home) => {
      const shallow = repo(home, 'code', 'a');
      repo(home, 'code', 'x', 'y', 'z', 'deep');
      const res = await scanForRepos([join(home, 'code')], { maxDepth: 2 });
      expect(res.repos.map((r) => r.path)).toEqual([shallow]);
    });
  });

  it('never follows symlinks (no cycles, no escapes)', async () => {
    await withTempHome(async (home) => {
      const real = repo(home, 'code', 'real');
      symlinkSync(join(home, 'code'), join(home, 'code', 'loop'));
      const res = await scanForRepos([join(home, 'code')], { maxDepth: 4 });
      expect(res.repos.map((r) => r.path)).toEqual([real]);
    });
  });

  it('refuses to crawl the home directory, its parents, or the filesystem root', async () => {
    await withTempHome(async (home) => {
      await expect(scanForRepos([home], { home })).rejects.toBeInstanceOf(ScanRootError);
      await expect(scanForRepos(['/'], { home })).rejects.toBeInstanceOf(ScanRootError);
      // `/Users` is not $HOME but contains it — and everyone else's.
      await expect(scanForRepos([join(home, '..')], { home })).rejects.toBeInstanceOf(
        ScanRootError,
      );
    });
  });

  it('ignores roots that do not exist instead of failing', async () => {
    await withTempHome(async (home) => {
      const res = await scanForRepos([join(home, 'nope'), join(home, 'also-nope')]);
      expect(res.repos).toEqual([]);
      expect(res.skippedRoots).toHaveLength(2);
    });
  });

  it('deduplicates overlapping roots', async () => {
    await withTempHome(async (home) => {
      const a = repo(home, 'code', 'alpha');
      const res = await scanForRepos([join(home, 'code'), join(home, 'code'), join(home, 'code')]);
      expect(res.repos.map((r) => r.path)).toEqual([a]);
    });
  });

  it('stops at a limit and reports truncation', async () => {
    await withTempHome(async (home) => {
      for (let i = 0; i < 8; i++) repo(home, 'code', `p${i}`);
      const res = await scanForRepos([join(home, 'code')], { limit: 3 });
      expect(res.repos).toHaveLength(3);
      expect(res.truncated).toBe(true);
    });
  });

  it('reads the repo hint of each discovered repository', async () => {
    await withTempHome(async (home) => {
      const dir = repo(home, 'code', 'alpha');
      writeFileSync(
        join(dir, '.git', 'config'),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
      );
      const res = await scanForRepos([join(home, 'code')]);
      expect(res.repos[0]?.repoHint?.name).toBe('acme/widgets');
    });
  });

  it('defaults to a bounded depth', () => {
    expect(MAX_SCAN_DEPTH).toBeGreaterThan(0);
    expect(MAX_SCAN_DEPTH).toBeLessThanOrEqual(5);
  });

  it('scans a few hundred repositories quickly', async () => {
    await withTempHome(async (home) => {
      for (let i = 0; i < 300; i++) repo(home, 'code', `g${i % 10}`, `p${i}`);
      const started = Date.now();
      const res = await scanForRepos([join(home, 'code')]);
      expect(res.repos).toHaveLength(300);
      expect(Date.now() - started).toBeLessThan(4000);
    });
  });
});

describe('defaultScanRoots', () => {
  it('returns only roots that exist, never the home directory itself', async () => {
    await withTempHome(async (home) => {
      plain(home, 'code');
      plain(home, 'Developer');
      const roots = defaultScanRoots({ home, cwd: join(home, 'code', 'app') });
      expect(roots).toContain(join(home, 'code'));
      expect(roots).toContain(join(home, 'Developer'));
      expect(roots).not.toContain(home);
    });
  });

  it("includes the current directory's parent when it is not the home directory", async () => {
    await withTempHome(async (home) => {
      const parent = plain(home, 'work', 'group');
      const roots = defaultScanRoots({ home, cwd: join(parent, 'app') });
      expect(roots).toContain(parent);
    });
  });

  it('never offers a system location, even as the current directory’s parent', async () => {
    await withTempHome(async (home) => {
      // A shell sitting in /tmp must not turn /private into a scan root.
      const roots = defaultScanRoots({ home, cwd: '/private/tmp/whatever' });
      for (const r of roots) expect(r.startsWith('/private')).toBe(false);
      expect(defaultScanRoots({ home, cwd: '/usr/local/src' })).not.toContain('/usr/local');
      expect(defaultScanRoots({ home, cwd: '/Applications/Foo.app' })).not.toContain(
        '/Applications',
      );
    });
  });

  it('never returns ~/Library', async () => {
    await withTempHome(async (home) => {
      plain(home, 'Library', 'code');
      const roots = defaultScanRoots({ home, cwd: join(home, 'Library', 'code', 'x') });
      expect(roots.some((r) => r.startsWith(join(home, 'Library')))).toBe(false);
    });
  });
});

describe('inferProjectNames', () => {
  it('uses the folder name', () => {
    expect(inferProjectNames('/Users/me/code/widgets').displayName).toBe('widgets');
  });

  it('adds the GitHub repo name as an alias when it differs from the folder', () => {
    const n = inferProjectNames('/Users/me/code/widgets-checkout', {
      host: 'github.com',
      name: 'acme/widgets',
    });
    expect(n.displayName).toBe('widgets-checkout');
    expect(n.aliases).toContain('widgets');
  });

  it('does not duplicate the folder name as an alias', () => {
    const n = inferProjectNames('/Users/me/code/widgets', {
      host: 'github.com',
      name: 'acme/widgets',
    });
    expect(n.aliases).not.toContain('widgets');
  });

  it('caps names and aliases to protocol limits', () => {
    const n = inferProjectNames(`/Users/me/code/${'x'.repeat(200)}`, {
      name: `acme/${'y'.repeat(200)}`,
    });
    expect(n.displayName.length).toBeLessThanOrEqual(80);
    for (const a of n.aliases) expect(a.length).toBeLessThanOrEqual(40);
  });
});

describe('resolveNameCollisions', () => {
  it('leaves unique names alone', () => {
    const out = resolveNameCollisions(
      [{ path: '/a/alpha', displayName: 'alpha', aliases: [] }],
      [{ displayName: 'beta', aliases: [] }],
    );
    expect(out[0]?.displayName).toBe('alpha');
    expect(out[0]?.renamedFrom).toBeUndefined();
  });

  it('qualifies a name that collides with an existing project', () => {
    const out = resolveNameCollisions(
      [{ path: '/work/pagr/bridge', displayName: 'bridge', aliases: [] }],
      [{ displayName: 'bridge', aliases: [] }],
    );
    expect(out[0]?.displayName).toBe('pagr/bridge');
    expect(out[0]?.renamedFrom).toBe('bridge');
  });

  it('resolves collisions between two candidates in the same batch', () => {
    const out = resolveNameCollisions(
      [
        { path: '/work/one/app', displayName: 'app', aliases: [] },
        { path: '/work/two/app', displayName: 'app', aliases: [] },
      ],
      [],
    );
    expect(out.map((c) => c.displayName)).toEqual(['app', 'two/app']);
  });

  it('falls back to a numeric suffix when the qualified name also collides', () => {
    const out = resolveNameCollisions(
      [{ path: '/work/pagr/bridge', displayName: 'bridge', aliases: [] }],
      [
        { displayName: 'bridge', aliases: [] },
        { displayName: 'pagr/bridge', aliases: [] },
      ],
    );
    expect(out[0]?.displayName).toBe('bridge-2');
  });

  it('terminates on names already at the length cap', () => {
    const long = 'x'.repeat(80);
    const out = resolveNameCollisions(
      [
        { path: `/a/acme/${long}`, displayName: long, aliases: [] },
        { path: `/b/acme/${long}`, displayName: long, aliases: [] },
        { path: `/c/acme/${long}`, displayName: long, aliases: [] },
      ],
      [{ displayName: long, aliases: [] }],
    );
    const names = out.map((c) => c.displayName);
    expect(new Set([...names, long]).size).toBe(4);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(80);
  });

  it('terminates when the path has no parent to qualify with', () => {
    const out = resolveNameCollisions(
      [
        { path: '/app', displayName: 'app', aliases: [] },
        { path: '/app', displayName: 'app', aliases: [] },
      ],
      [{ displayName: 'app', aliases: [] }],
    );
    expect(new Set(out.map((c) => c.displayName)).size).toBe(2);
    expect(out.map((c) => c.displayName)).toEqual(['app-2', 'app-3']);
  });

  it('is case-insensitive', () => {
    const out = resolveNameCollisions(
      [{ path: '/work/pagr/Bridge', displayName: 'Bridge', aliases: [] }],
      [{ displayName: 'bridge', aliases: [] }],
    );
    expect(out[0]?.displayName).toBe('pagr/Bridge');
  });

  it('drops aliases that collide with an existing name or alias', () => {
    const out = resolveNameCollisions(
      [{ path: '/work/checkout', displayName: 'checkout', aliases: ['widgets', 'shop'] }],
      [{ displayName: 'other', aliases: ['widgets'] }],
    );
    expect(out[0]?.aliases).toEqual(['shop']);
    expect(out[0]?.droppedAliases).toEqual(['widgets']);
  });

  it('drops an alias that would shadow the display name of the same batch', () => {
    const out = resolveNameCollisions(
      [
        { path: '/work/alpha', displayName: 'alpha', aliases: [] },
        { path: '/work/beta', displayName: 'beta', aliases: ['alpha'] },
      ],
      [],
    );
    expect(out[1]?.aliases).toEqual([]);
  });
});
