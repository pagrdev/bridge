import type { SessionRecord } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { daemonDownError } from '../errors.js';
import { daemonStatus, ipc } from '../ipc.js';
import { dim, printJson, table } from '../output.js';

export async function runSessions(ctx: CliContext): Promise<void> {
  if (!(await daemonStatus(ctx))) throw daemonDownError();
  const list = await ipc(ctx).call<SessionRecord[]>('sessions.list');
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
      list.map((s) => [s.sessionId, s.provider, s.status, s.projectId, dim(s.updatedAt)]),
      ['SESSION', 'AGENT', 'STATUS', 'PROJECT', 'UPDATED'],
    ),
  );
}

export function registerSessions(program: Command, getCtx: () => CliContext): void {
  program
    .command('sessions')
    .description('list agent sessions known to the daemon')
    .action(() => runSessions(getCtx()));
}
