import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHome } from '../testUtil.js';
import { HANDOFF_DIR, type HandoffDoc, serialize } from './format.js';
import { listHandoffs } from './list.js';

const ID_A = 'hnd_aaaa0000000000000000000000000001';
const ID_B = 'hnd_bbbb0000000000000000000000000002';
const ID_C = 'hnd_cccc0000000000000000000000000003';

function doc(id: string, over: Partial<HandoffDoc['frontmatter']> = {}): string {
  return serialize({
    frontmatter: {
      pagr: 'handoff/1',
      id,
      from: { provider: 'claude', sessionId: 'ses_7f2a', origin: 'terminal' },
      to: { provider: 'codex' },
      project: { id: 'prj_91c4', name: 'checkout-api' },
      git: { branch: 'feat/refunds', head: '3f9c1d0', wipCommit: '7a1d44f', dirtyBefore: true },
      writer: 'sender',
      previous: null,
      created: '2026-09-20T05:41:12Z',
      ...over,
    },
    goal: 'Make partial refunds work end to end.\n\nA refund may be smaller than the charge.',
    done: [],
    notDone: [{ text: 'Wire the amount through', next: true }],
    decisions: [],
    filesTouched: [],
    commands: [],
    knownFailures: [],
    rulesInForce: [],
    openQuestions: [],
    extra: [],
  });
}

function write(repo: string, id: string, over: Partial<HandoffDoc['frontmatter']> = {}): void {
  const dir = join(repo, HANDOFF_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), doc(id, over));
}

describe('listHandoffs', () => {
  const t = useTempHome('pagr-handoff-list-');

  it('reads a handoff back off the disk', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(repo, { recursive: true });
    write(repo, ID_A);
    const { handoffs, skipped } = await listHandoffs([repo]);
    expect(skipped).toEqual([]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      handoffId: ID_A,
      path: join(repo, HANDOFF_DIR, `${ID_A}.md`),
      repo,
      from: 'claude',
      to: 'codex',
      writer: 'sender',
      branch: 'feat/refunds',
      wipCommit: '7a1d44f',
      truncated: false,
    });
    // The summary is the `# Goal` line, not the whole section.
    expect(handoffs[0]?.summary).toBe('Make partial refunds work end to end.');
  });

  it('is newest first, by the frontmatter rather than by mtime', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(repo, { recursive: true });
    // Written oldest-last on purpose: mtime ordering would put C first.
    write(repo, ID_A, { created: '2026-09-20T09:00:00Z' });
    write(repo, ID_B, { created: '2026-09-20T10:00:00Z' });
    write(repo, ID_C, { created: '2026-09-19T10:00:00Z' });
    const { handoffs } = await listHandoffs([repo]);
    expect(handoffs.map((x) => x.handoffId)).toEqual([ID_B, ID_A, ID_C]);
  });

  it('walks several repositories, and each repo only once', async () => {
    const one = join(t.home, 'one');
    const two = join(t.home, 'two');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    write(one, ID_A, { created: '2026-09-20T09:00:00Z' });
    write(two, ID_B, { created: '2026-09-20T10:00:00Z' });
    const { handoffs } = await listHandoffs([one, two, one]);
    expect(handoffs.map((x) => x.handoffId)).toEqual([ID_B, ID_A]);
    expect(handoffs.map((x) => x.repo)).toEqual([two, one]);
  });

  it('a repository that has never had a handoff is empty, not a skip', async () => {
    const repo = join(t.home, 'clean');
    mkdirSync(repo, { recursive: true });
    await expect(listHandoffs([repo])).resolves.toEqual({ handoffs: [], skipped: [] });
    // Nor is a directory that does not exist at all — a project removed from disk.
    await expect(listHandoffs([join(t.home, 'gone')])).resolves.toEqual({
      handoffs: [],
      skipped: [],
    });
  });

  it('shows a file it cannot parse instead of dropping it from the listing', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, HANDOFF_DIR), { recursive: true });
    writeFileSync(join(repo, HANDOFF_DIR, `${ID_A}.md`), 'this is not a handoff');
    const { handoffs } = await listHandoffs([repo]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.handoffId).toBe(ID_A);
    expect(handoffs[0]?.problem).toBeTruthy();
    expect(handoffs[0]?.created).toBeNull();
  });

  it('a file it cannot parse sorts last, where it is still visible', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, HANDOFF_DIR), { recursive: true });
    writeFileSync(join(repo, HANDOFF_DIR, `${ID_A}.md`), 'not a handoff');
    write(repo, ID_B, { created: '2026-09-01T00:00:00Z' });
    const { handoffs } = await listHandoffs([repo]);
    expect(handoffs.map((x) => x.handoffId)).toEqual([ID_B, ID_A]);
  });

  it('ignores anything in the directory that is not a handoff id', async () => {
    const repo = join(t.home, 'repo');
    const dir = join(repo, HANDOFF_DIR);
    mkdirSync(dir, { recursive: true });
    write(repo, ID_A);
    writeFileSync(join(dir, 'notes.md'), '# my own notes');
    writeFileSync(join(dir, 'README'), 'x');
    writeFileSync(join(dir, 'hnd_short.md'), 'x');
    const { handoffs } = await listHandoffs([repo]);
    expect(handoffs.map((x) => x.handoffId)).toEqual([ID_A]);
  });

  it('carries the truncation flag through', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(repo, { recursive: true });
    write(repo, ID_A, { truncated: true });
    const { handoffs } = await listHandoffs([repo]);
    expect(handoffs[0]?.truncated).toBe(true);
  });

  it('reports a directory it cannot read rather than pretending it was empty', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(repo, { recursive: true });
    // A FILE where the handoff directory should be: readdir fails with ENOTDIR, which is a real
    // problem worth naming, unlike a directory that simply is not there.
    mkdirSync(join(repo, '.pagr'), { recursive: true });
    writeFileSync(join(repo, HANDOFF_DIR), 'not a directory');
    const { handoffs, skipped } = await listHandoffs([repo]);
    expect(handoffs).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.repo).toBe(repo);
  });
});
