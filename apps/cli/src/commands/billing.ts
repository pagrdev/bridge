import { readConfig } from '@pagr/bridge-core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { dim, ok, printJson } from '../output.js';
import { resolveWebUrl } from '../urls.js';

export type BillingAction = 'status' | 'upgrade' | 'portal';

/** Billing is browser-only: the CLI never sees card data, Stripe keys or portal credentials. */
export function billingUrl(ctx: CliContext, action: BillingAction, webUrl?: string): string {
  const base = resolveWebUrl(ctx.env, readConfig(ctx.paths.configFile), webUrl);
  const path = action === 'status' ? '/app/billing' : `/app/billing?action=${action}`;
  return `${base}${path}`;
}

export async function runBilling(
  ctx: CliContext,
  action: BillingAction,
  opts: { webUrl?: string; open: boolean },
): Promise<void> {
  const url = billingUrl(ctx, action, opts.webUrl);
  if (ctx.json) {
    printJson(ctx, { action, url });
    return;
  }
  const verb =
    action === 'upgrade'
      ? 'secure checkout'
      : action === 'portal'
        ? 'the billing portal'
        : 'billing';
  ctx.out(ok(`opening ${verb} in your browser…`));
  ctx.out(dim(`  ${url}`));
  if (opts.open) await ctx.openBrowser(url);
}

export function registerBilling(program: Command, getCtx: () => CliContext): void {
  program
    .command('billing [action]')
    .description('open billing in the browser: status (default) | upgrade | portal')
    .option('--web-url <url>', 'dashboard base URL (default: $PAGR_WEB_URL)')
    .option('--no-open', 'print the URL only')
    .action((action: string | undefined, opts: { webUrl?: string; open: boolean }) => {
      const a = (action ?? 'status') as BillingAction;
      if (!['status', 'upgrade', 'portal'].includes(a))
        throw new Error(`unknown billing action "${action}" (status | upgrade | portal)`);
      return runBilling(getCtx(), a, opts);
    });
}
