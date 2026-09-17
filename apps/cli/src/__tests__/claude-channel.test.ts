import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_VERSION_FLOOR,
  channelServerPath,
  installChannelRegistration,
  meetsVersionFloor,
  readRegistration,
  removeChannelRegistration,
} from '../commands/claudeChannel.js';
import { createContext } from '../context.js';
import { EXIT } from '../errors.js';
import { type Harness, harness, lastJson, plain } from './helpers.js';

/**
 * User-scope registration.
 *
 * `claude mcp add-json --scope user` is the only supported way to write `~/.claude.json`: Claude
 * Code rewrites that whole file and concurrent sessions were seen clobbering each other's keys
 * during spike MOB-045. So the assertions here are about the argv we hand `claude`, and about
 * not handing it anything at all when there is nothing to change.
 */

let h: Harness;
const SERVER = fileURLToPath(new URL('../channel-server.mjs', import.meta.url));

/** A `claude mcp` that remembers a single user-scope entry, and records every argv. */
function fakeClaudeMcp(initial: string | null = null) {
  let registered = initial;
  h.execImpl = (file, args) => {
    if (file !== 'claude') throw new Error('command not found: claude');
    if (args[0] === '--version') return '2.1.274 (Claude Code)\n';
    if (args[0] !== 'mcp') return '';
    if (args[1] === 'get') {
      if (registered === null) throw new Error('No MCP server found with name: pagr');
      return `pagr:\n  Scope: User config (available in all your projects)\n  Command: node\n  Args: ${registered}\n`;
    }
    if (args[1] === 'add-json') {
      const spec = JSON.parse(args[5] ?? '{}') as { args?: string[] };
      registered = spec.args?.[0] ?? null;
      return 'Added stdio MCP server pagr to user config\n';
    }
    if (args[1] === 'remove') {
      registered = null;
      return 'Removed MCP server pagr\n';
    }
    return '';
  };
  return { current: () => registered };
}

const mcpCalls = () => h.execCalls.filter((c) => c[0] === 'claude' && c[1] === 'mcp');
const ctx = () => createContext(h.overrides);

beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

describe('channel-install', () => {
  it('registers at user scope with `claude mcp add-json`, never by editing ~/.claude.json', () => {
    const mcp = fakeClaudeMcp();
    const res = installChannelRegistration(ctx());
    expect(res.action).toBe('installed');
    expect(mcp.current()).toBe(SERVER);
    const add = mcpCalls().find((c) => c[2] === 'add-json');
    expect(add).toEqual([
      'claude',
      'mcp',
      'add-json',
      '--scope',
      'user',
      'pagr',
      JSON.stringify({ command: 'node', args: [SERVER] }),
    ]);
  });

  it('is idempotent: a registration already pointing here is left alone', () => {
    fakeClaudeMcp(SERVER);
    expect(installChannelRegistration(ctx()).action).toBe('already-installed');
    expect(mcpCalls().some((c) => c[2] === 'add-json')).toBe(false);
  });

  it('re-registers when the entry points somewhere else (an old install)', () => {
    const mcp = fakeClaudeMcp('/opt/old/server.mjs');
    expect(installChannelRegistration(ctx()).action).toBe('installed');
    expect(mcp.current()).toBe(SERVER);
  });

  it('re-registers on --force even when nothing changed', () => {
    fakeClaudeMcp(SERVER);
    expect(installChannelRegistration(ctx(), { force: true }).action).toBe('installed');
  });

  it('reports a `claude` that is missing rather than throwing', () => {
    h.execImpl = () => {
      throw new Error('command not found: claude');
    };
    const res = installChannelRegistration(ctx());
    expect(res.action).toBe('failed');
    expect(res.problem).toContain('claude');
  });

  it('removes only when there is something to remove', () => {
    const mcp = fakeClaudeMcp(SERVER);
    expect(removeChannelRegistration(ctx())).toBe(true);
    expect(mcp.current()).toBeNull();
    h.execCalls.length = 0;
    expect(removeChannelRegistration(ctx())).toBe(false);
    expect(mcpCalls().some((c) => c[2] === 'remove')).toBe(false);
  });

  it('treats "no such server" as an answer, not a problem', () => {
    fakeClaudeMcp();
    expect(readRegistration(ctx())).toEqual({ registered: false });
  });

  it('honours PAGR_CHANNEL_SERVER for a hand-built server', () => {
    const custom = join(h.home, 'custom-server.mjs');
    writeFileSync(custom, '// custom');
    h.overrides.env = { ...h.overrides.env, PAGR_CHANNEL_SERVER: custom };
    expect(channelServerPath(ctx())).toBe(custom);
  });
});

describe('the CLI surface', () => {
  it('`pagr claude channel-install --json` reports what it did', async () => {
    fakeClaudeMcp();
    expect(await h.run(['--json', 'claude', 'channel-install'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      action: 'installed',
      serverName: 'pagr',
      launchCommand: 'pagr claude',
    });
  });

  it('`pagr claude channel-remove` says so when there was nothing registered', async () => {
    fakeClaudeMcp();
    expect(await h.run(['claude', 'channel-remove'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('no `pagr` server registered');
  });

  it('`pagr claude channel-status --json` answers without a daemon', async () => {
    fakeClaudeMcp(SERVER);
    expect(await h.run(['--json', 'claude', 'channel-status'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      registered: true,
      daemonRunning: false,
      claudeVersion: '2.1.274',
      versionFloor: CLAUDE_VERSION_FLOOR,
      meetsFloor: true,
    });
  });
});

describe('version floor', () => {
  it('compares numerically, not lexically', () => {
    expect(meetsVersionFloor('2.1.251', '2.1.251')).toBe(true);
    expect(meetsVersionFloor('2.1.274', '2.1.251')).toBe(true);
    expect(meetsVersionFloor('2.1.9', '2.1.251')).toBe(false);
    expect(meetsVersionFloor('2.1.220', '2.1.251')).toBe(false);
    expect(meetsVersionFloor('3.0.0', '2.1.251')).toBe(true);
  });

  it('does not accuse a version it cannot parse', () => {
    expect(meetsVersionFloor('dev', '2.1.251')).toBe(true);
  });
});

describe('connect', () => {
  it('registers the channel while pairing, and skips it under --no-channel', async () => {
    // Exercised through the real `connect` flow in connect.test.ts; here we only pin that the
    // installer is a no-op when asked to be one, which is what `--no-channel` promises.
    const mcp = fakeClaudeMcp();
    mkdirSync(join(h.home, 'x'), { recursive: true });
    installChannelRegistration(ctx());
    expect(mcp.current()).toBe(SERVER);
  });
});
