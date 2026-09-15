import {
  isAdopted,
  isLiveStatus,
  type ProjectRecord,
  type SessionRecord,
  UNREGISTERED_PROJECT,
} from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { daemonDownError } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { bold, dim, ok, printJson, table } from '../output.js';

export interface SessionsOptions {
  /** Re-check every session against its provider and clear anything that only claims to run. */
  reconcile?: boolean;
}

interface Reconciled {
  sessionId: string;
  provider: string;
  status: string;
  outcome: string;
  reason: string;
}

export async function runSessions(ctx: CliContext, opts: SessionsOptions = {}): Promise<void> {
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const client = ipc(ctx);

  if (opts.reconcile) {
    const changed = await client.call<Reconciled[]>('sessions.reconcile', undefined, 30_000);
    if (ctx.json) {
      printJson(ctx, changed);
      return;
    }
    if (changed.length === 0) {
      ctx.out(ok('every session matches its provider — nothing to reconcile'));
      return;
    }
    ctx.out(
      table(
        changed.map((c) => [c.sessionId, c.provider, c.outcome, c.status, dim(c.reason)]),
        ['SESSION', 'AGENT', 'OUTCOME', 'NOW', 'WHY'],
      ),
    );
    return;
  }

  const [list, projects] = await Promise.all([
    client.call<SessionRecord[]>('sessions.list'),
    client.call<ProjectRecord[]>('projects.list').catch(() => [] as ProjectRecord[]),
  ]);
  const nameOf = new Map(projects.map((p) => [p.projectId, p.displayName]));
  if (ctx.json) {
    printJson(ctx, list);
    return;
  }
  if (list.length === 0) {
    ctx.out(dim('no sessions'));
    return;
  }
  ctx.out(
    table(
      list.map((s) => [
        s.sessionId,
        s.provider,
        isLiveStatus(s.status) ? bold(s.status) : s.status,
        // A session with no registered project is still real; naming its directory makes the fix
        // obvious instead of leaving an empty cell.
        s.projectId === UNREGISTERED_PROJECT
          ? dim(s.cwd ?? 'no registered project')
          : (nameOf.get(s.projectId) ?? s.projectId),
        isAdopted(s) ? 'yours' : dim('pagr'),
        dim(s.updatedAt),
      ]),
      ['SESSION', 'AGENT', 'STATUS', 'PROJECT', 'STARTED BY', 'UPDATED'],
    ),
  );
  const live = list.filter((s) => isLiveStatus(s.status)).length;
  const adopted = list.filter(isAdopted);
  const unregistered = adopted.filter((s) => s.projectId === UNREGISTERED_PROJECT);
  ctx.out('');
  ctx.out(dim(`${list.length} session(s), ${live} live`));
  if (adopted.length > 0)
    ctx.out(
      dim(
        `${adopted.length} started by you, not by Pagr: it can relay approvals only — no instructions, no stop, no resume`,
      ),
    );
  for (const s of unregistered)
    ctx.out(
      dim(
        `  ${s.cwd ?? 'that directory'} is in no registered project, so its prompts stay in the terminal — \`pagr projects add ${s.cwd ?? '<dir>'}\``,
      ),
    );
}

export function registerSessions(program: Command, getCtx: () => CliContext): void {
  program
    .command('sessions')
    .description('list agent sessions known to the daemon')
    .option(
      '--reconcile',
      'ask each provider what it still knows and clear any session that only claims to run',
    )
    .action((opts: SessionsOptions) => runSessions(getCtx(), opts));
}
