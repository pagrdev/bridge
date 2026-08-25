import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ProjectSummary } from '@pagr/protocol';
import type { LocalProject } from './adapters/types.js';
import { readJson, writeJson } from './jsonFile.js';

export interface ProjectRecord extends LocalProject {
  aliases: string[];
  allowNonGit: boolean;
  addedAt: string;
  repoHint?: RepoHint;
}

export interface RepoHint {
  host?: string;
  name?: string;
  defaultBranch?: string;
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
  idGen?: () => string;
}

export const newProjectId = (): string => `proj_${randomBytes(16).toString('hex')}`;

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

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
  private readonly idGen: () => string;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.file = opts.file;
    this.home = safeRealpath(opts.home ?? homedir());
    this.pagrHome = safeRealpath(opts.pagrHome ?? join(this.home, '.pagr'));
    this.now = opts.now ?? (() => new Date());
    this.idGen = opts.idGen ?? newProjectId;
    if (this.file) {
      const raw = readJson<Record<string, ProjectRecord>>(this.file, {});
      for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') this.map.set(k, v);
    }
  }

  private forbiddenRoots(): string[] {
    return ['/', '/System', '/private/etc', '/etc', '/usr', '/bin', '/sbin', '/Library', this.home];
  }

  add(inputPath: string, opts: AddProjectOptions = {}): ProjectRecord {
    const abs = resolve(inputPath);
    if (!existsSync(abs)) throw new ProjectError('not_found', `path does not exist: ${abs}`);
    const path = realpathSync(abs);
    if (!statSync(path).isDirectory())
      throw new ProjectError('not_directory', `not a directory: ${path}`);
    for (const root of this.forbiddenRoots()) {
      if (path === root) throw new ProjectError('forbidden_root', `refusing to register ${path}`);
    }
    for (const root of ['/System', '/private/etc', '/etc', '/usr', '/bin', '/sbin']) {
      if (isUnder(path, root))
        throw new ProjectError('forbidden_root', `refusing to register ${path}`);
    }
    if (isUnder(path, this.pagrHome))
      throw new ProjectError(
        'forbidden_root',
        `refusing to register a path inside ${this.pagrHome}`,
      );
    const allowNonGit = opts.allowNonGit ?? false;
    if (!allowNonGit && !existsSync(join(path, '.git')))
      throw new ProjectError('not_git', `${path} is not a git repository (use --allow-non-git)`);
    for (const existing of this.map.values()) {
      if (existing.path === path)
        throw new ProjectError('duplicate', `already registered as ${existing.projectId}`);
    }
    const displayName = (opts.displayName?.trim() || basename(path)).slice(0, 80);
    const rec: ProjectRecord = {
      projectId: this.idGen(),
      path,
      displayName,
      aliases: (opts.aliases ?? [])
        .map((a) => a.trim())
        .filter(Boolean)
        .slice(0, 10),
      allowNonGit,
      addedAt: this.now().toISOString(),
    };
    const hint = repoHint(path);
    if (hint) rec.repoHint = hint;
    this.map.set(rec.projectId, rec);
    this.persist();
    return rec;
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
    if (!isAbsolute(candidatePath)) return undefined;
    let real: string;
    try {
      real = realpathNearest(resolve(candidatePath));
    } catch {
      return undefined;
    }
    let best: ProjectRecord | undefined;
    for (const rec of this.map.values()) {
      if (isUnder(real, rec.path) && (!best || rec.path.length > best.path.length)) best = rec;
    }
    return best;
  }

  /** Shallow (depth ≤ 3) search for git repositories under the given roots. */
  discover(roots: string[], maxDepth = 3): string[] {
    const found = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      if (entries.includes('.git')) {
        found.add(safeRealpath(dir));
        return; // don't descend into repos
      }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'Library') continue;
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) walk(full, depth + 1);
        } catch {
          // unreadable
        }
      }
    };
    for (const r of roots) if (existsSync(r)) walk(resolve(r), 1);
    return [...found].sort();
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
