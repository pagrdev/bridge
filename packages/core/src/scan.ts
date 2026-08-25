import { statSync } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { type RepoHint, repoHint } from './projects.js';

/**
 * Bounded, non-invasive discovery of git repositories.
 *
 * The rules here exist because a scanner that walks a developer's whole home directory is both
 * slow and creepy. We therefore: start only from explicitly named roots (or a short list of
 * conventional ones), never accept `~` or `/` as a root, stop descending as soon as a `.git`
 * lives in a directory, refuse hidden/cache/vendor directories, never follow symlinks, and cap
 * both depth and the number of results.
 */

/** Deliberately shallow: conventional layouts are `<root>/<org>/<repo>` at worst. */
export const MAX_SCAN_DEPTH = 3;
export const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_CONCURRENCY = 24;

/**
 * Directories that never contain a project a user wants to text about, and which are large
 * enough that walking them is what makes a naive scanner feel slow.
 */
export const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules',
  'Library',
  'Applications',
  'Pods',
  'DerivedData',
  'Caches',
  'vendor',
  'target',
  'venv',
  '__pycache__',
  'Photos Library.photoslibrary',
]);

/** Conventional code roots, in the order they are offered. */
export const CONVENTIONAL_ROOT_NAMES = [
  'code',
  'src',
  'Developer',
  'Projects',
  'projects',
  'dev',
  'repos',
  'git',
  'work',
  'Sites',
  'Desktop',
] as const;

export class ScanRootError extends Error {
  constructor(
    readonly root: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScanRootError';
  }
}

export interface ScanOptions {
  maxDepth?: number;
  concurrency?: number;
  /** Stop after this many repositories (default `DEFAULT_SCAN_LIMIT`). */
  limit?: number;
  /** The user's home directory; scanning it directly is refused. Defaults to `os.homedir()`. */
  home?: string;
  signal?: AbortSignal;
}

export interface ScannedRepo {
  path: string;
  repoHint?: RepoHint;
}

export interface ScanRootsResult {
  repos: ScannedRepo[];
  /** Roots that were named but could not be walked (missing, not a directory, unreadable). */
  skippedRoots: Array<{ root: string; reason: string }>;
  /** Directories opened; useful for explaining why a scan was slow. */
  scannedDirs: number;
  truncated: boolean;
}

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * System locations that are never offered as a default root. A user may still name one
 * explicitly; this list only stops `pagr project scan` with no arguments from wandering into
 * `/private` because the shell happened to be in `/tmp`.
 */
const SYSTEM_ROOTS = [
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/var',
  '/tmp',
  '/usr',
  '/etc',
  '/bin',
  '/sbin',
  '/opt',
  '/dev',
  '/cores',
  '/Volumes',
];

/**
 * Conventional roots that actually exist, plus the parent of `cwd` (so `pagr project scan` run
 * inside a repo offers its siblings). Never the home directory itself, never `~/Library`, never
 * a system location.
 */
export function defaultScanRoots(opts: { home?: string; cwd?: string } = {}): string[] {
  const home = resolve(opts.home ?? homedir());
  const out: string[] = [];
  const push = (candidate: string) => {
    const p = resolve(candidate);
    if (p === home || p === sep) return;
    if (isUnder(p, join(home, 'Library'))) return;
    // Anything inside the user's own home is theirs, wherever the home itself lives.
    if (!isUnder(p, home) && SYSTEM_ROOTS.some((r) => isUnder(p, r))) return;
    if (!out.includes(p) && isDirectorySync(p)) out.push(p);
  };
  for (const name of CONVENTIONAL_ROOT_NAMES) push(join(home, name));
  if (opts.cwd) {
    const cwd = resolve(opts.cwd);
    const parent = dirname(cwd);
    if (parent !== cwd) push(parent);
  }
  return out;
}

function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk `roots` and return the git repositories found. Never throws on unreadable directories. */
export async function scanForRepos(
  roots: string[],
  opts: ScanOptions = {},
): Promise<ScanRootsResult> {
  const home = resolve(opts.home ?? homedir());
  const maxDepth = Math.max(1, opts.maxDepth ?? MAX_SCAN_DEPTH);
  const limit = Math.max(1, opts.limit ?? DEFAULT_SCAN_LIMIT);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  const skippedRoots: ScanRootsResult['skippedRoots'] = [];
  const startDirs: string[] = [];
  for (const raw of roots) {
    const root = resolve(raw);
    if (root === sep)
      throw new ScanRootError(root, 'refusing to scan the whole filesystem — name a code folder');
    if (root === home || isUnder(home, root))
      throw new ScanRootError(
        root,
        // `/Users` is not the home directory but contains it (and everyone else's), so walking
        // it from depth 1 would reach exactly what refusing `~` is meant to prevent.
        `refusing to scan ${root}: it contains your home directory — name a code folder such as ~/code`,
      );
    if (isUnder(root, join(home, 'Library')))
      throw new ScanRootError(root, `refusing to scan ${join(home, 'Library')}`);
    if (startDirs.includes(root)) continue;
    startDirs.push(root);
  }
  // Drop roots nested inside another named root so overlapping input is walked once.
  const effective = startDirs.filter((r) => !startDirs.some((o) => o !== r && isUnder(r, o)));

  const found = new Map<string, ScannedRepo>();
  let scannedDirs = 0;
  let truncated = false;

  let frontier: Array<{ dir: string; depth: number }> = [];
  for (const root of effective) {
    try {
      const st = await stat(root);
      if (!st.isDirectory()) {
        skippedRoots.push({ root, reason: 'not a directory' });
        continue;
      }
    } catch (err) {
      skippedRoots.push({ root, reason: reasonOf(err) });
      continue;
    }
    frontier.push({ dir: root, depth: 1 });
  }

  while (frontier.length > 0 && !truncated) {
    const next: Array<{ dir: string; depth: number }> = [];
    await pool(frontier, concurrency, async ({ dir, depth }) => {
      if (truncated || opts.signal?.aborted) return;
      scannedDirs++;
      let names: string[];
      let subdirs: string[];
      try {
        names = [];
        subdirs = [];
        const handle = await opendir(dir);
        for await (const entry of handle) {
          names.push(entry.name);
          // `isDirectory()` is false for symlinks, which is exactly what we want: a symlinked
          // directory is never followed, so there are no cycles and no escapes out of the root.
          if (entry.isDirectory() && !skipDirectory(entry.name)) subdirs.push(entry.name);
        }
      } catch (err) {
        if (depth === 1) skippedRoots.push({ root: dir, reason: reasonOf(err) });
        return;
      }
      if (names.includes('.git')) {
        if (found.size >= limit) {
          truncated = true;
          return;
        }
        const hint = repoHint(dir);
        found.set(dir, hint ? { path: dir, repoHint: hint } : { path: dir });
        return; // a repository is a leaf: never descend into one
      }
      if (depth >= maxDepth) return;
      for (const name of subdirs) next.push({ dir: join(dir, name), depth: depth + 1 });
    });
    frontier = next;
  }

  return {
    repos: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skippedRoots,
    scannedDirs,
    truncated,
  };
}

function skipDirectory(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRECTORY_NAMES.has(name);
}

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'not readable';
  if (code === 'ENOTDIR') return 'not a directory';
  return code ?? String(err);
}

/** Run `fn` over `items` with at most `n` in flight. Rejections propagate. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const MAX_DISPLAY_NAME = 80;
export const MAX_ALIAS = 40;
export const MAX_ALIASES = 10;

export interface InferredNames {
  displayName: string;
  aliases: string[];
}

/**
 * A display name from the folder, plus the GitHub repo name as an alias when it differs — so a
 * user can text either "checkout" (the folder they cloned into) or "widgets" (what GitHub calls
 * it) and reach the same project.
 */
export function inferProjectNames(projectPath: string, hint?: RepoHint): InferredNames {
  const folder = basename(resolve(projectPath));
  const displayName = folder.slice(0, MAX_DISPLAY_NAME) || 'project';
  const aliases: string[] = [];
  const repoName = hint?.name?.split('/').pop()?.trim();
  if (repoName && repoName.toLowerCase() !== folder.toLowerCase())
    aliases.push(repoName.slice(0, MAX_ALIAS));
  return { displayName, aliases: aliases.slice(0, MAX_ALIASES) };
}

export interface NameCandidate {
  path: string;
  displayName: string;
  aliases: string[];
}

export interface ResolvedName extends NameCandidate {
  /** Set when the display name had to change to avoid a collision. */
  renamedFrom?: string;
  /** Aliases removed because something else already answers to them. */
  droppedAliases?: string[];
}

/**
 * Make every candidate's display name and aliases unique against `existing` and against each
 * other, case-insensitively — because `pagr project remove <ref>` and the cloud's routing both
 * match on name *or* alias, so two projects answering to one word is a real ambiguity, not a
 * cosmetic one.
 */
export function resolveNameCollisions(
  candidates: NameCandidate[],
  existing: Array<{ displayName: string; aliases: string[] }>,
): ResolvedName[] {
  const taken = new Set<string>();
  for (const e of existing) {
    taken.add(e.displayName.toLowerCase());
    for (const a of e.aliases) taken.add(a.toLowerCase());
  }
  // Reserve every candidate's preferred display name first, so an alias never shadows a name.
  const wanted = new Set(candidates.map((c) => c.displayName.toLowerCase()));

  const out: ResolvedName[] = [];
  for (const c of candidates) {
    const original = c.displayName;
    let name = original;
    if (taken.has(name.toLowerCase())) {
      const parent = basename(dirname(resolve(c.path)));
      name = parent ? `${parent}/${original}`.slice(0, MAX_DISPLAY_NAME) : original;
      // The suffix has to fit INSIDE the cap: appending then truncating produces the same
      // string every time for a name already at the limit, which would spin forever.
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        const suffix = `-${n}`;
        name = original.slice(0, MAX_DISPLAY_NAME - suffix.length) + suffix;
      }
    }
    taken.add(name.toLowerCase());

    const aliases: string[] = [];
    const dropped: string[] = [];
    for (const a of c.aliases) {
      const lc = a.toLowerCase();
      if (taken.has(lc) || wanted.has(lc)) dropped.push(a);
      else {
        aliases.push(a);
        taken.add(lc);
      }
    }
    out.push({
      path: c.path,
      displayName: name,
      aliases: aliases.slice(0, MAX_ALIASES),
      ...(name === original ? {} : { renamedFrom: original }),
      ...(dropped.length ? { droppedAliases: dropped } : {}),
    });
  }
  return out;
}
