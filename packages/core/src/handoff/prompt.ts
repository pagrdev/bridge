import { HANDOFF_DIR, HANDOFF_SECTIONS, type HandoffProvider } from './format.js';

/**
 * The one instruction that asks an agent to write a handoff file.
 *
 * Both writer paths (spec §3) use this exact text: the sending agent, steered mid-session, and
 * the receiving agent, spawned headless over the sender's transcript. It is deliberately NOT
 * forked per provider — the moment Claude's copy and Codex's copy drift, the two agents write
 * files with different sections and `format.ts` starts guessing. The only difference between
 * the two paths is whether `transcriptPath` is set.
 */

export interface HandoffWritePromptInput {
  /** Absolute path the agent must write, `<repo>/.pagr/handoff/<id>.md`. */
  path: string;
  /** The agent that will pick the work up. */
  to: HandoffProvider;
  /** What the person said when they asked for the switch, if anything. */
  note?: string | undefined;
  /**
   * Absolute path to the sending session's transcript. Present only on the receiver-writes path,
   * where the writing agent was not in the conversation and has to read it first.
   */
  transcriptPath?: string | undefined;
}

/** The four rules from spec §2, in the order they are stated there. */
export const HANDOFF_RULES = [
  'Keep it short. The receiver reads this whole file before doing anything.',
  'Point at files and line ranges instead of pasting their contents.',
  'Never include secrets: no tokens, keys, passwords or `.env` values.',
  'Mark exactly one item under "Not done" with ` ← next`. Not zero, not two.',
] as const;

const PROVIDER_NAME: Record<HandoffProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * Build the instruction. Pure and deterministic — the same input always produces the same text,
 * so the prompt is snapshot-testable and a capture can be replayed.
 */
export function handoffWritePrompt(input: HandoffWritePromptInput): string {
  const receiver = PROVIDER_NAME[input.to];
  const lines: string[] = [];

  if (input.transcriptPath) {
    lines.push(
      'You are continuing someone else’s task. Another agent was working on this repo and',
      'the person has asked to move the work to you. Read its transcript first, in full:',
      '',
      `  ${input.transcriptPath}`,
      '',
      'Do not start the work yet, and do not change any file in the repo. Your only job right now',
      'is to write the handoff note described below, from what that transcript shows.',
    );
  } else {
    lines.push(
      `Stop what you are doing and write a handoff note. The work is moving to ${receiver},`,
      'which has none of this conversation. Do not change any other file, and do not try to',
      'finish the current task first.',
    );
  }

  lines.push(
    '',
    `Write exactly one file, at this absolute path: ${input.path}`,
    '',
    `It is read by ${receiver} and by nobody else. Use this structure, with these nine headings,`,
    'spelled exactly like this and in this order:',
    '',
    ...HANDOFF_SECTIONS.map((heading) => `  # ${heading}`),
    '',
    'What goes in each:',
    '',
    '  # Goal — one line saying the task as currently scoped. This line is texted to the person,',
    '    so make it stand on its own. An optional short paragraph may follow it.',
    '  # Done — what is actually finished and verified.',
    '  # Not done — a checklist of what is left, as `- [ ] item`.',
    '  # Decisions and why — `- <decision> — <why, and what was rejected>`.',
    '  # Files touched — `- path — what changed`.',
    '  # Commands to run — a fenced code block of the exact commands (tests, build, run).',
    '  # Known failures — tests or checks that are red right now, and how they fail.',
    '  # Rules in force — constraints, scope boundaries and conventions the receiver must keep.',
    '  # Open questions — what you would have asked the person next.',
    '',
    'Leave a heading in place with nothing under it if you have nothing for it.',
    '',
    'Rules:',
    '',
    ...HANDOFF_RULES.map((rule, i) => `  ${i + 1}. ${rule}`),
  );

  if (input.note) {
    lines.push(
      '',
      'The person added this when they asked for the switch; treat it as part of the goal:',
      '',
      `  ${input.note}`,
    );
  }

  lines.push('', 'Write the file, then stop. Say nothing else.');
  return `${lines.join('\n')}\n`;
}

/**
 * The one instruction a receiving agent is started with, on every front door.
 *
 * Repo-relative on purpose, exactly like `reviewApplyInstruction`: the agent's cwd is the
 * repository, and a path is the whole of what Pagr passes along. Nothing of the handoff is
 * summarised, quoted or re-explained here — the file says it all, and an instruction that
 * paraphrased it would be a second, worse copy that drifts from the one on disk.
 *
 * It is also the line `pagr handoff --no-start` prints for a person to paste into an agent Pagr
 * has no adapter for, which is why it reads as something a human can hand over verbatim.
 */
export const handoffStartInstruction = (handoffId: string): string =>
  `Read ${HANDOFF_DIR}/${handoffId}.md and continue the task it describes.`;
