import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHome } from '../testUtil.js';
import { countLines } from '../text.js';
import {
  AGENTS_MD,
  CLAUDE_DIR_MD,
  CLAUDE_LOCAL_MD,
  CLAUDE_MD,
  NATIVE_AGENTS_MD_VERSION,
} from './convert.js';
import {
  migrateRules,
  type RulesMigrateOptions,
  rulesRepoRoot,
  toRulesMigrateResult,
} from './migrate.js';

/**
 * Spec §6's migration table, row by row, plus the one promise ADR 0019 decision 6 makes that a
 * table cannot express: **nothing is written without a second, explicit yes**, and an existing
 * rules file is refused rather than overwritten even when that yes has been given.
 *
 * Every test runs inside a temp HOME. Nothing here may read or write the real `~/.claude`,
 * `~/.codex`, or any repository on this Mac — `home` is passed on every call so the repo-root
 * walk stops at the fixture, and no test ever omits it.
 */

const t = useTempHome('pagr-rules-migrate-');

/** A repository under the temp home, from a `path → contents` map. Returns its root. */
function repoWith(files: Record<string, string>, name = 'repo'): string {
  const root = join(t.home, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const FIXED_NOW = () => new Date('2026-09-20T12:00:00Z');

/** One migration call, always with the fixture's home and clock. */
const run = (
  dir: string,
  o: Omit<RulesMigrateOptions, 'dir' | 'home' | 'now'> & { home?: string },
) => migrateRules({ dir, home: t.home, now: FIXED_NOW, ...o });

const ask = (
  dir: string,
  from: 'claude' | 'codex',
  to: 'claude' | 'codex',
  claudeVersion?: string,
) => run(dir, { from, to, consent: false, ...(claudeVersion ? { claudeVersion } : {}) });

const yes = (
  dir: string,
  from: 'claude' | 'codex',
  to: 'claude' | 'codex',
  claudeVersion?: string,
) => run(dir, { from, to, consent: true, ...(claudeVersion ? { claudeVersion } : {}) });

const NEWER_CLAUDE = '2.1.300';
const OLDER_CLAUDE = '2.1.276';

// ---------------------------------------------------------------------------
// spec §6, row by row
// ---------------------------------------------------------------------------

describe('spec §6 migration table', () => {
  it('claude → codex, AGENTS.md present: already_present, nothing', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n', [AGENTS_MD]: '# theirs\n' });
    const before = readFileSync(join(repo, AGENTS_MD), 'utf8');

    expect(ask(repo, 'claude', 'codex')).toMatchObject({
      action: 'already_present',
      written: false,
    });
    // Even a yes cannot turn "they already have one" into a write.
    expect(yes(repo, 'claude', 'codex')).toMatchObject({
      action: 'already_present',
      written: false,
    });
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(before);
  });

  it('claude → codex, CLAUDE.md and no AGENTS.md: proposes the conversion', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nalways run the tests\n' });
    expect(ask(repo, 'claude', 'codex')).toMatchObject({
      action: 'write',
      sourceFile: CLAUDE_MD,
      targetFile: AGENTS_MD,
      written: false,
    });
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });

  it('claude → codex, .claude/CLAUDE.md and no AGENTS.md: proposes it from there', () => {
    const repo = repoWith({ [CLAUDE_DIR_MD]: '# rules\n\nno force pushes\n' });
    expect(ask(repo, 'claude', 'codex')).toMatchObject({
      action: 'write',
      sourceFile: CLAUDE_DIR_MD,
      targetFile: AGENTS_MD,
    });
  });

  it('codex → claude, CLAUDE.md present: already_present', () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n', [CLAUDE_MD]: '# mine\n' });
    expect(ask(repo, 'codex', 'claude', OLDER_CLAUDE)).toMatchObject({
      action: 'already_present',
      sourceFile: CLAUDE_MD,
    });
  });

  it('codex → claude, .claude/CLAUDE.md present: already_present', () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n', [CLAUDE_DIR_MD]: '# mine\n' });
    expect(ask(repo, 'codex', 'claude', OLDER_CLAUDE)).toMatchObject({
      action: 'already_present',
      sourceFile: CLAUDE_DIR_MD,
    });
  });

  it(`codex → claude, AGENTS.md and Claude ≥ ${NATIVE_AGENTS_MD_VERSION}: native_read, nothing`, () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n' });
    expect(ask(repo, 'codex', 'claude', NEWER_CLAUDE)).toMatchObject({
      action: 'native_read',
      written: false,
    });
    expect(yes(repo, 'codex', 'claude', NEWER_CLAUDE).written).toBe(false);
    expect(existsSync(join(repo, CLAUDE_MD))).toBe(false);
  });

  it('codex → claude, AGENTS.md and an older Claude: proposes the one-line shim', () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n' });
    const p = ask(repo, 'codex', 'claude', OLDER_CLAUDE);
    expect(p).toMatchObject({
      action: 'write',
      sourceFile: AGENTS_MD,
      targetFile: CLAUDE_MD,
      lineCount: 1,
    });
    expect(existsSync(join(repo, CLAUDE_MD))).toBe(false);
  });

  it('codex → claude, AGENTS.md and an unknown Claude version: the shim, not a guess', () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n' });
    expect(ask(repo, 'codex', 'claude')).toMatchObject({ action: 'write', targetFile: CLAUDE_MD });
  });

  it('either direction, neither file: none — the handoff carries the rules', () => {
    const repo = repoWith({ 'README.md': 'hi\n' });
    expect(ask(repo, 'claude', 'codex')).toMatchObject({ action: 'none', written: false });
    expect(ask(repo, 'codex', 'claude', NEWER_CLAUDE)).toMatchObject({ action: 'none' });
    expect(yes(repo, 'claude', 'codex').written).toBe(false);
  });

  it('an empty CLAUDE.md is skipped rather than proposed as an empty AGENTS.md', () => {
    const repo = repoWith({ [CLAUDE_MD]: '   \n\n' });
    const p = ask(repo, 'claude', 'codex');
    expect(p.action).toBe('skipped');
    expect(p.reason).toContain(CLAUDE_MD);
    expect(yes(repo, 'claude', 'codex').written).toBe(false);
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

describe('consent', () => {
  it('a yes writes the converted file, with the inlined imports and the header', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n@docs/style.md\n@CLAUDE.local.md\n',
      'docs/style.md': 'two spaces, no tabs\n',
      [CLAUDE_LOCAL_MD]: 'my own scratch notes\n',
    });

    const out = yes(repo, 'claude', 'codex');
    expect(out).toMatchObject({ action: 'write', written: true, consent: true });
    const text = readFileSync(join(repo, AGENTS_MD), 'utf8');
    expect(text).toContain(`Generated by Pagr from ${CLAUDE_MD} on 2026-09-20`);
    expect(text).toContain('two spaces, no tabs');
    expect(text).not.toContain('my own scratch notes');
    // The source is a source, not a thing to tidy up.
    expect(existsSync(join(repo, CLAUDE_MD))).toBe(true);
    expect(existsSync(join(repo, CLAUDE_LOCAL_MD))).toBe(true);
  });

  it('silence writes nothing, however many times the question is asked', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nalways run the tests\n' });
    for (let i = 0; i < 3; i++) expect(ask(repo, 'claude', 'codex').written).toBe(false);
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });

  it('a no writes nothing: the second command simply never arrives', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n' });
    const proposed = ask(repo, 'claude', 'codex');
    expect(proposed.action).toBe('write');
    expect(proposed.written).toBe(false);
    // A "no" is the absence of the consented call. Nothing else runs.
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });

  it('the shim a yes writes is exactly the one-line import', () => {
    const repo = repoWith({ [AGENTS_MD]: '# rules\n\nno force pushes\n' });
    expect(yes(repo, 'codex', 'claude', OLDER_CLAUDE)).toMatchObject({
      action: 'write',
      written: true,
      targetFile: CLAUDE_MD,
    });
    expect(readFileSync(join(repo, CLAUDE_MD), 'utf8')).toBe(`@${AGENTS_MD}\n`);
  });

  it('consent is not transferable: a yes for a proposal that has gone stale writes nothing', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nalways run the tests\n' });
    expect(ask(repo, 'claude', 'codex').action).toBe('write');

    // The person wrote their own AGENTS.md while the question sat on their phone.
    const theirs = '# our real agent rules\n';
    writeFileSync(join(repo, AGENTS_MD), theirs);

    const out = yes(repo, 'claude', 'codex');
    expect(out).toMatchObject({ action: 'already_present', written: false });
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(theirs);
  });
});

// ---------------------------------------------------------------------------
// never overwrite
// ---------------------------------------------------------------------------

describe('an existing rules file', () => {
  it('is refused, not overwritten, byte for byte', () => {
    const theirs = '# hand-written\n\nnever touch this\n';
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nrun the tests\n', [AGENTS_MD]: theirs });

    const out = yes(repo, 'claude', 'codex');
    expect(out.written).toBe(false);
    expect(out.action).toBe('already_present');
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(theirs);
    // And nothing was left lying around beside it either.
    expect(existsSync(join(repo, `${AGENTS_MD}.tmp`))).toBe(false);
  });

  it('is refused at the write too, when it is not a file the table can see', () => {
    // A DIRECTORY called AGENTS.md: `detect` does not count it as rules, so the proposal is a
    // write — and the write itself refuses. This is the guard that makes the two-step safe when
    // the disk moves between the question and the answer.
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nrun the tests\n' });
    mkdirSync(join(repo, AGENTS_MD));
    expect(ask(repo, 'claude', 'codex').action).toBe('write');

    const out = yes(repo, 'claude', 'codex');
    expect(out).toMatchObject({
      action: 'already_present',
      written: false,
      refusal: 'target_exists',
    });
    expect(out.reason).toContain(AGENTS_MD);
  });

  it('never has the source deleted, merged into, or appended to', () => {
    const rules = '# rules\n\nrun the tests\n';
    const repo = repoWith({ [CLAUDE_MD]: rules });
    expect(yes(repo, 'claude', 'codex').written).toBe(true);
    expect(readFileSync(join(repo, CLAUDE_MD), 'utf8')).toBe(rules);
  });
});

// ---------------------------------------------------------------------------
// the number the person is quoted
// ---------------------------------------------------------------------------

describe('the proposed line count', () => {
  it('is the line count of the text that is actually written', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '# rules\n\n@docs/style.md\n\nand nothing else\n',
      'docs/style.md': 'line one\nline two\nline three\n',
    });

    const proposed = ask(repo, 'claude', 'codex');
    expect(proposed.lineCount).toBeGreaterThan(0);

    const written = yes(repo, 'claude', 'codex');
    expect(written.lineCount).toBe(proposed.lineCount);
    expect(countLines(readFileSync(join(repo, AGENTS_MD), 'utf8'))).toBe(proposed.lineCount);
  });

  it('counts the inlined import, not the one-line reference to it', () => {
    const repo = repoWith({
      [CLAUDE_MD]: '@docs/long.md\n',
      'docs/long.md': Array.from({ length: 40 }, (_, i) => `rule ${i}`).join('\n') + '\n',
    });
    // Header + blank + 40 inlined lines.
    expect(ask(repo, 'claude', 'codex').lineCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// the shapes the rest of the system sees
// ---------------------------------------------------------------------------

describe('toRulesMigrateResult', () => {
  it('carries the four wire fields and nothing local', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nrun the tests\n' });
    const out = ask(repo, 'claude', 'codex');
    const wire = toRulesMigrateResult(out);

    expect(wire).toEqual({
      action: 'write',
      sourceFile: CLAUDE_MD,
      targetFile: AGENTS_MD,
      lineCount: out.lineCount,
    });
    // The repository path, the warnings and the notes stay on this Mac.
    expect(JSON.stringify(wire)).not.toContain(t.home);
    expect(Object.keys(wire).sort()).toEqual(['action', 'lineCount', 'sourceFile', 'targetFile']);
  });

  it('is just the action when there is nothing to name', () => {
    const repo = repoWith({ 'README.md': 'hi\n' });
    expect(toRulesMigrateResult(ask(repo, 'claude', 'codex'))).toEqual({ action: 'none' });
  });
});

describe('rulesRepoRoot', () => {
  it('migrates the repository root, not the subdirectory a session happened to run in', () => {
    const repo = repoWith({ [CLAUDE_MD]: '# rules\n\nrun the tests\n' });
    const deep = join(repo, 'apps', 'web');
    mkdirSync(deep, { recursive: true });

    expect(rulesRepoRoot(deep, t.home)).toBe(repo);
    expect(yes(deep, 'claude', 'codex')).toMatchObject({ repo, written: true });
    expect(existsSync(join(repo, AGENTS_MD))).toBe(true);
    expect(existsSync(join(deep, AGENTS_MD))).toBe(false);
  });

  it('falls back to the folder itself when it is not a repository', () => {
    const plain = join(t.home, 'notes');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, CLAUDE_MD), '# rules\n\nrun the tests\n');

    expect(rulesRepoRoot(plain, t.home)).toBe(plain);
    expect(yes(plain, 'claude', 'codex').written).toBe(true);
    expect(existsSync(join(plain, AGENTS_MD))).toBe(true);
  });

  it('never walks above the home it was given', () => {
    const plain = join(t.home, 'a', 'b');
    mkdirSync(plain, { recursive: true });
    expect(rulesRepoRoot(plain, t.home)).toBe(plain);
  });
});
