import { resolve } from 'node:path';
import { RulesFile, type RulesMigrateResult } from '@pagr/protocol';
import type { Logger } from '../logging.js';
import { nearestGitRoot } from '../projects.js';
import {
  proposal,
  type RulesAction,
  type RulesProposal,
  type RulesProvider,
  type RulesWarning,
  RulesWriteError,
  write,
} from './convert.js';

/**
 * `rules.migrate`: the two-step consent the rules converter is not allowed to skip.
 *
 * Spec: `docs/superpowers/specs/2026-09-20-handoff-v1-design.md` §6, ADR 0019 decision 6 —
 * *rules move only with consent, silence means no, an existing rules file is never overwritten*.
 *
 * `convert.ts` (HND-040) knows how to read the repository and what the bytes would be. It
 * deliberately does not know whether it is allowed to put them on disk. That is this module:
 *
 *   1. **Ask.** {@link migrateRules} with `consent: false` runs `detect` → `proposal` and answers
 *      with the action, the two file names and the REAL line count of the text a write would
 *      produce — the number the cloud quotes back by text ("…from CLAUDE.md (142 lines)?").
 *      Nothing is written, ever, on this step.
 *   2. **Write.** A second, separately-signed `rules.migrate` with `consent: true` arrives only
 *      after the person typed yes. The proposal is recomputed from the disk as it is *now*, and
 *      only an action of `write` writes anything.
 *
 * Two steps rather than one command with a timeout because of what "silence means no" has to mean
 * mechanically: a no and a silence are both *the absence of a second command*, so the default
 * behaviour of this module — asked once and never told anything — is to leave the repository
 * exactly as it found it. There is no path through `migrateRules` where a missing answer, a lost
 * connection or a crashed workflow results in a file appearing.
 *
 * Neither is this module the place a decision gets made. It reports; the person decides; the
 * cloud relays (ADR 0017). It composes no question text either — the line count and the file
 * names are computed here, on the Mac, and the sentence is assembled where the project's name
 * lives. The file bodies never leave.
 */

/** Everything a caller needs to ask for, or perform, one repository's rules migration. */
export interface RulesMigrateOptions {
  /**
   * A directory inside the repository — normally the registered project's root. The repository
   * root above it is what the §6 table is keyed on, and {@link rulesRepoRoot} finds it.
   */
  dir: string;
  /** The agent handing the work over. */
  from: RulesProvider;
  /** The agent picking it up: the one whose rules file may be missing. */
  to: RulesProvider;
  /**
   * `false` asks — a proposal comes back and the disk is untouched. `true` writes, and is only
   * ever sent after an explicit yes.
   */
  consent: boolean;
  /** The receiving Claude's version from the adapter probe. Unknown is treated as old. */
  claudeVersion?: string | undefined;
  /** The user's home directory, so the root walk stops there. Tests pass a temp one. */
  home?: string | undefined;
  /** Injectable clock for the generated header's date. */
  now?: (() => Date) | undefined;
  /** Where the consent and the write are recorded. */
  logger?: Logger | undefined;
}

/**
 * Why a `consent: true` step did not write, when the proposal said it would.
 *
 * Both are races against the disk rather than bugs: seconds pass between the question reaching a
 * phone and the answer coming back, and in that window the person may have written the file
 * themselves, or thrown the source away.
 */
export type RulesMigrateRefusal =
  /** The receiving agent's rules file exists now. Refused, never merged and never overwritten. */
  | 'target_exists'
  /** The source is gone, so there is nothing to convert any more. */
  | 'nothing_to_write';

/**
 * The full local answer. {@link toRulesMigrateResult} narrows it to the four fields the protocol
 * puts on the wire — `repo`, the warnings and the notes are for this Mac's logs and for the
 * handoff's rules-in-force section, not for the cloud.
 */
export interface RulesMigrateOutcome {
  /** §6's action. With `consent: false`, `write` means *would write*. */
  action: RulesAction;
  /** Absolute repository root the decision was made about. Local only. */
  repo: string;
  /** Repo-relative source, when one is involved. */
  sourceFile?: string;
  /** Repo-relative file a write would create, or did. */
  targetFile?: string;
  /** Lines of the converted text — the number the consent question quotes. */
  lineCount?: number;
  /** Whether bytes actually reached the disk. False on every `consent: false` call. */
  written: boolean;
  /** The consent this call was made with, echoed so a log line is self-explaining. */
  consent: boolean;
  /** Why an action is `skipped`, or why a consented write did not happen. */
  reason?: string;
  /** Set when consent was given and the write was refused anyway. */
  refusal?: RulesMigrateRefusal;
  /** What the conversion would not inline — imports left as text, personal rules dropped. */
  warnings: RulesWarning[];
  /** Advisory local facts, most importantly an ancestor `CLAUDE.md`. */
  notes: string[];
}

/**
 * The repository root `dir` belongs to, or `dir` itself when it is not in a work tree.
 *
 * `nearestGitRoot` walks with `existsSync` — no git subprocess, so asking about rules cannot fail
 * because git is missing or its licence is unaccepted. A folder somebody registered that is not a
 * repository at all still gets its rules migrated, in the folder itself: the person pointed at it.
 */
export function rulesRepoRoot(dir: string, home?: string | undefined): string {
  return nearestGitRoot(dir, home === undefined ? {} : { home }) ?? resolve(dir);
}

/** The protocol's three known rules files, or `undefined` for anything else. */
function asRulesFile(name: string | undefined): RulesFile | undefined {
  if (name === undefined) return undefined;
  const parsed = RulesFile.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The four fields `rules.migrate` acks with.
 *
 * Narrowing here rather than at the call site is the point: the outcome carries an absolute path
 * and the converter's warnings, and neither is allowed on the wire. A file name the protocol does
 * not know is dropped rather than sent, so a future converter target cannot widen what the cloud
 * learns by accident.
 */
export function toRulesMigrateResult(outcome: RulesMigrateOutcome): RulesMigrateResult {
  const sourceFile = asRulesFile(outcome.sourceFile);
  const targetFile = asRulesFile(outcome.targetFile);
  return {
    action: outcome.action,
    ...(sourceFile ? { sourceFile } : {}),
    ...(targetFile ? { targetFile } : {}),
    ...(outcome.lineCount === undefined ? {} : { lineCount: outcome.lineCount }),
  };
}

const outcomeOf = (
  p: RulesProposal,
  o: { repo: string; consent: boolean; written: boolean },
): RulesMigrateOutcome => ({
  action: p.action,
  repo: o.repo,
  ...(p.sourceFile === undefined ? {} : { sourceFile: p.sourceFile }),
  ...(p.targetFile === undefined ? {} : { targetFile: p.targetFile }),
  ...(p.lineCount === undefined ? {} : { lineCount: p.lineCount }),
  written: o.written,
  consent: o.consent,
  ...(p.reason === undefined ? {} : { reason: p.reason }),
  warnings: p.warnings ?? [],
  notes: p.notes ?? [],
});

/**
 * Decide, and — only with consent — perform, one repository's rules migration.
 *
 * This is the whole of `rules.migrate`, and the function HND-013's handoff dispatcher calls
 * directly: the command surface is a signature check and a project id in front of this call, so a
 * switch driven from the phone and one driven from `pagr handoff` cannot diverge on what they
 * write into somebody's repository.
 *
 * With `consent: true` the proposal is recomputed rather than trusted from the first step. The
 * gap between the two commands is a person reading a text message, and the disk may have moved
 * under us in it: the file may now exist (`already_present`, refused), the source may be gone
 * (`none`), or a newer Claude may now read `AGENTS.md` itself (`native_read`). Only an action of
 * `write`, computed from the disk as it is at this instant, writes anything.
 *
 * It throws for nothing an answer can describe. A refused write is an outcome with a reason, not
 * an exception, because the person on the other end is owed a sentence rather than a stack trace.
 */
export function migrateRules(opts: RulesMigrateOptions): RulesMigrateOutcome {
  const repo = rulesRepoRoot(opts.dir, opts.home);
  const log = opts.logger;
  const p = proposal({
    repo,
    from: opts.from,
    to: opts.to,
    claudeVersion: opts.claudeVersion,
    now: opts.now,
  });

  if (!opts.consent) {
    log?.info('rules migration proposed', {
      from: opts.from,
      to: opts.to,
      action: p.action,
      ...(p.sourceFile ? { sourceFile: p.sourceFile } : {}),
      ...(p.targetFile ? { targetFile: p.targetFile } : {}),
      ...(p.lineCount === undefined ? {} : { lineCount: p.lineCount }),
    });
    return outcomeOf(p, { repo, consent: false, written: false });
  }

  // Consent for a proposal that is no longer the right move is not consent to do something else.
  if (p.action !== 'write') {
    log?.info('rules migration was consented to but is no longer needed', {
      from: opts.from,
      to: opts.to,
      action: p.action,
    });
    return outcomeOf(p, { repo, consent: true, written: false });
  }

  try {
    const res = write({ repo, from: opts.from, to: opts.to, now: opts.now });
    log?.info('rules migrated', {
      from: opts.from,
      to: opts.to,
      sourceFile: res.sourceFile,
      targetFile: res.targetFile,
      lineCount: res.lineCount,
      warnings: res.warnings.length,
    });
    return {
      action: 'write',
      repo,
      sourceFile: res.sourceFile,
      targetFile: res.targetFile,
      lineCount: res.lineCount,
      written: true,
      consent: true,
      warnings: res.warnings,
      notes: p.notes ?? [],
    };
  } catch (err) {
    if (!(err instanceof RulesWriteError)) throw err;
    // The disk moved between the question and the answer. Say what is true now; touch nothing.
    const action: RulesAction = err.code === 'target_exists' ? 'already_present' : 'none';
    log?.warn('rules migration refused at the write', {
      from: opts.from,
      to: opts.to,
      code: err.code,
      ...(p.targetFile ? { targetFile: p.targetFile } : {}),
    });
    return {
      action,
      repo,
      ...(p.sourceFile === undefined ? {} : { sourceFile: p.sourceFile }),
      ...(action === 'already_present' && p.targetFile !== undefined
        ? { targetFile: p.targetFile }
        : {}),
      written: false,
      consent: true,
      reason: err.message,
      refusal: err.code,
      warnings: [],
      notes: p.notes ?? [],
    };
  }
}
