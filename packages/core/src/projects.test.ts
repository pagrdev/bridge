import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry, parseRemoteUrl, repoHint } from './projects.js';
import { tempHome } from './testUtil.js';

function makeRepo(dir: string, remote = 'git@github.com:acme/widgets.git') {
  mkdirSync(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`,
  );
  writeFileSync(
    join(dir, '.git', 'refs', 'remotes', 'origin', 'HEAD'),
    'ref: refs/remotes/origin/main\n',
  );
}

describe('ProjectRegistry', () => {
  let t: ReturnType<typeof tempHome>;
  let home: string;
  let pagrHome: string;
  let reg: ProjectRegistry;
  beforeEach(() => {
    t = tempHome();
    home = join(t.home, 'home');
    pagrHome = join(home, '.pagr');
    mkdirSync(pagrHome, { recursive: true });
    let n = 0;
    reg = new ProjectRegistry({
      file: join(pagrHome, 'projects.json'),
      home,
      pagrHome,
      idGen: () => `proj_${(++n).toString(16).padStart(32, '0')}`,
    });
  });
  afterEach(() => t.cleanup());

  it('adds a git repo with realpath, repo hint, and persists', () => {
    const repo = join(home, 'code', 'widgets');
    makeRepo(repo);
    const p = reg.add(repo, { displayName: 'Widgets', aliases: ['w'] });
    expect(p.path).toBe(repo);
    expect(p.repoHint).toEqual({ host: 'github.com', name: 'acme/widgets', defaultBranch: 'main' });
    const reloaded = new ProjectRegistry({ file: join(pagrHome, 'projects.json'), home, pagrHome });
    expect(reloaded.resolve(p.projectId)).toEqual({
      projectId: p.projectId,
      path: repo,
      displayName: 'Widgets',
    });
    expect(reloaded.summaries()[0]).not.toHaveProperty('path');
    expect(reg.remove(p.projectId)).toBe(true);
    expect(reg.list()).toEqual([]);
  });

  it('rejects non-git unless allowed, missing, files, duplicates', () => {
    const plain = join(home, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(() => reg.add(plain)).toThrow(/not a git/);
    expect(reg.add(plain, { allowNonGit: true }).displayName).toBe('plain');
    expect(() => reg.add(plain, { allowNonGit: true })).toThrow(/already registered/);
    expect(() => reg.add(join(home, 'nope'))).toThrow(/does not exist/);
    const f = join(home, 'file.txt');
    writeFileSync(f, 'x');
    expect(() => reg.add(f, { allowNonGit: true })).toThrow(/not a directory/);
  });

  it('rejects forbidden roots: home, ~/.pagr, /, /System, /private/etc', () => {
    expect(() => reg.add(home, { allowNonGit: true })).toThrow(/refusing/);
    const inside = join(pagrHome, 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(() => reg.add(inside, { allowNonGit: true })).toThrow(/refusing/);
    expect(() => reg.add('/', { allowNonGit: true })).toThrow(/refusing/);
    expect(() => reg.add('/System', { allowNonGit: true })).toThrow(/refusing/);
    expect(() => reg.add('/private/etc', { allowNonGit: true })).toThrow(/refusing/);
  });

  it('assertContained resolves symlinks and rejects escapes', () => {
    const repo = join(home, 'repo');
    makeRepo(repo);
    const outside = join(home, 'outside');
    mkdirSync(outside);
    mkdirSync(join(repo, 'src'));
    symlinkSync(outside, join(repo, 'link'));
    const p = reg.add(repo);
    expect(reg.assertContained(p.projectId, 'src/index.ts')).toBe(join(repo, 'src', 'index.ts'));
    expect(reg.assertContained(p.projectId, 'src/new/file.ts')).toBe(
      join(repo, 'src', 'new', 'file.ts'),
    );
    expect(() => reg.assertContained(p.projectId, '../outside/x')).toThrow(/outside project/);
    expect(() => reg.assertContained(p.projectId, 'link/x')).toThrow(/outside project/);
    expect(() => reg.assertContained(p.projectId, '/etc/passwd')).toThrow(/outside project/);
    expect(() => reg.assertContained('proj_missing', 'x')).toThrow(/unknown project/);
  });

  it('findByPath maps a cwd to the registered project containing it (finding 12)', () => {
    const repo = join(home, 'repo');
    makeRepo(repo);
    const nested = join(home, 'repo-nested');
    makeRepo(nested);
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const outside = join(home, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(repo, 'link'));
    const p = reg.add(repo);
    reg.add(nested);
    expect(reg.findByPath(repo)?.projectId).toBe(p.projectId);
    expect(reg.findByPath(join(repo, 'src', 'deep'))?.projectId).toBe(p.projectId);
    // not-yet-existing subdir still resolves via nearest existing ancestor
    expect(reg.findByPath(join(repo, 'src', 'nope'))?.projectId).toBe(p.projectId);
    // sibling with a shared prefix is NOT inside
    expect(reg.findByPath(`${repo}-nested`)?.projectId).not.toBe(p.projectId);
    expect(reg.findByPath(outside)).toBeUndefined();
    expect(reg.findByPath(join(repo, 'link'))).toBeUndefined(); // symlink escapes the root
    expect(reg.findByPath(home)).toBeUndefined();
    expect(reg.findByPath('relative/path')).toBeUndefined();
  });

  it('discover finds repos shallowly, skips node_modules and marks registered ones', async () => {
    const roots = join(home, 'code');
    makeRepo(join(roots, 'a'));
    makeRepo(join(roots, 'x', 'b'));
    makeRepo(join(roots, 'x', 'y', 'z', 'deep'));
    makeRepo(join(roots, 'node_modules', 'pkg'));
    const a = reg.add(join(roots, 'a'));
    const found = await reg.discover([roots]);
    expect(found.repos.map((r) => r.path)).toEqual([join(roots, 'a'), join(roots, 'x', 'b')]);
    expect(found.repos[0]?.registeredAs).toBe(a.projectId);
    expect(found.repos[1]?.registeredAs).toBeUndefined();
  });

  it('refuses to discover the home directory itself', async () => {
    await expect(reg.discover([home])).rejects.toThrow(/home directory/);
  });

  it('infers a display name and a GitHub alias, and reports collisions it resolved', () => {
    const one = join(home, 'work', 'checkout');
    makeRepo(one, 'git@github.com:acme/widgets.git');
    const p = reg.add(one);
    expect(p.displayName).toBe('checkout');
    expect(p.aliases).toEqual(['widgets']);

    const two = join(home, 'other', 'checkout');
    makeRepo(two, 'git@github.com:acme/widgets.git');
    const q = reg.add(two);
    expect(q.displayName).toBe('other/checkout');
    expect(q.renamedFrom).toBe('checkout');
    expect(q.aliases).toEqual([]);
    expect(q.droppedAliases).toEqual(['widgets']);
  });

  it('refuses an explicit name or alias that already refers to another project', () => {
    const one = join(home, 'one');
    const two = join(home, 'two');
    makeRepo(one);
    makeRepo(two);
    reg.add(one, { displayName: 'Alpha', aliases: ['a'] });
    expect(() => reg.add(two, { displayName: 'alpha' })).toThrow(/already refers to Alpha/);
    expect(() => reg.add(two, { displayName: 'Beta', aliases: ['A'] })).toThrow(
      /alias "A" already refers to/,
    );
    expect(reg.add(two, { displayName: 'Beta', aliases: ['b'] }).displayName).toBe('Beta');
  });

  it('resolves a project by id, name or alias, and reports ambiguity', () => {
    const one = join(home, 'one');
    makeRepo(one);
    const p = reg.add(one, { displayName: 'Alpha', aliases: ['a'] });
    expect(reg.matches(p.projectId)).toHaveLength(1);
    expect(reg.matches('alpha')[0]?.projectId).toBe(p.projectId);
    expect(reg.matches('A')[0]?.projectId).toBe(p.projectId);
    expect(reg.matches('nope')).toEqual([]);
    expect(reg.findByName('ALPHA')?.projectId).toBe(p.projectId);
  });

  it('parses remote urls and missing hints', () => {
    expect(parseRemoteUrl('https://gitlab.com/g/sub/repo.git')).toEqual({
      host: 'gitlab.com',
      name: 'g/sub/repo',
    });
    expect(parseRemoteUrl('ssh://git@host:2222/o/r')).toEqual({ host: 'host', name: 'o/r' });
    expect(repoHint(join(home, 'nothing'))).toBeUndefined();
  });
});

/**
 * Registration is a convenience, not a prerequisite: a folder the person names locally becomes
 * addressable on the spot. The safety property that must survive is that only a LOCAL action can
 * turn a path into an id — an id arriving from the cloud is a lookup and never a path.
 */
describe('ProjectRegistry.ensure (implicit registration)', () => {
  let t: ReturnType<typeof tempHome>;
  let home: string;
  let pagrHome: string;
  let file: string;
  let reg: ProjectRegistry;
  const open = (over: Partial<ConstructorParameters<typeof ProjectRegistry>[0]> = {}) =>
    new ProjectRegistry({ file, home, pagrHome, ...over });
  beforeEach(() => {
    t = tempHome();
    home = join(t.home, 'home');
    pagrHome = join(home, '.pagr');
    mkdirSync(pagrHome, { recursive: true });
    file = join(pagrHome, 'projects.json');
    reg = open();
  });
  afterEach(() => t.cleanup());

  it('registers a folder nobody added, and does not care that it is not a git repo', () => {
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    const p = reg.ensure(notes);
    expect(p.created).toBe(true);
    expect(p.path).toBe(notes);
    expect(p.displayName).toBe('notes');
    expect(reg.resolve(p.projectId).path).toBe(notes);
    expect(reg.summaries()[0]).not.toHaveProperty('path');
  });

  it('keeps one id per path across repeat calls, restarts and an explicit add', () => {
    const repo = join(home, 'code', 'widgets');
    makeRepo(repo);
    const first = reg.ensure(repo);
    const again = reg.ensure(repo);
    expect(again.created).toBe(false);
    expect(again.projectId).toBe(first.projectId);
    expect(reg.list()).toHaveLength(1);

    // a restart re-reads the file, so the cloud keeps talking to the same id
    expect(open().resolve(first.projectId).path).toBe(repo);

    // and explicit registration of the same path mints the same id, so the two paths agree
    const fresh = open();
    expect(fresh.remove(first.projectId)).toBe(true);
    expect(fresh.add(repo).projectId).toBe(first.projectId);
  });

  it('reuses the project that already contains the path instead of nesting a second one', () => {
    const repo = join(home, 'code', 'app');
    makeRepo(repo);
    const root = reg.ensure(repo);
    const pkg = join(repo, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    const inner = reg.ensure(pkg);
    expect(inner.created).toBe(false);
    expect(inner.projectId).toBe(root.projectId);
    expect(reg.list()).toHaveLength(1);
  });

  it('refuses the same paths add refuses, with a reason', () => {
    expect(() => reg.ensure('/')).toThrow(/refusing/);
    expect(() => reg.ensure(home)).toThrow(/refusing/);
    const inside = join(pagrHome, 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(() => reg.ensure(inside)).toThrow(/refusing/);
    expect(() => reg.ensure('/etc')).toThrow(/refusing/);
    expect(() => reg.ensure(join(home, 'nope'))).toThrow(/does not exist/);
    const f = join(home, 'file.txt');
    writeFileSync(f, 'x');
    expect(() => reg.ensure(f)).toThrow(/not a directory/);
    expect(reg.list()).toEqual([]);
  });

  it('refuses a directory owned by someone other than the user running the daemon', () => {
    const other = join(home, 'someone-elses');
    mkdirSync(other, { recursive: true });
    const foreign = open({ uid: () => 999_999 });
    expect(() => foreign.ensure(other)).toThrow(/owned by another user/);
    expect(() => foreign.add(other, { allowNonGit: true })).toThrow(/owned by another user/);
    expect(foreign.list()).toEqual([]);
  });

  it('resolves symlinks before deciding, so a link into a refused root is still refused', () => {
    const link = join(home, 'shortcut');
    symlinkSync('/etc', link);
    expect(() => reg.ensure(link)).toThrow(/refusing/);
    const repo = join(home, 'code', 'widgets');
    makeRepo(repo);
    const alias = join(home, 'widgets-link');
    symlinkSync(repo, alias);
    const direct = reg.ensure(repo);
    const viaLink = reg.ensure(alias);
    expect(viaLink.projectId).toBe(direct.projectId);
    expect(reg.list()).toHaveLength(1);
  });

  it('an id the registry did not mint locally never reaches the filesystem', () => {
    const repo = join(home, 'code', 'widgets');
    makeRepo(repo);
    const real = reg.ensure(repo);
    const secrets = join(home, 'secrets');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, 'keys.txt'), 'x');

    // 1. an id invented by the cloud, however well-formed
    const forged = `proj_${'f'.repeat(32)}`;
    expect(reg.has(forged)).toBe(false);
    expect(() => reg.resolve(forged)).toThrow(/unknown project/);
    expect(() => reg.assertContained(forged, 'keys.txt')).toThrow(/unknown project/);

    // 2. an id derived exactly the way this device derives them, for a real directory that no
    //    local action ever named. Knowing the scheme is not authorisation: the mapping is.
    const wouldBe = reg.ensure(secrets).projectId;
    expect(open().remove(wouldBe)).toBe(true);
    const after = open();
    expect(after.has(wouldBe)).toBe(false);
    expect(() => after.resolve(wouldBe)).toThrow(/unknown project/);
    expect(() => after.assertContained(wouldBe, 'keys.txt')).toThrow(/unknown project/);

    // 3. the surviving project still only reaches its own tree
    expect(() => after.assertContained(real.projectId, '../secrets/keys.txt')).toThrow(
      /outside project/,
    );
    expect(() => after.assertContained(real.projectId, '/etc/passwd')).toThrow(/outside project/);
  });

  it('ids are opaque: nothing about them is derived from the path alone', () => {
    const repo = join(home, 'code', 'widgets');
    makeRepo(repo);
    const id = reg.ensure(repo).projectId;
    expect(id).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(id).not.toContain('widgets');
    // a second device (a different registry file) would call the same path something else
    const otherPagrHome = join(home, '.pagr-other');
    mkdirSync(otherPagrHome, { recursive: true });
    const elsewhere = new ProjectRegistry({
      file: join(otherPagrHome, 'projects.json'),
      home,
      pagrHome: otherPagrHome,
    });
    expect(elsewhere.ensure(repo).projectId).not.toBe(id);
  });

  it('discovery marks an implicitly registered repo as known, never a second id', async () => {
    const roots = join(home, 'code');
    makeRepo(join(roots, 'a'));
    makeRepo(join(roots, 'b'));
    const a = reg.ensure(join(roots, 'a'));
    const found = await reg.discover([roots]);
    expect(found.repos.find((r) => r.path === join(roots, 'a'))?.registeredAs).toBe(a.projectId);
    expect(found.repos.find((r) => r.path === join(roots, 'b'))?.registeredAs).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});
