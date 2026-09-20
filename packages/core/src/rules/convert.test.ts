import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHome } from '../testUtil.js';
import { countLines } from '../text.js';
import {
  AGENTS_MD,
  CLAUDE_DIR_MD,
  CLAUDE_LOCAL_MD,
  CLAUDE_MD,
  convert,
  detect,
  MAX_IMPORT_DEPTH,
  NATIVE_AGENTS_MD_VERSION,
  proposal,
  RulesWriteError,
  readsAgentsMdNatively,
  rulesHeader,
  write,
} from './convert.js';

/**
 * Every row of spec §6's table has a test below, named after the row. The rest of the file is
 * the import inliner, which is where the risk actually lives: this module writes a file into
 * someone's repository, so "left the text alone" is the correct answer far more often than
 * "did something clever".
 */

const t = useTempHome('pagr-rules-');

/** Build a repo under the temp home from a `path → contents` map. Returns the repo root. */
function repoWith(files: Record<string, string>, name = 'repo'): string {
  const root = join(t.home, name);
  mkdirSync(root, { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const FIXED_NOW = () => new Date('2026-09-20T12:00:00Z');

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe('detect', () => {
  it('reports each rules file independently', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# root\n',
      [CLAUDE_DIR_MD]: '# dir\n',
      [CLAUDE_LOCAL_MD]: '# personal\n',
      [AGENTS_MD]: '# agents\n',
    });
    const d = detect(repo);
    expect(d).toMatchObject({
      claudeMd: true,
      claudeDirMd: true,
      claudeLocalMd: true,
      agentsMd: true,
    });
  });

  it('reports nothing for a bare repo', () => {
    const d = detect(repoWith({ 'README.md': 'hi\n' }));
    expect(d).toMatchObject({
      claudeMd: false,
      claudeDirMd: false,
      claudeLocalMd: false,
      agentsMd: false,
      ancestors: [],
    });
  });

  it('notices rules files in ancestor directories, nearest first', () => {
    writeFileSync(join(t.home, CLAUDE_MD), '# above\n');
    const outer = join(t.home, 'outer');
    mkdirSync(join(outer, '.claude'), { recursive: true });
    writeFileSync(join(outer, '.claude', CLAUDE_MD), '# nearer\n');
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' }, join('outer', 'repo'));

    const d = detect(repo);
    expect(d.ancestors[0]).toEqual({ dir: outer, files: [CLAUDE_DIR_MD] });
    expect(d.ancestors.map((a) => a.dir)).toContain(t.home);
  });

  it('ignores a directory named CLAUDE.md', () => {
    const repo = repoWith({ 'README.md': 'hi\n' });
    mkdirSync(join(repo, CLAUDE_MD));
    expect(detect(repo).claudeMd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// version probe
// ---------------------------------------------------------------------------

describe('readsAgentsMdNatively', () => {
  it('is true from 2.1.277 upwards', () => {
    expect(readsAgentsMdNatively(NATIVE_AGENTS_MD_VERSION)).toBe(true);
    expect(readsAgentsMdNatively('2.1.278')).toBe(true);
    expect(readsAgentsMdNatively('2.2.0')).toBe(true);
    expect(readsAgentsMdNatively('3.0.0')).toBe(true);
    expect(readsAgentsMdNatively('2.1.277 (Claude Code)')).toBe(true);
  });

  it('is false below it', () => {
    expect(readsAgentsMdNatively('2.1.276')).toBe(false);
    expect(readsAgentsMdNatively('2.0.999')).toBe(false);
    expect(readsAgentsMdNatively('1.9.9')).toBe(false);
  });

  it('treats an unknown version as old, because the shim is safe on every version', () => {
    expect(readsAgentsMdNatively(undefined)).toBe(false);
    expect(readsAgentsMdNatively('')).toBe(false);
    expect(readsAgentsMdNatively('nightly')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spec §6 table — one test per row
// ---------------------------------------------------------------------------

describe('proposal — spec §6 table', () => {
  it('row 1: claude → codex, AGENTS.md present → already_present', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n', [CLAUDE_MD]: '# claude\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex' })).toMatchObject({
      action: 'already_present',
      sourceFile: AGENTS_MD,
    });
  });

  it('row 2: claude → codex, CLAUDE.md and no AGENTS.md → write', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nbe careful\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW })).toMatchObject({
      action: 'write',
      sourceFile: CLAUDE_MD,
      targetFile: AGENTS_MD,
    });
  });

  it('row 2: .claude/CLAUDE.md is an equally valid source', () => {
    const repo = repoWith({ [CLAUDE_DIR_MD]: '# rules\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW })).toMatchObject({
      action: 'write',
      sourceFile: CLAUDE_DIR_MD,
      targetFile: AGENTS_MD,
    });
  });

  it('row 2: the root CLAUDE.md wins when both exist', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# root\n', [CLAUDE_DIR_MD]: '# dir\n' });
    const p = proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(p.sourceFile).toBe(CLAUDE_MD);
  });

  it('row 3: codex → claude, CLAUDE.md present → already_present', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# claude\n', [AGENTS_MD]: '# agents\n' });
    expect(proposal({ repo, from: 'codex', to: 'claude', claudeVersion: '2.0.0' })).toMatchObject({
      action: 'already_present',
      sourceFile: CLAUDE_MD,
    });
  });

  it('row 3: .claude/CLAUDE.md also counts as "Claude already has rules"', () => {
    const repo = repoWith({ [CLAUDE_DIR_MD]: '# claude\n', [AGENTS_MD]: '# agents\n' });
    expect(proposal({ repo, from: 'codex', to: 'claude', claudeVersion: '2.0.0' })).toMatchObject({
      action: 'already_present',
      sourceFile: CLAUDE_DIR_MD,
    });
  });

  it('row 4: codex → claude, AGENTS.md and Claude ≥ 2.1.277 → native_read, no write', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    const p = proposal({
      repo,
      from: 'codex',
      to: 'claude',
      claudeVersion: NATIVE_AGENTS_MD_VERSION,
    });
    expect(p).toMatchObject({ action: 'native_read', sourceFile: AGENTS_MD });
    expect(p.targetFile).toBeUndefined();
    expect(existsSync(join(repo, CLAUDE_MD))).toBe(false);
  });

  it('row 5: codex → claude, AGENTS.md and an older Claude → write the shim', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    expect(proposal({ repo, from: 'codex', to: 'claude', claudeVersion: '2.1.276' })).toMatchObject(
      { action: 'write', sourceFile: AGENTS_MD, targetFile: CLAUDE_MD, lineCount: 1 },
    );
  });

  it('row 5: an unknown Claude version also gets the shim', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    expect(proposal({ repo, from: 'codex', to: 'claude' })).toMatchObject({
      action: 'write',
      targetFile: CLAUDE_MD,
    });
  });

  it('row 6: neither file → none, in both directions', () => {
    const repo = repoWith({ 'README.md': 'nothing here\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex' }).action).toBe('none');
    expect(proposal({ repo, from: 'codex', to: 'claude', claudeVersion: '2.2.0' }).action).toBe(
      'none',
    );
  });

  it('row 6: CLAUDE.local.md alone is not rules to migrate', () => {
    const repo = repoWith({ [CLAUDE_LOCAL_MD]: '# my own notes\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex' }).action).toBe('none');
  });

  it('an empty CLAUDE.md is skipped rather than proposed as an empty AGENTS.md', () => {
    const repo = repoWith({ [CLAUDE_MD]: '   \n\n' });
    const p = proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(p.action).toBe('skipped');
    expect(p.reason).toContain(CLAUDE_MD);
    expect(p.targetFile).toBeUndefined();
  });

  it('never writes anything, whatever the row', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n' });
    const before = readdirSync(repo);
    proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    proposal({ repo, from: 'codex', to: 'claude' });
    expect(readdirSync(repo)).toEqual(before);
  });

  it('writes the shim rather than claiming a native read an ancestor CLAUDE.md would win', () => {
    // Claude reads AGENTS.md only when no CLAUDE.md sits in this directory or above it. With one
    // above — a monorepo root, ~/code/CLAUDE.md — a `native_read` answer would be silently wrong:
    // Claude follows the ancestor and never opens the AGENTS.md we pointed at. The shim is correct
    // on every version, so an ancestor forces the write.
    writeFileSync(join(t.home, CLAUDE_MD), '# monorepo rules\n');
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    const p = proposal({
      repo,
      from: 'codex',
      to: 'claude',
      claudeVersion: NATIVE_AGENTS_MD_VERSION,
    });
    expect(p.action).toBe('write');
    expect(p.targetFile).toBe(CLAUDE_MD);
    expect(p.notes?.join(' ')).toContain('above the repo root');
  });

  it('reports native_read only when nothing above the repo carries Claude rules', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    const p = proposal({
      repo,
      from: 'codex',
      to: 'claude',
      claudeVersion: NATIVE_AGENTS_MD_VERSION,
    });
    expect(p.action).toBe('native_read');
  });

  it('quotes a line count that matches the bytes convert would write', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n@docs/style.md\n',
      'docs/style.md': 'one\ntwo\nthree\n',
    });
    const p = proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(p.lineCount).toBe(c?.lineCount);
    expect(p.lineCount).toBe(countLines(c?.text ?? ''));
    expect(countLines(c?.text ?? '')).toBe((c?.text ?? '').split('\n').length - 1);
  });
});

// ---------------------------------------------------------------------------
// convert — the text
// ---------------------------------------------------------------------------

describe('convert — claude → codex', () => {
  it('adds one header line naming the source and the date, then the text verbatim', () => {
    const body = '# Project rules\n\nRun `pnpm gate` before every push.\n';
    const repo = repoWith({ [CLAUDE_MD]: body });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toBe(`${rulesHeader(CLAUDE_MD, FIXED_NOW())}\n\n${body}`);
    expect(rulesHeader(CLAUDE_MD, FIXED_NOW())).toContain(
      'Generated by Pagr from CLAUDE.md on 2026-09-20',
    );
    expect(c?.text.split('\n').filter((l) => l.includes('Generated by Pagr'))).toHaveLength(1);
  });

  it('inlines an import in place of the reference', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n@docs/style.md\n\ndone\n',
      'docs/style.md': '## Style\n\ntwo spaces\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('## Style\n\ntwo spaces\n\ndone');
    expect(c?.text).not.toContain('@docs/style.md');
    expect(c?.warnings).toEqual([]);
  });

  it('resolves imports relative to the importing file, not the repo root', () => {
    const repo = repoWith({
      [CLAUDE_DIR_MD]: '# rules\n\n@./style.md\n',
      '.claude/style.md': 'nested rule\n',
      'style.md': 'ROOT FILE, WRONG ONE\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.sourceFile).toBe(CLAUDE_DIR_MD);
    expect(c?.text).toContain('nested rule');
    expect(c?.text).not.toContain('WRONG ONE');
  });

  it('inlines four levels deep and refuses the fifth', () => {
    const repo = repoWith({
      [CLAUDE_MD]: 'root\n\n@l1.md\n',
      'l1.md': 'level one\n\n@l2.md\n',
      'l2.md': 'level two\n\n@l3.md\n',
      'l3.md': 'level three\n\n@l4.md\n',
      'l4.md': 'level four\n\n@l5.md\n',
      'l5.md': 'LEVEL FIVE\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    for (const n of ['level one', 'level two', 'level three', 'level four']) {
      expect(c?.text).toContain(n);
    }
    expect(c?.text).not.toContain('LEVEL FIVE');
    expect(c?.text).toContain('@l5.md');
    expect(c?.warnings).toEqual([{ code: 'depth_exceeded', file: 'l4.md', spec: 'l5.md' }]);
    expect(MAX_IMPORT_DEPTH).toBe(4);
  });

  it('refuses an import that leaves the repository', () => {
    writeFileSync(join(t.home, 'secrets.md'), 'SECRET\n');
    const repo = repoWith({ [CLAUDE_MD]: 'root\n\n@../secrets.md\n\n@~/secrets.md\n' });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).not.toContain('SECRET');
    expect(c?.text).toContain('@../secrets.md');
    expect(c?.text).toContain('@~/secrets.md');
    expect(c?.warnings.map((w) => w.code)).toEqual(['outside_repo', 'outside_repo']);
  });

  it('refuses an absolute import outside the repository', () => {
    writeFileSync(join(t.home, 'outside.md'), 'OUTSIDE\n');
    const repo = repoWith({ [CLAUDE_MD]: `root\n\n@${join(t.home, 'outside.md')}\n` });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).not.toContain('OUTSIDE');
    expect(c?.warnings.map((w) => w.code)).toEqual(['outside_repo']);
  });

  it('refuses a symlink inside the repo that points out of it', () => {
    writeFileSync(join(t.home, 'escape.md'), 'ESCAPED\n');
    const repo = repoWith({ [CLAUDE_MD]: 'root\n\n@link.md\n' });
    symlinkSync(join(t.home, 'escape.md'), join(repo, 'link.md'));
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).not.toContain('ESCAPED');
    expect(c?.warnings.map((w) => w.code)).toEqual(['outside_repo']);
  });

  it('leaves an import inside a fenced code block alone', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n```md\n@docs/style.md\n```\n\n@docs/style.md\n',
      'docs/style.md': 'INLINED BODY\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('```md\n@docs/style.md\n```');
    // The one outside the fence still resolved.
    expect(c?.text).toContain('INLINED BODY');
    expect(c?.text.match(/INLINED BODY/g)).toHaveLength(1);
  });

  it('leaves an import inside an inline code span alone', () => {
    const repo = repoWith({
      [CLAUDE_MD]: 'Write `@docs/style.md` to import it.\n',
      'docs/style.md': 'INLINED BODY\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('Write `@docs/style.md` to import it.');
    expect(c?.text).not.toContain('INLINED BODY');
  });

  it('detects a cycle instead of recursing forever', () => {
    const repo = repoWith({
      [CLAUDE_MD]: 'root\n\n@a.md\n',
      'a.md': 'A\n\n@b.md\n',
      'b.md': 'B\n\n@a.md\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('A');
    expect(c?.text).toContain('B');
    expect(c?.warnings).toEqual([{ code: 'cycle', file: 'b.md', spec: 'a.md' }]);
  });

  it('detects a self-import', () => {
    const repo = repoWith({ [CLAUDE_MD]: 'root\n\n@CLAUDE.md\n' });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.warnings).toEqual([{ code: 'cycle', file: CLAUDE_MD, spec: CLAUDE_MD }]);
  });

  it('drops a CLAUDE.local.md import entirely', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n@CLAUDE.local.md\n\nkeep this\n',
      [CLAUDE_LOCAL_MD]: 'MY LAPTOP PATHS\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).not.toContain('MY LAPTOP PATHS');
    expect(c?.text).not.toContain('CLAUDE.local.md');
    expect(c?.text).toContain('keep this');
    expect(c?.warnings).toEqual([
      { code: 'dropped_local', file: CLAUDE_MD, spec: CLAUDE_LOCAL_MD },
    ]);
  });

  it('never uses CLAUDE.local.md as a source', () => {
    const repo = repoWith({ [CLAUDE_LOCAL_MD]: 'personal\n' });
    expect(convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW })).toBeUndefined();
  });

  it('leaves a missing import as written', () => {
    const repo = repoWith({ [CLAUDE_MD]: 'root\n\n@docs/gone.md\n' });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('@docs/gone.md');
    expect(c?.warnings.map((w) => w.code)).toEqual(['missing']);
  });

  it('is not fooled by email addresses or bare mentions', () => {
    const repo = repoWith({
      [CLAUDE_MD]: 'Ask you@example.com. Use @beta. Tag @waleed-hash for review.\n',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('Ask you@example.com. Use @beta. Tag @waleed-hash for review.');
    expect(c?.warnings).toEqual([]);
  });

  it('keeps trailing punctuation outside the resolved path', () => {
    const repo = repoWith({
      [CLAUDE_MD]: 'See @docs/style.md, then stop.\n',
      'docs/style.md': 'STYLE',
    });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(c?.text).toContain('See STYLE, then stop.');
  });

  it('returns undefined when the repo has no Claude rules', () => {
    expect(
      convert({ repo: repoWith({ 'README.md': 'x\n' }), from: 'claude', to: 'codex' }),
    ).toBeUndefined();
  });
});

describe('convert — codex → claude', () => {
  it('is a one-line @AGENTS.md shim, not a copy', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n\nlots of rules\n' });
    const c = convert({ repo, from: 'codex', to: 'claude', now: FIXED_NOW });
    expect(c?.text).toBe('@AGENTS.md\n');
    expect(c?.lineCount).toBe(1);
    expect(c?.sourceFile).toBe(AGENTS_MD);
    expect(c?.targetFile).toBe(CLAUDE_MD);
    expect(c?.text).not.toContain('lots of rules');
  });

  it('returns undefined without an AGENTS.md', () => {
    expect(
      convert({ repo: repoWith({ 'README.md': 'x\n' }), from: 'codex', to: 'claude' }),
    ).toBeUndefined();
  });
});

describe('countLines', () => {
  it('does not count the phantom line a trailing newline makes', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe('write', () => {
  it('writes exactly what convert produced and leaves no temp file behind', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nbe careful\n' });
    const c = convert({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    const r = write({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(r).toMatchObject({ targetFile: AGENTS_MD, sourceFile: CLAUDE_MD });
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(c?.text);
    expect(readdirSync(repo).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the shim for codex → claude', () => {
    const repo = repoWith({ [AGENTS_MD]: '# agents\n' });
    const r = write({ repo, from: 'codex', to: 'claude' });
    expect(r.targetFile).toBe(CLAUDE_MD);
    expect(readFileSync(join(repo, CLAUDE_MD), 'utf8')).toBe('@AGENTS.md\n');
  });

  it('refuses outright when the target already exists, and does not touch it', () => {
    const existing = '# hand written, do not touch\n';
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n', [AGENTS_MD]: existing });
    expect(() => write({ repo, from: 'claude', to: 'codex' })).toThrowError(RulesWriteError);
    try {
      write({ repo, from: 'claude', to: 'codex' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RulesWriteError).code).toBe('target_exists');
    }
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(existing);
    expect(readdirSync(repo).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to overwrite an existing CLAUDE.md with the shim', () => {
    const existing = '# mine\n';
    const repo = repoWith({ [AGENTS_MD]: '# agents\n', [CLAUDE_MD]: existing });
    expect(() => write({ repo, from: 'codex', to: 'claude' })).toThrowError(/already exists/);
    expect(readFileSync(join(repo, CLAUDE_MD), 'utf8')).toBe(existing);
  });

  it('throws nothing_to_write when there is no source', () => {
    const repo = repoWith({ 'README.md': 'x\n' });
    try {
      write({ repo, from: 'claude', to: 'codex' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RulesWriteError).code).toBe('nothing_to_write');
    }
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });

  it('makes the proposal true: after writing, the same proposal says already_present', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n' });
    expect(proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW }).action).toBe('write');
    write({ repo, from: 'claude', to: 'codex', now: FIXED_NOW });
    expect(proposal({ repo, from: 'claude', to: 'codex', now: FIXED_NOW }).action).toBe(
      'already_present',
    );
  });
});
