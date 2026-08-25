import {
  IpcClientError,
  ProjectError,
  type ProjectRecord,
  ProjectRegistry,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, table } from '../output.js';

const registry = (ctx: CliContext) =>
  new ProjectRegistry({ file: ctx.paths.projectsFile, pagrHome: ctx.home });

async function viaDaemon(ctx: CliContext): Promise<boolean> {
  return (await daemonStatus(ctx)) !== null;
}

export async function listProjects(ctx: CliContext): Promise<ProjectRecord[]> {
  if (await viaDaemon(ctx)) return ipc(ctx).call<ProjectRecord[]>('projects.list');
  return registry(ctx).list();
}

export async function runProjects(ctx: CliContext): Promise<void> {
  const list = await listProjects(ctx);
  if (ctx.json) {
    printJson(ctx, list);
    return;
  }
  if (list.length === 0) {
    ctx.out(dim('no projects registered — `pagr project add . --name MyApp`'));
    return;
  }
  ctx.out(
    table(
      list.map((p) => [
        p.projectId,
        bold(p.displayName),
        p.aliases.join(', ') || dim('—'),
        dim(p.path),
      ]),
      ['ID', 'NAME', 'ALIASES', 'PATH'],
    ),
  );
}

export interface AddOptions {
  name?: string;
  alias?: string;
  allowNonGit?: boolean;
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
  let rec: ProjectRecord;
  let live = false;
  try {
    if (await viaDaemon(ctx)) {
      rec = await ipc(ctx).call<ProjectRecord>('projects.add', params);
      live = true;
    } else {
      rec = registry(ctx).add(path, params);
    }
  } catch (err) {
    if (err instanceof ProjectError || err instanceof IpcClientError)
      throw new CliError(err.message, EXIT.precondition, projectHint(err.code));
    throw err;
  }
  if (ctx.json) {
    printJson(ctx, rec);
    return;
  }
  ctx.out(ok(`registered ${bold(rec.displayName)} as ${rec.projectId}`));
  ctx.out(dim(`  ${rec.path}`));
  ctx.out(
    dim(
      live
        ? '  the cloud was told the id + name (never the path)'
        : '  daemon not running: the cloud learns about it on next connect',
    ),
  );
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

export function resolveProject(list: ProjectRecord[], ref: string): ProjectRecord | undefined {
  const lc = ref.toLowerCase();
  return (
    list.find((p) => p.projectId === ref) ??
    list.find((p) => p.displayName.toLowerCase() === lc) ??
    list.find((p) => p.aliases.some((a) => a.toLowerCase() === lc))
  );
}

export async function runProjectRemove(ctx: CliContext, ref: string): Promise<void> {
  const list = await listProjects(ctx);
  const rec = resolveProject(list, ref);
  if (!rec)
    throw new CliError(`no project matches "${ref}"`, EXIT.precondition, 'see `pagr projects`');
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
    .description('list registered projects')
    .action(() => runProjects(getCtx()));
  const p = program.command('project').description('add or remove a project');
  p.command('add [path]')
    .description('register a folder (default: current directory)')
    .option('-n, --name <alias>', 'display name (default: folder name)')
    .option('--alias <a,b>', 'comma-separated extra aliases for iMessage')
    .option('--allow-non-git', 'allow a folder without a .git directory')
    .action((path: string | undefined, opts: AddOptions) =>
      runProjectAdd(getCtx(), path ?? process.cwd(), opts),
    );
  p.command('remove <aliasOrId>')
    .alias('rm')
    .description('unregister a project by id, name or alias')
    .action((ref: string) => runProjectRemove(getCtx(), ref));
}
