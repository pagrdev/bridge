import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Rules migration: `CLAUDE.md` → `AGENTS.md`, and the `@AGENTS.md` shim the other way.
 *
 * Spec: `docs/superpowers/specs/2026-09-20-handoff-v1-design.md` §6. When a handoff moves work
 * from one agent to the other, the receiving agent usually cannot see the sender's rules file:
 * Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`. Claude Code has read `AGENTS.md`
 * natively since 2.1.277, but ONLY when no `CLAUDE.md` exists in that directory or above it —
 * which is why `detect` reports the ancestor directories too.
 *
 * Three functions, deliberately separated:
 *
 *   - `detect(repo)` — what rules files exist. No judgement, no writes.
 *   - `proposal({repo, from, to, claudeVersion})` — the §6 table, as one value. No writes, ever.
 *     HND-041 turns this into the consent text and asks the human.
 *   - `convert` / `write` — the bytes, and putting them on disk.
 *
 * Two rules this module does not bend:
 *
 *   1. **An existing rules file is never modified.** Not merged, not appended to, not renamed.
 *      `write` refuses outright when the target exists; every table row that would land on an
 *      existing file resolves to `already_present` or `native_read` instead.
 *   2. **The conversion is mechanical.** `@path` imports are inlined (`AGENTS.md` has no import
 *      syntax, so leaving them would silently drop rules), `CLAUDE.local.md` is dropped because
 *      it is personal and per-machine, one header line records the provenance, and every other
 *      byte survives unchanged. Nothing is summarised, reordered, or "improved".
 */

/** The two agents a handoff moves between. Mirrors the protocol's `Provider`. */
export type RulesProvider = 'claude' | 'codex';

/**
 * The first Claude Code that reads `AGENTS.md` natively (2026-09-18). Below this, a repo with
 * only `AGENTS.md` needs the one-line shim; at or above it, Claude reads the file itself.
 */
export const NATIVE_AGENTS_MD_VERSION = '2.1.277';

/**
 * How many imports deep the inliner follows, matching Claude Code's own limit. The fifth hop is
 * refused and left as literal text rather than followed, so a converted file can never contain
 * more than Claude itself would have assembled.
 */
export const MAX_IMPORT_DEPTH = 4;

/** Directories walked above the repo root before giving up. A guard, not a policy. */
const MAX_ANCESTOR_WALK = 64;

/** The rules files this module knows about, as repo-relative paths. */
export const CLAUDE_MD = 'CLAUDE.md';
export const CLAUDE_DIR_MD = join('.claude', CLAUDE_MD);
export const CLAUDE_LOCAL_MD = 'CLAUDE.local.md';
export const AGENTS_MD = 'AGENTS.md';

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

/** Rules files found in one directory above the repo root. */
export interface AncestorRules {
  /** Absolute path of the directory. Never leaves the Mac — the cloud only sees counts. */
  dir: string;
  /** Which of the known rules files live there, as directory-relative paths. */
  files: string[];
}

export interface RulesDetection {
  /** The repo root as given (absolute, symlinks resolved when it exists). */
  repo: string;
  /** `<repo>/CLAUDE.md` */
  claudeMd: boolean;
  /** `<repo>/.claude/CLAUDE.md` — the other place Claude Code looks for project memory. */
  claudeDirMd: boolean;
  /** `<repo>/CLAUDE.local.md` — personal, per-machine, never a conversion source. */
  claudeLocalMd: boolean;
  /** `<repo>/AGENTS.md` */
  agentsMd: boolean;
  /**
   * Rules files in directories ABOVE the repo root, nearest first (this includes `$HOME` and
   * `$HOME/.claude/CLAUDE.md` when the repo lives under the home directory). Claude Code reads
   * these too, so an ancestor `CLAUDE.md` both supplies rules a conversion is not needed for and
   * — importantly — suppresses Claude's native `AGENTS.md` reading.
   */
  ancestors: AncestorRules[];
}

/** True when `<repo>` has at least one file Claude Code would read as project memory. */
export function hasClaudeRules(d: RulesDetection): boolean {
  return d.claudeMd || d.claudeDirMd;
}

/** True when any directory above the repo carries a `CLAUDE.md` Claude Code would also read. */
export function hasAncestorClaudeRules(d: RulesDetection): boolean {
  return d.ancestors.some((a) => a.files.some((f) => basename(f) === CLAUDE_MD));
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Absolute, symlink-resolved when the path exists; absolute-but-literal when it does not. */
function realAbs(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Which rules files exist in `repo`, and whether any live above it.
 *
 * Pure inspection — the caller decides what, if anything, that means. The ancestor walk stops at
 * the filesystem root and reports absolute directories, because this value never crosses the
 * network: §6's proposal text is composed on the Mac and only the counts travel.
 */
export function detect(repo: string): RulesDetection {
  const root = realAbs(repo);
  const ancestors: AncestorRules[] = [];
  let dir = dirname(root);
  for (let i = 0; i < MAX_ANCESTOR_WALK && dir !== root; i++) {
    const files = [CLAUDE_MD, CLAUDE_DIR_MD, AGENTS_MD].filter((f) => isFile(join(dir, f)));
    if (files.length > 0) ancestors.push({ dir, files });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    repo: root,
    claudeMd: isFile(join(root, CLAUDE_MD)),
    claudeDirMd: isFile(join(root, CLAUDE_DIR_MD)),
    claudeLocalMd: isFile(join(root, CLAUDE_LOCAL_MD)),
    agentsMd: isFile(join(root, AGENTS_MD)),
    ancestors,
  };
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

function parseVersion(v: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Does this Claude Code read `AGENTS.md` on its own?
 *
 * An unknown or unparsable version answers **false**: the fallback is a one-line `CLAUDE.md`
 * containing `@AGENTS.md`, which is correct on every version — a new Claude follows the import,
 * an old one needs it. Guessing "yes" from a version we cannot read would leave the receiving
 * agent with no rules at all and nothing on screen to say so.
 */
export function readsAgentsMdNatively(claudeVersion: string | undefined): boolean {
  if (!claudeVersion) return false;
  const got = parseVersion(claudeVersion);
  const need = parseVersion(NATIVE_AGENTS_MD_VERSION);
  if (!got || !need) return false;
  for (let i = 0; i < need.length; i++) {
    const a = got[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

export type RulesWarningCode =
  /** The import resolved outside the repository (`~/…`, `../…`, or a symlink out). Left as text. */
  | 'outside_repo'
  /** Following it would exceed `MAX_IMPORT_DEPTH`. Left as text. */
  | 'depth_exceeded'
  /** The import chain came back to a file already being inlined. Left as text. */
  | 'cycle'
  /** The file the import names does not exist. Left as text, exactly as Claude would see it. */
  | 'missing'
  /** A `@CLAUDE.local.md` import. Removed — personal, per-machine rules do not travel. */
  | 'dropped_local';

export interface RulesWarning {
  code: RulesWarningCode;
  /** The importing file, repo-relative. */
  file: string;
  /** The import as written, without the leading `@`. */
  spec: string;
}

export interface RulesConversion {
  /** Repo-relative path the text came from. */
  sourceFile: string;
  /** Repo-relative path it is destined for. */
  targetFile: string;
  /** The exact bytes `write` would put on disk. */
  text: string;
  /** Lines of `text` — the number the consent question quotes. */
  lineCount: number;
  /** Everything the conversion refused to inline, so nothing is lost silently. */
  warnings: RulesWarning[];
}

export interface RulesConvertOptions {
  repo: string;
  from: RulesProvider;
  to: RulesProvider;
  /** Injectable clock for the header line's date. */
  now?: (() => Date) | undefined;
}

/** `Generated by Pagr from <source> on <YYYY-MM-DD>`, wrapped so renderers ignore it. */
export function rulesHeader(sourceFile: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return `<!-- Generated by Pagr from ${sourceFile} on ${day} -->`;
}

/** Lines in `text`, not counting the phantom line a trailing newline creates. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

type Segment = { code: boolean; text: string };

/**
 * Split a line into inline-code spans and everything else. Claude does not treat `@foo.md`
 * inside backticks as an import, and neither do we — a rules file that documents the import
 * syntax must not be rewritten by the documentation of it.
 */
function splitInlineCode(line: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n++;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] === '`') {
        let m = 0;
        while (line[j + m] === '`') m++;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      } else j++;
    }
    if (close === -1) {
      // An unbalanced run opens nothing; keep scanning past it as plain text.
      i += n;
      continue;
    }
    if (plainStart < i) out.push({ code: false, text: line.slice(plainStart, i) });
    out.push({ code: true, text: line.slice(i, close + n) });
    i = close + n;
    plainStart = i;
  }
  if (plainStart < line.length) out.push({ code: false, text: line.slice(plainStart) });
  return out;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * `@path` — not preceded by a word character (so `you@example.com` is an address, not an
 * import), and stopping at whitespace, quotes and brackets.
 */
const IMPORT_RE = /(^|[\s([{"'])@([^\s`'"()[\]{}<>]+)/g;

/** Trailing sentence punctuation is prose, not part of the path. */
function trimTrailingPunctuation(p: string): { path: string; trailing: string } {
  const m = /[.,;:!?]+$/.exec(p);
  if (!m) return { path: p, trailing: '' };
  return { path: p.slice(0, m.index), trailing: m[0] };
}

/**
 * Does this token look like a file reference at all? `@types/node` in prose and `@overload` in a
 * doc comment are not imports; Claude resolves a path, and so do we. A token that looks like a
 * path but names nothing on disk is left exactly as written (with a `missing` warning), which is
 * also what the reader would have got from Claude.
 */
function looksLikeImport(p: string): boolean {
  return p.includes('/') || /\.(md|markdown|mdx|txt)$/i.test(p);
}

interface InlineContext {
  repo: string;
  warnings: RulesWarning[];
}

/** Repo-relative, POSIX-ish, for messages and warnings. */
function rel(repo: string, abs: string): string {
  const r = relative(repo, abs);
  return r === '' ? basename(abs) : r.split(sep).join('/');
}

function within(repo: string, abs: string): boolean {
  return abs === repo || abs.startsWith(repo + sep);
}

/**
 * Inline every `@path` import in `text`, recursively.
 *
 * `chain` is the stack of absolute files currently being inlined — membership in it is a cycle,
 * and its length is the depth. Anything refused is left as the literal text that was there, so a
 * refusal degrades to "the reader sees the reference" rather than "the rule vanishes".
 */
function inlineImports(
  text: string,
  importerAbs: string,
  chain: string[],
  ctx: InlineContext,
): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (m) {
      const marker = m[1] as string;
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (fence !== undefined) {
      out.push(line);
      continue;
    }
    out.push(
      splitInlineCode(line)
        .map((seg) =>
          seg.code ? seg.text : resolveImportsInText(seg.text, importerAbs, chain, ctx),
        )
        .join(''),
    );
  }
  return out.join('\n');
}

function resolveImportsInText(
  text: string,
  importerAbs: string,
  chain: string[],
  ctx: InlineContext,
): string {
  return text.replace(IMPORT_RE, (whole, prefix: string, raw: string) => {
    const { path: spec, trailing } = trimTrailingPunctuation(raw);
    if (spec === '' || !looksLikeImport(spec)) return whole;

    const keep = `${prefix}@${spec}${trailing}`;
    const warn = (code: RulesWarningCode): string => {
      ctx.warnings.push({ code, file: rel(ctx.repo, importerAbs), spec });
      return keep;
    };

    // `~` is the user's home directory: outside the repository by construction.
    if (spec === '~' || spec.startsWith('~/')) return warn('outside_repo');

    const target = isAbsolute(spec) ? resolve(spec) : resolve(dirname(importerAbs), spec);
    if (!within(ctx.repo, target)) return warn('outside_repo');

    // Personal rules never travel, whether they are the source or merely imported by it.
    if (basename(target) === CLAUDE_LOCAL_MD) {
      ctx.warnings.push({ code: 'dropped_local', file: rel(ctx.repo, importerAbs), spec });
      return `${prefix}${trailing}`;
    }

    if (!isFile(target)) return warn('missing');

    // A symlink inside the repo may still point out of it.
    const realTarget = realAbs(target);
    if (!within(ctx.repo, realTarget)) return warn('outside_repo');

    if (chain.includes(realTarget)) return warn('cycle');
    // `chain.length` is the hop this import would be: 1 at the source file, 5 one too far.
    if (chain.length > MAX_IMPORT_DEPTH) return warn('depth_exceeded');

    let body: string;
    try {
      body = readFileSync(realTarget, 'utf8');
    } catch {
      return warn('missing');
    }
    const inlined = inlineImports(body, realTarget, [...chain, realTarget], ctx).replace(
      /\n+$/,
      '',
    );
    return `${prefix}${inlined}${trailing}`;
  });
}

/**
 * The bytes a migration would write, or `undefined` when there is nothing to convert.
 *
 * `claude → codex` inlines the Claude rules into an `AGENTS.md`. `codex → claude` produces the
 * one-line `@AGENTS.md` shim rather than a copy, so the two files can never drift apart — the
 * only thing a stale duplicate of someone's rules can do is mislead.
 *
 * This reads files. It never writes one.
 */
export function convert(opts: RulesConvertOptions): RulesConversion | undefined {
  const repo = realAbs(opts.repo);
  const d = detect(repo);
  const now = opts.now ?? (() => new Date());

  if (opts.from === 'claude' && opts.to === 'codex') {
    const sourceFile = d.claudeMd ? CLAUDE_MD : d.claudeDirMd ? CLAUDE_DIR_MD : undefined;
    if (!sourceFile) return undefined;
    const sourceAbs = join(repo, sourceFile);
    const ctx: InlineContext = { repo, warnings: [] };
    const body = inlineImports(readFileSync(sourceAbs, 'utf8'), sourceAbs, [sourceAbs], ctx);
    const text = `${rulesHeader(sourceFile, now())}\n\n${body.replace(/\n+$/, '')}\n`;
    return {
      sourceFile,
      targetFile: AGENTS_MD,
      text,
      lineCount: countLines(text),
      warnings: ctx.warnings,
    };
  }

  if (opts.from === 'codex' && opts.to === 'claude') {
    if (!d.agentsMd) return undefined;
    // Exactly one line, by design: an import, not a copy. Claude resolves it on every run, so
    // editing AGENTS.md is editing the Claude rules too.
    const text = `@${AGENTS_MD}\n`;
    return {
      sourceFile: AGENTS_MD,
      targetFile: CLAUDE_MD,
      text,
      lineCount: countLines(text),
      warnings: [],
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// proposal
// ---------------------------------------------------------------------------

export type RulesAction =
  /** The receiving agent already has its own rules file here. Do nothing. */
  | 'already_present'
  /** Claude ≥ 2.1.277 reads the existing `AGENTS.md` itself. Do nothing. */
  | 'native_read'
  /** A file would be written, once the human says yes. */
  | 'write'
  /** There is a source but converting it is not the right move; the handoff carries the rules. */
  | 'skipped'
  /** Neither agent has rules here. The handoff carries them. */
  | 'none';

export interface RulesProposal {
  action: RulesAction;
  /** Repo-relative source, when one is involved. */
  sourceFile?: string;
  /** Repo-relative file `write` would create. Only ever set for `write`. */
  targetFile?: string;
  /** Lines of the file that would be written — the number the consent text quotes. */
  lineCount?: number;
  /** Why, for `skipped`. */
  reason?: string;
  /** What the conversion would refuse to inline. Empty unless `action` is `write`. */
  warnings?: RulesWarning[];
  /**
   * Advisory, never authoritative. §6's table is keyed on files at the repo root; these notes
   * record the things the table does not ask about — most importantly an ancestor `CLAUDE.md`,
   * which suppresses Claude's native `AGENTS.md` reading.
   */
  notes?: string[];
}

export interface RulesProposalOptions {
  repo: string;
  from: RulesProvider;
  to: RulesProvider;
  /** The receiving Claude's version, from the adapter probe. Unknown ⇒ treated as old. */
  claudeVersion?: string | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Spec §6's table, as a value. Performs no writes and asks no questions — HND-041 renders this
 * into the consent text and, on a yes, calls `write`.
 *
 * Row by row, with the two clarifications this implementation makes explicit:
 *
 * | from → to      | repo state                                     | action           |
 * |----------------|------------------------------------------------|------------------|
 * | claude → codex | `AGENTS.md`                                    | `already_present`|
 * | claude → codex | `CLAUDE.md` or `.claude/CLAUDE.md`, no AGENTS  | `write`          |
 * | codex → claude | `CLAUDE.md` **or `.claude/CLAUDE.md`**          | `already_present`|
 * | codex → claude | `AGENTS.md`, Claude ≥ 2.1.277                   | `native_read`    |
 * | codex → claude | `AGENTS.md`, older or unknown Claude           | `write` (shim)   |
 * | any            | neither                                        | `none`           |
 *
 * `.claude/CLAUDE.md` counts as "Claude already has rules" because Claude Code reads it, exactly
 * as row 2 already assumes when it treats the same file as a conversion source. A `CLAUDE.md`
 * that is present but empty yields `skipped` rather than a proposal to write an empty file.
 */
export function proposal(opts: RulesProposalOptions): RulesProposal {
  const repo = realAbs(opts.repo);
  const d = detect(repo);
  const notes: string[] = [];
  if (hasAncestorClaudeRules(d)) {
    notes.push(
      'a CLAUDE.md exists above the repo root; Claude Code reads it and will not read AGENTS.md natively',
    );
  }
  const decorate = (p: RulesProposal): RulesProposal => (notes.length > 0 ? { ...p, notes } : p);

  if (opts.from === 'claude' && opts.to === 'codex') {
    if (d.agentsMd) return decorate({ action: 'already_present', sourceFile: AGENTS_MD });
    if (!hasClaudeRules(d)) return decorate({ action: 'none' });
    const c = convert({ repo, from: 'claude', to: 'codex', now: opts.now });
    if (!c) return decorate({ action: 'none' });
    if (c.text.replace(/<!--.*?-->/gs, '').trim() === '') {
      return decorate({
        action: 'skipped',
        sourceFile: c.sourceFile,
        reason: `${c.sourceFile} is empty`,
      });
    }
    return decorate({
      action: 'write',
      sourceFile: c.sourceFile,
      targetFile: c.targetFile,
      lineCount: c.lineCount,
      warnings: c.warnings,
    });
  }

  if (opts.from === 'codex' && opts.to === 'claude') {
    if (hasClaudeRules(d)) {
      return decorate({
        action: 'already_present',
        sourceFile: d.claudeMd ? CLAUDE_MD : CLAUDE_DIR_MD,
      });
    }
    if (!d.agentsMd) return decorate({ action: 'none' });
    if (readsAgentsMdNatively(opts.claudeVersion)) {
      return decorate({ action: 'native_read', sourceFile: AGENTS_MD });
    }
    const c = convert({ repo, from: 'codex', to: 'claude', now: opts.now });
    if (!c) return decorate({ action: 'none' });
    return decorate({
      action: 'write',
      sourceFile: c.sourceFile,
      targetFile: c.targetFile,
      lineCount: c.lineCount,
      warnings: c.warnings,
    });
  }

  // Same provider on both ends, which a handoff never produces: nothing to migrate.
  return decorate({ action: 'none' });
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export type RulesWriteErrorCode =
  /** The target rules file already exists. Pagr does not touch other people's rules. */
  | 'target_exists'
  /** There was no source to convert. */
  | 'nothing_to_write';

export class RulesWriteError extends Error {
  constructor(
    readonly code: RulesWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RulesWriteError';
  }
}

export type RulesWriteOptions = RulesConvertOptions;

export interface RulesWriteResult {
  /** Repo-relative path that was created. */
  targetFile: string;
  /** Repo-relative path the text came from. */
  sourceFile: string;
  lineCount: number;
  warnings: RulesWarning[];
}

/**
 * Convert and write, atomically, refusing to overwrite.
 *
 * Temp file in the same directory then rename, the way `jsonFile.ts` does it: a crash mid-write
 * leaves no half-file in the user's repository. The existence check brackets the write on both
 * sides — this runs behind a human "yes" on a phone, seconds after the proposal was composed,
 * and the one thing that must never happen is clobbering a rules file someone wrote by hand.
 */
export function write(opts: RulesWriteOptions): RulesWriteResult {
  const repo = realAbs(opts.repo);
  const c = convert({ ...opts, repo });
  if (!c) {
    throw new RulesWriteError(
      'nothing_to_write',
      `no rules file to convert for ${opts.from} → ${opts.to} in ${repo}`,
    );
  }
  const target = join(repo, c.targetFile);
  if (existsSync(target)) {
    throw new RulesWriteError('target_exists', `${c.targetFile} already exists; refusing to write`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, c.text, { mode: 0o644, flag: 'wx' });
    if (existsSync(target)) {
      throw new RulesWriteError(
        'target_exists',
        `${c.targetFile} already exists; refusing to write`,
      );
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written, or already renamed into place
    }
    throw err;
  }
  return {
    targetFile: c.targetFile,
    sourceFile: c.sourceFile,
    lineCount: c.lineCount,
    warnings: c.warnings,
  };
}
