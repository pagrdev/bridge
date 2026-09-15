import { describe, expect, it } from 'vitest';
import {
  ClaudeProcess,
  DEFAULT_SETTING_SOURCES,
  READ_ONLY_DISALLOWED_TOOLS,
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
function argvFor(readOnly: boolean, settingSources?: string): string[] {
  const p = new ClaudeProcess({
    command: ['/bin/echo'],
    cwd: '/tmp',
    env: {},
    session: { kind: 'new', id: 'abc' },
    readOnly,
    ...(settingSources ? { settingSources } : {}),
    logger: new FileLogger(null),
  });
  p.start();
  const args = (p as unknown as { child: { spawnargs: string[] } }).child.spawnargs;
  void p.stop();
  return args;
}

describe('claude argv', () => {
  it('never lets the project grant its own permissions (SEC-3)', () => {
    const argv = argvFor(false);
    // Without these, `claude -p` reads the cloned repo's `.claude/settings.json` and `.mcp.json`,
    // so a repo shipping `permissions.allow: ["Bash(*)"]` or a PreToolUse hook that returns allow
    // means no approval is ever raised and the user is never asked.
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe(DEFAULT_SETTING_SOURCES);
    expect(DEFAULT_SETTING_SOURCES.split(',')).not.toContain('project');
  });

  it('lets the operator tighten setting sources further', () => {
    const argv = argvFor(false, 'user');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
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
