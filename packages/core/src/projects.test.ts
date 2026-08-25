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

  it('discover finds repos shallowly and skips node_modules', () => {
    makeRepo(join(home, 'a'));
    makeRepo(join(home, 'x', 'b'));
    makeRepo(join(home, 'x', 'y', 'z', 'deep'));
    makeRepo(join(home, 'node_modules', 'pkg'));
    const found = reg.discover([home]);
    expect(found).toEqual([join(home, 'a'), join(home, 'x', 'b')]);
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
