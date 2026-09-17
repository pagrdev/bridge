import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The public documents, checked against the code they describe.
 *
 * This repository exists so people can read what software on their computer can be asked to do,
 * which makes a stale sentence here a different kind of bug from a stale comment. Eleven pull
 * requests changed what the bridge sends; these are the specific claims that stopped being true
 * along the way, each pinned so it cannot come back.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const DOCS = ['docs/PROTOCOL.md', 'docs/SECURITY.md', 'docs/PRIVACY.md', 'docs/TROUBLESHOOTING.md'];
const ALL = [...DOCS, 'README.md'];

/**
 * Phrases that were true of a v1 bridge and are not true of this one.
 *
 * `nine` is the count the command table used to carry; there are fifteen commands now and the
 * document says so without fixing a number in prose that nothing updates. The transcript claims
 * are the important ones: full transcripts DO leave this Mac now — sealed — and a document that
 * still says they do not is worse than one that says nothing.
 */
const FORBIDDEN = [
  {
    pattern: /\bnine\b/i,
    why: 'the command surface is not nine rows any more — count it and say so',
  },
  {
    pattern: /summary only/i,
    why: 'v2 sends the transcript itself, sealed; "summary only" is a v1 claim',
  },
  {
    pattern: /never full transcripts/i,
    why: 'full transcripts leave this Mac sealed; say what the cloud can see instead',
  },
  {
    pattern: /cannot name a directory/i,
    why: 'repo.scan + project.register_handle exist; the true claim is that it cannot CHOOSE one',
  },
];

describe('public docs · claims that stopped being true', () => {
  for (const file of ALL) {
    const text = read(file);
    for (const { pattern, why } of FORBIDDEN) {
      it(`${file} does not say /${pattern.source}/`, () => {
        const line = text.split('\n').findIndex((l) => pattern.test(l));
        expect(line === -1 ? null : `${file}:${line + 1} — ${why}`).toBeNull();
      });
    }
  }
});

describe('public docs · what v2 must actually document', () => {
  it('PROTOCOL.md has the negotiation table, the capability gating and the hello field table', () => {
    const p = read('docs/PROTOCOL.md');
    expect(p).toContain('### Version negotiation');
    expect(p).toContain('### Capability gating');
    expect(p).toContain('### `device.hello`, field by field');
    expect(p).toContain('### Control levels');
    expect(p).toContain('### Delivery states');
    // Every capability name the bridge can advertise is described, so a cloud implementer never
    // has to read `dispatcher.ts` to find out what one gates.
    for (const cap of [
      'frames.v1',
      'seal.v1',
      'questions.v1',
      'approval_options.v1',
      'backfill.v1',
      'repo_scan.v1',
      'keep_awake.v1',
      'channel.v1',
    ])
      expect(p).toContain(cap);
  });

  it('PROTOCOL.md points at the security document for the sealing boundary', () => {
    expect(read('docs/PROTOCOL.md')).toContain('What changed for the iPhone app');
  });

  it('SECURITY.md consolidates the phone-app changes in one section', () => {
    const sec = read('docs/SECURITY.md');
    expect(sec).toContain('## What changed for the iPhone app');
    // The boundary, both directions, and the trust limit stated rather than implied.
    expect(sec).toMatch(/phone → Mac direction is plaintext/i);
    expect(sec).toMatch(/signing key belongs to the Pagr API/i);
    expect(sec).toMatch(/fifteen commands/i);
  });

  it('SECURITY.md lists every command the schema defines', () => {
    // Read from the schema rather than from a list kept here, so a command added tomorrow fails
    // this test until somebody writes the row that tells people it exists.
    const sec = read('docs/SECURITY.md');
    const schema = read('packages/protocol/src/schemas.ts');
    const start = schema.indexOf('export const CommandPayloads');
    const end = schema.indexOf('export const CommandType', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const names = [
      ...new Set(
        [...schema.slice(start, end).matchAll(/^ {2}'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]),
      ),
    ];
    expect(names.length).toBe(15);
    for (const name of names) expect(sec).toContain(`\`${name}\``);
  });

  it('PRIVACY.md describes the whole `~/.pagr` inventory, not just the v1 half', () => {
    const priv = read('docs/PRIVACY.md');
    for (const path of [
      'journal/',
      'tailer-state.json',
      'replay.json',
      'run/',
      'hooks/',
      'bin/pagr-node',
      'recipientKeys',
    ])
      expect(priv).toContain(path);
  });

  it('PRIVACY.md names every process the daemon may run', () => {
    const priv = read('docs/PRIVACY.md');
    expect(priv).toContain('### Processes the daemon may run');
    expect(priv).toContain('caffeinate');
    expect(priv).toContain('codex app-server');
    expect(priv).toContain('channel-server.mjs');
  });

  it('TROUBLESHOOTING.md indexes the entries v2 added', () => {
    const tr = read('docs/TROUBLESHOOTING.md');
    expect(tr).toContain('### Where the phone-app entries are');
    expect(tr).toContain('2.1.251');
    expect(tr).toContain('Codex daemon not running');
    expect(tr).toContain('Older history missing on a new phone');
    expect(tr).toContain('Mac keeps sleeping while Pagr works');
  });

  it('the Claude Code version floor in the docs is the one the CLI enforces', () => {
    const floor = /CLAUDE_VERSION_FLOOR = '([\d.]+)'/.exec(
      read('apps/cli/src/commands/claudeChannel.ts'),
    )?.[1];
    expect(floor).toBeTruthy();
    expect(read('docs/TROUBLESHOOTING.md')).toContain(floor);
  });

  it('README says what the phone sees and what the cloud sees', () => {
    const readme = read('README.md');
    expect(readme).toContain('## What your phone sees, and what our cloud sees');
    expect(readme).toContain('pagr connect');
    expect(readme).toContain('pagr claude');
  });
});

describe('public docs · the repository is where it says it is', () => {
  it('every doc named in the README exists', () => {
    for (const rel of DOCS)
      expect(() => readFileSync(new URL(rel, `file://${root}`))).not.toThrow();
  });
});
