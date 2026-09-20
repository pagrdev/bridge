import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecFileLike } from '../git.js';
import { useTempHome } from '../testUtil.js';
import { countLines } from '../text.js';
import {
  buildReviewPacket,
  DEFAULT_REVIEW_MAX_FILE_LINES,
  intentLine,
  isPagrPath,
  REVIEW_MAX_FILE_LINES_ENV,
  REVIEW_MAX_PACKET_BYTES_ENV,
  ReviewPacketError,
  stripPagrFromDiff,
} from './packet.js';

const REVIEW_ID = `rev_${'a'.repeat(32)}`;
const RANGE = 'HEAD~2..HEAD';

interface FakeRepo {
  log?: string[];
  stat?: string;
  patch?: string;
  names?: string[];
}

/**
 * git, faked at the process boundary.
 *
 * `git.ts` owns the only real git subprocess in the tree and its grep test fails the build if
 * any other file spawns one — including this one. So the fixtures inject a runner through the
 * module's own `execFile` seam instead, which also makes every assertion here deterministic:
 * the packet is a pure function of what git said and what is on disk.
 */
function fakeGit(root: string, o: FakeRepo): ExecFileLike {
  return (_file, args, _options, cb) => {
    const a = [...args];
    const done = (stdout: string): undefined => {
      queueMicrotask(() => cb(null, stdout, ''));
      return undefined;
    };
    if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') return done(`${root}\n`);
    if (a[0] === 'rev-parse' && a[1] === '--absolute-git-dir')
      return done(`${join(root, '.git')}\n`);
    if (a[0] === 'log') return done((o.log ?? []).map((l) => `${l}\n`).join(''));
    if (a[0] === 'diff' && a[1] === '--stat') return done(o.stat ?? '');
    if (a[0] === 'diff' && a[1] === '--name-only')
      return done((o.names ?? []).map((n) => `${n}\0`).join(''));
    if (a[0] === 'diff') return done(o.patch ?? '');
    const err = Object.assign(new Error(`unexpected git call: ${a.join(' ')}`), {
      code: 1,
      stderr: 'unexpected',
    });
    queueMicrotask(() => cb(err, '', 'unexpected'));
    return undefined;
  };
}

function write(root: string, rel: string, body: string | Buffer): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const lines = (n: number, prefix = 'line'): string =>
  `${Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')}\n`;

const build = (
  root: string,
  fake: FakeRepo,
  o: { intent?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  buildReviewPacket({
    repo: root,
    range: RANGE,
    intent: o.intent ?? 'add a retry to the webhook sender',
    reviewId: REVIEW_ID,
    env: o.env ?? {},
    git: { execFile: fakeGit(root, fake) },
  });

describe('buildReviewPacket', () => {
  const t = useTempHome('pagr-packet-');

  it('writes packet.md under .pagr/review/<id>/ and returns exactly what it wrote', async () => {
    const root = t.home;
    write(root, 'src/send.ts', 'export const send = () => 1;\n');
    const packet = await build(root, {
      log: ['abc1234 feat: retry the webhook', 'def5678 test: cover the retry'],
      stat: ' src/send.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
      patch: 'diff --git a/src/send.ts b/src/send.ts\n@@ -1 +1 @@\n-old\n+new\n',
      names: ['src/send.ts'],
    });

    expect(packet.packetPath).toBe(join(root, '.pagr/review', REVIEW_ID, 'packet.md'));
    expect(packet.reviewPath).toBe(join(root, '.pagr/review', REVIEW_ID, 'review.md'));
    expect(readFileSync(packet.packetPath, 'utf8')).toBe(packet.content);
    expect(packet.truncated).toBe(false);
    expect(packet.commits).toHaveLength(2);
    expect(packet.files).toEqual([{ path: 'src/send.ts', included: true, lines: 1, bytes: 29 }]);
  });

  it('orders the sections: intent, commits, diffstat, diff, then file contents', async () => {
    const root = t.home;
    write(root, 'src/send.ts', 'export const send = () => 1;\n');
    const { content } = await build(root, {
      log: ['abc1234 feat: retry the webhook'],
      stat: ' src/send.ts | 2 +-\n',
      patch: 'diff --git a/src/send.ts b/src/send.ts\n@@ -1 +1 @@\n-old\n+new\n',
      names: ['src/send.ts'],
    });
    const at = (h: string) => content.indexOf(h);
    expect(at('## Intent')).toBeGreaterThan(-1);
    expect(at('## Intent')).toBeLessThan(at('## Commits'));
    expect(at('## Commits')).toBeLessThan(at('## Diffstat'));
    expect(at('## Diffstat')).toBeLessThan(at('## Diff\n'));
    expect(at('## Diff\n')).toBeLessThan(at('## Changed files'));
    expect(content).toContain('> add a retry to the webhook sender');
    expect(content).toContain('abc1234 feat: retry the webhook');
    expect(content).toContain('export const send = () => 1;');
  });

  it('excludes .pagr/ from git before it writes anything into it', async () => {
    const root = t.home;
    await build(root, { names: [] });
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8')).toContain('.pagr/');
  });

  it('refuses a review id that is not a rev_ id, so it can never be a path', async () => {
    const root = t.home;
    for (const bad of ['../../etc', 'rev_nothex', '', `hnd_${'a'.repeat(32)}`]) {
      const err = await buildReviewPacket({
        repo: root,
        range: RANGE,
        intent: 'x',
        reviewId: bad,
        env: {},
        git: { execFile: fakeGit(root, {}) },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewPacketError);
      expect(err.code).toBe('bad_review_id');
    }
  });

  it('refuses an empty intent', async () => {
    const err = await build(t.home, { names: [] }, { intent: '   \n  ' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewPacketError);
    expect(err.code).toBe('bad_intent');
  });
});

describe('buildReviewPacket · the 600-line rule', () => {
  const t = useTempHome('pagr-packet-lines-');

  it('includes a file of exactly the limit and names the one a line over it', async () => {
    const root = t.home;
    write(root, 'src/exact.ts', lines(DEFAULT_REVIEW_MAX_FILE_LINES, 'exact'));
    write(root, 'src/over.ts', lines(DEFAULT_REVIEW_MAX_FILE_LINES + 1, 'over'));
    write(root, 'src/under.ts', lines(DEFAULT_REVIEW_MAX_FILE_LINES - 1, 'under'));
    const packet = await build(root, {
      names: ['src/exact.ts', 'src/over.ts', 'src/under.ts'],
    });

    const byPath = Object.fromEntries(packet.files.map((f) => [f.path, f]));
    expect(byPath['src/exact.ts']).toMatchObject({ included: true, lines: 600 });
    expect(byPath['src/under.ts']).toMatchObject({ included: true, lines: 599 });
    expect(byPath['src/over.ts']).toMatchObject({
      included: false,
      lines: 601,
      skipped: 'too_long',
    });

    expect(packet.content).toContain('exact 600');
    expect(packet.content).toContain('under 599');
    expect(packet.content).not.toContain('over 601');
    // Named, with its size, so the reviewer knows what it was not shown.
    expect(packet.content).toContain('- `src/over.ts` — 601 lines — over the 600-line limit');
  });

  it('honours PAGR_REVIEW_MAX_FILE_LINES', async () => {
    const root = t.home;
    write(root, 'src/three.ts', lines(3, 'three'));
    const packet = await build(
      root,
      { names: ['src/three.ts'] },
      { env: { [REVIEW_MAX_FILE_LINES_ENV]: '2' } },
    );
    expect(packet.maxFileLines).toBe(2);
    expect(packet.files[0]).toMatchObject({ included: false, skipped: 'too_long', lines: 3 });
    expect(packet.content).not.toContain('three 1');
  });
});

describe('buildReviewPacket · files it names but cannot inline', () => {
  const t = useTempHome('pagr-packet-skip-');

  it('names binary and deleted files without inlining them', async () => {
    const root = t.home;
    write(root, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    write(root, 'src/kept.ts', 'export const kept = true;\n');
    const packet = await build(root, {
      // `src/gone.ts` is named by the range but no longer on disk: deleted.
      names: ['assets/logo.png', 'src/gone.ts', 'src/kept.ts'],
      patch: 'diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n',
    });

    const byPath = Object.fromEntries(packet.files.map((f) => [f.path, f]));
    expect(byPath['assets/logo.png']).toMatchObject({ included: false, skipped: 'binary' });
    expect(byPath['src/gone.ts']).toMatchObject({ included: false, skipped: 'deleted' });
    expect(byPath['src/kept.ts']).toMatchObject({ included: true });

    expect(packet.content).toContain('- `assets/logo.png` — binary');
    expect(packet.content).toContain('- `src/gone.ts` — deleted by this range');
    // The PNG header bytes never reach the packet.
    expect(packet.content).not.toContain('PNG');
    expect(packet.content).not.toContain(' ');
    expect(packet.content).toContain('export const kept = true;');
  });

  it('fences a file that itself contains a fence', async () => {
    const root = t.home;
    write(root, 'README.md', 'see:\n```ts\nconst a = 1;\n```\n');
    const packet = await build(root, { names: ['README.md'] });
    expect(packet.files[0]).toMatchObject({ included: true });
    expect(packet.content).toContain('````markdown\nsee:\n```ts');
  });
});

// ---------------------------------------------------------------------------
// The rule the whole feature exists for.
// ---------------------------------------------------------------------------

/**
 * Text that means "someone pasted the author's session in here".
 *
 * A reviewer that reads the builder's transcript, handoff note or justification inherits the
 * builder's confidence and starts approving what it should block. These patterns are the shapes
 * that leak takes: the handoff file's own headings, Pagr's working paths, session and handoff
 * ids, JSONL transcript records, and the markers planted in the fixture below.
 */
const SESSION_TEXT = [
  /PLANTED_[A-Z_]+/,
  /"role"\s*:\s*"(?:user|assistant)"/,
  /^#+ Not done/m,
  /^#+ Decisions and why/m,
  /^#+ Open questions/m,
  /\.pagr\/handoff/,
  /\.pagr\/transcripts/,
  /\bses_[0-9a-f]{32}\b/,
  /\bhnd_[0-9a-f]{32}\b/,
  /I'm confident this is safe/i,
];

describe('buildReviewPacket · never leaks the session', () => {
  const t = useTempHome('pagr-packet-leak-');

  it('contains no transcript, handoff or author reasoning, even when they are in the range', async () => {
    const root = t.home;
    const handoffId = `hnd_${'b'.repeat(32)}`;
    const sessionId = `ses_${'c'.repeat(32)}`;

    // Everything Pagr keeps next to the work, present on disk and named by the range.
    write(
      root,
      `.pagr/handoff/${handoffId}.md`,
      [
        '# Goal',
        'PLANTED_HANDOFF_GOAL ship the retry',
        '# Not done',
        '- [ ] PLANTED_HANDOFF_TODO wire the dead-letter queue ← next',
        '# Decisions and why',
        '- skipped the lock — PLANTED_HANDOFF_REASON it cannot race in practice',
        '# Open questions',
        'PLANTED_HANDOFF_QUESTION should the retry be capped?',
        '',
      ].join('\n'),
    );
    write(
      root,
      `.pagr/transcripts/${sessionId}.jsonl`,
      `{"role":"assistant","text":"PLANTED_TRANSCRIPT_LINE I'm confident this is safe because nothing else calls it"}\n`,
    );
    write(
      root,
      `.pagr/review/${`rev_${'d'.repeat(32)}`}/review.md`,
      'verdict: approve — PLANTED_OLD_REVIEW\n',
    );
    write(root, 'src/send.ts', 'export const send = () => 1;\n');

    const packet = await build(
      root,
      {
        log: ['abc1234 feat: retry the webhook'],
        stat: ` .pagr/handoff/${handoffId}.md | 9 +++++++++\n src/send.ts | 2 +-\n`,
        // A repository that committed `.pagr/` before Pagr excluded it: the handoff is in the patch.
        patch: [
          `diff --git a/.pagr/handoff/${handoffId}.md b/.pagr/handoff/${handoffId}.md`,
          '--- /dev/null',
          `+++ b/.pagr/handoff/${handoffId}.md`,
          '@@ -0,0 +1,2 @@',
          '+# Decisions and why',
          '+PLANTED_HANDOFF_REASON it cannot race in practice',
          'diff --git a/src/send.ts b/src/send.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
        names: [`.pagr/handoff/${handoffId}.md`, 'src/send.ts'],
      },
      {
        // The caller hands over the builder's whole reasoning. Only the first line survives.
        intent: [
          'add a retry to the webhook sender',
          '',
          "PLANTED_INTENT_REASONING I'm confident this is safe because nothing else calls it,",
          'and I already checked the lock by hand.',
        ].join('\n'),
      },
    );

    const written = readFileSync(packet.packetPath, 'utf8');
    for (const pattern of SESSION_TEXT) expect(written).not.toMatch(pattern);
    expect(written).not.toContain('PLANTED_');

    // The change itself is still all there.
    expect(written).toContain('add a retry to the webhook sender');
    expect(written).toContain('export const send = () => 1;');
    expect(written).toContain('+new');
    // And the reviewer is told the path exists rather than being shown it.
    expect(packet.files.some((f) => f.skipped === 'pagr_internal')).toBe(true);
    expect(written).toContain('never part of a review');
  });

  it('keeps only the first line of a multi-line intent, capped', async () => {
    expect(intentLine('one line\nsecond line\nthird')).toBe('one line');
    expect(intentLine('  padded   out  ')).toBe('padded out');
    expect(intentLine(`${'x'.repeat(600)}`)).toHaveLength(500);
    expect(intentLine('short', 4)).toBe('sho…');
  });

  it('drops every .pagr block from a unified diff and leaves the rest byte-identical', () => {
    const keep = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b';
    const drop =
      'diff --git a/.pagr/handoff/x.md b/.pagr/handoff/x.md\n@@ -1 +1 @@\n-secret\n+secret2';
    const out = stripPagrFromDiff(`${drop}\n${keep}\n`);
    expect(out.patch.trim()).toBe(keep);
    expect(out.dropped).toEqual(['.pagr/handoff/x.md']);
    expect(stripPagrFromDiff(`${keep}\n`).dropped).toEqual([]);
  });
});

describe('buildReviewPacket · the size ceiling', () => {
  const t = useTempHome('pagr-packet-size-');

  it('cuts the diff, drops the files that do not fit, and says so in the packet', async () => {
    const root = t.home;
    const huge = `diff --git a/src/huge.ts b/src/huge.ts\n${lines(4000, '+added')}`;
    write(root, 'src/huge.ts', lines(400, 'body'));
    write(root, 'src/also.ts', lines(400, 'also'));
    const packet = await build(
      root,
      { names: ['src/huge.ts', 'src/also.ts'], patch: huge },
      { env: { [REVIEW_MAX_PACKET_BYTES_ENV]: '8192' } },
    );

    expect(packet.maxBytes).toBe(8192);
    expect(packet.truncated).toBe(true);
    expect(packet.bytes).toBeLessThan(16_000);
    expect(packet.content).toContain('**This packet is truncated.**');
    expect(packet.content).toContain('the diff below is cut short');
    expect(packet.content).toContain('You are reading part of the change, not all of it.');
    // The notice is above everything a reviewer could start reading from.
    expect(packet.content.indexOf('truncated')).toBeLessThan(packet.content.indexOf('## Diff'));
    // The tail of the diff really is gone, rather than quietly included.
    expect(packet.content).not.toContain('+added 4000');
    expect(packet.files.filter((f) => f.skipped === 'budget').length).toBeGreaterThan(0);
    expect(packet.content).toContain('dropped: the packet hit its size ceiling');
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    const root = t.home;
    write(root, 'src/a.ts', 'const a = 1;\n');
    const packet = await build(root, { names: ['src/a.ts'], patch: 'diff --git a/x b/x\n+a\n' });
    expect(packet.truncated).toBe(false);
    expect(packet.content).not.toContain('truncated');
  });
});

describe('packet helpers', () => {
  it('counts lines without inventing one for the trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('\n')).toBe(1);
  });

  it('recognises Pagr paths and nothing else', () => {
    expect(isPagrPath('.pagr')).toBe(true);
    expect(isPagrPath('.pagr/handoff/x.md')).toBe(true);
    expect(isPagrPath('./.pagr/review/y/packet.md')).toBe(true);
    expect(isPagrPath('src/.pagrenv')).toBe(false);
    expect(isPagrPath('pagr/thing.ts')).toBe(false);
  });
});
