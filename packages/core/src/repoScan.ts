import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectRegistry, RepoHint } from './projects.js';
import {
  DEFAULT_SCAN_LIMIT,
  defaultScanRoots,
  inferProjectNames,
  MAX_SCAN_DEPTH,
  resolveNameCollisions,
} from './scan.js';

/**
 * Letting a phone pick a project without letting the cloud name a folder.
 *
 * The bridge already knows how to find repositories (`scan.ts`) and how to turn a folder into an
 * opaque project id (`projects.ts`). What was missing was a way to OFFER an unregistered folder:
 * a phone cannot say "add ~/code/widgets", because the whole point of `projects.ts` is that no
 * cloud-facing surface may name a path.
 *
 * A handle closes that gap without opening the path. It is a salted hash of the real path, held
 * in memory for an hour and never written to disk, so:
 *   - what leaves the Mac is a random-looking string plus a folder name the user would recognise;
 *   - it cannot be turned back into a path anywhere but on this Mac, because the salt never
 *     leaves (the same salt `projectIdFor` uses, so both live and die with the device);
 *   - it stops working an hour after the scan that produced it, so a handle captured off a phone
 *     is not a durable capability;
 *   - and it only ever names something the scan itself returned, which is a git repository under
 *     the user's own conventional code folders — never `~`, never `~/Library`, never deeper
 *     than `MAX_SCAN_DEPTH`.
 */

/** How long a handle stays resolvable. One scan's worth of picking, not a standing grant. */
export const REPO_HANDLE_TTL_MS = 60 * 60 * 1000;

/**
 * `rh_` + a device-salted hash of the real path, domain-separated from `projectIdFor` by the
 * literal `repo` so that a handle never reveals the project id the same folder would get.
 * Deterministic within the hour: the same repository offered twice is the same handle, so a
 * phone that scanned twice does not end up with two cards for one folder.
 */
export function handleFor(realPath: string, salt: string): string {
  return `rh_${createHash('sha256').update(`${salt}\u0000repo\u0000${realPath}`).digest('hex').slice(0, 32)}`;
}

export interface RepoHandleCacheOptions {
  /** Default `REPO_HANDLE_TTL_MS`. */
  ttlMs?: number;
  now?: () => Date;
}

/**
 * handle → real path, in memory only. Never persisted: a file of handles would be exactly the
 * path list this design exists to not have, and would outlive the minute of picking it is for.
 */
export class RepoHandleCache {
  private readonly entries = new Map<string, { path: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: RepoHandleCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? REPO_HANDLE_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  put(handle: string, realPath: string): void {
    this.entries.set(handle, { path: realPath, expiresAt: this.now().getTime() + this.ttlMs });
  }

  /** The path this handle names, or undefined when it is unknown or has expired. */
  get(handle: string): string | undefined {
    const hit = this.entries.get(handle);
    if (!hit) return undefined;
    if (hit.expiresAt < this.now().getTime()) {
      this.entries.delete(handle);
      return undefined;
    }
    return hit.path;
  }

  /** Forget everything. Called once a handle has been registered: the next scan is the truth. */
  clear(): void {
    this.entries.clear();
  }

  /** Live handles, expired ones dropped. `pagr doctor` reports this. */
  get size(): number {
    const now = this.now().getTime();
    for (const [handle, hit] of this.entries) if (hit.expiresAt < now) this.entries.delete(handle);
    return this.entries.size;
  }
}

/** One repository as a phone sees it: a handle, a name, and nothing a path could be built from. */
export interface ScannedRepoHandle {
  handle: string;
  displayName: string;
  repoHint?: RepoHint;
  /** Set when this repository is already a registered project, so the phone offers "open". */
  registeredAs?: string;
}

export interface ScanReposResult {
  repos: ScannedRepoHandle[];
  truncated: boolean;
  /**
   * How many roots were walked. A COUNT, deliberately: this value is logged and reported, and a
   * list of root paths is the one thing a scan result must never carry off the Mac.
   */
  scannedRoots: number;
}

export interface ScanReposOptions {
  registry: ProjectRegistry;
  cache: RepoHandleCache;
  /** The user's home directory. Defaults to the registry's own, which is realpath-resolved. */
  home?: string;
  /** Default `DEFAULT_SCAN_LIMIT`. */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Scan the conventional code folders and describe what is there as handles.
 *
 * The roots are `defaultScanRoots` — the bridge's own list, never anything the caller supplies,
 * because a root from the cloud would be a path from the cloud. `cwd` is deliberately not passed:
 * the daemon's working directory is not a place the user pointed at.
 */
export async function scanRepos(opts: ScanReposOptions): Promise<ScanReposResult> {
  const { registry, cache } = opts;
  const home = opts.home ?? registry.homeDirectory;
  const roots = defaultScanRoots({ home });
  const found = await registry.discover(roots, {
    home,
    maxDepth: MAX_SCAN_DEPTH,
    limit: opts.limit ?? DEFAULT_SCAN_LIMIT,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const salt = registry.deviceSalt();
  const registered = new Map(registry.list().map((p) => [p.path, p]));
  // Names are resolved only for the repositories that are NOT projects yet: a registered one
  // already has a name the user has seen, and re-deriving it would rename it on their phone.
  const unregistered = found.repos.filter((r) => !registered.has(safeRealpath(r.path)));
  const resolved = new Map(
    resolveNameCollisions(
      unregistered.map((r) => {
        const inferred = inferProjectNames(r.path, r.repoHint);
        return { path: r.path, displayName: inferred.displayName, aliases: inferred.aliases };
      }),
      registry.list().map((p) => ({ displayName: p.displayName, aliases: p.aliases })),
    ).map((n) => [n.path, n.displayName]),
  );

  const repos: ScannedRepoHandle[] = [];
  for (const r of found.repos) {
    const real = safeRealpath(r.path);
    const project = registered.get(real);
    const handle = handleFor(real, salt);
    cache.put(handle, real);
    repos.push({
      handle,
      displayName: project?.displayName ?? resolved.get(r.path) ?? 'project',
      ...(r.repoHint ? { repoHint: r.repoHint } : {}),
      ...(project ? { registeredAs: project.projectId } : {}),
    });
  }
  return {
    repos,
    truncated: found.truncated,
    scannedRoots: roots.length - found.skippedRoots.length,
  };
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
