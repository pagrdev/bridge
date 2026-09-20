import type { ReviewVerdict } from '@pagr/protocol';

/**
 * The reviewing agent's instruction, and the parser for what it writes back (spec §5).
 *
 * The reviewer is a different vendor's model, started read-only on the same tree, holding
 * nothing but `packet.md`. It never sees the builder's transcript or reasoning — see
 * `packet.ts` for why that is the whole point — so this prompt has to supply the *stance* the
 * missing context would otherwise have to fight: assume the author was wrong, and go looking.
 *
 * The one machine-readable contract is the first line of the report:
 *
 *     verdict: approve|comment|block — <one line>
 *
 * The bridge parses that line with a regex, not with another model, so the verdict costs
 * nothing and cannot drift. {@link parseVerdict} is deliberately forgiving about everything a
 * real model actually does to that line — a code fence, a blank line first, `**Verdict:**`,
 * an en dash instead of an em dash — and when it still cannot read it, it answers `comment`
 * with a note rather than throwing. A reviewer that formats its answer badly has still done the
 * work; losing the whole review over punctuation would be the worse failure.
 */

export interface ReviewPromptInput {
  /** Absolute path to `packet.md`, the only input the reviewer is given. */
  packetPath: string;
  /** Absolute path the reviewer must write, `<repo>/.pagr/review/<reviewId>/review.md`. */
  outPath: string;
}

/** The five things every review scores, in the order the report states them. */
export const REVIEW_CHECKLIST = [
  {
    name: 'Correctness',
    ask: 'Does the code do what the intent line says, on every path? Off-by-one, wrong operator, unhandled null, wrong branch taken, an error swallowed, a promise not awaited, a loop that never terminates.',
  },
  {
    name: 'Security',
    ask: 'What can an attacker or a malformed input reach? Injection, path traversal, a secret in a log or a committed file, authentication or authorisation skipped, an unvalidated boundary, a dependency added that nobody vetted.',
  },
  {
    name: 'Reversibility',
    ask: 'What here cannot be undone? Data deleted or overwritten, a schema migration with no backfill or no down path, a file written outside the repo, a network call with a side effect, anything that destroys state before the replacement is proven.',
  },
  {
    name: 'Tests',
    ask: 'Is the new behaviour actually covered, including the failure case? A test that would still pass with the change reverted is not coverage. Name the case that is missing.',
  },
  {
    name: 'Scope',
    ask: 'Is anything here outside the intent line? Unrelated refactors, drive-by renames, a config or dependency change nobody asked for, a debug line left in, commented-out code.',
  },
] as const;

/** The exact first line the bridge parses. Shown to the reviewer as the example to copy. */
export const VERDICT_LINE_EXAMPLE =
  'verdict: block — applyMigration drops the old column before the backfill runs, so a failed deploy loses data';

/** The three answers, strongest first in the order a person cares about them. */
export const REVIEW_VERDICTS = ['approve', 'comment', 'block'] as const;

/**
 * Build the reviewer's instruction. Pure and deterministic: the same two paths always produce
 * the same text, so the prompt is snapshot-testable and a review can be replayed exactly.
 */
export function reviewPrompt(input: ReviewPromptInput): string {
  const lines: string[] = [
    'You are reviewing someone else’s change, and you are the last check before it ships.',
    '',
    'Read this file, in full, first:',
    '',
    `  ${input.packetPath}`,
    '',
    'It contains the diff, the commit list and one line saying what the author was trying to do.',
    'That is everything you get. You do not have the author’s transcript, notes or reasoning, and',
    'you must not go looking for them: no other file under `.pagr/` is part of this review. Judge',
    'the change on what the code does, not on what it was meant to do.',
    '',
    'Do not change any file in the repository, do not run the code, and do not fix anything. You',
    'are read-only apart from the one report described below.',
    '',
    '## How to review',
    '',
    'Start from the assumption that the author got something wrong. Your job is to find the bug,',
    'the security hole or the irreversible action — not to confirm that the change looks',
    'reasonable. "Looks fine" is a failed review. If after real effort you genuinely find nothing,',
    'say what you checked and why it holds.',
    '',
    'Work the diff line by line. For each hunk ask what input makes it behave differently than the',
    'author expected, and what happens on the failure path. Prefer one concrete, demonstrable',
    'finding over five vague concerns; a finding you cannot anchor to a line is not a finding.',
    '',
    'Score the change against these five, every time, in this order:',
    '',
  ];

  REVIEW_CHECKLIST.forEach((item, i) => {
    lines.push(`  ${i + 1}. **${item.name}** — ${item.ask}`);
  });

  lines.push(
    '',
    '## What to write',
    '',
    `Write exactly one file, at this absolute path: ${input.outPath}`,
    '',
    'THE FIRST LINE OF THAT FILE IS A CONTRACT. It is read by a program, not by a person, and it',
    'must match this shape exactly:',
    '',
    '  verdict: <approve|comment|block> — <one short line saying why>',
    '',
    'The word `verdict`, then a colon, then exactly one of `approve`, `comment` or `block`, then',
    'an em dash, then one line. Lower case. No heading, no code fence, no blank line, no preamble',
    'of any kind above it — the very first characters in the file are `verdict:`. Keep the line',
    'under 200 characters and put nothing else on it.',
    '',
    'For example, a first line that is exactly right (indented here only so it stands out; in',
    'your file it starts at the very first column):',
    '',
    `  ${VERDICT_LINE_EXAMPLE}`,
    '',
    'Choose the verdict by this rule, and do not hedge between them:',
    '',
    '  - `block` — you found something that must be fixed before this ships: it is wrong, it is',
    '    unsafe, or it destroys something that cannot be recovered.',
    '  - `comment` — it works as far as you can tell, but there is something the author should',
    '    see: a missing test, a risky edge case, something out of scope.',
    '  - `approve` — you looked hard and found nothing that needs to change.',
    '',
    'Below that first line, write the findings. One section per finding, strongest first:',
    '',
    '  ### <file>:<line> — <one-line title>',
    '  What is wrong, the input or sequence that triggers it, and what it costs.',
    '  What you would do instead — one or two lines, not a patch.',
    '',
    'Anchor every finding to a file and a line from the packet. When a finding is about something',
    'that is *missing* and so has no line, name the file it belongs in and say so. Finish with a',
    'short `## Checklist` section giving one line per item above, including the ones that passed.',
    '',
    'If the packet says it was truncated, say so in your report and be explicit that you reviewed',
    'part of the change; do not treat what you were not shown as fine.',
    '',
    'Write the file, then stop. Say nothing else.',
  );

  return `${lines.join('\n')}\n`;
}

/** The first line of a review, read by the bridge. */
export interface ParsedVerdict {
  verdict: ReviewVerdict;
  /** The text after the dash, trimmed and capped at 500 characters (the protocol's limit). */
  summary: string;
  /**
   * Why this needed interpreting. Absent when the first line was exactly the contract.
   * Present — with `verdict: 'comment'` — when the line could not be read at all.
   */
  note?: string;
}

/** Longest summary the protocol's `review.completed.summary` accepts. */
const SUMMARY_MAX = 500;

/**
 * Accepts the contract and the near misses a real model produces: leading blank lines, an
 * opening ``` fence, a `#` heading marker or a `>` quote, `**Verdict:**`, upper case, an en
 * dash or a hyphen or a colon instead of an em dash. What it does not accept is a first line
 * that merely contains one of the three words — "Approve with reservations" is prose, and
 * reading a verdict out of prose is how a `block` becomes an `approve`.
 */
const VERDICT_RE =
  /^[\s>#*_`]*verdict[\s*_`]*:[\s*_`]*(approve|comment|block)\b[\s*_`]*(?:[—–-]+|:)?[\s*_`]*(.*)$/i;

/** A line that is only a code fence, with or without a language. */
const FENCE_RE = /^\s*(?:`{3,}|~{3,})[a-z]*\s*$/i;

const cap = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

/**
 * Read the verdict line at the top of a review.
 *
 * Never throws. An unreadable first line comes back as `comment` with a `note`, because the
 * findings underneath are still worth sending to the person — and `comment` is the answer that
 * neither ships an unreviewed change nor blocks a reviewed one.
 */
export function parseVerdict(text: string): ParsedVerdict {
  const lines = text.split('\n');
  let first: string | undefined;
  for (const line of lines) {
    if (line.trim() === '') continue;
    // A leading fence is the single most common wrapper; skip it and read the line inside.
    if (FENCE_RE.test(line)) continue;
    first = line;
    break;
  }

  if (first === undefined)
    return {
      verdict: 'comment',
      summary: 'the reviewer wrote an empty report',
      note: 'no verdict line: the review file was empty',
    };

  const m = VERDICT_RE.exec(first);
  if (!m || m[1] === undefined)
    return {
      verdict: 'comment',
      summary: cap(first.trim().replace(/^[\s>#*_`]+/, ''), 200),
      note: `no verdict line: the review began with ${JSON.stringify(cap(first.trim(), 80))} instead of "verdict: …"`,
    };

  const verdict = m[1].toLowerCase() as ReviewVerdict;
  const summary = cap((m[2] ?? '').replace(/[\s*_`]+$/, '').trim(), SUMMARY_MAX);
  if (summary === '')
    return {
      verdict,
      summary: `the reviewer’s verdict is ${verdict}`,
      note: 'the verdict line carried no summary',
    };
  return { verdict, summary };
}
