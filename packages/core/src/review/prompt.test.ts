import { describe, expect, it } from 'vitest';
import {
  parseVerdict,
  REVIEW_CHECKLIST,
  REVIEW_VERDICTS,
  reviewPrompt,
  VERDICT_LINE_EXAMPLE,
} from './prompt.js';

const PACKET =
  '/Users/x/code/checkout-api/.pagr/review/rev_0123456789abcdef0123456789abcdef/packet.md';
const OUT =
  '/Users/x/code/checkout-api/.pagr/review/rev_0123456789abcdef0123456789abcdef/review.md';

const prompt = () => reviewPrompt({ packetPath: PACKET, outPath: OUT });

describe('reviewPrompt', () => {
  it('matches the snapshot', () => {
    expect(prompt()).toMatchSnapshot();
  });

  it('is deterministic', () => {
    expect(prompt()).toBe(prompt());
  });

  it('names both absolute paths and asks for exactly one file', () => {
    const text = prompt();
    expect(text).toContain(PACKET);
    expect(text).toContain(`Write exactly one file, at this absolute path: ${OUT}`);
  });

  it('sets the adversarial stance rather than asking for an opinion', () => {
    const text = prompt();
    expect(text).toContain('assumption that the author got something wrong');
    expect(text).toContain('"Looks fine" is a failed review.');
    expect(text).toMatch(/find the bug,\nthe security hole or the irreversible action/);
  });

  it('tells the reviewer it does not have — and must not look for — the author’s reasoning', () => {
    const text = prompt();
    expect(text).toContain('You do not have the author’s transcript, notes or reasoning');
    expect(text).toContain('no other file under `.pagr/` is part of this review');
    expect(text).toContain('Judge');
  });

  it('scores the five-item checklist, in order', () => {
    const text = prompt();
    const names = REVIEW_CHECKLIST.map((c) => c.name);
    expect(names).toEqual(['Correctness', 'Security', 'Reversibility', 'Tests', 'Scope']);
    REVIEW_CHECKLIST.forEach((item, i) => {
      expect(text).toContain(`${i + 1}. **${item.name}** — ${item.ask}`);
    });
  });

  it('states the verdict-line contract unambiguously, with an example that parses', () => {
    const text = prompt();
    expect(text).toContain('THE FIRST LINE OF THAT FILE IS A CONTRACT');
    expect(text).toContain('verdict: <approve|comment|block> — <one short line saying why>');
    expect(text).toContain('the very first characters in the file are `verdict:`');
    expect(text).toContain(VERDICT_LINE_EXAMPLE);
    // The example the model is told to copy must itself survive the parser.
    expect(parseVerdict(VERDICT_LINE_EXAMPLE).verdict).toBe('block');
    expect(parseVerdict(VERDICT_LINE_EXAMPLE).note).toBeUndefined();
    // Each verdict is defined, so the reviewer is not guessing where the line is.
    for (const v of REVIEW_VERDICTS) expect(text).toContain(`\`${v}\` —`);
  });

  it('asks for findings anchored to a file and a line', () => {
    const text = prompt();
    expect(text).toContain('### <file>:<line> — <one-line title>');
    expect(text).toContain('Anchor every finding to a file and a line from the packet');
    expect(text).toContain('a finding you cannot anchor to a line is not a finding');
  });

  it('tells the reviewer to declare a truncated packet', () => {
    expect(prompt()).toContain('If the packet says it was truncated, say so in your report');
  });
});

describe('parseVerdict', () => {
  it('reads all three verdicts and their summary', () => {
    expect(parseVerdict('verdict: approve — nothing to change; the retry is bounded\n')).toEqual({
      verdict: 'approve',
      summary: 'nothing to change; the retry is bounded',
    });
    expect(parseVerdict('verdict: comment — the retry has no test for the 429 path')).toEqual({
      verdict: 'comment',
      summary: 'the retry has no test for the 429 path',
    });
    expect(parseVerdict('verdict: block — drops the column before the backfill')).toEqual({
      verdict: 'block',
      summary: 'drops the column before the backfill',
    });
  });

  it('reads a fenced answer', () => {
    const text = '```markdown\nverdict: block — the token is logged in plain text\n\n### a.ts:12\n';
    expect(parseVerdict(text)).toEqual({
      verdict: 'block',
      summary: 'the token is logged in plain text',
    });
  });

  it('reads an answer that starts with blank lines', () => {
    expect(parseVerdict('\n\n   \n  verdict: comment — scope creep in the config\n')).toEqual({
      verdict: 'comment',
      summary: 'scope creep in the config',
    });
  });

  it('tolerates the decoration a model actually adds', () => {
    const cases = [
      '**Verdict:** approve — looks bounded',
      '# verdict: approve — looks bounded',
      '> verdict: APPROVE - looks bounded',
      '`verdict: approve` – looks bounded',
      'Verdict:approve—looks bounded',
    ];
    for (const c of cases) {
      const got = parseVerdict(c);
      expect(got.verdict, c).toBe('approve');
      expect(got.summary, c).toBe('looks bounded');
    }
  });

  it('caps the summary at the protocol’s 500 characters', () => {
    const got = parseVerdict(`verdict: block — ${'x'.repeat(900)}`);
    expect(got.summary).toHaveLength(500);
    expect(got.summary.endsWith('…')).toBe(true);
  });

  it('keeps the verdict but notes a line with no summary', () => {
    const got = parseVerdict('verdict: block\n\nfindings follow');
    expect(got.verdict).toBe('block');
    expect(got.note).toBe('the verdict line carried no summary');
    expect(got.summary).toContain('block');
  });

  it('answers comment with a note on a garbage first line, and never throws', () => {
    const got = parseVerdict(
      'Sure! Here is my review of the change you asked about.\n\n### a.ts:1',
    );
    expect(got.verdict).toBe('comment');
    expect(got.note).toMatch(/^no verdict line:/);
    expect(got.summary).toContain('Here is my review');
  });

  it('refuses to read a verdict out of prose', () => {
    // "Approve with reservations" is an opinion, not the contract. Guessing here is how a
    // block becomes an approve.
    for (const prose of ['Approve with reservations.', 'I would block this.', 'No comment.'])
      expect(parseVerdict(prose).note).toMatch(/^no verdict line:/);
  });

  it('answers comment with a note on an empty report', () => {
    for (const empty of ['', '   \n\n', '```\n```\n']) {
      const got = parseVerdict(empty);
      expect(got.verdict).toBe('comment');
      expect(got.note).toContain('empty');
    }
  });
});
