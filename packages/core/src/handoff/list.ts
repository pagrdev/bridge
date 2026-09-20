import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HANDOFF_DIR,
  HANDOFF_ID_RE,
  type HandoffFrontmatter,
  parse,
  summaryLine,
} from './format.js';

/**
 * Reading back the handoffs this Mac has written.
 *
 * There is no index and there is deliberately not going to be one. The files under
 * `<repo>/.pagr/handoff/` ARE the record: they are what an agent reads, what a person opens, and
 * what survives a `~/.pagr` that was thrown away — so a second copy in a database would be a
 * second answer to the same question, and the two would disagree the first time somebody deleted
 * a file by hand. `pagr handoffs ls` walks the directories instead, which is slower and always
 * right.
 *
 * The cloud's `handoffs` table (HND-020) is not that second copy: it records switches the cloud
 * ORCHESTRATED, with their workflow state. A handoff made locally by `pagr handoff` never enters
 * it, and this listing is the only place it shows up.
 */

/** One handoff file, as much of it as the frontmatter can be trusted for. */
export interface HandoffListing {
  handoffId: string;
  /** Absolute path to the file. The whole point of the listing on the `--no-start` path. */
  path: string;
  /** The work tree the file lives in. */
  repo: string;
  from: string;
  to: string;
  writer: string;
  /** The `# Goal` line, empty when the file has no goal. */
  summary: string;
  /** ISO-8601 from the frontmatter, or null when it could not be read. */
  created: string | null;
  branch: string | null;
  wipCommit: string | null;
  truncated: boolean;
  /**
   * Set when the file is on disk but could not be understood. Everything else is then a
   * best-effort guess from the filename, because a corrupt handoff the person can still open is
   * worth more in a listing than a row silently missing from it.
   */
  problem?: string;
}

/** A directory that could not be read, named so the listing can say what it skipped. */
export interface HandoffListingSkip {
  repo: string;
  reason: string;
}

export interface HandoffListResult {
  handoffs: HandoffListing[];
  skipped: HandoffListingSkip[];
}

const listingFromDoc = (
  handoffId: string,
  path: string,
  repo: string,
  fm: HandoffFrontmatter,
  summary: string,
): HandoffListing => ({
  handoffId,
  path,
  repo,
  from: fm.from.provider,
  to: fm.to.provider,
  writer: fm.writer,
  summary,
  created: fm.created,
  branch: fm.git.branch,
  wipCommit: fm.git.wipCommit,
  truncated: fm.truncated === true,
});

const unreadable = (
  handoffId: string,
  path: string,
  repo: string,
  problem: string,
): HandoffListing => ({
  handoffId,
  path,
  repo,
  from: '?',
  to: '?',
  writer: '?',
  summary: '',
  created: null,
  branch: null,
  wipCommit: null,
  truncated: false,
  problem,
});

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

/** Every handoff file under one work tree, unsorted. A missing directory is not an error. */
async function listOneRepo(repo: string): Promise<HandoffListing[] | HandoffListingSkip> {
  const dir = join(repo, HANDOFF_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    // No handoff has ever been written here. That is the normal state of almost every repo on
    // the Mac, and it is not something to report.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return { repo, reason: errorMessage(err) };
  }
  const out: HandoffListing[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const handoffId = name.slice(0, -3);
    // The id is the filename: anything else in here was put there by something that is not Pagr,
    // and parsing it as a handoff would be this listing making things up.
    if (!HANDOFF_ID_RE.test(handoffId)) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      out.push(unreadable(handoffId, path, repo, errorMessage(err)));
      continue;
    }
    const result = parse(text);
    if (!result.ok) {
      out.push(unreadable(handoffId, path, repo, result.problem.message));
      continue;
    }
    out.push(
      listingFromDoc(handoffId, path, repo, result.doc.frontmatter, summaryLine(result.doc)),
    );
  }
  return out;
}

/**
 * Every handoff file in the given work trees, newest first.
 *
 * `repos` are the directories to walk — the registered projects, as the CLI passes them. A repo
 * named twice is walked once; a repo with no `.pagr/handoff` contributes nothing and is not
 * reported as a skip, because "this project has never had a handoff" is not a problem.
 *
 * Ordering is by the frontmatter's `created`, not by mtime: mtime moves when the switch stamps
 * the WIP commit back into the file, so sorting by it would shuffle a handoff to the top for
 * having been finished rather than for having been made. A file whose frontmatter would not
 * parse has no `created` and sorts last, where it is still visible.
 */
export async function listHandoffs(repos: readonly string[]): Promise<HandoffListResult> {
  const unique = [...new Set(repos)];
  const results = await Promise.all(unique.map((repo) => listOneRepo(repo)));
  const handoffs: HandoffListing[] = [];
  const skipped: HandoffListingSkip[] = [];
  for (const result of results) {
    if (Array.isArray(result)) handoffs.push(...result);
    else skipped.push(result);
  }
  handoffs.sort((a, b) => {
    if (a.created === b.created) return a.handoffId.localeCompare(b.handoffId);
    if (a.created === null) return 1;
    if (b.created === null) return -1;
    return b.created.localeCompare(a.created);
  });
  return { handoffs, skipped };
}
