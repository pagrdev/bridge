import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
  type AddedProject,
  type DiscoveredRepo,
  defaultScanRoots,
  IpcClientError,
  inferProjectNames,
  isLiveStatus,
  ProjectError,
  type ProjectRecord,
  ProjectRegistry,
  projectContaining,
  resolveNameCollisions,
  ScanRootError,
  type SessionRecord,
  scanForRepos,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, say, table, warn } from '../output.js';

const registry = (ctx: CliContext) =>
  new ProjectRegistry({
    file: ctx.paths.projectsFile,
    pagrHome: ctx.home,
    home: ctx.env.HOME ?? homedir(),
  });

async function viaDaemon(ctx: CliContext): Promise<boolean> {
  return (await daemonStatus(ctx)) !== null;
}

export async function listProjects(ctx: CliContext): Promise<ProjectRecord[]> {
  if (await viaDaemon(ctx)) return ipc(ctx).call<ProjectRecord[]>('projects.list');
  return registry(ctx).list();
}

/** Sessions are daemon state; without a daemon there is nothing running to report. */
async function listSessions(ctx: CliContext): Promise<SessionRecord[]> {
  try {
    if (!(await viaDaemon(ctx))) return [];
    return await ipc(ctx).call<SessionRecord[]>('sessions.list');
  } catch {
    return [];
  }
}

/** `~/code/app` instead of `/Users/me/code/app`; a 20-row list is unreadable otherwise. */
export function tildify(path: string, home = homedir()): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export async function runProjects(ctx: CliContext): Promise<void> {
  const [list, sessions] = await Promise.all([listProjects(ctx), listSessions(ctx)]);
  const liveByProject = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (!isLiveStatus(s.status)) continue;
    liveByProject.set(s.projectId, [...(liveByProject.get(s.projectId) ?? []), s]);
  }
  if (ctx.json) {
    printJson(
      ctx,
      list.map((p) => ({
        ...p,
        sessions: (liveByProject.get(p.projectId) ?? []).map((s) => ({
          sessionId: s.sessionId,
          provider: s.provider,
          status: s.status,
        })),
      })),
    );
    return;
  }
  if (list.length === 0) {
    ctx.out(
      dim('nothing registered yet — `pagr project use .` here, or `pagr project scan` to sweep'),
    );
    return;
  }
  ctx.out(
    table(
      list.map((p) => {
        const live = liveByProject.get(p.projectId) ?? [];
        return [
          bold(p.displayName),
          p.aliases.join(', ') || dim('—'),
          live.length ? live.map((s) => `${s.provider}:${s.status}`).join(', ') : dim('—'),
          dim(tildify(p.path, ctx.env.HOME ?? homedir())),
          dim(p.projectId),
        ];
      }),
      ['NAME', 'ALIASES', 'LIVE', 'PATH', 'ID'],
    ),
  );
  ctx.out('');
  ctx.out(dim(`${list.length} project(s) — text a name or alias to start a session`));
}

export interface AddOptions {
  name?: string;
  alias?: string;
  allowNonGit?: boolean;
}

async function addOne(
  ctx: CliContext,
  path: string,
  params: Record<string, unknown>,
): Promise<{ rec: AddedProject; live: boolean }> {
  try {
    if (await viaDaemon(ctx))
      return { rec: await ipc(ctx).call<AddedProject>('projects.add', params), live: true };
    return { rec: registry(ctx).add(path, params), live: false };
  } catch (err) {
    if (err instanceof ProjectError || err instanceof IpcClientError)
      throw new CliError(err.message, EXIT.precondition, projectHint(err.code));
    throw err;
  }
}

export async function runProjectAdd(
  ctx: CliContext,
  path: string,
  opts: AddOptions,
): Promise<void> {
  const aliases = (opts.alias ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const params = {
    path,
    ...(opts.name ? { displayName: opts.name } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(opts.allowNonGit ? { allowNonGit: true } : {}),
  };
  const { rec, live } = await addOne(ctx, path, params);
  if (ctx.json) {
    printJson(ctx, rec);
    return;
  }
  ctx.out(ok(`registered ${bold(rec.displayName)} as ${rec.projectId}`));
  ctx.out(dim(`  ${tildify(rec.path, ctx.env.HOME ?? homedir())}`));
  if (rec.aliases.length) ctx.out(dim(`  also answers to: ${rec.aliases.join(', ')}`));
  if (rec.renamedFrom)
    ctx.out(warn(`  "${rec.renamedFrom}" was taken, so this one is called "${rec.displayName}"`));
  if (rec.droppedAliases?.length)
    ctx.out(dim(`  dropped alias(es) already in use: ${rec.droppedAliases.join(', ')}`));
  ctx.out(
    dim(
      live
        ? '  the cloud was told the id + name (never the path)'
        : '  daemon not running: the cloud learns about it on next connect',
    ),
  );
}

// ---------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------

/**
 * Resolve a folder to a project, registering it if nothing covers it yet.
 *
 * When the daemon is up it must be the one to write: it holds the registry in memory and its
 * next save would clobber anything this process wrote behind its back. So we ask it what it
 * already has, and let it do the registering — which also means the cloud hears about the new
 * project (id and name, never the path) through the same event as an explicit `project add`.
 */
async function ensureOne(
  ctx: CliContext,
  path: string,
): Promise<{ rec: ProjectRecord; created: boolean; live: boolean }> {
  try {
    if (!(await viaDaemon(ctx))) {
      const rec = registry(ctx).ensure(path);
      return { rec, created: rec.created, live: false };
    }
    const known = await ipc(ctx).call<ProjectRecord[]>('projects.list');
    const covering = projectContaining(known, path);
    if (covering) return { rec: covering, created: false, live: true };
    try {
      const rec = await ipc(ctx).call<AddedProject>('projects.add', { path, allowNonGit: true });
      return { rec, created: true, live: true };
    } catch (err) {
      // Someone (another `pagr`, a hook) registered it between the list and the add.
      if (!(err instanceof IpcClientError) || err.code !== 'duplicate') throw err;
      const again = projectContaining(await ipc(ctx).call<ProjectRecord[]>('projects.list'), path);
      if (!again) throw err;
      return { rec: again, created: false, live: true };
    }
  } catch (err) {
    if (err instanceof ProjectError || err instanceof IpcClientError)
      throw new CliError(err.message, EXIT.precondition, projectHint(err.code));
    throw err;
  }
}

/**
 * `pagr project use [path]` — make a folder addressable, whether or not anyone registered it.
 * Registering is a convenience here, not a prerequisite; what it is NOT is something the cloud
 * can do. A path only ever becomes an id because someone ran this on the Mac itself.
 */
export async function runProjectUse(ctx: CliContext, path: string): Promise<void> {
  const { rec, created, live } = await ensureOne(ctx, resolve(path));
  if (ctx.json) {
    printJson(ctx, { ...rec, created });
    return;
  }
  const home = ctx.env.HOME ?? homedir();
  ctx.out(
    created
      ? ok(`registered ${bold(rec.displayName)} as ${rec.projectId}`)
      : ok(`${bold(rec.displayName)} is already reachable as ${rec.projectId}`),
  );
  ctx.out(dim(`  ${tildify(rec.path, home)}`));
  if (rec.aliases.length) ctx.out(dim(`  also answers to: ${rec.aliases.join(', ')}`));
  if (created)
    ctx.out(
      dim(
        live
          ? '  the cloud was told the id + name (never the path)'
          : '  daemon not running: the cloud learns about it on next connect',
      ),
    );
  ctx.out(dim(`  text "${rec.displayName}" to start a session here`));
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

export interface ScanOptions {
  all?: boolean;
  dryRun?: boolean;
  depth?: string;
  limit?: string;
}

export interface ScanCandidate {
  path: string;
  displayName: string;
  aliases: string[];
  renamedFrom?: string;
  droppedAliases?: string[];
}

/**
 * Turn discovered repositories into ready-to-register candidates: registered paths are dropped
 * (so a second run is a no-op), names come from the folder and the git remote, and collisions
 * are resolved against both the existing registry and the rest of this batch.
 */
export function planScan(repos: DiscoveredRepo[], existing: ProjectRecord[]): ScanCandidate[] {
  const known = new Set(existing.map((p) => p.path));
  const fresh = repos.filter((r) => !r.registeredAs && !known.has(r.path));
  return resolveNameCollisions(
    fresh.map((r) => ({ path: r.path, ...inferProjectNames(r.path, r.repoHint) })),
    existing.map((p) => ({ displayName: p.displayName, aliases: p.aliases })),
  );
}

/**
 * Parse an interactive selection: `all`, `none`/empty, or a comma/space list of 1-based indices
 * and `a-b` ranges. Out-of-range and unparseable entries are ignored rather than aborting a scan
 * the user has already waited for.
 */
export function parseSelection(answer: string, count: number): number[] {
  const a = answer.trim().toLowerCase();
  if (a === '' || a === 'none' || a === 'q') return [];
  if (a === 'all' || a === '*') return Array.from({ length: count }, (_, i) => i);
  const picked = new Set<number>();
  for (const part of a.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
        if (i >= 1 && i <= count) picked.add(i - 1);
      continue;
    }
    const n = Number.parseInt(part, 10);
    if (Number.isInteger(n) && n >= 1 && n <= count) picked.add(n - 1);
  }
  return [...picked].sort((x, y) => x - y);
}

export async function runProjectScan(
  ctx: CliContext,
  roots: string[],
  opts: ScanOptions,
): Promise<void> {
  const existing = await listProjects(ctx);
  // `HOME` is honoured (not just `os.homedir()`) so the "never crawl the home directory" rule
  // follows the environment the user is actually running in.
  const home = ctx.env.HOME ?? homedir();
  const chosenRoots = roots.length
    ? roots.map((r) => resolve(r))
    : defaultScanRoots({ home, cwd: process.cwd() });
  if (chosenRoots.length === 0)
    throw new CliError(
      'no folders to scan',
      EXIT.precondition,
      'name one explicitly, e.g. `pagr project scan ~/code`',
    );

  const depth = intOption(opts.depth, 'depth');
  const limit = intOption(opts.limit, 'limit');
  let found: Awaited<ReturnType<typeof scanForRepos>>;
  try {
    found = await scanForRepos(chosenRoots, {
      home,
      ...(depth ? { maxDepth: depth } : {}),
      ...(limit ? { limit } : {}),
    });
  } catch (err) {
    if (err instanceof ScanRootError) throw new CliError(err.message, EXIT.precondition);
    throw err;
  }

  const known = new Map(existing.map((p) => [p.path, p]));
  const repos: DiscoveredRepo[] = found.repos.map((r) => {
    const hit = known.get(safeReal(r.path));
    return hit ? { ...r, registeredAs: hit.projectId } : r;
  });
  const candidates = planScan(repos, existing);
  const alreadyRegistered = repos.length - candidates.length;
  const base = {
    roots: chosenRoots,
    scannedDirs: found.scannedDirs,
    truncated: found.truncated,
    skippedRoots: found.skippedRoots,
    alreadyRegistered,
    candidates,
  };

  if (candidates.length === 0) {
    if (ctx.json) printJson(ctx, { ...base, registered: [] });
    else
      ctx.out(
        alreadyRegistered > 0
          ? ok(`nothing new — all ${alreadyRegistered} repo(s) found are already registered`)
          : warn(
              `no git repositories under ${chosenRoots.map((r) => tildify(r, home)).join(', ')}`,
            ),
      );
    return;
  }

  // `--json` is non-interactive by contract: without `--all` it reports the plan and stops.
  if (ctx.json && !opts.all) {
    printJson(ctx, {
      ...base,
      registered: [],
      ...(opts.dryRun ? { dryRun: true } : { hint: 'rerun with --all to register these' }),
    });
    return;
  }

  if (!ctx.json) {
    say(ctx, bold(`found ${candidates.length} unregistered repo(s)`));
    ctx.out(
      table(
        candidates.map((c, i) => [
          dim(String(i + 1).padStart(2)),
          bold(c.displayName),
          c.aliases.join(', ') || dim('—'),
          dim(tildify(c.path, home)),
        ]),
        ['  #', 'NAME', 'ALIASES', 'PATH'],
      ),
    );
    if (alreadyRegistered > 0) ctx.out(dim(`  (${alreadyRegistered} already registered, skipped)`));
    if (found.truncated)
      ctx.out(dim('  more repos exist than the scan limit — rerun with --limit to see them'));
    for (const s of found.skippedRoots)
      ctx.out(dim(`  skipped ${tildify(s.root, home)}: ${s.reason}`));
  }

  if (opts.dryRun) {
    ctx.out(dim('\n--dry-run: nothing was registered'));
    return;
  }

  let selected = candidates;
  if (!opts.all) {
    if (!ctx.isTTY || ctx.json) {
      ctx.out(dim('\nnot a terminal: rerun with --all to register these, or --dry-run to preview'));
      return;
    }
    const answer = await ctx.prompt(
      '\nRegister which? (e.g. 1,3 or 1-4, "all", or Enter for none):',
    );
    selected = parseSelection(answer, candidates.length).map((i) => candidates[i] as ScanCandidate);
  }

  const registered: AddedProject[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const c of selected) {
    try {
      const { rec } = await addOne(ctx, c.path, {
        path: c.path,
        displayName: c.displayName,
        ...(c.aliases.length ? { aliases: c.aliases } : {}),
      });
      registered.push(rec);
    } catch (err) {
      failed.push({ path: c.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (ctx.json) {
    printJson(ctx, { ...base, registered, failed });
    return;
  }
  ctx.out('');
  for (const r of registered) ctx.out(ok(`${bold(r.displayName)}  ${dim(tildify(r.path, home))}`));
  for (const f of failed) ctx.out(warn(`${tildify(f.path, home)}: ${f.error}`));
  ctx.out(
    registered.length
      ? dim(`\n${registered.length} project(s) registered — see \`pagr projects\``)
      : dim('\nnothing registered'),
  );
}

function intOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1)
    throw new CliError(`--${name} must be a positive integer`, EXIT.usage);
  return n;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function projectHint(code: string): string | undefined {
  switch (code) {
    case 'not_git':
      return 'pass --allow-non-git to register a folder that is not a git repo';
    case 'duplicate':
      return 'see `pagr projects`';
    case 'forbidden_root':
      return 'pick a specific project folder, not your home directory or a system path';
    default:
      return undefined;
  }
}

/** id → display name → alias, case-insensitively. Ambiguity is reported, never guessed. */
export function matchProjects(list: ProjectRecord[], ref: string): ProjectRecord[] {
  const lc = ref.trim().toLowerCase();
  const byId = list.filter((p) => p.projectId === ref);
  if (byId.length) return byId;
  const byName = list.filter((p) => p.displayName.toLowerCase() === lc);
  if (byName.length) return byName;
  return list.filter((p) => p.aliases.some((a) => a.toLowerCase() === lc));
}

export async function runProjectRemove(ctx: CliContext, ref: string): Promise<void> {
  const list = await listProjects(ctx);
  const hits = matchProjects(list, ref);
  if (hits.length === 0)
    throw new CliError(`no project matches "${ref}"`, EXIT.precondition, 'see `pagr projects`');
  if (hits.length > 1)
    throw new CliError(
      `"${ref}" matches ${hits.length} projects: ${hits.map((h) => h.projectId).join(', ')}`,
      EXIT.precondition,
      'remove it by id',
    );
  const rec = hits[0] as ProjectRecord;
  if (await viaDaemon(ctx)) await ipc(ctx).call('projects.remove', { projectId: rec.projectId });
  else registry(ctx).remove(rec.projectId);
  if (ctx.json) {
    printJson(ctx, { removed: rec.projectId });
    return;
  }
  ctx.out(ok(`removed ${bold(rec.displayName)} (${rec.projectId})`));
}

export function registerProjects(program: Command, getCtx: () => CliContext): void {
  program
    .command('projects')
    .description('list registered projects, with any live session')
    .action(() => runProjects(getCtx()));
  const p = program
    .command('project')
    .description('make a folder reachable from Pagr, scan for repos, or remove a project');
  p.command('use [path]')
    .description('make a folder reachable now, registering it if needed (default: this folder)')
    .action((path: string | undefined) => runProjectUse(getCtx(), path ?? process.cwd()));
  p.command('add [path]')
    .description('register a folder under a name you choose (default: current directory)')
    .option('-n, --name <alias>', 'display name (default: folder name, or the git repo name)')
    .option('--alias <a,b>', 'comma-separated extra aliases for iMessage')
    .option('--allow-non-git', 'allow a folder without a .git directory')
    .action((path: string | undefined, opts: AddOptions) =>
      runProjectAdd(getCtx(), path ?? process.cwd(), opts),
    );
  p.command('scan [roots...]')
    .description('find git repos under a few folders and register them in one go')
    .option('--all', 'register everything found, without asking')
    .option('--dry-run', 'show what would be registered and change nothing')
    .option('--depth <n>', 'how deep to walk each root (default 3)')
    .option('--limit <n>', 'stop after this many repositories (default 500)')
    .action((roots: string[], opts: ScanOptions) => runProjectScan(getCtx(), roots ?? [], opts));
  p.command('remove <aliasOrId>')
    .alias('rm')
    .description('unregister a project by id, name or alias')
    .action((ref: string) => runProjectRemove(getCtx(), ref));
}
