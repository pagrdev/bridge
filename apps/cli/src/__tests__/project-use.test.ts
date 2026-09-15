import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IpcServer } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let server: IpcServer | null = null;
/** The harness puts PAGR_HOME at `<root>/pagr` and HOME at `<root>`. */
let root = '';

const DEV = `dev_${'a'.repeat(32)}`;

const status = (over: Record<string, unknown> = {}) => ({
  bridgeVersion: '0.1.0',
  paired: true,
  deviceId: DEV,
  userId: `usr_${'b'.repeat(32)}`,
  gatewayUrl: 'wss://gw.example',
  transport: 'connected',
  bufferedEvents: 0,
  projects: 0,
  sessions: 0,
  pendingApprovals: 0,
  socketPath: 'x',
  pid: 4242,
  startedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  h = harness();
  root = dirname(h.home);
});
afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
});

const out = () => plain(h.stdout);
const err = () => plain(h.stderr);
const registry = () =>
  JSON.parse(readFileSync(join(h.home, 'projects.json'), 'utf8')) as Record<
    string,
    { displayName: string; path: string }
  >;

describe('pagr project use', () => {
  it('makes a folder nobody registered addressable, git repo or not', async () => {
    const notes = join(root, 'notes');
    mkdirSync(notes, { recursive: true });
    expect(await h.run(['project', 'use', notes])).toBe(EXIT.ok);
    const entries = Object.entries(registry());
    expect(entries).toHaveLength(1);
    const [id, rec] = entries[0] as [string, { displayName: string; path: string }];
    expect(rec.path).toBe(notes);
    expect(rec.displayName).toBe('notes');
    expect(out()).toContain(id);
    expect(out()).toContain('notes');
  });

  it('is idempotent: the same folder keeps the same id', async () => {
    const repo = join(root, 'widgets');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await h.run(['project', 'use', repo])).toBe(EXIT.ok);
    const first = Object.keys(registry());
    h.stdout.length = 0;
    expect(await h.run(['project', 'use', repo])).toBe(EXIT.ok);
    expect(Object.keys(registry())).toEqual(first);
    expect(out()).toContain('already');
  });

  it('answers with the project that already contains the path, not a nested second one', async () => {
    const repo = join(root, 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await h.run(['project', 'add', repo, '--name', 'app'])).toBe(EXIT.ok);
    const id = Object.keys(registry())[0];
    const pkg = join(repo, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    h.stdout.length = 0;
    expect(await h.run(['project', 'use', pkg])).toBe(EXIT.ok);
    expect(Object.keys(registry())).toHaveLength(1);
    expect(out()).toContain(id as string);
    expect(out()).toContain('app');
  });

  it('reports the project as json, id included', async () => {
    const repo = join(root, 'here');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await h.run(['--json', 'project', 'use', repo])).toBe(EXIT.ok);
    const j = lastJson(h) as {
      projectId: string;
      displayName: string;
      path: string;
      created: boolean;
    };
    expect(j.created).toBe(true);
    expect(j.displayName).toBe('here');
    expect(j.projectId).toMatch(/^proj_[0-9a-f]{32}$/);
    // local output, local audience: the path belongs here. It is the cloud that never sees it.
    expect(j.path).toBe(repo);
  });

  it('refuses the home directory, a missing path and a file, each with a reason', async () => {
    expect(await h.run(['project', 'use', root])).toBe(EXIT.precondition);
    expect(err()).toMatch(/refusing/);
    expect(await h.run(['project', 'use', join(root, 'nope')])).toBe(EXIT.precondition);
    expect(err()).toMatch(/does not exist/);
    const f = join(root, 'file.txt');
    writeFileSync(f, 'x');
    expect(await h.run(['project', 'use', f])).toBe(EXIT.precondition);
    expect(err()).toMatch(/not a directory/);
    expect(existsSync(join(h.home, 'projects.json'))).toBe(false);
  });

  it('lets the running daemon own the registry instead of writing behind its back', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rec = {
      projectId: `proj_${'c'.repeat(32)}`,
      path: join(root, 'remote-side'),
      displayName: 'remote-side',
      aliases: [],
      allowNonGit: true,
      addedAt: '2026-08-24T00:00:00.000Z',
    };
    server = await fakeDaemon(h.home, {
      status: () => status(),
      'projects.list': (params) => {
        calls.push({ method: 'projects.list', params });
        return [];
      },
      'projects.add': (params) => {
        calls.push({ method: 'projects.add', params });
        return rec;
      },
    });
    const dir = join(root, 'remote-side');
    mkdirSync(dir, { recursive: true });
    expect(await h.run(['project', 'use', dir])).toBe(EXIT.ok);
    expect(calls.map((c) => c.method)).toContain('projects.add');
    expect(calls.find((c) => c.method === 'projects.add')?.params).toMatchObject({
      path: dir,
      allowNonGit: true,
    });
    expect(out()).toContain(rec.projectId);
    // the daemon holds the registry in memory; a CLI write here would be clobbered by its next save
    expect(existsSync(join(h.home, 'projects.json'))).toBe(false);
  });
});
