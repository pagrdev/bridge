import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { hookState, installHookForUser, removeHookForUser } from '../claudeHook.js';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { bad, bold, dim, ok, printJson, warn } from '../output.js';

/**
 * `pagr claude channel-setup` — wire the Pagr channel server into a project's `.mcp.json`.
 *
 * Claude Code channels are a research preview and custom channels are NOT on Anthropic's
 * approved allowlist, so this only works with `--dangerously-load-development-channels`
 * (ADR 0001 `approved-channel`). Nothing here changes the default `cli-hooks` behaviour.
 */

/** Key under `mcpServers`; also the name used after `server:` on the Claude Code command line. */
export const MCP_SERVER_KEY = 'pagr';
export const MCP_CONFIG_FILE = '.mcp.json';

export const LAUNCH_COMMAND = `claude --dangerously-load-development-channels server:${MCP_SERVER_KEY}`;

export const PREVIEW_WARNING = [
  'Claude Code channels are a RESEARCH PREVIEW.',
  'Custom channels are not on Anthropic’s approved allowlist, so this path requires',
  '`--dangerously-load-development-channels`, which Claude Code guards with a full-screen',
  'warning dialog. Anyone who can send you a Pagr message can then also approve or deny tool',
  'use in that session. Use it for local development only; Pagr does not depend on it.',
].join('\n  ');

/**
 * The plain-language explanation. Users hit `--dangerously-…` and reasonably stop; this is the
 * text that has to make the trade-off legible before they type it.
 */
export const CHANNEL_EXPLAINER = [
  'What a channel is',
  '  Normally Pagr talks to Claude Code by starting its own `claude` process. While that',
  '  process is mid-answer there is no way in, so a follow-up you text is QUEUED and delivered',
  '  when the current turn finishes.',
  '',
  '  A "channel" is a Claude Code extension point that lets an outside program push text into a',
  '  session that is already running — including yours, the one in your own terminal. With a',
  '  channel attached, a follow-up you text INTERRUPTS the turn instead of waiting for it.',
  '',
  'What the preview flag means',
  '  Channels are a research preview and only Anthropic-approved channels load normally. Pagr’s',
  '  is not on that list, so Claude Code will only load it when you start it with',
  '  `--dangerously-load-development-channels` and accept a full-screen warning. That warning is',
  '  real: while the channel is attached, anyone who can text your Pagr number can inject',
  '  instructions into that session and answer its permission prompts.',
  '',
  'What Pagr does without it',
  '  Everything else works exactly the same. The only difference is that follow-ups queue',
  '  instead of steering, and `pagr doctor` says which of the two you are getting.',
].join('\n');

/** Exactly what `channel-setup` adds under `mcpServers` — printed before anything is written. */
export const mcpEntryFor = (serverPath: string) => ({
  [MCP_SERVER_KEY]: { command: 'node', args: [serverPath] },
});

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Read `.mcp.json`, refusing to touch anything that is not a JSON object. */
export function readMcpConfig(file: string): McpConfig {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${file}: ${(err as Error).message}`, EXIT.error);
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${(err as Error).message})`,
      EXIT.precondition,
      'fix or move the file; pagr will not overwrite an MCP config it cannot parse',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new CliError(`${file} does not contain a JSON object`, EXIT.precondition);
  return parsed as McpConfig;
}

/** Add/replace only the `pagr` entry. Every other server and top-level key is preserved. */
export function mergeMcpConfig(config: McpConfig, serverPath: string): McpConfig {
  const servers = { ...(config.mcpServers ?? {}) };
  servers[MCP_SERVER_KEY] = { command: 'node', args: [serverPath] };
  return { ...config, mcpServers: servers };
}

/** Remove only the `pagr` entry. Returns null when there was nothing to remove. */
export function removeMcpEntry(config: McpConfig): McpConfig | null {
  if (!config.mcpServers || !(MCP_SERVER_KEY in config.mcpServers)) return null;
  const servers = { ...config.mcpServers };
  delete servers[MCP_SERVER_KEY];
  return { ...config, mcpServers: servers };
}

export function writeMcpConfig(file: string, config: McpConfig): void {
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Absolute path of the built channel server. `@pagr/claude-channel` is a separate, optional
 * package: the daemon and CLI work without it, so a missing install is a precondition error
 * with an install hint rather than a crash.
 */
export function resolveChannelServer(ctx: CliContext, override?: string): string {
  const explicit = override ?? ctx.env.PAGR_CHANNEL_SERVER;
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(p)) throw new CliError(`no channel server at ${p}`, EXIT.precondition);
    return p;
  }
  try {
    return createRequire(import.meta.url).resolve('@pagr/claude-channel/server');
  } catch {
    throw new CliError(
      'the Pagr channel server is not installed',
      EXIT.precondition,
      'install it with `npm i -g @pagr/claude-channel`, or pass --server <path to server.mjs>',
    );
  }
}

export interface ChannelSetupOptions {
  project?: string;
  remove?: boolean;
  server?: string;
  dryRun?: boolean;
  explain?: boolean;
}

export async function runChannelSetup(ctx: CliContext, opts: ChannelSetupOptions): Promise<void> {
  const projectDir = resolve(opts.project ?? process.cwd());
  if (!existsSync(projectDir))
    throw new CliError(`no such directory: ${projectDir}`, EXIT.precondition);
  const file = join(projectDir, MCP_CONFIG_FILE);
  const config = readMcpConfig(file);

  if (opts.remove) {
    const next = removeMcpEntry(config);
    if (!next) {
      if (ctx.json) printJson(ctx, { project: projectDir, file, removed: false });
      else ctx.out(warn(`no \`${MCP_SERVER_KEY}\` entry in ${file}`));
      return;
    }
    writeMcpConfig(file, next);
    if (ctx.json) printJson(ctx, { project: projectDir, file, removed: true });
    else {
      ctx.out(ok(`removed \`${MCP_SERVER_KEY}\` from ${file}`));
      ctx.out(dim('  other MCP servers in that file were left untouched'));
    }
    return;
  }

  const serverPath = resolveChannelServer(ctx, opts.server);
  const entry = mcpEntryFor(serverPath);
  const next = mergeMcpConfig(config, serverPath);
  const existed = Boolean(config.mcpServers && MCP_SERVER_KEY in config.mcpServers);
  if (!opts.dryRun) writeMcpConfig(file, next);

  if (ctx.json) {
    printJson(ctx, {
      project: projectDir,
      file,
      written: !opts.dryRun,
      dryRun: Boolean(opts.dryRun),
      alreadyPresent: existed,
      serverPath,
      serverKey: MCP_SERVER_KEY,
      mcpEntry: entry,
      otherServers: Object.keys(config.mcpServers ?? {}).filter((k) => k !== MCP_SERVER_KEY),
      launchCommand: LAUNCH_COMMAND,
      env: { PAGR_CLAUDE_CHANNEL: '1' },
      researchPreview: true,
      explanation: CHANNEL_EXPLAINER,
      warning: PREVIEW_WARNING.replace(/\n\s+/g, ' '),
    });
    return;
  }

  ctx.out(CHANNEL_EXPLAINER);
  ctx.out('');
  ctx.out(bold(opts.dryRun ? `Would add to ${file}:` : `Added to ${file}:`));
  for (const line of JSON.stringify({ mcpServers: entry }, null, 2).split('\n'))
    ctx.out(dim(`  ${line}`));
  const others = Object.keys(config.mcpServers ?? {}).filter((k) => k !== MCP_SERVER_KEY);
  ctx.out(
    dim(
      others.length
        ? `  every other key is preserved (${others.join(', ')} stay as they are)`
        : '  no other key in that file is touched',
    ),
  );
  ctx.out('');
  if (opts.dryRun) {
    ctx.out(warn('--dry-run: nothing was written'));
    return;
  }
  ctx.out(ok(`wrote \`${MCP_SERVER_KEY}\` into ${file}`));
  ctx.out('');
  ctx.out(warn(bold('research preview')));
  ctx.out(dim(`  ${PREVIEW_WARNING}`));
  ctx.out('');
  ctx.out('Then, in this project:');
  ctx.out(`  ${bold(LAUNCH_COMMAND)}`);
  ctx.out('');
  ctx.out(dim('  Being in .mcp.json is not enough — the server must also be named on the'));
  ctx.out(dim('  command line. Restart the daemon with PAGR_CLAUDE_CHANNEL=1 so it accepts'));
  ctx.out(dim('  the channel and steers this project live instead of queueing follow-ups.'));
  ctx.out(dim('  `pagr doctor` will then say whether steering is actually reachable.'));
}

/**
 * `pagr claude hook-install` / `hook-remove` — the manual half of the `PermissionRequest` hook.
 *
 * `pagr connect` and `pagr daemon install` do this for you. These exist for the two cases they
 * cannot: you already have a PermissionRequest hook of your own and want Pagr's alongside it
 * (`--force`), or you want Pagr's out without logging out.
 */
export function runHookInstall(ctx: CliContext, opts: { force?: boolean }): void {
  const { action, report } = installHookForUser(ctx, (l) => ctx.out(l), {
    ...(opts.force ? { force: true } : {}),
  });
  if (ctx.json) {
    printJson(ctx, { action, ...(report ?? {}) });
    return;
  }
  if (action === 'already-installed')
    ctx.out(ok(`already installed ${dim(report?.settingsPath ?? '')}`));
  if (action === 'failed')
    throw new CliError('the Claude Code settings file could not be read', EXIT.state, {
      code: 'claude_settings_unreadable',
      hint: 'fix the JSON in that file, then run `pagr claude hook-install` again',
    });
}

export function runHookRemove(ctx: CliContext): void {
  const report = removeHookForUser(ctx, (l) => ctx.out(l));
  if (ctx.json) {
    printJson(ctx, report);
    return;
  }
  ctx.out(
    report.removed.length > 0
      ? ok('the Pagr hook is out of your Claude Code settings')
      : warn('there was no Pagr hook in your Claude Code settings'),
  );
}

export function runHookStatus(ctx: CliContext): void {
  const state = hookState(ctx);
  if (ctx.json) {
    printJson(ctx, state);
    return;
  }
  ctx.out(
    state.entryInstalled
      ? ok(`installed ${dim(state.settingsPath)}`)
      : state.problem
        ? bad(state.problem)
        : warn(`not installed ${dim(state.settingsPath)}`),
  );
  if (state.conflict.length > 0)
    ctx.out(
      warn(`you also have PermissionRequest hooks of your own: ${state.conflict.join(', ')}`),
    );
}

export function registerClaude(program: Command, getCtx: () => CliContext): void {
  const c = program.command('claude').description('Claude Code integration helpers');
  c.command('hook-install')
    .description('register the Pagr PermissionRequest hook in ~/.claude/settings.json')
    .option('--force', 'install even when you already have a PermissionRequest hook of your own')
    .action((opts: { force?: boolean }) => runHookInstall(getCtx(), opts));
  c.command('hook-remove')
    .description('remove the Pagr PermissionRequest hook, leaving the rest of the file alone')
    .action(() => runHookRemove(getCtx()));
  c.command('hook-status')
    .description('report whether the Pagr PermissionRequest hook is installed')
    .action(() => runHookStatus(getCtx()));
  c.command('channel-setup')
    .description(
      'wire the Pagr channel server into a project .mcp.json (research preview, dev flag only)',
    )
    .option('--project <path>', 'project directory (default: cwd)')
    .option('--server <path>', 'path to the built channel server.mjs')
    .option('--remove', 'remove the pagr entry instead of adding it')
    .option('--dry-run', 'explain and show the exact .mcp.json change without writing it')
    .action((opts: ChannelSetupOptions) => runChannelSetup(getCtx(), opts));
}
