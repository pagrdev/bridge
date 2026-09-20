import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ReviewId } from '@pagr/protocol';
import {
  changedFiles,
  diff,
  diffStat,
  ensureExcluded,
  GitError,
  type GitOptions,
  logOneline,
  repoRoot,
} from '../git.js';
import { countLines } from '../text.js';

/**
 * The review packet (spec §5).
 *
 * One file, `<repo>/.pagr/review/<reviewId>/packet.md`, and it is the **entire** evidence the
 * reviewing agent gets: one line of stated intent, the commit list, the diffstat, the unified
 * diff, and the current contents of the changed files that are small enough to read.
 *
 * What is NOT in it is the point of the whole feature. No transcript. No handoff note. No
 * builder reasoning, no plan, no "here is why this is safe". A reviewer that reads the author's
 * justification adopts the author's frame and starts confirming it — it approves the migration
 * because the author explained why the migration is fine, instead of noticing that the column is
 * dropped before the backfill runs. The packet gives it the change and the one line of intent it
 * needs to judge *scope*, and nothing else, so the only thing it can do is read the code.
 *
 * Three structural guarantees hold that line, rather than a convention someone has to remember:
 *
 *   1. `intent` is reduced to its FIRST line and capped ({@link REVIEW_INTENT_MAX_CHARS}). A
 *      caller that hands this function a whole handoff body gets one line of it in the packet.
 *   2. Anything under `.pagr/` is stripped — from the diff, from the diffstat and from the
 *      inlined files — because that directory is where Pagr keeps handoff notes, transcripts and
 *      previous reviews. It is git-excluded, so it should never appear; a repository that
 *      committed it once would otherwise leak every handoff into every later packet.
 *   3. Nothing else is ever read from disk except the changed files this range names.
 *
 * `packet.test.ts` greps the produced file for session and transcript text and fails if it finds
 * any, which is the check that actually keeps this true as the surrounding code changes.
 *
 * Every git invocation goes through `../git.ts`; this module never spawns a subprocess.
 */

/** Repo-relative directory holding one review's working files. */
export const REVIEW_DIR = '.pagr/review';

/** Longest intent line a packet carries. Matches the protocol's `review.start.intent` cap. */
export const REVIEW_INTENT_MAX_CHARS = 500;

/** A changed file longer than this is named in the manifest, not inlined. */
export const DEFAULT_REVIEW_MAX_FILE_LINES = 600;
export const REVIEW_MAX_FILE_LINES_ENV = 'PAGR_REVIEW_MAX_FILE_LINES';

/**
 * Whole-packet ceiling, in UTF-8 bytes. A 40 000-line refactor must still produce something a
 * model can read to the end; past this the diff is cut and the remaining files are dropped, and
 * the packet says so at the top so the reviewer knows it is looking at part of the change.
 */
export const DEFAULT_REVIEW_MAX_PACKET_BYTES = 256 * 1024;
export const REVIEW_MAX_PACKET_BYTES_ENV = 'PAGR_REVIEW_MAX_PACKET_BYTES';

/** Share of the budget the unified diff may take before file contents get the rest. */
const DIFF_BUDGET_SHARE = 0.7;

/** Longest commit list shown. A range with more commits than this is not being read anyway. */
const MAX_COMMITS_SHOWN = 200;

/** Longest diffstat shown, in lines. */
const MAX_STAT_LINES_SHOWN = 200;

/** A file bigger than this is not even read to count its lines. */
const FILE_READ_MAX_BYTES = 2 * 1024 * 1024;

/** Bytes checked for a NUL before calling a file binary — what git itself looks at. */
const BINARY_SNIFF_BYTES = 8000;

export type ReviewPacketErrorCode =
  /** `reviewId` is not a `rev_…` id, so it cannot be used as a directory name. */
  | 'bad_review_id'
  /** `intent` was empty, or whitespace only. */
  | 'bad_intent'
  /** The packet could not be written. */
  | 'io';

export class ReviewPacketError extends Error {
  constructor(
    readonly code: ReviewPacketErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ReviewPacketError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Why a changed file's contents are not in the packet. */
export type ReviewSkipReason =
  /** Over {@link reviewMaxFileLines}. */
  | 'too_long'
  /** Contains a NUL byte. */
  | 'binary'
  /** Gone from the work tree at the end of the range. */
  | 'deleted'
  /** A symlink, a submodule, or anything else that is not a regular file. */
  | 'not_a_file'
  /** Present but unreadable (permissions). */
  | 'unreadable'
  /** Pagr's own working directory: handoffs, transcripts, earlier reviews. Never included. */
  | 'pagr_internal'
  /** The packet hit {@link reviewMaxPacketBytes} before reaching this file. */
  | 'budget';

/** One changed path, and whether the reviewer can see its contents. */
export interface ReviewPacketFile {
  /** Repo-relative path, exactly as git named it. */
  path: string;
  /** True when the file's full current contents are in the packet. */
  included: boolean;
  /** Line count, or null when it was never read (deleted, binary, oversized on disk). */
  lines: number | null;
  /** Size on disk in bytes, or null when it was never read. */
  bytes: number | null;
  /** Set when `included` is false. */
  skipped?: ReviewSkipReason;
}

/** What `buildReviewPacket` wrote, and what it decided about every changed file. */
export interface ReviewPacket {
  reviewId: string;
  /** The resolved repository root — the packet is always written under this. */
  repo: string;
  /** `<repo>/.pagr/review/<reviewId>`. */
  dir: string;
  /** The file that was written. */
  packetPath: string;
  /** Where the reviewer is expected to write its report. Not created here. */
  reviewPath: string;
  range: string;
  /** The one line that went into the packet — already reduced and capped. */
  intent: string;
  /** `git log --oneline <range>`, newest first. */
  commits: string[];
  /** Every path the range touched, included or not, in git's order. */
  files: ReviewPacketFile[];
  /** Exactly the bytes written to `packetPath`. */
  content: string;
  bytes: number;
  /** True when the diff was cut or a file was dropped for size. Said inside the packet too. */
  truncated: boolean;
  maxFileLines: number;
  maxBytes: number;
}

export interface BuildReviewPacketInput {
  /** Any directory inside the repository; the packet is written at its root. */
  repo: string;
  /** `<base>..HEAD`, or any range `git log`/`git diff` accepts. */
  range: string;
  /** ONE line: what the author was trying to do. Anything after the first line is dropped. */
  intent: string;
  /** `rev_` + 32 hex, from `review.start`. */
  reviewId: string;
  /** Environment the two caps are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Passed straight to `../git.ts`. Tests substitute their own runner. */
  git?: GitOptions | undefined;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The per-file line cap, from the environment or {@link DEFAULT_REVIEW_MAX_FILE_LINES}. */
export const reviewMaxFileLines = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInt(env[REVIEW_MAX_FILE_LINES_ENV], DEFAULT_REVIEW_MAX_FILE_LINES);

/** The whole-packet byte ceiling, from the environment or {@link DEFAULT_REVIEW_MAX_PACKET_BYTES}. */
export const reviewMaxPacketBytes = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInt(env[REVIEW_MAX_PACKET_BYTES_ENV], DEFAULT_REVIEW_MAX_PACKET_BYTES);

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

/** True for `.pagr` itself and anything beneath it, on either path separator. */
export const isPagrPath = (p: string): boolean => {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm === '.pagr' || norm.startsWith('.pagr/');
};

/**
 * One line, whitespace collapsed, capped.
 *
 * The cap is a containment measure, not cosmetics: `intent` is the only free text in the packet
 * and therefore the only way the author's reasoning could get in front of the reviewer.
 */
export function intentLine(raw: string, max = REVIEW_INTENT_MAX_CHARS): string {
  const first = raw.split('\n')[0] ?? '';
  const line = first.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Fence long enough to hold `body` — a file that contains ``` needs ````. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const LANG_BY_EXT: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'js',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  md: 'markdown',
  mjs: 'js',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const langOf = (path: string): string => {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  return LANG_BY_EXT[ext] ?? '';
};

const codeBlock = (body: string, lang = ''): string => {
  const fence = fenceFor(body);
  const inner = body.endsWith('\n') ? body : `${body}\n`;
  return `${fence}${lang}\n${inner}${fence}`;
};

/**
 * Drop every `diff --git` block that touches `.pagr/`.
 *
 * The packet's one rule is enforced on the diff itself, not only on the files inlined after it:
 * a repository that committed `.pagr/handoff/hnd_….md` before Pagr excluded it would otherwise
 * hand the reviewer the author's handoff note as part of the patch.
 */
export function stripPagrFromDiff(patch: string): { patch: string; dropped: string[] } {
  if (patch.trim() === '') return { patch, dropped: [] };
  const lines = patch.split('\n');
  const out: string[] = [];
  const dropped: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = (line.match(/ [ab]\/(.+?)(?= [ab]\/|$)/g) ?? []).map((m) => m.trim().slice(2));
      skipping = paths.some(isPagrPath);
      if (skipping) {
        for (const p of paths) if (isPagrPath(p) && !dropped.includes(p)) dropped.push(p);
        continue;
      }
    }
    if (!skipping) out.push(line);
  }
  return { patch: out.join('\n'), dropped };
}

/** Same rule, applied to `git diff --stat`'s `path | 3 ++-` lines. */
function stripPagrFromStat(stat: string): string {
  return stat
    .split('\n')
    .filter((line) => {
      const bar = line.indexOf('|');
      if (bar < 0) return true;
      return !isPagrPath(line.slice(0, bar).trim());
    })
    .join('\n');
}

/** Cut `text` to at most `max` bytes, on a line boundary. */
function cutToBytes(text: string, max: number): { text: string; cut: boolean } {
  if (bytesOf(text) <= max) return { text, cut: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = bytesOf(line) + 1;
    if (used + size > max) break;
    kept.push(line);
    used += size;
  }
  return { text: kept.join('\n'), cut: true };
}

interface Classified extends ReviewPacketFile {
  /** Contents, present only when the file is a candidate for inlining. */
  body?: string | undefined;
}

function classify(root: string, path: string, maxLines: number): Classified {
  const base: Classified = { path, included: false, lines: null, bytes: null };
  if (isPagrPath(path)) return { ...base, skipped: 'pagr_internal' };

  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) return { ...base, skipped: 'not_a_file' };

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    // Named by the range but gone from the work tree: deleted (or renamed away).
    return { ...base, skipped: 'deleted' };
  }
  if (!stat.isFile()) return { ...base, skipped: 'not_a_file' };
  if (stat.size > FILE_READ_MAX_BYTES) return { ...base, bytes: stat.size, skipped: 'too_long' };

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { ...base, skipped: 'unreadable' };
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0))
    return { ...base, bytes: buf.byteLength, skipped: 'binary' };

  const body = buf.toString('utf8');
  const lines = countLines(body);
  if (lines > maxLines) return { ...base, lines, bytes: buf.byteLength, skipped: 'too_long' };
  return { path, included: true, lines, bytes: buf.byteLength, body };
}

function reasonText(f: ReviewPacketFile, maxLines: number): string {
  switch (f.skipped) {
    case 'too_long':
      return f.lines === null
        ? `${f.bytes ?? 0} bytes — too large to inline (limit ${maxLines} lines)`
        : `${f.lines} lines — over the ${maxLines}-line limit`;
    case 'binary':
      return 'binary';
    case 'deleted':
      return 'deleted by this range — see the diff';
    case 'not_a_file':
      return 'not a regular file';
    case 'unreadable':
      return 'could not be read';
    case 'pagr_internal':
      return "Pagr's own working file — never shown to a reviewer";
    case 'budget':
      return 'dropped: the packet hit its size ceiling';
    default:
      return 'not included';
  }
}

/** Write `text` to `file` atomically: temp file in the same directory, then rename over. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (cause) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file was never created */
    }
    throw new ReviewPacketError('io', `could not write ${file}`, { cause });
  }
}

/**
 * Build the review packet for a commit range.
 *
 * Writes `<repo>/.pagr/review/<reviewId>/packet.md` and returns both its exact contents and a
 * manifest saying which changed files the reviewer can actually see and why the others are only
 * named. `.pagr/` is added to `.git/info/exclude` first, so building a packet never dirties the
 * user's work tree.
 */
export async function buildReviewPacket(input: BuildReviewPacketInput): Promise<ReviewPacket> {
  const { range, reviewId } = input;
  if (!ReviewId.safeParse(reviewId).success)
    throw new ReviewPacketError(
      'bad_review_id',
      `reviewId must be "rev_" followed by 32 hex characters, got ${JSON.stringify(reviewId)}`,
    );

  const intent = intentLine(input.intent);
  if (intent === '') throw new ReviewPacketError('bad_intent', 'intent is empty');

  const env = input.env ?? process.env;
  const maxFileLines = reviewMaxFileLines(env);
  const maxBytes = reviewMaxPacketBytes(env);
  const git = input.git ?? {};

  const root = await repoRoot(input.repo, git);
  // Before anything is written into the work tree.
  await ensureExcluded(root, '.pagr/', git);

  const commits = await logOneline(root, range, git);
  const rawStat = await diffStat(root, range, git);
  const { text: rawPatch, capped: diffCapped } = await readDiff(root, range, git);
  const names = await changedFiles(root, range, git);

  const stat = stripPagrFromStat(rawStat.trimEnd());
  const { patch: fullPatch, dropped: pagrInDiff } = stripPagrFromDiff(rawPatch.trimEnd());

  const files: Classified[] = names.map((p) => classify(root, p, maxFileLines));
  // A `.pagr/` path that only showed up in the patch still belongs in the manifest.
  for (const p of pagrInDiff)
    if (!files.some((f) => f.path === p))
      files.push({ path: p, included: false, lines: null, bytes: null, skipped: 'pagr_internal' });

  const dir = resolve(root, REVIEW_DIR, reviewId);
  const packetPath = resolve(dir, 'packet.md');
  const reviewPath = resolve(dir, 'review.md');

  const assembled = assemble({
    reviewId,
    range,
    intent,
    commits,
    stat,
    patch: fullPatch,
    files,
    maxFileLines,
    maxBytes,
    diffCapped,
  });

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new ReviewPacketError('io', `could not create ${dir}`, { cause });
  }
  writeAtomic(packetPath, assembled.content);

  return {
    reviewId,
    repo: root,
    dir,
    packetPath,
    reviewPath,
    range,
    intent,
    commits,
    files: files.map((f) => ({
      path: f.path,
      included: f.included,
      lines: f.lines,
      bytes: f.bytes,
      ...(f.skipped === undefined ? {} : { skipped: f.skipped }),
    })),
    content: assembled.content,
    bytes: bytesOf(assembled.content),
    truncated: assembled.truncated,
    maxFileLines,
    maxBytes,
  };
}

/**
 * The diff, or a stand-in when git refused to produce it.
 *
 * `git.ts` caps a child's output at 10 MiB and raises `too_large`. A change that big must still
 * produce a usable review — the reviewer reads the file list and the stat and says what it can —
 * so the failure becomes a line in the packet rather than a thrown error.
 */
async function readDiff(
  root: string,
  range: string,
  git: GitOptions,
): Promise<{ text: string; capped: boolean }> {
  try {
    return { text: await diff(root, range, git), capped: false };
  } catch (e) {
    if (e instanceof GitError && e.code === 'too_large')
      return {
        text: '[git refused to print this diff: it is larger than the bridge reads in one go]',
        capped: true,
      };
    throw e;
  }
}

interface AssembleInput {
  reviewId: string;
  range: string;
  intent: string;
  commits: string[];
  stat: string;
  patch: string;
  files: Classified[];
  maxFileLines: number;
  maxBytes: number;
  diffCapped: boolean;
}

/** Compose the packet under the byte ceiling, mutating `files[].skipped` for what did not fit. */
function assemble(i: AssembleInput): { content: string; truncated: boolean } {
  const shownCommits = i.commits.slice(0, MAX_COMMITS_SHOWN);
  const commitsBody =
    shownCommits.length === 0
      ? '_No commits in this range._'
      : codeBlock(
          shownCommits.join('\n') +
            (i.commits.length > shownCommits.length
              ? `\n… and ${i.commits.length - shownCommits.length} more commits`
              : ''),
        );

  const statLines = i.stat === '' ? [] : i.stat.split('\n');
  const statBody =
    statLines.length === 0
      ? '_No changes in this range._'
      : codeBlock(
          statLines.slice(0, MAX_STAT_LINES_SHOWN).join('\n') +
            (statLines.length > MAX_STAT_LINES_SHOWN
              ? `\n… and ${statLines.length - MAX_STAT_LINES_SHOWN} more lines`
              : ''),
        );

  const head = [
    `# Review packet — ${i.reviewId}`,
    '',
    `Range \`${i.range}\` · ${i.commits.length} commit${i.commits.length === 1 ? '' : 's'} · ${i.files.length} changed file${i.files.length === 1 ? '' : 's'}`,
    '',
    'This packet is the whole of the evidence for this review: the change itself, and one line',
    'of stated intent. There is deliberately no transcript, no handoff note and none of the',
    'author’s reasoning here — those would tell you what the change was meant to do, and your',
    'job is to find out what it actually does.',
    '',
    '## Intent (one line, from the author)',
    '',
    `> ${i.intent}`,
    '',
    '## Commits',
    '',
    commitsBody,
    '',
    '## Diffstat',
    '',
    statBody,
    '',
    '## Diff',
    '',
  ].join('\n');

  // Footer allowance, so the manifest is never the thing that gets cut.
  const footerReserve = Math.min(8 * 1024, 512 + 120 * i.files.length);
  const budget = Math.max(1024, i.maxBytes - bytesOf(head) - footerReserve);

  const patchBody = i.patch.trim() === '' ? '' : i.patch;
  const diffBudget = Math.floor(budget * DIFF_BUDGET_SHARE);
  const cutDiff = patchBody === '' ? { text: '', cut: false } : cutToBytes(patchBody, diffBudget);
  let truncated = cutDiff.cut || i.diffCapped;

  const diffSection =
    patchBody === ''
      ? '_The diff is empty._'
      : cutDiff.cut
        ? `${codeBlock(cutDiff.text, 'diff')}\n\n> **The diff above is cut short.** It reached this packet’s ${diffBudget}-byte allowance;\n> the rest of the patch is not here. You are reading part of the change, not all of it.`
        : codeBlock(cutDiff.text, 'diff');

  let used = bytesOf(cutDiff.text) + 64;
  const parts: string[] = [head, diffSection, '', '## Changed files (full current contents)', ''];

  const inlined: string[] = [];
  for (const f of i.files) {
    if (!f.included || f.body === undefined) continue;
    const section = `### \`${f.path}\` — ${f.lines} line${f.lines === 1 ? '' : 's'}\n\n${codeBlock(f.body, langOf(f.path))}\n`;
    const size = bytesOf(section);
    if (used + size > budget) {
      f.included = false;
      f.skipped = 'budget';
      f.body = undefined;
      truncated = true;
      continue;
    }
    used += size;
    inlined.push(section);
  }

  parts.push(
    inlined.length === 0 ? '_No changed file was small enough to include._' : inlined.join('\n'),
  );

  const skipped = i.files.filter((f) => !f.included);
  // `.pagr/` paths are counted, never named. The path of a handoff note is itself a pointer at
  // the author's reasoning, and a reviewer told the file exists is a reviewer that goes and
  // reads it. It is a number here and a path only in the manifest the bridge gets back.
  const internal = skipped.filter((f) => f.skipped === 'pagr_internal');
  const named = skipped.filter((f) => f.skipped !== 'pagr_internal');
  if (skipped.length > 0) {
    parts.push('', '## Named but not included', '');
    parts.push(...named.map((f) => `- \`${f.path}\` — ${reasonText(f, i.maxFileLines)}`));
    if (internal.length > 0)
      parts.push(
        `- ${internal.length} Pagr working file${internal.length === 1 ? '' : 's'} (a handoff note, a transcript or an earlier review) — never part of a review`,
      );
  }

  const body = `${parts.join('\n').trimEnd()}\n`;
  if (!truncated) return { content: body, truncated: false };

  const dropped = i.files.filter((f) => f.skipped === 'budget').length;
  const cutClause = cutDiff.cut ? ', so the diff below is cut short' : '';
  const droppedClause =
    dropped === 0
      ? ''
      : ` and ${dropped} changed ${dropped === 1 ? 'file is' : 'files are'} not included`;
  const notice = [
    '> **This packet is truncated.**',
    `> It reached its ${i.maxBytes}-byte ceiling${cutClause}${droppedClause}.`,
    '> Review what is here, and say in your report that you were shown part of the change —',
    '> do not assume the rest is fine because you did not see it.',
    '',
  ].join('\n');
  // After the H1, before the range line, where it cannot be scrolled past.
  const [h1, ...rest] = body.split('\n');
  return { content: [h1, '', notice, ...rest.slice(1)].join('\n'), truncated: true };
}
