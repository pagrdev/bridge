import { GitRange } from '@pagr/protocol';
import {
  GitError,
  type GitOptions,
  branch as gitBranch,
  head,
  logOneline,
  repoRoot,
  statusPorcelain,
} from '../git.js';

/**
 * Which commits a review is about, when nobody said (spec §5, HND-034).
 *
 * The cloud always knows: `review.start` carries `<base>..HEAD`, where base is the builder
 * session's start commit. A person typing `pagr review --with codex` in a terminal has said no
 * such thing, and the command cannot simply guess — a reviewer pointed at the wrong commits is
 * worse than no reviewer, because it answers `approve` about code it never read and the person
 * has no way to tell that from a real approval.
 *
 * So this resolves a range from the repository's own state, and reports **why** it chose it, so
 * the CLI can print that sentence before a ten-minute agent starts rather than after:
 *
 *   - **The tree is dirty** → `HEAD~1..HEAD`, meaning *the work you have not committed*. That
 *     reads wrong until you remember that `review.start` WIP-commits a dirty tree before it
 *     builds the packet (`prepareReview`), so by the time the range is evaluated HEAD **is** the
 *     commit holding that work and `HEAD~1` is where it started. The range is lazy on purpose:
 *     resolving it to shas here would name the commit before the commit exists.
 *   - **The tree is clean** → `HEAD~1..HEAD`, the last commit, and the commit's own subject
 *     line comes back so the CLI can say which one out loud.
 *   - **`--range` was given** → used as written, after one normalisation (a bare ref becomes
 *     `<ref>..HEAD`, which is what `--range HEAD~3` plainly means) and one check: git is asked
 *     to list it, so a typo is a usage error in a second rather than a packet failure minutes in.
 *
 * Every git call goes through `../git.ts`, the one module allowed to spawn git.
 */

/** Why the resolved range is the one it is. `explicit` means the person said so. */
export type ReviewRangeBasis =
  /** `--range`, normalised and checked but otherwise theirs. */
  | 'explicit'
  /** The work tree was dirty: the range names the WIP commit `review.start` is about to make. */
  | 'uncommitted'
  /** The tree was clean: the range names the commit at HEAD. */
  | 'last_commit';

/** Why a range could not be chosen. Each one is a sentence a person can act on. */
export type ReviewRangeFailure =
  /** The project directory is not inside a git work tree. */
  | 'not_a_repo'
  /** The repository has no commits at all, so there is nothing to compare anything against. */
  | 'no_commits'
  /** One commit, and it is the first: `HEAD~1` does not exist and only the person can say what to read. */
  | 'root_commit'
  /** `--range` is not a range, or not one this repository understands. */
  | 'bad_range';

export class ReviewRangeError extends Error {
  constructor(
    readonly reason: ReviewRangeFailure,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ReviewRangeError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface ResolveReviewRangeInput {
  /** Any directory inside the repository. Resolved to its work tree root. */
  dir: string;
  /** `--range`, as the person typed it. Absent means "choose one and say so". */
  explicit?: string | undefined;
  /** Passed straight to `git.ts`. Tests substitute their own runner. */
  git?: GitOptions | undefined;
}

export interface ResolvedReviewRange {
  /** The work tree root the range was resolved in. */
  repo: string;
  /** The current branch, or `HEAD` when detached. */
  branch: string;
  /** A `<a>..<b>` range, valid against the protocol's `GitRange`. */
  range: string;
  basis: ReviewRangeBasis;
  /**
   * `git log --oneline` for the range **as it stands now**, newest first.
   *
   * Empty for `uncommitted`, and empty on purpose: the commit that range will name has not been
   * made yet, so the only honest list is no list. Printing HEAD~1..HEAD's current contents there
   * would name the previous commit as the thing about to be reviewed, which is exactly the lie
   * this module exists to prevent.
   */
  commits: string[];
  /** Uncommitted paths right now. They become the WIP commit `review.start` makes. */
  dirtyFiles: number;
}

/** The newest commit's subject, without its abbreviated sha. */
const subject = (oneline: string): string => oneline.replace(/^[0-9a-f]{7,40}\s+/, '').trim();

/**
 * One line for the packet: what the author was trying to do.
 *
 * `review.start.intent` is required and the packet leads with it, so the CLI has to supply
 * something when the person did not pass `--intent`. The newest commit's subject is the best
 * available answer — it is the author's own description of the change, written by them, at the
 * time. For uncommitted work there is no such line yet, so it says plainly what is being read
 * rather than inventing a goal the reviewer would then score the diff against.
 */
export function reviewIntentFor(r: ResolvedReviewRange): string {
  if (r.basis === 'uncommitted') return `uncommitted work on ${r.branch}`;
  const newest = r.commits[0];
  return newest ? subject(newest) : `the changes in ${r.range}`;
}

/**
 * Normalise what the person typed into something `GitRange` accepts.
 *
 * A bare ref becomes `<ref>..HEAD`: `--range HEAD~3` means "the last three commits" to everyone
 * who types it, and `git log HEAD~3` (every commit up to that point) is never what they meant.
 * Anything that still fails the protocol's regex is refused here rather than by a zod parse
 * three layers down, where the message would be a regex.
 */
export function normalizeRange(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ReviewRangeError('bad_range', '--range cannot be empty');
  const range = trimmed.includes('..') ? trimmed : `${trimmed}..HEAD`;
  if (!GitRange.safeParse(range).success)
    throw new ReviewRangeError(
      'bad_range',
      `"${raw}" is not a commit range — write it as <base>..<head>, for example HEAD~3..HEAD`,
    );
  return range;
}

/** Choose the commits a `pagr review` will read, and say why they are the ones. */
export async function resolveReviewRange(
  input: ResolveReviewRangeInput,
): Promise<ResolvedReviewRange> {
  const git = input.git ?? {};

  let repo: string;
  try {
    repo = await repoRoot(input.dir, git);
  } catch (e) {
    throw new ReviewRangeError('not_a_repo', e instanceof Error ? e.message : String(e), {
      cause: e,
    });
  }

  const branch = await gitBranch(repo, git);
  const dirtyFiles = (await statusPorcelain(repo, git)).length;

  if (input.explicit !== undefined) {
    const range = normalizeRange(input.explicit);
    let commits: string[];
    try {
      commits = await logOneline(repo, range, git);
    } catch (e) {
      if (e instanceof GitError)
        throw new ReviewRangeError(
          'bad_range',
          `${repo} does not understand the range "${range}": ${e.detail ?? e.message}`,
          { cause: e },
        );
      throw e;
    }
    return { repo, branch, range, basis: 'explicit', commits, dirtyFiles };
  }

  // No commits at all: the WIP commit would become the first one, and `HEAD~1` would still not
  // exist afterwards. Nothing this function can choose would work, so say so now.
  try {
    await head(repo, git);
  } catch (e) {
    if (e instanceof GitError && (e.code === 'no_commits' || e.code === 'git_failed'))
      throw new ReviewRangeError(
        'no_commits',
        `${repo} has no commits yet, so there is nothing to compare a change against`,
        { cause: e },
      );
    throw e;
  }

  const range = 'HEAD~1..HEAD';
  if (dirtyFiles > 0) return { repo, branch, range, basis: 'uncommitted', commits: [], dirtyFiles };

  let commits: string[];
  try {
    commits = await logOneline(repo, range, git);
  } catch (e) {
    // The one commit in this repository is its first. `git` can show it, but not as a range, and
    // guessing which half of "the whole history" the person meant is not this function's call.
    if (e instanceof GitError)
      throw new ReviewRangeError(
        'root_commit',
        `the only commit in ${repo} is its first, so there is nothing before it to compare against`,
        { cause: e },
      );
    throw e;
  }
  return { repo, branch, range, basis: 'last_commit', commits, dirtyFiles };
}
