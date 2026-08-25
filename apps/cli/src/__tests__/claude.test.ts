import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let root: string;
let project: string;
let serverPath: string;

const mcpFile = () => join(project, '.mcp.json');
const readMcp = () => JSON.parse(readFileSync(mcpFile(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-chan-cli-')));
  project = join(root, 'app');
  mkdirSync(project, { recursive: true });
  serverPath = join(root, 'server.mjs');
  writeFileSync(serverPath, '// fake channel server\n');
  h = harness();
});
afterEach(() => {
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const setup = (extra: string[] = []) =>
  h.run(['claude', 'channel-setup', '--project', project, '--server', serverPath, ...extra]);

describe('pagr claude channel-setup', () => {
  it('writes the pagr MCP server entry', async () => {
    expect(await setup()).toBe(EXIT.ok);
    expect(readMcp()).toEqual({
      mcpServers: { pagr: { command: 'node', args: [serverPath] } },
    });
  });

  it('merges into an existing .mcp.json without clobbering anything', async () => {
    writeFileSync(
      mcpFile(),
      JSON.stringify({
        mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'] } },
        someOtherKey: { keep: true },
      }),
    );
    expect(await setup()).toBe(EXIT.ok);
    const cfg = readMcp() as {
      mcpServers: Record<string, unknown>;
      someOtherKey: unknown;
    };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['linear', 'pagr']);
    expect(cfg.mcpServers.linear).toEqual({ command: 'npx', args: ['-y', 'linear-mcp'] });
    expect(cfg.someOtherKey).toEqual({ keep: true });
  });

  it('is idempotent', async () => {
    await setup();
    const first = readFileSync(mcpFile(), 'utf8');
    await setup();
    expect(readFileSync(mcpFile(), 'utf8')).toBe(first);
  });

  it('prints the launch line and a loud research-preview warning', async () => {
    await setup();
    const out = plain(h.stdout);
    expect(out).toContain('claude --dangerously-load-development-channels server:pagr');
    expect(out).toContain('RESEARCH PREVIEW');
    expect(out).toContain('PAGR_CLAUDE_CHANNEL=1');
  });

  it('emits a machine-readable summary with --json', async () => {
    expect(
      await h.run([
        '--json',
        'claude',
        'channel-setup',
        '--project',
        project,
        '--server',
        serverPath,
      ]),
    ).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      project,
      serverKey: 'pagr',
      serverPath,
      launchCommand: 'claude --dangerously-load-development-channels server:pagr',
      researchPreview: true,
    });
  });

  it('takes the server path from PAGR_CHANNEL_SERVER', async () => {
    const g = harness({ env: { HOME: root, PATH: '/usr/bin', PAGR_CHANNEL_SERVER: serverPath } });
    try {
      expect(await g.run(['claude', 'channel-setup', '--project', project])).toBe(EXIT.ok);
      expect(readMcp()).toMatchObject({ mcpServers: { pagr: { args: [serverPath] } } });
    } finally {
      g.cleanup();
    }
  });
});

describe('pagr claude channel-setup --remove', () => {
  it('removes only the pagr entry', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await setup();
    expect(await setup(['--remove'])).toBe(EXIT.ok);
    expect(readMcp()).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('is a no-op when there is nothing to remove', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: {} }));
    expect(await setup(['--remove'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('no `pagr` entry');
    expect(readMcp()).toEqual({ mcpServers: {} });
  });

  it('does not need the channel server to be installed', async () => {
    const g = harness({ env: { HOME: root, PATH: '/usr/bin' } });
    try {
      writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { pagr: { command: 'node' } } }));
      expect(await g.run(['claude', 'channel-setup', '--project', project, '--remove'])).toBe(
        EXIT.ok,
      );
      expect(readMcp()).toEqual({ mcpServers: {} });
    } finally {
      g.cleanup();
    }
  });
});

describe('refusals', () => {
  it('never overwrites a .mcp.json it cannot parse', async () => {
    writeFileSync(mcpFile(), '{ this is not json');
    expect(await setup()).toBe(EXIT.precondition);
    expect(readFileSync(mcpFile(), 'utf8')).toBe('{ this is not json');
  });

  it('rejects a .mcp.json that is not an object', async () => {
    writeFileSync(mcpFile(), '["nope"]');
    expect(await setup()).toBe(EXIT.precondition);
  });

  it('errors when the server path does not exist', async () => {
    expect(
      await h.run([
        'claude',
        'channel-setup',
        '--project',
        project,
        '--server',
        join(root, 'missing.mjs'),
      ]),
    ).toBe(EXIT.precondition);
  });

  it('errors when the project directory does not exist', async () => {
    expect(
      await h.run([
        'claude',
        'channel-setup',
        '--project',
        join(root, 'nope'),
        '--server',
        serverPath,
      ]),
    ).toBe(EXIT.precondition);
  });
});
