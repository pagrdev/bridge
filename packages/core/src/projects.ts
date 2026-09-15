import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ProjectSummary } from '@pagr/protocol';
import type { LocalProject } from './adapters/types.js';
import { readJson, writeJson } from './jsonFile.js';
import {
  inferProjectNames,
  MAX_ALIAS,
  MAX_ALIASES,
  MAX_DISPLAY_NAME,
  resolveNameCollisions,
  type ScanOptions,
  type ScanRootsResult,
  scanForRepos,
} from './scan.js';

export interface ProjectRecord extends LocalProject {
  aliases: string[];
  allowNonGit: boolean;
  addedAt: string;
  repoHint?: RepoHint;
}

/**
 * What `add()` returns: the persisted record plus a report of anything the registry had to
 * change to keep names unambiguous. The extra fields are never written to `projects.json`.
 */
export interface AddedProject extends ProjectRecord {
  renamedFrom?: string;
  droppedAliases?: string[];
}

export interface RepoHint {
  host?: string;
  name?: string;
  defaultBranch?: string;
}

export interface DiscoveredRepo {
  path: string;
  repoHint?: RepoHint;
  /** Project id when this path is already in the registry — scan results stay safe to re-run. */
  registeredAs?: string;
}

/** What `ensure()` returns: the project covering a path, and whether this call created it. */
export interface EnsuredProject extends AddedProject {
  created: boolean;
}

export interface AddProjectOptions {
  displayName?: string;
  aliases?: string[];
  allowNonGit?: boolean;
}

export class ProjectError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_directory'
      | 'not_git'
      | 'not_owned'
      | 'forbidden_root'
      | 'duplicate'
      | 'unknown_project'
      | 'outside_project',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export interface ProjectRegistryOptions {
  file?: string;
  /** The user's home directory (defaults to os.homedir()). Registering it directly is refused. */
  home?: string;
  /** The pagr home (defaults to `<home>/.pagr`). Anything under it is refused. */
  pagrHome?: string;
  now?: () => Date;
  /**
   * Override id minting. Left unset, ids are derived from the path (see `projectIdFor`) so that
   * the same folder keeps one id however it was registered.
   */
  idGen?: (path: string) => string;
  /** The uid the daemon runs as (defaults to `process.getuid()`); a seam for tests. */
  uid?: () => number;
}

/** A random project id. Kept for embedders passing their own `idGen`; not the default. */
export const newProjectId = (): string => `proj_${randomBytes(16).toString('hex')}`;

/**
 * Device-local salt for id derivation, beside `projects.json`. Its own file because
 * `projects.json` is read elsewhere as "one key per project" and must stay exactly that.
 */
const SALT_FILE = 'project-id-salt.json';

/**
 * A project id is `proj_` + a device-salted hash of the real path.
 *
 * Deterministic on purpose: the same folder must come back with the same id whether it was
 * registered explicitly or implicitly, after a restart, and even after the registry file is lost
 * — otherwise the cloud's view of that project's sessions fractures into two ids.
 *
 * Salted on purpose: an unsalted hash would let the cloud confirm a guessed
 * `/Users/<name>/code/<repo>`, which is the one fact this registry exists to keep local. The salt
 * never leaves the Mac, so off-device an id is opaque.
 */
export function projectIdFor(realPath: string, salt: string): string {
  return `proj_${createHash('sha256').update(`${salt}\u0000${realPath}`).digest('hex').slice(0, 32)}`;
}

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Roots no project may live under, however the path was spelled. */
const SYSTEM_ROOTS = ['/System', '/private/etc', '/etc', '/usr', '/bin', '/sbin'];

/**
 * The project whose root contains `candidatePath` (deepest root wins), or undefined. Exported
 * because the CLI has to answer the same question about a list it got from the daemon over IPC,
 * and one copy of "is this path inside that project" is the only safe number of copies.
 */
export function projectContaining<T extends { path: string }>(
  records: Iterable<T>,
  candidatePath: string,
): T | undefined {
  if (!isAbsolute(candidatePath)) return undefined;
  let real: string;
  try {
    real = realpathNearest(resolve(candidatePath));
  } catch {
    return undefined;
  }
  let best: T | undefined;
  for (const rec of records) {
    if (isUnder(real, rec.path) && (!best || rec.path.length > best.path.length)) best = rec;
  }
  return best;
}

/**
 * Local project registry (`~/.pagr/projects.json`). This is the ONLY place local paths live;
 * the cloud only ever sees opaque `proj_…` ids and safe metadata.
 */
export class ProjectRegistry {
  private map = new Map<string, ProjectRecord>();
  private readonly file: string | undefined;
  private readonly home: string;
  private readonly pagrHome: string;
  private readonly now: () => Date;
  private readonly idGen: (path: string) => string;
  private readonly uid: () => number;
  private readonly saltFile: string | undefined;
  private salt: string | undefined;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.file = opts.file;
    this.saltFile = this.file ? join(dirname(this.file), SALT_FILE) : undefined;
    this.home = safeRealpath(opts.home ?? homedir());
    this.pagrHome = safeRealpath(opts.pagrHome ?? join(this.home, '.pagr'));
    this.now = opts.now ?? (() => new Date());
    this.idGen = opts.idGen ?? ((path) => projectIdFor(path, this.deviceSalt()));
    this.uid = opts.uid ?? (() => process.getuid?.() ?? -1);
    if (this.file) {
      const raw = readJson<Record<string, ProjectRecord>>(this.file, {});
      for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') this.map.set(k, v);
    }
  }

  /**
   * The salt this device derives ids with, created on first use. Re-read from disk on a miss so
   * a CLI invocation and the daemon agree on one salt instead of each minting its own. A race
   * cannot break anything already registered: the persisted path→id record is the authority,
   * and the salt only decides what a brand new id looks like.
   */
  private deviceSalt(): string {
    if (this.salt) return this.salt;
    const stored = this.saltFile ? readJson<{ salt?: string }>(this.saltFile, {}).salt : undefined;
    if (typeof stored === 'string' && stored.length >= 32) {
      this.salt = stored;
      return stored;
    }
    const fresh = randomBytes(32).toString('hex');
    this.salt = fresh;
    if (this.saltFile) writeJson(this.saltFile, { salt: fresh });
    return fresh;
  }

  private forbiddenRoots(): string[] {
    return ['/', '/System', '/private/etc', '/etc', '/usr', '/bin', '/sbin', '/Library', this.home];
  }

  /**
   * Everything both registration paths must agree on. The path is realpath-resolved BEFORE any
   * containment decision, so a symlink cannot smuggle a refused root past these checks, and the
   * forbidden-root rules are applied before ownership so `/` reads as "refusing", not as
   * "someone else's".
   */
  private vetPath(inputPath: string): string {
    const abs = resolve(inputPath);
    if (!existsSync(abs)) throw new ProjectError('not_found', `path does not exist: ${abs}`);
    const path = realpathSync(abs);
    const st = statSync(path);
    if (!st.isDirectory()) throw new ProjectError('not_directory', `not a directory: ${path}`);
    for (const root of this.forbiddenRoots()) {
      if (path === root) throw new ProjectError('forbidden_root', `refusing to register ${path}`);
    }
    for (const root of SYSTEM_ROOTS) {
      if (isUnder(path, root))
        throw new ProjectError('forbidden_root', `refusing to register ${path}`);
    }
    if (isUnder(path, this.pagrHome))
      throw new ProjectError(
        'forbidden_root',
        `refusing to register a path inside ${this.pagrHome}`,
      );
    const uid = this.uid();
    if (uid >= 0 && st.uid !== uid)
      throw new ProjectError(
        'not_owned',
        `${path} is owned by another user (uid ${st.uid}); refusing to register it`,
      );
    return path;
  }

  /**
   * Explicit registration: curation. It refuses the surprises a person typing a path would want
   * to hear about — a folder that is not a repository, a path already registered, a name already
   * taken. `ensure()` is the forgiving door; this one is allowed to argue.
   */
  add(inputPath: string, opts: AddProjectOptions = {}): AddedProject {
    const path = this.vetPath(inputPath);
    const allowNonGit = opts.allowNonGit ?? false;
    if (!allowNonGit && !existsSync(join(path, '.git')))
      throw new ProjectError('not_git', `${path} is not a git repository (use --allow-non-git)`);
    for (const existing of this.map.values()) {
      if (existing.path === path)
        throw new ProjectError('duplicate', `already registered as ${existing.projectId}`);
    }
    return this.register(path, { ...opts, allowNonGit });
  }

  /**
   * Make a path the person named addressable, registering it on the spot if nothing covers it
   * yet. Registration is a convenience here, not a prerequisite.
   *
   * LOCAL CALLERS ONLY. This is the single place a path turns into an id, and it is why the
   * cloud can never name a directory: every cloud-facing surface takes an id and goes through
   * `resolve()`, which only ever finds what a local action put in the map.
   *
   * A path already inside a registered project returns that project rather than nesting a second
   * root under a second id — it is already reachable, which is the whole question being asked.
   * Non-git folders are allowed: the person pointed at this exact folder, so `.git` is a
   * discovery heuristic here, not a safety rule.
   */
  ensure(inputPath: string, opts: AddProjectOptions = {}): EnsuredProject {
    const path = this.vetPath(inputPath);
    const existing = this.findByPath(path);
    if (existing) return { ...existing, created: false };
    return { ...this.register(path, { allowNonGit: true, ...opts }), created: true };
  }

  /** Mint and persist a record for an already-vetted path. */
  private register(path: string, opts: AddProjectOptions): AddedProject {
    const allowNonGit = opts.allowNonGit ?? true;
    const hint = repoHint(path);
    const inferred = inferProjectNames(path, hint);
    const explicitName = opts.displayName?.trim();
    const explicitAliases = opts.aliases
      ?.map((a) => a.trim())
      .filter(Boolean)
      .map((a) => a.slice(0, MAX_ALIAS));

    // A name the user typed must never be silently changed: if it is already taken, say so.
    if (explicitName) {
      const clash = this.findByName(explicitName);
      if (clash)
        throw new ProjectError(
          'duplicate',
          `the name "${explicitName}" already refers to ${clash.displayName} (${clash.projectId})`,
        );
    }
    for (const alias of explicitAliases ?? []) {
      const clash = this.findByName(alias);
      if (clash)
        throw new ProjectError(
          'duplicate',
          `the alias "${alias}" already refers to ${clash.displayName} (${clash.projectId})`,
        );
    }

    const [resolved] = resolveNameCollisions(
      [
        {
          path,
          displayName: (explicitName || inferred.displayName).slice(0, MAX_DISPLAY_NAME),
          aliases: explicitAliases ?? inferred.aliases,
        },
      ],
      this.list().map((p) => ({ displayName: p.displayName, aliases: p.aliases })),
    );
    if (!resolved) throw new ProjectError('duplicate', 'could not pick a unique name');

    const rec: ProjectRecord = {
      projectId: this.idGen(path),
      path,
      displayName: resolved.displayName,
      aliases: resolved.aliases.slice(0, MAX_ALIASES),
      allowNonGit,
      addedAt: this.now().toISOString(),
    };
    if (hint) rec.repoHint = hint;
    this.map.set(rec.projectId, rec);
    this.persist();
    return {
      ...rec,
      ...(resolved.renamedFrom ? { renamedFrom: resolved.renamedFrom } : {}),
      ...(resolved.droppedAliases ? { droppedAliases: resolved.droppedAliases } : {}),
    };
  }

  /** Case-insensitive lookup by display name or alias. Ids are matched by `resolve`/`has`. */
  findByName(ref: string): ProjectRecord | undefined {
    const lc = ref.trim().toLowerCase();
    if (!lc) return undefined;
    for (const rec of this.map.values()) {
      if (rec.displayName.toLowerCase() === lc) return rec;
      if (rec.aliases.some((a) => a.toLowerCase() === lc)) return rec;
    }
    return undefined;
  }

  /** Every project a `<ref>` could mean: exact id, then name, then alias. */
  matches(ref: string): ProjectRecord[] {
    const lc = ref.trim().toLowerCase();
    const byId = this.map.get(ref);
    if (byId) return [byId];
    const byName = this.list().filter((p) => p.displayName.toLowerCase() === lc);
    if (byName.length) return byName;
    return this.list().filter((p) => p.aliases.some((a) => a.toLowerCase() === lc));
  }

  remove(projectId: string): boolean {
    const ok = this.map.delete(projectId);
    if (ok) this.persist();
    return ok;
  }

  list(): ProjectRecord[] {
    return [...this.map.values()];
  }

  /** Cloud-safe summaries: never include local paths. */
  summaries(): ProjectSummary[] {
    return this.list().map((p) => {
      const s: ProjectSummary = {
        projectId: p.projectId,
        displayName: p.displayName,
        aliases: p.aliases,
      };
      if (p.repoHint) s.repoHint = p.repoHint;
      return s;
    });
  }

  has(projectId: string): boolean {
    return this.map.has(projectId);
  }

  resolve(projectId: string): LocalProject {
    const rec = this.map.get(projectId);
    if (!rec) throw new ProjectError('unknown_project', `unknown project ${projectId}`);
    return { projectId: rec.projectId, path: rec.path, displayName: rec.displayName };
  }

  /**
   * Assert `candidatePath` lives inside the project's root after realpath resolution.
   * Symlinks that escape the root are rejected. For not-yet-existing paths the nearest
   * existing ancestor is resolved.
   */
  assertContained(projectId: string, candidatePath: string): string {
    const project = this.resolve(projectId);
    const abs = resolve(project.path, candidatePath);
    const real = realpathNearest(abs);
    if (!isUnder(real, project.path))
      throw new ProjectError('outside_project', `${candidatePath} resolves outside project root`);
    return real;
  }

  /**
   * Find the registered project whose root contains `candidatePath` (after realpath resolution,
   * nearest existing ancestor for not-yet-existing paths). Symlinks that escape a root do not
   * match. When roots nest, the deepest matching root wins. Relative paths never match.
   */
  findByPath(candidatePath: string): ProjectRecord | undefined {
    return projectContaining(this.map.values(), candidatePath);
  }

  /**
   * Bounded search for git repositories under `roots`, annotated with whether each one is
   * already registered. Never walks the home directory itself (see `scanForRepos`).
   */
  async discover(
    roots: string[],
    opts: ScanOptions = {},
  ): Promise<Omit<ScanRootsResult, 'repos'> & { repos: DiscoveredRepo[] }> {
    const res = await scanForRepos(roots, { home: this.home, ...opts });
    const registered = new Map(this.list().map((p) => [p.path, p]));
    return {
      ...res,
      repos: res.repos.map((r) => {
        const existing = registered.get(safeRealpath(r.path));
        return existing ? { ...r, registeredAs: existing.projectId } : { ...r };
      }),
    };
  }

  private persist(): void {
    if (this.file) writeJson(this.file, Object.fromEntries(this.map));
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function realpathNearest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

/**
 * Read `.git/config` (no git subprocess) to extract remote origin host/name and the default
 * branch (from `.git/refs/remotes/origin/HEAD` or `init.defaultBranch`).
 */
export function repoHint(projectPath: string): RepoHint | undefined {
  const gitDir = join(projectPath, '.git');
  let configText: string;
  try {
    configText = readFileSync(join(gitDir, 'config'), 'utf8');
  } catch {
    return undefined;
  }
  const hint: RepoHint = {};
  const url = parseGitConfigValue(configText, 'remote "origin"', 'url');
  if (url) {
    const parsed = parseRemoteUrl(url);
    if (parsed.host) hint.host = parsed.host;
    if (parsed.name) hint.name = parsed.name;
  }
  try {
    const head = readFileSync(join(gitDir, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/remotes\/origin\/(.+)$/.exec(head);
    if (m?.[1]) hint.defaultBranch = m[1];
  } catch {
    // no remote HEAD; try packed-refs? keep simple.
  }
  if (!hint.defaultBranch) {
    const b = parseGitConfigValue(configText, 'init', 'defaultBranch');
    if (b) hint.defaultBranch = b;
  }
  return Object.keys(hint).length ? hint : undefined;
}

function parseGitConfigValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inSection = line.slice(1, line.lastIndexOf(']')).replace(/\s+/g, ' ').trim() === section;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return undefined;
}

export function parseRemoteUrl(url: string): { host?: string; name?: string } {
  // git@github.com:owner/repo.git
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp?.[1] && scp[2]) return { host: scp[1], name: scp[2] };
  try {
    const u = new URL(url);
    const name = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/, '')
      .replace(/\/$/, '');
    const out: { host?: string; name?: string } = {};
    if (u.hostname) out.host = u.hostname;
    if (name) out.name = name;
    return out;
  } catch {
    return {};
  }
}
