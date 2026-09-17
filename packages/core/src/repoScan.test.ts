import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry, projectIdFor } from './projects.js';
import { handleFor, REPO_HANDLE_TTL_MS, RepoHandleCache, scanRepos } from './repoScan.js';
import { withTempHome } from './testUtil.js';

/** A synthetic repository. Never the real home directory — see `withTempHome`. */
const repo = (root: string, ...segments: string[]): string => {
  const dir = join(root, ...segments);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  return dir;
};

const withRemote = (dir: string, url: string): string => {
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  return dir;
};

const registryFor = (home: string) =>
  new ProjectRegistry({
    home,
    pagrHome: join(home, '.pagr'),
    file: join(home, '.pagr', 'projects.json'),
    uid: () => -1,
  });

/** Everything in a scan result except the repo hint, which may legitimately carry `owner/name`. */
const withoutHints = (repos: Array<Record<string, unknown>>): string =>
  JSON.stringify(repos.map(({ repoHint: _hint, ...rest }) => rest));

describe('handleFor', () => {
  it('is deterministic for a path and salt', () => {
    expect(handleFor('/Users/x/code/alpha', 'salt-a')).toBe(
      handleFor('/Users/x/code/alpha', 'salt-a'),
    );
    expect(handleFor('/Users/x/code/alpha', 'salt-a')).toMatch(/^rh_[0-9a-f]{32}$/);
  });

  it('binds to the device salt, so one Mac’s handle means nothing on another', () => {
    expect(handleFor('/Users/x/code/alpha', 'salt-a')).not.toBe(
      handleFor('/Users/x/code/alpha', 'salt-b'),
    );
  });

  it('separates two paths, and never collides with that path’s project id', () => {
    const salt = 'salt-a';
    expect(handleFor('/Users/x/code/alpha', salt)).not.toBe(handleFor('/Users/x/code/beta', salt));
    // Same salt, same path, different domain: the hex must differ, or a handle would hand the
    // cloud the project id of a folder no local action has named.
    expect(handleFor('/Users/x/code/alpha', salt).slice(3)).not.toBe(
      projectIdFor('/Users/x/code/alpha', salt).slice(5),
    );
  });
});

describe('RepoHandleCache', () => {
  it('returns a path it was given, and forgets it after the TTL', () => {
    let now = new Date('2026-09-17T12:00:00Z');
    const cache = new RepoHandleCache({ now: () => now });
    cache.put('rh_' + 'a'.repeat(32), '/Users/x/code/alpha');
    expect(cache.get('rh_' + 'a'.repeat(32))).toBe('/Users/x/code/alpha');
    expect(cache.size).toBe(1);

    now = new Date(now.getTime() + REPO_HANDLE_TTL_MS - 1);
    expect(cache.get('rh_' + 'a'.repeat(32))).toBe('/Users/x/code/alpha');

    now = new Date(now.getTime() + 2);
    expect(cache.get('rh_' + 'a'.repeat(32))).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('knows nothing about a handle it never saw', () => {
    const cache = new RepoHandleCache();
    expect(cache.get('rh_' + 'b'.repeat(32))).toBeUndefined();
  });

  it('clears', () => {
    const cache = new RepoHandleCache();
    cache.put('rh_' + 'c'.repeat(32), '/Users/x/code/alpha');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('scanRepos', () => {
  it('never returns a path', async () => {
    await withTempHome(async (home) => {
      withRemote(repo(home, 'code', 'alpha'), 'git@github.com:acme/alpha.git');
      repo(home, 'Developer', 'beta');
      const cache = new RepoHandleCache();
      const res = await scanRepos({ home, registry: registryFor(home), cache });

      expect(res.repos.length).toBe(2);
      const serialised = withoutHints(res.repos as unknown as Array<Record<string, unknown>>);
      expect(serialised).not.toContain('/');
      expect(serialised).not.toContain(home);
      // The one place a slash may appear is the remote's `owner/name`, which is not a path.
      expect(res.repos.find((r) => r.repoHint?.name)?.repoHint?.name).toBe('acme/alpha');
      expect(JSON.stringify(res.repos)).not.toContain(home);
    });
  });

  it('hands back handles the cache can turn into local paths', async () => {
    await withTempHome(async (home) => {
      const alpha = repo(home, 'code', 'alpha');
      const cache = new RepoHandleCache();
      const registry = registryFor(home);
      const res = await scanRepos({ home, registry, cache });

      const found = res.repos.find((r) => r.displayName === 'alpha');
      expect(found?.handle).toMatch(/^rh_[0-9a-f]{32}$/);
      expect(cache.get(found?.handle ?? '')).toBe(alpha);
      expect(found?.handle).toBe(handleFor(alpha, registry.deviceSalt()));
    });
  });

  it('walks the conventional roots only — never ~ itself, never ~/Library', async () => {
    await withTempHome(async (home) => {
      repo(home, 'code', 'alpha');
      repo(home, 'Desktop', 'beta');
      repo(home, 'Library', 'Caches', 'sneaky');
      repo(home, 'loose'); // directly in ~, which is never a scan root
      const res = await scanRepos({
        home,
        registry: registryFor(home),
        cache: new RepoHandleCache(),
      });

      expect(res.repos.map((r) => r.displayName).sort()).toEqual(['alpha', 'beta']);
      expect(res.scannedRoots).toBe(2);
    });
  });

  it('stops at depth 3 and does not descend into a repository', async () => {
    await withTempHome(async (home) => {
      repo(home, 'code', 'org', 'deep'); // depth 3 — found
      repo(home, 'code', 'org', 'team', 'deeper'); // depth 4 — not found
      repo(home, 'code', 'outer', 'vendor', 'inner'); // inside a repo — not found
      repo(home, 'code', 'outer');
      const res = await scanRepos({
        home,
        registry: registryFor(home),
        cache: new RepoHandleCache(),
      });

      expect(res.repos.map((r) => r.displayName).sort()).toEqual(['deep', 'outer']);
    });
  });

  it('marks repositories that are already projects, and keeps their registered name', async () => {
    await withTempHome(async (home) => {
      const alpha = repo(home, 'code', 'alpha');
      repo(home, 'code', 'beta');
      const registry = registryFor(home);
      const added = registry.add(alpha, { displayName: 'alpha-prime' });

      const res = await scanRepos({ home, registry, cache: new RepoHandleCache() });
      const registered = res.repos.find((r) => r.registeredAs);
      expect(registered?.registeredAs).toBe(added.projectId);
      expect(registered?.displayName).toBe('alpha-prime');
      expect(res.repos.find((r) => r.displayName === 'beta')?.registeredAs).toBeUndefined();
    });
  });

  it('keeps every name distinct, including against registered projects', async () => {
    await withTempHome(async (home) => {
      const first = repo(home, 'code', 'one', 'app');
      repo(home, 'code', 'two', 'app');
      const registry = registryFor(home);
      registry.add(first);

      const res = await scanRepos({ home, registry, cache: new RepoHandleCache() });
      const names = res.repos.map((r) => r.displayName);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  it('truncates at the limit instead of streaming a whole disk', async () => {
    await withTempHome(async (home) => {
      for (const name of ['a', 'b', 'c']) repo(home, 'code', name);
      const res = await scanRepos({
        home,
        registry: registryFor(home),
        cache: new RepoHandleCache(),
        limit: 2,
      });
      expect(res.repos.length).toBe(2);
      expect(res.truncated).toBe(true);
    });
  });
});
