import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliContext } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { bold, dim, ok, printJson, warn } from '../output.js';

/**
 * `pagr claude channel-install` — register the Pagr channel server at USER scope.
 *
 * Spike MOB-045 checked both scopes. A user-scope entry (`claude mcp add-json --scope user`) is
 * nameable as `server:pagr` on the channel flag, works in every project, and is the one that
 * avoids Claude Code's extra "New MCP server found in this project" dialog on the first launch in
 * each new project — a project `.mcp.json` gets that dialog on top of the channel warning.
 *
 * `claude mcp add-json` is also the only supported way to write `~/.claude.json`: Claude Code
 * rewrites that whole file, and concurrent sessions were observed overwriting each other's
 * per-project keys during the spike. Nothing here ever opens it.
 */

/** Key under `mcpServers`; also the name used after `server:` on the Claude Code command line. */
export const CHANNEL_SERVER_NAME = 'pagr';
export const DEV_CHANNEL_FLAG = '--dangerously-load-development-channels';
/** Claude Code accepts the flag from 2.1.220, but older builds cannot run the current models. */
export const CLAUDE_VERSION_FLOOR = '2.1.251';

export const LAUNCH_COMMAND = 'pagr claude';

/** The tool call Claude Code asks about when the model answers your phone in manual mode. */
export const REPLY_TOOL_PERMISSION = `mcp__${CHANNEL_SERVER_NAME}__reply`;

/**
 * The built channel server, `dist/channel-server.mjs`, next to this CLI's own `dist`.
 *
 * Resolved from this module rather than looked up in `node_modules`, so a globally installed
 * `pagr` registers the server inside its own install and an upgrade moves both together.
 */
export function channelServerPath(ctx: CliContext, override?: string): string {
  const explicit = override ?? ctx.env.PAGR_CHANNEL_SERVER;
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(p)) throw new CliError(`no channel server at ${p}`, EXIT.precondition);
    return p;
  }
  return fileURLToPath(new URL('../channel-server.mjs', import.meta.url));
}

export const mcpEntryFor = (serverPath: string) => ({ command: 'node', args: [serverPath] });

export interface ChannelRegistration {
  registered: boolean;
  /** The server path the registration points at, when it could be read back. */
  serverPath?: string;
  /** Set when `claude` itself could not be asked (not installed, or it errored). */
  problem?: string;
}

/** What `claude mcp get pagr` says right now. Never throws: an absent `claude` is an answer. */
export function readRegistration(ctx: CliContext): ChannelRegistration {
  let out: string;
  try {
    out = ctx.exec('claude', ['mcp', 'get', CHANNEL_SERVER_NAME], { timeoutMs: 15_000 });
  } catch (err) {
    const message = (err as { stderr?: string; message?: string }).stderr || String(err);
    // `mcp get` exits non-zero for "no such server", which is a normal, expected answer.
    if (/No MCP server found|not found/i.test(message)) return { registered: false };
    return { registered: false, problem: firstLine(message) };
  }
  // `claude mcp get` prints `  Args: <path>`. Taken as the whole rest of the line, because a
  // perfectly ordinary install path contains spaces and a `\S+` match would silently truncate it
  // — and a truncated comparison would re-register on every `pagr connect`.
  const path = /^\s*Args:\s*(.+?)\s*$/m.exec(out)?.[1];
  return { registered: true, ...(path ? { serverPath: path } : {}) };
}

export interface ChannelInstallResult {
  action: 'installed' | 'already-installed' | 'failed';
  serverPath: string;
  serverName: string;
  problem?: string;
}

/**
 * Idempotent: a registration already pointing at this server is left alone, so `pagr connect`
 * can run this every time without rewriting `~/.claude.json` and without a second consent dialog.
 */
export function installChannelRegistration(
  ctx: CliContext,
  opts: { server?: string; force?: boolean } = {},
): ChannelInstallResult {
  const serverPath = channelServerPath(ctx, opts.server);
  const current = readRegistration(ctx);
  if (current.registered && !opts.force && current.serverPath === serverPath)
    return { action: 'already-installed', serverPath, serverName: CHANNEL_SERVER_NAME };
  try {
    // Re-registering replaces the entry; removing first would leave a window where a running
    // Claude Code could reload and find nothing.
    ctx.exec(
      'claude',
      [
        'mcp',
        'add-json',
        '--scope',
        'user',
        CHANNEL_SERVER_NAME,
        JSON.stringify(mcpEntryFor(serverPath)),
      ],
      { timeoutMs: 20_000 },
    );
  } catch (err) {
    const message = (err as { stderr?: string; message?: string }).stderr || String(err);
    return {
      action: 'failed',
      serverPath,
      serverName: CHANNEL_SERVER_NAME,
      problem: firstLine(message),
    };
  }
  return { action: 'installed', serverPath, serverName: CHANNEL_SERVER_NAME };
}

/** Remove the user-scope entry. Returns false when there was nothing registered. */
export function removeChannelRegistration(ctx: CliContext): boolean {
  if (!readRegistration(ctx).registered) return false;
  try {
    ctx.exec('claude', ['mcp', 'remove', '--scope', 'user', CHANNEL_SERVER_NAME], {
      timeoutMs: 20_000,
    });
    return true;
  } catch {
    // `claude` gone, or it refused. Nothing here is worth failing an uninstall over.
    return false;
  }
}

export function runChannelInstall(
  ctx: CliContext,
  opts: { server?: string; force?: boolean },
): void {
  const res = installChannelRegistration(ctx, opts);
  if (ctx.json) {
    printJson(ctx, { ...res, launchCommand: LAUNCH_COMMAND });
    return;
  }
  if (res.action === 'failed')
    throw new CliError(
      `could not register the Pagr channel with Claude Code: ${res.problem ?? 'unknown error'}`,
      EXIT.precondition,
      'check that `claude` is on PATH and `claude mcp list` works, then try again',
    );
  ctx.out(
    ok(
      res.action === 'installed'
        ? `registered \`${CHANNEL_SERVER_NAME}\` at user scope (every project)`
        : `\`${CHANNEL_SERVER_NAME}\` was already registered at user scope`,
    ),
  );
  ctx.out(dim(`  ${res.serverPath}`));
  ctx.out('');
  ctx.out(`Start a session your phone can take a turn in with ${bold(LAUNCH_COMMAND)}.`);
  ctx.out(dim('  Claude Code asks you to confirm development channels on every launch; press'));
  ctx.out(dim('  Enter. Plain `claude` is untouched and its sessions stay approvals-only.'));
}

export function runChannelRemove(ctx: CliContext): void {
  const removed = removeChannelRegistration(ctx);
  if (ctx.json) {
    printJson(ctx, { removed, serverName: CHANNEL_SERVER_NAME });
    return;
  }
  ctx.out(
    removed
      ? ok(`removed \`${CHANNEL_SERVER_NAME}\` from your user-scope MCP servers`)
      : warn(`there was no \`${CHANNEL_SERVER_NAME}\` server registered`),
  );
}

export interface ChannelStatusReport {
  registered: boolean;
  serverPath: string;
  serverInstalled: boolean;
  boundSessions: number | null;
  attachedProjects: string[];
  claudeVersion: string | null;
  versionFloor: string;
  meetsFloor: boolean | null;
  problem?: string;
}

export async function channelStatusReport(
  ctx: CliContext,
  channel: { attachedProjects: string[]; boundSessions?: number } | null,
): Promise<ChannelStatusReport> {
  const serverPath = channelServerPath(ctx);
  const reg = readRegistration(ctx);
  const claudeVersion = claudeVersionOf(ctx);
  return {
    registered: reg.registered,
    serverPath,
    serverInstalled: existsSync(serverPath),
    boundSessions: channel?.boundSessions ?? null,
    attachedProjects: channel?.attachedProjects ?? [],
    claudeVersion,
    versionFloor: CLAUDE_VERSION_FLOOR,
    meetsFloor: claudeVersion ? meetsVersionFloor(claudeVersion, CLAUDE_VERSION_FLOOR) : null,
    ...(reg.problem ? { problem: reg.problem } : {}),
  };
}

/** `claude --version` prints `2.1.274 (Claude Code)`. Null when it is not installed. */
export function claudeVersionOf(ctx: CliContext): string | null {
  try {
    const out = ctx.exec('claude', ['--version'], { timeoutMs: 5000 });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Numeric dotted compare. A version that will not parse is treated as "cannot tell" (true). */
export function meetsVersionFloor(version: string, floor: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10));
  const b = floor.split('.').map((n) => Number.parseInt(n, 10));
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const firstLine = (s: string): string =>
  s
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? s;
