import { Command, CommanderError } from 'commander';
import { registerBilling } from './commands/billing.js';
import { registerClaude } from './commands/claude.js';
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
import { EXIT, toCliError } from './errors.js';
import { bad, dim } from './output.js';

export type { CliContext, ContextOverrides } from './context.js';
export { CliError, EXIT, toCliError } from './errors.js';

/**
 * `--json` and `--home` are global, but commander only parses options declared on the command
 * that is actually running. Declaring them on every leaf too means `pagr doctor --json` works
 * as well as `pagr --json doctor`, which is what everyone types.
 */
function addGlobalFlags(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (sub.commands.length > 0) {
      addGlobalFlags(sub);
      continue;
    }
    const declared = new Set(sub.options.map((o) => o.long));
    if (!declared.has('--json')) sub.option('--json', 'machine-readable output where supported');
    if (!declared.has('--home')) sub.option('--home <dir>', 'override PAGR_HOME (default ~/.pagr)');
    addGlobalFlags(sub);
  }
}

/**
 * `exitOverride()` only applies to the command it is called on. Without this recursion,
 * `pagr daemon logs --bogus` (or any subcommand `--help`) called `process.exit()` directly,
 * bypassing the documented exit codes entirely and killing any embedder.
 */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

interface BuiltProgram {
  program: Command;
  getCtx: () => CliContext;
}

function build(overrides: ContextOverrides = {}): BuiltProgram {
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
    .hook('preAction', (_thisCommand, actionCommand) => {
      const opts = actionCommand.optsWithGlobals<{ json?: boolean; home?: string }>();
      ctx = opts.home ? withHome(base, opts.home, overrides) : base;
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
  registerClaude(program, getCtx);
  registerLogout(program, getCtx);
  addGlobalFlags(program);
  return { program, getCtx };
}

/** Build the `pagr` program. `overrides` inject test seams (home, exec, fetch, output…). */
export function createProgram(overrides: ContextOverrides = {}): Command {
  return build(overrides).program;
}

/** Parse + run; returns the exit code instead of exiting (bin.ts does the exit). */
export async function run(argv: string[], overrides: ContextOverrides = {}): Promise<number> {
  const { program, getCtx } = build(overrides);
  applyExitOverride(program);
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
    const cliError = toCliError(e);
    // `--json` contract: stdout carries exactly one JSON document, success or failure. Commands
    // that already printed their own document raise a CliError with an empty message.
    if (getCtx().json && cliError.message) {
      getCtx().out(JSON.stringify(cliError.toJson(), null, 2));
      return cliError.exitCode;
    }
    if (cliError.message) err(bad(cliError.message));
    if (cliError.detail) err(dim(`  ${cliError.detail}`));
    if (cliError.hint) err(dim(`  ${cliError.hint}`));
    if (overrides.env?.PAGR_DEBUG === '1' || process.env.PAGR_DEBUG === '1')
      err(dim(String(e instanceof Error ? e.stack : '')));
    return cliError.exitCode;
  }
}
