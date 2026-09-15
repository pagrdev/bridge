import { describe, expect, it } from 'vitest';
import {
  ClaudeProcess,
  DEFAULT_SETTING_SOURCES,
  READ_ONLY_DISALLOWED_TOOLS,
  SEALED_SETTING_SOURCES,
  sealedModeEnabled,
} from './claude-process.js';
import { FileLogger } from './logger.js';

/**
 * The exact argv the bridge hands `claude`. Two of these flags are the whole of SEC-3 and SEC-6,
 * so they are pinned here as well as in the fake-claude fixture: a refactor that drops one should
 * fail a test that says why, not merely stop being safe.
 *
 * Spawns `/bin/echo` and reads `spawnargs` back off the child, so this asserts what would really
 * be executed rather than re-deriving it.
 */
function argvFor(readOnly: boolean, settingSources?: string, sealed?: boolean): string[] {
  const p = new ClaudeProcess({
    command: ['/bin/echo'],
    cwd: '/tmp',
    env: {},
    session: { kind: 'new', id: 'abc' },
    readOnly,
    ...(settingSources ? { settingSources } : {}),
    ...(sealed === undefined ? {} : { sealed }),
    logger: new FileLogger(null),
  });
  p.start();
  const args = (p as unknown as { child: { spawnargs: string[] } }).child.spawnargs;
  void p.stop();
  return args;
}

describe('claude argv', () => {
  it("honours the whole of the person's own configuration by default", () => {
    const argv = argvFor(false);
    // Pagr does not get to decide which of someone's Claude Code settings count. A session the
    // bridge starts reads the same user, project and local settings their own `claude` reads, so
    // the repo's `.claude/settings.json` — the file their team wrote and they chose to clone —
    // applies here too.
    expect(DEFAULT_SETTING_SOURCES.split(',')).toEqual(['user', 'project', 'local']);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    // …and their MCP servers come with it: `--strict-mcp-config` would drop every server they
    // configured, which is part of the same configuration.
    expect(argv).not.toContain('--strict-mcp-config');
  });

  it("sealed mode drops the project's settings and MCP servers together", () => {
    const argv = argvFor(false, undefined, true);
    expect(SEALED_SETTING_SOURCES.split(',')).not.toContain('project');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe(SEALED_SETTING_SOURCES);
    // Both flags are one switch: a repo that cannot grant itself a permission must not be able to
    // hand itself a tool through `.mcp.json` either.
    expect(argv).toContain('--strict-mcp-config');
  });

  it('reads sealed mode from PAGR_CLAUDE_SEALED, off unless it is explicitly on', () => {
    expect(sealedModeEnabled({})).toBe(false);
    expect(sealedModeEnabled({ PAGR_CLAUDE_SEALED: '' })).toBe(false);
    expect(sealedModeEnabled({ PAGR_CLAUDE_SEALED: '0' })).toBe(false);
    expect(sealedModeEnabled({ PAGR_CLAUDE_SEALED: '1' })).toBe(true);
  });

  it('lets the operator name setting sources explicitly, sealed or not', () => {
    expect(argvFor(false, 'user')[argvFor(false, 'user').indexOf('--setting-sources') + 1]).toBe(
      'user',
    );
    // An explicit list wins over sealed mode's default list, but not over its MCP rule.
    const argv = argvFor(false, 'user', true);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('a read-only session has no tool that can write, Bash included (SEC-6/BR-9)', () => {
    const argv = argvFor(true);
    const denied = (argv[argv.indexOf('--disallowedTools') + 1] ?? '').split(',');
    // `concurrency.ts` records a read-only session as `writeCapable: false` and lets a second
    // writer share the checkout on the strength of it. That is only true if none of these is
    // available: `Bash` alone is a write path (`sed -i`, `tee`, `>`), and a subagent is a fresh
    // tool budget.
    for (const tool of [
      'Bash',
      'BashOutput',
      'KillShell',
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
    ])
      expect(denied, tool).toContain(tool);
    expect(READ_ONLY_DISALLOWED_TOOLS.split(',')).toEqual(denied);
    // Variadic flag: nothing may follow it or `claude` swallows it into the tool list.
    expect(argv.at(-1)).toBe(READ_ONLY_DISALLOWED_TOOLS);
  });

  it('a write-capable session is not given a deny list at all', () => {
    expect(argvFor(false)).not.toContain('--disallowedTools');
  });
});
