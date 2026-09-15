import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSelection, planScan } from '../commands/projects.js';
import { EXIT } from '../errors.js';
import { type Harness, harness, lastJson, plain } from './helpers.js';

const repo = (dir: string, remote?: string) => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    remote
      ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n`
      : '[core]\n\trepositoryformatversion = 0\n',
  );
  return dir;
};

describe('parseSelection', () => {
  it('understands all, none, indices and ranges', () => {
    expect(parseSelection('all', 4)).toEqual([0, 1, 2, 3]);
    expect(parseSelection('*', 2)).toEqual([0, 1]);
    expect(parseSelection('', 4)).toEqual([]);
    expect(parseSelection('none', 4)).toEqual([]);
    expect(parseSelection('1,3', 4)).toEqual([0, 2]);
    expect(parseSelection('2 4', 4)).toEqual([1, 3]);
    expect(parseSelection('1-3', 4)).toEqual([0, 1, 2]);
    expect(parseSelection('3-1', 4)).toEqual([0, 1, 2]);
  });

  it('ignores out-of-range and junk instead of failing the whole scan', () => {
    expect(parseSelection('0,5,banana,2', 3)).toEqual([1]);
    expect(parseSelection('1,1,1', 3)).toEqual([0]);
  });
});

describe('planScan', () => {
  it('drops already-registered repos and resolves names', () => {
    const out = planScan(
      [
        { path: '/w/one/app' },
        { path: '/w/two/app' },
        { path: '/w/known', registeredAs: 'proj_x' },
      ],
      [{ projectId: 'p', path: '/w/other', displayName: 'zzz', aliases: [] } as never],
    );
    expect(out.map((c) => c.displayName)).toEqual(['app', 'two/app']);
  });

  it('drops repos already registered by path even without the marker', () => {
    const out = planScan(
      [{ path: '/w/app' }],
      [{ projectId: 'p', path: '/w/app', displayName: 'app', aliases: [] } as never],
    );
    expect(out).toEqual([]);
  });
});

describe('pagr project scan', () => {
  let h: Harness;
  let root: string;

  beforeEach(() => {
    h = harness();
    root = join(dirname(h.home), 'code');
    repo(join(root, 'alpha'), 'git@github.com:acme/alpha.git');
    repo(join(root, 'beta'), 'git@github.com:acme/beta-service.git');
    mkdirSync(join(root, 'not-a-repo'), { recursive: true });
    repo(join(root, 'node_modules', 'skipme'));
  });
  afterEach(() => h.cleanup());

  const projects = () =>
    JSON.parse(readFileSync(join(h.home, 'projects.json'), 'utf8')) as Record<
      string,
      { displayName: string; aliases: string[]; path: string }
    >;

  it('--dry-run lists candidates and writes nothing', async () => {
    const code = await h.run(['project', 'scan', root, '--dry-run']);
    expect(code).toBe(EXIT.ok);
    const out = plain(h.stdout);
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).not.toContain('skipme');
    expect(out).not.toContain('not-a-repo');
    expect(out).toContain('nothing was registered');
    expect(() => projects()).toThrow();
  });

  it('--all registers everything found, with inferred aliases', async () => {
    expect(await h.run(['project', 'scan', root, '--all'])).toBe(EXIT.ok);
    const list = Object.values(projects());
    expect(list.map((p) => p.displayName).sort()).toEqual(['alpha', 'beta']);
    const beta = list.find((p) => p.displayName === 'beta');
    expect(beta?.aliases).toEqual(['beta-service']);
  });

  it('is safe to run twice', async () => {
    await h.run(['project', 'scan', root, '--all']);
    h.stdout.length = 0;
    expect(await h.run(['project', 'scan', root, '--all'])).toBe(EXIT.ok);
    expect(Object.keys(projects())).toHaveLength(2);
    expect(plain(h.stdout)).toContain('already registered');
  });

  it('--json reports the plan without registering anything', async () => {
    expect(await h.run(['project', 'scan', root, '--json'])).toBe(EXIT.ok);
    const doc = lastJson(h) as {
      candidates: Array<{ displayName: string }>;
      registered: unknown[];
      hint: string;
    };
    expect(doc.candidates.map((c) => c.displayName).sort()).toEqual(['alpha', 'beta']);
    expect(doc.registered).toEqual([]);
    expect(doc.hint).toMatch(/--all/);
    expect(() => projects()).toThrow();
  });

  it('--json --all registers and reports what it did', async () => {
    expect(await h.run(['project', 'scan', root, '--json', '--all'])).toBe(EXIT.ok);
    const doc = lastJson(h) as { registered: Array<{ projectId: string }> };
    expect(doc.registered).toHaveLength(2);
    expect(Object.keys(projects())).toHaveLength(2);
  });

  it('without a TTY and without --all it explains instead of guessing', async () => {
    expect(await h.run(['project', 'scan', root])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('rerun with --all');
    expect(() => projects()).toThrow();
  });

  it('asks which repos to register when attached to a terminal', async () => {
    h.overrides.isTTY = true;
    h.promptAnswers = ['1'];
    expect(await h.run(['project', 'scan', root])).toBe(EXIT.ok);
    const list = Object.values(projects());
    expect(list).toHaveLength(1);
    expect(list[0]?.displayName).toBe('alpha');
    expect(h.prompts[0]).toMatch(/Register which/);
  });

  it('registers nothing when the user just presses Enter', async () => {
    h.overrides.isTTY = true;
    h.promptAnswers = [''];
    expect(await h.run(['project', 'scan', root])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('nothing registered');
  });

  it('resolves a name collision instead of registering two "app" projects', async () => {
    const other = join(dirname(h.home), 'work');
    repo(join(other, 'one', 'app'));
    repo(join(other, 'two', 'app'));
    expect(await h.run(['project', 'scan', other, '--all'])).toBe(EXIT.ok);
    const names = Object.values(projects()).map((p) => p.displayName);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('app');
    expect(names.some((n) => n.includes('/'))).toBe(true);
  });

  it('refuses to scan the home directory or the filesystem root', async () => {
    const homeDir = h.overrides.env?.HOME as string;
    expect(await h.run(['project', 'scan', homeDir, '--all'])).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toMatch(/home directory/);
    h.stderr.length = 0;
    expect(await h.run(['project', 'scan', '/', '--all'])).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toMatch(/whole filesystem/);
  });

  it('rejects a nonsense --depth', async () => {
    expect(await h.run(['project', 'scan', root, '--depth', 'zero', '--all'])).toBe(EXIT.usage);
    expect(plain(h.stderr)).toContain('--depth must be a positive integer');
  });

  it('honours --depth', async () => {
    repo(join(root, 'deep', 'a', 'b', 'c'));
    expect(await h.run(['project', 'scan', root, '--depth', '1', '--json'])).toBe(EXIT.ok);
    expect((lastJson(h) as { candidates: unknown[] }).candidates).toEqual([]);
  });

  it('treats an implicitly registered repo as known, never a second id', async () => {
    expect(await h.run(['project', 'use', join(root, 'alpha')])).toBe(EXIT.ok);
    const implicitId = Object.keys(projects())[0];
    h.stdout.length = 0;
    expect(await h.run(['project', 'scan', root, '--all'])).toBe(EXIT.ok);
    const list = Object.entries(projects());
    expect(list).toHaveLength(2);
    expect(list.filter(([, p]) => p.displayName === 'alpha')).toHaveLength(1);
    expect(Object.keys(projects())).toContain(implicitId as string);
    expect(plain(h.stdout)).toContain('already registered');
  });
});
