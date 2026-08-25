import { Command, CommanderError } from 'commander';
import { registerBilling } from './commands/billing.js';
import { registerConnect } from './commands/connect.js';
import { registerDaemon } from './commands/daemon.js';
import { registerDoctor } from './commands/doctor.js';
import { registerLogout } from './commands/logout.js';
import { registerProjects } from './commands/projects.js';
import { registerSessions } from './commands/sessions.js';
import { registerStatus } from './commands/status.js';
import {
  CLI_VERSION,
  type CliContext,
  type ContextOverrides,
  createContext,
  withHome,
} from './context.js';
import { CliError, EXIT } from './errors.js';
import { bad, dim } from './output.js';

export type { CliContext, ContextOverrides } from './context.js';
export { CliError, EXIT } from './errors.js';

/** Build the `pagr` program. `overrides` inject test seams (home, exec, fetch, output…). */
export function createProgram(overrides: ContextOverrides = {}): Command {
  const base = createContext(overrides);
  let ctx: CliContext = base;
  const program = new Command('pagr')
    .description('Your coding agents have a phone number. Bridge Claude Code and Codex to Pagr.')
    .version(CLI_VERSION, '-v, --version')
    .option('--json', 'machine-readable output where supported')
    .option('--home <dir>', 'override PAGR_HOME (default ~/.pagr)')
    .showHelpAfterError(dim('(run with --help for usage)'))
    .configureOutput({
      writeOut: (s) => base.out(s.replace(/\n$/, '')),
      writeErr: (s) => base.err(s.replace(/\n$/, '')),
    })
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts<{ json?: boolean; home?: string }>();
      ctx = opts.home ? withHome(base, opts.home) : base;
      ctx.json = Boolean(opts.json);
    });
  const getCtx = () => ctx;
  registerConnect(program, getCtx);
  registerStatus(program, getCtx);
  registerDoctor(program, getCtx);
  registerProjects(program, getCtx);
  registerSessions(program, getCtx);
  registerDaemon(program, getCtx);
  registerBilling(program, getCtx);
  registerLogout(program, getCtx);
  return program;
}

/** Parse + run; returns the exit code instead of exiting (bin.ts does the exit). */
export async function run(argv: string[], overrides: ContextOverrides = {}): Promise<number> {
  const program = createProgram(overrides).exitOverride();
  const err = overrides.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) {
      // help/version print then "exit"; usage errors were already printed by commander.
      if (
        e.code === 'commander.helpDisplayed' ||
        e.code === 'commander.version' ||
        e.code === 'commander.help'
      )
        return EXIT.ok;
      return EXIT.usage;
    }
    if (e instanceof CliError) {
      if (e.message) err(bad(e.message));
      if (e.hint) err(dim(`  ${e.hint}`));
      return e.exitCode;
    }
    const msg = e instanceof Error ? e.message : String(e);
    err(bad(msg));
    if (overrides.env?.PAGR_DEBUG === '1' || process.env.PAGR_DEBUG === '1')
      err(dim(String(e instanceof Error ? e.stack : '')));
    return EXIT.error;
  }
}
