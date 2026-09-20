import { z } from 'zod';

/**
 * The handoff file (`handoff/1`).
 *
 * One `<repo>/.pagr/handoff/<id>.md` per switch: typed frontmatter the cloud can validate
 * without ever reading the body, then nine fixed sections of prose the receiving agent reads
 * instead of the sender's transcript. Spec: `docs/superpowers/specs/2026-09-20-handoff-v1-design.md` §2.
 *
 * This module owns parse / validate / serialize and nothing else — no fs, no git, no adapters —
 * because the platform gets a byte-synced copy of it and must not inherit the bridge's world.
 *
 * Two invariants the rest of the system leans on:
 *
 *   1. **Serialization is stable.** The same document always produces the same bytes, and
 *      `serialize → parse → serialize` is byte-identical. The file is sealed and hashed; a
 *      serializer that reordered a map would re-seal an unchanged handoff on every rewrite.
 *   2. **Parsing is permissive about the body and strict about the frontmatter.** An agent
 *      writes this file by hand, so it will invent a section sooner or later: unknown headings
 *      are preserved in `extra` rather than failing the parse. The frontmatter is machine-written
 *      and machine-read, so a bad one is a typed problem, never a guess.
 */

/** `hnd_` + 32 lowercase hex — the handoff id, and the file's basename. */
export const HANDOFF_ID_RE = /^hnd_[0-9a-f]{32}$/;

/** Body size cap, in UTF-8 bytes. `truncate` drops sections from the bottom until it fits. */
export const HANDOFF_BODY_MAX_BYTES = 64 * 1024;

/** Longest `summaryLine` the phone is ever sent. */
export const HANDOFF_SUMMARY_MAX_CHARS = 500;

/**
 * Local copy of the protocol's `Provider`. HND-001 owns `@pagr/protocol`'s schemas on another
 * branch; this is re-pointed at `Provider` once both land, and the values are identical.
 */
export const HandoffProvider = z.enum(['claude', 'codex']);
export type HandoffProvider = z.infer<typeof HandoffProvider>;

/** Where the sending session came from. `unknown` is for sessions Pagr only ever mirrored. */
export const HandoffOrigin = z.enum(['pagr', 'terminal', 'ide', 'unknown']);
export type HandoffOrigin = z.infer<typeof HandoffOrigin>;

/** Who actually wrote the body: the sending agent, or the receiver from the transcript (§3). */
export const HandoffWriter = z.enum(['sender', 'receiver']);
export type HandoffWriter = z.infer<typeof HandoffWriter>;

export const HandoffFrontmatter = z.object({
  pagr: z.literal('handoff/1'),
  id: z.string().regex(HANDOFF_ID_RE, 'expected hnd_ followed by 32 hex characters'),
  from: z.object({
    provider: HandoffProvider,
    sessionId: z.string().min(1),
    origin: HandoffOrigin,
  }),
  to: z.object({ provider: HandoffProvider }),
  project: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  git: z.object({
    branch: z.string().min(1),
    head: z.string().min(1),
    /** The WIP commit made at the switch, or null when the tree was already clean. */
    wipCommit: z.string().nullable(),
    dirtyBefore: z.boolean(),
  }),
  writer: HandoffWriter,
  /** The handoff this one continues, for a chain of switches. */
  previous: z.string().regex(HANDOFF_ID_RE).nullable(),
  /** ISO-8601, UTC. */
  created: z.string().datetime({ offset: true }),
  /** Set by `truncate` when the body did not fit under the cap. */
  truncated: z.boolean().optional(),
});
export type HandoffFrontmatter = z.infer<typeof HandoffFrontmatter>;

/** One line of "Not done". Exactly one item in a valid handoff carries `next`. */
export interface HandoffNextItem {
  text: string;
  next: boolean;
}

/** `<decision> — <why; rejected alternatives>`. `why` is the first thing truncation drops. */
export interface HandoffDecision {
  what: string;
  why: string | null;
}

/** A heading this version does not know. Kept verbatim so a rewrite never loses the agent's work. */
export interface HandoffExtraSection {
  heading: string;
  lines: string[];
}

export interface HandoffDoc {
  frontmatter: HandoffFrontmatter;
  /** Everything under `# Goal`. Its first non-empty line is what the phone receives. */
  goal: string;
  done: string[];
  notDone: HandoffNextItem[];
  decisions: HandoffDecision[];
  filesTouched: string[];
  /** The lines inside the `# Commands to run` fence, verbatim. */
  commands: string[];
  knownFailures: string[];
  rulesInForce: string[];
  openQuestions: string[];
  extra: HandoffExtraSection[];
}

/** Sections `truncate` is allowed to drop, in the order it drops them. */
export const HANDOFF_TRUNCATION_ORDER = [
  'openQuestions',
  'knownFailures',
  'decisionDetail',
  'filesTouched',
] as const;
export type HandoffTruncationStep = (typeof HANDOFF_TRUNCATION_ORDER)[number];

export type HandoffProblemCode =
  /** No `---` fenced block at the top of the file at all. */
  | 'no_frontmatter'
  /** There is a block, but it is not the `key: value` / `key: { k: v }` shape we write. */
  | 'bad_frontmatter'
  /** It parsed, but it is not a `handoff/1` frontmatter. */
  | 'wrong_shape'
  /** Nothing in "Not done" is marked `← next`. */
  | 'no_next'
  /** More than one item is marked `← next`. */
  | 'multiple_next'
  /** `# Goal` is empty, so there is no summary to text. */
  | 'empty_goal';

/**
 * A problem with a handoff file, in the shape `jsonFile.ts` established: a code to branch on, a
 * sentence to show the user, and the thing to do about it. Never thrown — `parse` returns it.
 */
export interface HandoffProblem {
  code: HandoffProblemCode;
  message: string;
  hint: string;
}

export type HandoffParseResult =
  | { ok: true; doc: HandoffDoc; problems: HandoffProblem[] }
  | { ok: false; problem: HandoffProblem };

/** The nine section headings, in the order `serialize` writes them. Spec §2, verbatim. */
export const HANDOFF_SECTIONS = [
  'Goal',
  'Done',
  'Not done',
  'Decisions and why',
  'Files touched',
  'Commands to run',
  'Known failures',
  'Rules in force',
  'Open questions',
] as const;

const NEXT_MARKER = '← next';
const DECISION_SEPARATOR = ' — ';
const FENCE = '```';

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

type Scalar = string | number | boolean | null;

/** Bare inside a `{ ... }` flow mapping: no `:`, `,`, `{`, `}` or quoting hazards. */
const BARE_IN_FLOW = /^[A-Za-z0-9][A-Za-z0-9_\-./@+]*$/;
/** Bare at the top level, where a `:` inside the value is unambiguous (we split on the first). */
const BARE_AT_TOP = /^[A-Za-z0-9][A-Za-z0-9_\-./@+:]*$/;

function emitScalar(value: Scalar, inFlow: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const bare = inFlow ? BARE_IN_FLOW : BARE_AT_TOP;
  if (value !== 'null' && value !== 'true' && value !== 'false' && bare.test(value)) return value;
  return JSON.stringify(value);
}

function emitFlowMap(entries: Array<[string, Scalar]>): string {
  return `{ ${entries.map(([k, v]) => `${k}: ${emitScalar(v, true)}`).join(', ')} }`;
}

function parseScalar(raw: string): Scalar {
  const text = raw.trim();
  if (text === '' || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : text;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** Split a flow mapping's body on top-level commas, respecting quotes and nesting. */
function splitFlowEntries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function parseFlowMap(text: string): Record<string, Scalar> | null {
  const body = text.slice(1, -1);
  const map: Record<string, Scalar> = {};
  for (const entry of splitFlowEntries(body)) {
    const colon = entry.indexOf(':');
    if (colon <= 0) return null;
    map[entry.slice(0, colon).trim()] = parseScalar(entry.slice(colon + 1));
  }
  return map;
}

/**
 * The `key: value` / `key: { k: v }` subset we write. Deliberately not a YAML parser: the file is
 * machine-written, and a real YAML dependency in a module the platform byte-syncs is a cost with
 * no buyer.
 */
function parseFrontmatterBlock(block: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) return null; // no nested block mappings in handoff/1
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest.startsWith('{')) {
      if (!rest.endsWith('}')) return null;
      const map = parseFlowMap(rest);
      if (!map) return null;
      out[key] = map;
    } else {
      out[key] = parseScalar(rest);
    }
  }
  return out;
}

function serializeFrontmatter(fm: HandoffFrontmatter): string {
  const lines = [
    '---',
    `pagr: ${emitScalar(fm.pagr, false)}`,
    `id: ${emitScalar(fm.id, false)}`,
    `from: ${emitFlowMap([
      ['provider', fm.from.provider],
      ['sessionId', fm.from.sessionId],
      ['origin', fm.from.origin],
    ])}`,
    `to: ${emitFlowMap([['provider', fm.to.provider]])}`,
    `project: ${emitFlowMap([
      ['id', fm.project.id],
      ['name', fm.project.name],
    ])}`,
    `git: ${emitFlowMap([
      ['branch', fm.git.branch],
      ['head', fm.git.head],
      ['wipCommit', fm.git.wipCommit],
      ['dirtyBefore', fm.git.dirtyBefore],
    ])}`,
    `writer: ${emitScalar(fm.writer, false)}`,
    `previous: ${emitScalar(fm.previous, false)}`,
    `created: ${emitScalar(fm.created, false)}`,
  ];
  // Only ever written when true: absent means "nothing was dropped", which is the common case.
  if (fm.truncated === true) lines.push('truncated: true');
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

/** Items are one line by construction, so that `- ` bullets survive a round trip. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function bulletBlock(items: string[]): string[] {
  return items.map((item) => `- ${oneLine(item)}`).filter((line) => line !== '- ');
}

function section(heading: string, lines: string[]): string {
  return lines.length === 0 ? `# ${heading}\n\n` : `# ${heading}\n${lines.join('\n')}\n\n`;
}

function decisionLine(d: HandoffDecision): string {
  const what = oneLine(d.what);
  const why = d.why === null ? '' : oneLine(d.why);
  return why === '' ? `- ${what}` : `- ${what}${DECISION_SEPARATOR}${why}`;
}

function notDoneLine(item: HandoffNextItem): string {
  return `- [ ] ${oneLine(item.text)}${item.next ? ` ${NEXT_MARKER}` : ''}`;
}

/** The body only: everything after the closing `---`. This is what the 64 KiB cap measures. */
export function serializeBody(doc: HandoffDoc): string {
  const goal = doc.goal.replace(/\s+$/, '');
  const parts = [
    section('Goal', goal === '' ? [] : goal.split('\n')),
    section('Done', bulletBlock(doc.done)),
    section('Not done', doc.notDone.map(notDoneLine)),
    section('Decisions and why', doc.decisions.map(decisionLine)),
    section('Files touched', bulletBlock(doc.filesTouched)),
    section(
      'Commands to run',
      doc.commands.length === 0 ? [] : [FENCE, ...doc.commands.map((c) => c.trimEnd()), FENCE],
    ),
    section('Known failures', bulletBlock(doc.knownFailures)),
    section('Rules in force', bulletBlock(doc.rulesInForce)),
    section('Open questions', bulletBlock(doc.openQuestions)),
    ...doc.extra.map((s) => section(s.heading, trimBlankEdges(s.lines))),
  ];
  // One trailing newline, never a run of blank lines at the end of the file.
  return `${parts.join('').replace(/\n+$/, '')}\n`;
}

/**
 * The whole file. Stable: same document in, byte-identical file out, so an unchanged handoff
 * re-seals to the same ciphertext input and a rewrite is visible in a diff only when it changed.
 */
export function serialize(doc: HandoffDoc): string {
  return `${serializeFrontmatter(doc.frontmatter)}\n${serializeBody(doc)}`;
}

/** UTF-8 bytes of the body, for the cap. */
export function bodyBytes(doc: HandoffDoc): number {
  return Buffer.byteLength(serializeBody(doc), 'utf8');
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
}

function bullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    out.push(text.startsWith('- ') ? text.slice(2).trim() : text.replace(/^-\s*/, '').trim());
  }
  return out.filter((t) => t !== '');
}

function parseNotDone(lines: string[]): HandoffNextItem[] {
  return bullets(lines).map((raw) => {
    const withoutBox = raw.replace(/^\[[ xX]\]\s*/, '');
    const marked = /(?:←|<-|<—)\s*next\s*$/i.test(withoutBox);
    const text = marked ? withoutBox.replace(/(?:←|<-|<—)\s*next\s*$/i, '').trim() : withoutBox;
    return { text, next: marked };
  });
}

function parseDecisions(lines: string[]): HandoffDecision[] {
  return bullets(lines).map((raw) => {
    const at = raw.indexOf(DECISION_SEPARATOR);
    if (at < 0) return { what: raw, why: null };
    return { what: raw.slice(0, at).trim(), why: raw.slice(at + DECISION_SEPARATOR.length).trim() };
  });
}

/** The lines inside the fence; a fenceless section falls back to its non-empty lines. */
function parseCommands(lines: string[]): string[] {
  const open = lines.findIndex((l) => l.trimStart().startsWith(FENCE));
  if (open < 0) return trimBlankEdges(lines).filter((l) => l.trim() !== '');
  const rest = lines.slice(open + 1);
  const close = rest.findIndex((l) => l.trimStart().startsWith(FENCE));
  return trimBlankEdges(close < 0 ? rest : rest.slice(0, close));
}

/**
 * Split the body into `# Heading` blocks. Fence-aware: `# do the thing` inside a shell block in
 * "Commands to run" is a comment, not a tenth section.
 */
function splitSections(body: string): Array<{ heading: string; lines: string[] }> {
  const out: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) inFence = !inFence;
    const heading = inFence ? null : /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      if (current) out.push(current);
      current = { heading: heading[1], lines: [] };
      continue;
    }
    // Anything before the first heading is preamble; `serialize` never writes one.
    if (current) current.lines.push(line);
  }
  if (current) out.push(current);
  return out;
}

function problem(code: HandoffProblemCode, message: string, hint: string): HandoffProblem {
  return { code, message, hint };
}

/**
 * Read a handoff file. Permissive about the body — a heading this version does not know lands in
 * `extra`, a missing section is an empty array — and strict about the frontmatter, which is
 * reported as a typed problem rather than thrown.
 *
 * `problems` on a successful parse carries the non-fatal findings (`validate`'s output) so a
 * caller that only wants "did it parse" can ignore them.
 */
export function parse(text: string): HandoffParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      ok: false,
      problem: problem(
        'no_frontmatter',
        'this file does not start with a `---` frontmatter block',
        'a handoff file starts with `---`, `pagr: handoff/1` and ends that block with `---`',
      ),
    };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) {
    return {
      ok: false,
      problem: problem(
        'no_frontmatter',
        'the `---` frontmatter block is never closed',
        'close the block with a line containing only `---` before the `# Goal` heading',
      ),
    };
  }
  const block = normalized.slice(4, end);
  const afterFence = normalized.indexOf('\n', end + 1);
  const body = afterFence < 0 ? '' : normalized.slice(afterFence + 1);

  const raw = parseFrontmatterBlock(block);
  if (!raw) {
    return {
      ok: false,
      problem: problem(
        'bad_frontmatter',
        'the frontmatter is not the `key: value` / `key: { k: v }` shape handoff/1 uses',
        'rewrite the block, or delete the file and run the handoff again',
      ),
    };
  }
  const parsed = HandoffFrontmatter.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      problem: problem(
        'wrong_shape',
        `this is not a handoff/1 frontmatter${
          issue ? ` (${issue.path.join('.') || '(root)'}: ${issue.message})` : ''
        }`,
        'delete the file and run the handoff again; do not hand-edit the frontmatter',
      ),
    };
  }

  const sections = splitSections(body);
  const known = new Map(sections.map((s) => [s.heading, s.lines] as const));
  const take = (heading: string): string[] => trimBlankEdges(known.get(heading) ?? []);
  const extra = sections
    .filter((s) => !(HANDOFF_SECTIONS as readonly string[]).includes(s.heading))
    .map((s) => ({ heading: s.heading, lines: trimBlankEdges(s.lines) }));

  const doc: HandoffDoc = {
    frontmatter: parsed.data,
    goal: take('Goal').join('\n'),
    done: bullets(take('Done')),
    notDone: parseNotDone(take('Not done')),
    decisions: parseDecisions(take('Decisions and why')),
    filesTouched: bullets(take('Files touched')),
    commands: parseCommands(known.get('Commands to run') ?? []),
    knownFailures: bullets(take('Known failures')),
    rulesInForce: bullets(take('Rules in force')),
    openQuestions: bullets(take('Open questions')),
    extra,
  };
  return { ok: true, doc, problems: validate(doc) };
}

// ---------------------------------------------------------------------------
// validate / summary / truncate
// ---------------------------------------------------------------------------

/** The item the receiver should start on, or null when the handoff does not say. */
export function nextItem(doc: HandoffDoc): HandoffNextItem | null {
  const marked = doc.notDone.filter((i) => i.next);
  return marked.length === 1 ? (marked[0] ?? null) : null;
}

/**
 * Non-fatal findings: things a human should fix, not reasons to reject the file. "Exactly one
 * next" is the one the receiving agent actually depends on — zero leaves it guessing where to
 * start, and two make it pick.
 */
export function validate(doc: HandoffDoc): HandoffProblem[] {
  const out: HandoffProblem[] = [];
  if (summaryLine(doc) === '') {
    out.push(
      problem(
        'empty_goal',
        '`# Goal` is empty, so there is no one-line summary to send',
        'write one line under `# Goal` saying what the task is',
      ),
    );
  }
  const marked = doc.notDone.filter((i) => i.next).length;
  if (marked === 0 && doc.notDone.length > 0) {
    out.push(
      problem(
        'no_next',
        'no item under `# Not done` is marked `← next`',
        'mark exactly one item with `← next` so the receiver knows where to start',
      ),
    );
  } else if (marked > 1) {
    out.push(
      problem(
        'multiple_next',
        `${marked} items under \`# Not done\` are marked \`← next\`; exactly one may be`,
        'leave `← next` on the one item to start with and remove it from the others',
      ),
    );
  }
  return out;
}

/**
 * The line the phone receives: the first non-empty line under `# Goal`, trimmed and clipped.
 * Never empty when Goal has any content — the text message IS this string.
 */
export function summaryLine(doc: HandoffDoc): string {
  const first = doc.goal.split('\n').find((line) => line.trim() !== '');
  const text = (first ?? '').trim();
  if (text.length <= HANDOFF_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, HANDOFF_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Bring the body under `HANDOFF_BODY_MAX_BYTES` by dropping from the bottom:
 * Open questions, then Known failures, then the "why" on each decision, then Files touched.
 * Goal, Done and Not done are never touched — they are the handoff.
 *
 * Returns a new document; the input is not mutated. `dropped` names the steps that were applied,
 * because the file itself can only say *that* it was truncated, not what went.
 */
export function truncate(doc: HandoffDoc): { doc: HandoffDoc; dropped: HandoffTruncationStep[] } {
  if (bodyBytes(doc) <= HANDOFF_BODY_MAX_BYTES) return { doc, dropped: [] };
  let current: HandoffDoc = { ...doc };
  const dropped: HandoffTruncationStep[] = [];
  for (const step of HANDOFF_TRUNCATION_ORDER) {
    if (step === 'openQuestions') current = { ...current, openQuestions: [] };
    else if (step === 'knownFailures') current = { ...current, knownFailures: [] };
    else if (step === 'decisionDetail')
      current = { ...current, decisions: current.decisions.map((d) => ({ ...d, why: null })) };
    else current = { ...current, filesTouched: [] };
    dropped.push(step);
    if (bodyBytes(current) <= HANDOFF_BODY_MAX_BYTES) break;
  }
  return {
    doc: { ...current, frontmatter: { ...current.frontmatter, truncated: true } },
    dropped,
  };
}
