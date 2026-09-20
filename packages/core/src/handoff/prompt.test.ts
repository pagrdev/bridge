import { describe, expect, it } from 'vitest';
import { HANDOFF_SECTIONS } from './format.js';
import { HANDOFF_RULES, handoffWritePrompt } from './prompt.js';

const PATH = '/Users/x/code/checkout-api/.pagr/handoff/hnd_0123456789abcdef0123456789abcdef.md';

describe('handoffWritePrompt', () => {
  it('names the nine sections verbatim, in order', () => {
    const text = handoffWritePrompt({ path: PATH, to: 'codex' });
    const listed = text
      .split('\n')
      .filter((l) => /^ {2}# /.test(l))
      .map((l) => l.trim().slice(2));
    // The prompt lists the headings once as a block, then again with a gloss for each.
    expect(listed.slice(0, HANDOFF_SECTIONS.length)).toEqual([...HANDOFF_SECTIONS]);
    expect(listed).toHaveLength(HANDOFF_SECTIONS.length * 2);
  });

  it('states the four rules and the absolute path', () => {
    const text = handoffWritePrompt({ path: PATH, to: 'codex' });
    for (const rule of HANDOFF_RULES) expect(text).toContain(rule);
    expect(HANDOFF_RULES).toHaveLength(4);
    expect(text).toContain(PATH);
    expect(text).toContain('Write exactly one file, at this absolute path');
  });

  it('is the same prompt for both providers apart from the receiver name', () => {
    const claude = handoffWritePrompt({ path: PATH, to: 'claude' });
    const codex = handoffWritePrompt({ path: PATH, to: 'codex' });
    expect(claude.replace(/Claude Code/g, 'X')).toBe(codex.replace(/Codex/g, 'X'));
  });

  it('is deterministic', () => {
    expect(handoffWritePrompt({ path: PATH, to: 'codex', note: 'n' })).toBe(
      handoffWritePrompt({ path: PATH, to: 'codex', note: 'n' }),
    );
  });

  it('without a transcript it addresses the agent that was doing the work', () => {
    const text = handoffWritePrompt({ path: PATH, to: 'codex' });
    expect(text).toContain('Stop what you are doing and write a handoff note.');
    expect(text).not.toContain('transcript');
  });

  it('with a transcript it says to read it first and that the task is someone else’s', () => {
    const transcriptPath = '/Users/x/.claude/projects/checkout-api/ses_7f2a.jsonl';
    const text = handoffWritePrompt({ path: PATH, to: 'codex', transcriptPath });
    expect(text).toContain('You are continuing someone else’s task.');
    expect(text).toContain('Read its transcript first, in full:');
    expect(text).toContain(transcriptPath);
    expect(text.indexOf(transcriptPath)).toBeLessThan(text.indexOf(PATH));
  });

  it('carries the person’s note when there is one', () => {
    const text = handoffWritePrompt({ path: PATH, to: 'claude', note: 'only the refunds path' });
    expect(text).toContain('only the refunds path');
    expect(handoffWritePrompt({ path: PATH, to: 'claude' })).not.toContain('The person added this');
  });

  it('snapshot — sender path', () => {
    expect(handoffWritePrompt({ path: PATH, to: 'codex' })).toMatchInlineSnapshot(`
      "Stop what you are doing and write a handoff note. The work is moving to Codex,
      which has none of this conversation. Do not change any other file, and do not try to
      finish the current task first.

      Write exactly one file, at this absolute path: /Users/x/code/checkout-api/.pagr/handoff/hnd_0123456789abcdef0123456789abcdef.md

      It is read by Codex and by nobody else. Use this structure, with these nine headings,
      spelled exactly like this and in this order:

        # Goal
        # Done
        # Not done
        # Decisions and why
        # Files touched
        # Commands to run
        # Known failures
        # Rules in force
        # Open questions

      What goes in each:

        # Goal — one line saying the task as currently scoped. This line is texted to the person,
          so make it stand on its own. An optional short paragraph may follow it.
        # Done — what is actually finished and verified.
        # Not done — a checklist of what is left, as \`- [ ] item\`.
        # Decisions and why — \`- <decision> — <why, and what was rejected>\`.
        # Files touched — \`- path — what changed\`.
        # Commands to run — a fenced code block of the exact commands (tests, build, run).
        # Known failures — tests or checks that are red right now, and how they fail.
        # Rules in force — constraints, scope boundaries and conventions the receiver must keep.
        # Open questions — what you would have asked the person next.

      Leave a heading in place with nothing under it if you have nothing for it.

      Rules:

        1. Keep it short. The receiver reads this whole file before doing anything.
        2. Point at files and line ranges instead of pasting their contents.
        3. Never include secrets: no tokens, keys, passwords or \`.env\` values.
        4. Mark exactly one item under "Not done" with \` ← next\`. Not zero, not two.

      Write the file, then stop. Say nothing else.
      "
    `);
  });

  it('snapshot — receiver path, with a note', () => {
    expect(
      handoffWritePrompt({
        path: PATH,
        to: 'claude',
        note: 'keep the refund amount in cents',
        transcriptPath: '/Users/x/.pagr/tmp/hnd_0123.ndjson',
      }),
    ).toMatchInlineSnapshot(`
      "You are continuing someone else’s task. Another agent was working on this repo and
      the person has asked to move the work to you. Read its transcript first, in full:

        /Users/x/.pagr/tmp/hnd_0123.ndjson

      Do not start the work yet, and do not change any file in the repo. Your only job right now
      is to write the handoff note described below, from what that transcript shows.

      Write exactly one file, at this absolute path: /Users/x/code/checkout-api/.pagr/handoff/hnd_0123456789abcdef0123456789abcdef.md

      It is read by Claude Code and by nobody else. Use this structure, with these nine headings,
      spelled exactly like this and in this order:

        # Goal
        # Done
        # Not done
        # Decisions and why
        # Files touched
        # Commands to run
        # Known failures
        # Rules in force
        # Open questions

      What goes in each:

        # Goal — one line saying the task as currently scoped. This line is texted to the person,
          so make it stand on its own. An optional short paragraph may follow it.
        # Done — what is actually finished and verified.
        # Not done — a checklist of what is left, as \`- [ ] item\`.
        # Decisions and why — \`- <decision> — <why, and what was rejected>\`.
        # Files touched — \`- path — what changed\`.
        # Commands to run — a fenced code block of the exact commands (tests, build, run).
        # Known failures — tests or checks that are red right now, and how they fail.
        # Rules in force — constraints, scope boundaries and conventions the receiver must keep.
        # Open questions — what you would have asked the person next.

      Leave a heading in place with nothing under it if you have nothing for it.

      Rules:

        1. Keep it short. The receiver reads this whole file before doing anything.
        2. Point at files and line ranges instead of pasting their contents.
        3. Never include secrets: no tokens, keys, passwords or \`.env\` values.
        4. Mark exactly one item under "Not done" with \` ← next\`. Not zero, not two.

      The person added this when they asked for the switch; treat it as part of the goal:

        keep the refund amount in cents

      Write the file, then stop. Say nothing else.
      "
    `);
  });
});
