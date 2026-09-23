import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HandoffWriter as ProtocolHandoffWriter, Provider, SessionOrigin } from '@pagr/protocol';
import { describe, expect, it } from 'vitest';
import { useTempHome } from '../testUtil.js';
import {
  bodyBytes,
  HANDOFF_BODY_MAX_BYTES,
  HANDOFF_SECTIONS,
  HANDOFF_SUMMARY_MAX_CHARS,
  type HandoffDoc,
  HandoffOrigin,
  HandoffProvider,
  HandoffWriter,
  nextItem,
  parse,
  serialize,
  summaryLine,
  truncate,
  validate,
} from './format.js';

const ID = 'hnd_0123456789abcdef0123456789abcdef';

function doc(over: Partial<HandoffDoc> = {}): HandoffDoc {
  return {
    frontmatter: {
      pagr: 'handoff/1',
      id: ID,
      from: { provider: 'claude', sessionId: 'ses_7f2a', origin: 'pagr' },
      to: { provider: 'codex' },
      project: { id: 'prj_91c4', name: 'checkout-api' },
      git: {
        branch: 'feat/refunds',
        head: '3f9c1d0a77b4e2c5',
        wipCommit: '7a1d44f0b2e91c38',
        dirtyBefore: true,
      },
      writer: 'sender',
      previous: null,
      created: '2026-09-20T05:41:12Z',
    },
    goal: 'Make partial refunds work end to end on the checkout API.\n\nA refund may be\nsmaller than the charge.',
    done: ['Schema migration for `refunds.amount_cents`', 'Stripe client accepts a partial amount'],
    notDone: [
      { text: 'Wire the amount through `POST /refunds`', next: true },
      { text: 'Backfill the three rows with a null amount', next: false },
    ],
    decisions: [
      {
        what: 'Store cents, not decimals',
        why: 'the provider is integer-only; floats rounded 0.1',
      },
      { what: 'No idempotency key yet', why: null },
    ],
    filesTouched: ['src/refunds/route.ts — new amount branch', 'db/2026_09_20_refunds.sql — added'],
    commands: ['pnpm test --filter api', 'pnpm typecheck'],
    knownFailures: ['`refunds.partial.test.ts` fails on the null-amount rows'],
    rulesInForce: ['No new dependencies', 'Money is always cents in this repo'],
    openQuestions: ['Should a partial refund close the dispute window?'],
    extra: [],
    ...over,
  };
}

const bullets = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i} ${'x'.repeat(200)}`);

describe('handoff format — serialize', () => {
  it('writes the nine sections in the spec order, after the frontmatter', () => {
    const text = serialize(doc());
    const headings = text.split('\n').filter((l) => l.startsWith('# '));
    expect(headings).toEqual(HANDOFF_SECTIONS.map((h) => `# ${h}`));
    expect(text.startsWith('---\npagr: handoff/1\n')).toBe(true);
    expect(text).toContain('git: { branch: feat/refunds, head: 3f9c1d0a77b4e2c5,');
    expect(text).toContain('- [ ] Wire the amount through `POST /refunds` ← next');
  });

  it('is stable: the same document serializes to the same bytes every time', () => {
    expect(serialize(doc())).toBe(serialize(doc()));
  });

  it('omits `truncated` unless it is true', () => {
    expect(serialize(doc())).not.toContain('truncated');
    const t = doc();
    t.frontmatter.truncated = true;
    expect(serialize(t)).toContain('\ntruncated: true\n');
  });

  it('writes `truncatedSections` as a flow list right after `truncated`', () => {
    expect(serialize(doc())).not.toContain('truncatedSections');
    const t = doc();
    t.frontmatter.truncated = true;
    t.frontmatter.truncatedSections = ['openQuestions', 'knownFailures'];
    expect(serialize(t)).toContain(
      '\ntruncated: true\ntruncatedSections: [openQuestions, knownFailures]\n---\n',
    );
  });

  it('quotes values that would break the flow mapping', () => {
    const d = doc();
    d.frontmatter.project.name = 'checkout, api: v2';
    const text = serialize(d);
    expect(text).toContain('project: { id: prj_91c4, name: "checkout, api: v2" }');
    const back = parse(text);
    expect(back.ok && back.doc.frontmatter.project.name).toBe('checkout, api: v2');
  });
});

describe('handoff format — round trip', () => {
  const tmp = useTempHome('pagr-handoff-');

  it('serialize → parse → serialize is byte-identical', () => {
    const first = serialize(doc());
    const round = parse(first);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(serialize(round.doc)).toBe(first);
  });

  it('round-trips through a file on disk', () => {
    const file = join(tmp.home, `${ID}.md`);
    const first = serialize(doc());
    writeFileSync(file, first);
    const round = parse(readFileSync(file, 'utf8'));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(serialize(round.doc)).toBe(first);
    expect(round.doc.commands).toEqual(['pnpm test --filter api', 'pnpm typecheck']);
    expect(round.doc.decisions[0]?.why).toBe('the provider is integer-only; floats rounded 0.1');
  });

  it('survives CRLF line endings and a BOM', () => {
    const first = serialize(doc());
    const round = parse(`﻿${first.replace(/\n/g, '\r\n')}`);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(serialize(round.doc)).toBe(first);
  });

  it('a `#` comment inside the commands fence is not read as a tenth section', () => {
    const d = doc({ commands: ['# run the slow suite too', 'pnpm test'] });
    const round = parse(serialize(d));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.doc.commands).toEqual(['# run the slow suite too', 'pnpm test']);
    expect(round.doc.extra).toEqual([]);
  });

  it('missing optional sections parse as empty arrays', () => {
    const bare = [
      '---',
      'pagr: handoff/1',
      `id: ${ID}`,
      'from: { provider: claude, sessionId: ses_7f2a, origin: terminal }',
      'to: { provider: codex }',
      'project: { id: prj_91c4, name: checkout-api }',
      'git: { branch: main, head: abc123, wipCommit: null, dirtyBefore: false }',
      'writer: receiver',
      'previous: null',
      'created: 2026-09-20T05:41:12Z',
      '---',
      '',
      '# Goal',
      'Ship the thing.',
      '',
    ].join('\n');
    const r = parse(bare);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.done).toEqual([]);
    expect(r.doc.notDone).toEqual([]);
    expect(r.doc.commands).toEqual([]);
    expect(r.doc.openQuestions).toEqual([]);
    expect(r.doc.frontmatter.git.wipCommit).toBeNull();
    expect(r.doc.frontmatter.git.dirtyBefore).toBe(false);
  });
});

describe('handoff format — permissive body', () => {
  it('preserves an unknown section instead of failing, and round-trips it', () => {
    const first = serialize(
      doc({ extra: [{ heading: 'Scratch notes', lines: ['- the cache is cold on boot'] }] }),
    );
    expect(first).toContain('# Scratch notes');
    const r = parse(first);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.extra).toEqual([
      { heading: 'Scratch notes', lines: ['- the cache is cold on boot'] },
    ]);
    expect(serialize(r.doc)).toBe(first);
  });

  it('keeps unknown sections out of the nine', () => {
    const r = parse(serialize(doc({ extra: [{ heading: 'Done ish', lines: ['- nope'] }] })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.done).toEqual([
      'Schema migration for `refunds.amount_cents`',
      'Stripe client accepts a partial amount',
    ]);
  });
});

describe('handoff format — bad frontmatter', () => {
  it('reports a missing frontmatter block as a typed problem, not a throw', () => {
    const r = parse('# Goal\nDo the thing.\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('no_frontmatter');
    expect(r.problem.hint).toContain('handoff/1');
  });

  it('reports an unclosed block', () => {
    const r = parse('---\npagr: handoff/1\n\n# Goal\nDo it.\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('no_frontmatter');
  });

  it('reports a block that is not key: value', () => {
    const r = parse('---\n- pagr\n- handoff/1\n---\n\n# Goal\nDo it.\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('bad_frontmatter');
  });

  it('reports a well-formed block that is not a handoff/1 frontmatter', () => {
    const text = serialize(doc()).replace(`id: ${ID}`, 'id: nope');
    const r = parse(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('wrong_shape');
    expect(r.problem.message).toContain('id');
  });

  it('rejects a `truncatedSections` entry that is not a truncation step', () => {
    const text = serialize(doc()).replace(
      '\n---\n\n# Goal',
      '\ntruncated: true\ntruncatedSections: [openQuestions, goal]\n---\n\n# Goal',
    );
    const r = parse(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('wrong_shape');
    expect(r.problem.message).toContain('truncatedSections');
  });

  it('reports an unclosed or nested flow list as bad frontmatter', () => {
    for (const bad of ['[openQuestions, knownFailures', '[[openQuestions]]']) {
      const text = serialize(doc()).replace(
        '\n---\n\n# Goal',
        `\ntruncatedSections: ${bad}\n---\n\n# Goal`,
      );
      const r = parse(text);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problem.code).toBe('bad_frontmatter');
    }
  });

  it('never throws on arbitrary input', () => {
    for (const junk of [
      '',
      '---',
      '---\n---',
      '---\n{\n---\n',
      '---\n[\n---\n',
      'not a file at all',
    ]) {
      expect(() => parse(junk)).not.toThrow();
      expect(parse(junk).ok).toBe(false);
    }
  });
});

describe('handoff format — summaryLine', () => {
  it('is the first non-empty line under Goal, trimmed', () => {
    expect(summaryLine(doc())).toBe('Make partial refunds work end to end on the checkout API.');
  });

  it('skips leading blank lines rather than returning empty', () => {
    expect(summaryLine(doc({ goal: '\n\n   \n  The real goal.  \nmore' }))).toBe('The real goal.');
  });

  it('is empty only when Goal is empty, and that is reported by validate', () => {
    const empty = doc({ goal: '   \n\n' });
    expect(summaryLine(empty)).toBe('');
    expect(validate(empty).map((p) => p.code)).toContain('empty_goal');
  });

  it('clips to 500 characters', () => {
    const line = summaryLine(doc({ goal: 'g'.repeat(900) }));
    expect(line).toHaveLength(HANDOFF_SUMMARY_MAX_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });

  it('survives a round trip', () => {
    const r = parse(serialize(doc()));
    expect(r.ok && summaryLine(r.doc)).toBe(summaryLine(doc()));
  });
});

describe('handoff format — the next marker', () => {
  it('exposes the single marked item', () => {
    const r = parse(serialize(doc()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nextItem(r.doc)?.text).toBe('Wire the amount through `POST /refunds`');
    expect(r.doc.notDone[1]?.next).toBe(false);
    expect(r.problems).toEqual([]);
  });

  it('reports zero markers', () => {
    const none = doc({
      notDone: [
        { text: 'a', next: false },
        { text: 'b', next: false },
      ],
    });
    expect(validate(none).map((p) => p.code)).toEqual(['no_next']);
    expect(nextItem(none)).toBeNull();
    const r = parse(serialize(none));
    expect(r.ok && r.problems.map((p) => p.code)).toEqual(['no_next']);
  });

  it('reports two markers', () => {
    const two = doc({
      notDone: [
        { text: 'a', next: true },
        { text: 'b', next: true },
      ],
    });
    const problems = validate(two);
    expect(problems.map((p) => p.code)).toEqual(['multiple_next']);
    expect(problems[0]?.message).toContain('2 items');
    expect(nextItem(two)).toBeNull();
  });

  it('accepts the ascii `<- next` an agent may type', () => {
    const text = serialize(doc()).replace('← next', '<- next');
    const r = parse(text);
    expect(r.ok && nextItem(r.doc)?.text).toBe('Wire the amount through `POST /refunds`');
  });

  it('says nothing about an empty Not done list', () => {
    expect(validate(doc({ notDone: [] })).map((p) => p.code)).toEqual([]);
  });
});

describe('handoff format — truncation', () => {
  it('leaves a document that already fits alone', () => {
    const r = truncate(doc());
    expect(r.dropped).toEqual([]);
    expect(r.doc.frontmatter.truncated).toBeUndefined();
    expect(r.doc.frontmatter.truncatedSections).toBeUndefined();
  });

  it('drops Open questions first and stops as soon as it fits', () => {
    const r = truncate(doc({ openQuestions: bullets(400, 'q') }));
    expect(r.dropped).toEqual(['openQuestions']);
    expect(r.doc.openQuestions).toEqual([]);
    expect(r.doc.knownFailures).toHaveLength(1);
    expect(r.doc.frontmatter.truncated).toBe(true);
    expect(r.doc.frontmatter.truncatedSections).toEqual(['openQuestions']);
    expect(bodyBytes(r.doc)).toBeLessThanOrEqual(HANDOFF_BODY_MAX_BYTES);
  });

  it('drops Known failures second', () => {
    const r = truncate(doc({ openQuestions: bullets(400, 'q'), knownFailures: bullets(400, 'f') }));
    expect(r.dropped).toEqual(['openQuestions', 'knownFailures']);
    expect(r.doc.frontmatter.truncatedSections).toEqual(['openQuestions', 'knownFailures']);
    expect(r.doc.knownFailures).toEqual([]);
    expect(r.doc.decisions[0]?.why).not.toBeNull();
  });

  it('drops the why on each decision third, keeping the decision itself', () => {
    const r = truncate(
      doc({
        openQuestions: bullets(400, 'q'),
        knownFailures: bullets(400, 'f'),
        decisions: Array.from({ length: 400 }, (_, i) => ({
          what: `decision ${i}`,
          why: 'w'.repeat(300),
        })),
      }),
    );
    expect(r.dropped).toEqual(['openQuestions', 'knownFailures', 'decisionDetail']);
    expect(r.doc.decisions).toHaveLength(400);
    expect(r.doc.decisions.every((d) => d.why === null)).toBe(true);
    expect(r.doc.decisions[0]?.what).toBe('decision 0');
    expect(serialize(r.doc)).toContain('- decision 0\n');
  });

  it('drops Files touched last and never Goal, Done or Not done', () => {
    const big = doc({
      openQuestions: bullets(400, 'q'),
      knownFailures: bullets(400, 'f'),
      decisions: Array.from({ length: 400 }, (_, i) => ({ what: `d${i}`, why: 'w'.repeat(300) })),
      filesTouched: bullets(400, 'p'),
      done: bullets(400, 'd'),
    });
    const r = truncate(big);
    expect(r.dropped).toEqual(['openQuestions', 'knownFailures', 'decisionDetail', 'filesTouched']);
    expect(r.doc.filesTouched).toEqual([]);
    expect(r.doc.done).toEqual(big.done);
    expect(r.doc.notDone).toEqual(big.notDone);
    expect(r.doc.goal).toBe(big.goal);
    expect(r.doc.frontmatter.truncated).toBe(true);
    expect(r.doc.frontmatter.truncatedSections).toEqual(r.dropped);
  });

  it('keeps what an earlier pass dropped when a truncated document is cut again', () => {
    const once = doc({ knownFailures: bullets(400, 'f') });
    once.frontmatter.truncated = true;
    once.frontmatter.truncatedSections = ['openQuestions'];
    once.openQuestions = [];
    const r = truncate(once);
    expect(r.dropped).toEqual(['openQuestions', 'knownFailures']);
    expect(r.doc.frontmatter.truncatedSections).toEqual(['openQuestions', 'knownFailures']);
  });

  it('does not mutate the input document', () => {
    const before = doc({ openQuestions: bullets(400, 'q') });
    const snapshot = serialize(before);
    truncate(before);
    expect(serialize(before)).toBe(snapshot);
  });

  it('a truncated document still round-trips', () => {
    const { doc: t } = truncate(doc({ openQuestions: bullets(400, 'q') }));
    const first = serialize(t);
    const r = parse(first);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.frontmatter.truncated).toBe(true);
    expect(r.doc.frontmatter.truncatedSections).toEqual(['openQuestions']);
    expect(first).toContain('\ntruncatedSections: [openQuestions]\n');
    expect(serialize(r.doc)).toBe(first);
  });

  it('a file written before `truncatedSections` existed still parses and round-trips', () => {
    const old = doc();
    old.frontmatter.truncated = true;
    const first = serialize(old);
    expect(first).not.toContain('truncatedSections');
    const r = parse(first);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.frontmatter.truncated).toBe(true);
    expect(r.doc.frontmatter.truncatedSections).toBeUndefined();
    expect(serialize(r.doc)).toBe(first);
  });
});

describe('handoff format — shared vocabularies', () => {
  it('uses the protocol’s schemas for provider, origin and writer', () => {
    expect(HandoffProvider).toBe(Provider);
    expect(HandoffOrigin).toBe(SessionOrigin);
    expect(HandoffWriter).toBe(ProtocolHandoffWriter);
  });

  it('only accepts a real agent as a provider, while origin keeps `unknown`', () => {
    // A handoff to or from "unknown" is meaningless. If `Provider` ever grows a placeholder
    // member, this fails and the handoff schema has to narrow it explicitly.
    expect(HandoffProvider.options).toEqual(['claude', 'codex']);
    expect(HandoffProvider.safeParse('unknown').success).toBe(false);
    expect(HandoffOrigin.safeParse('unknown').success).toBe(true);
  });
});
