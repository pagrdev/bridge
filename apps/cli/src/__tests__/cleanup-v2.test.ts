import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getPaths, PRIVATE_KEY_SECRET } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { type Harness, harness, plain } from './helpers.js';

let h: Harness;

const DEV = `dev_${'a'.repeat(32)}`;
const KID = 'aabb:ccdd:eeff:0011';

/** Every file under `dir`, as `/`-joined relative paths, sorted. Directories are not listed. */
function inventory(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Everything protocol v2 put on this disk, as a paired Mac would have it. The point of writing it
 * by hand is that the test states the inventory rather than asking the code what it made.
 */
function seedV2Home(home: string, claudeHome: string): void {
  const p = getPaths(home);
  mkdirSync(p.journalDir, { recursive: true });
  mkdirSync(p.runDir, { recursive: true });
  mkdirSync(p.hooksDir, { recursive: true });
  writeFileSync(
    p.configFile,
    JSON.stringify({
      deviceId: DEV,
      userId: `usr_${'b'.repeat(32)}`,
      gatewayUrl: 'wss://gw.example',
      serverKeys: { k1: 'AAAA' },
      // The phones this Mac was sealing to. A logout that left these behind would leave a
      // pairing's key material on a Mac that is no longer in the pairing.
      recipientKeys: { [KID]: 'BBBB' },
      recipientKeysUpdatedAt: '2026-09-17T00:00:00.000Z',
    }),
  );
  writeFileSync(p.sessionsFile, '{}');
  writeFileSync(p.replayFile, '{"nonces":[]}');
  writeFileSync(p.policyFile, '{}');
  writeFileSync(p.projectsFile, '{}');
  // Plaintext transcript: what you typed and what the agent said.
  writeFileSync(join(p.journalDir, 'ses_1.log'), '{"seq":1,"body":{"kind":"assistant"}}\n');
  writeFileSync(join(p.journalDir, 'ses_1.idx'), '0\n');
  writeFileSync(p.outboxFile, '{"ses_1":{"sent":1,"acked":1}}');
  writeFileSync(join(home, 'tailer-state.json'), '{"/x.jsonl":{"offset":10}}');
  // The agents' own files, which are never ours to remove.
  mkdirSync(join(claudeHome, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(claudeHome, '.claude', 'projects', 'a.jsonl'), '{}\n');
  writeFileSync(join(claudeHome, '.claude', 'settings.json'), '{"hooks":{}}');
  mkdirSync(join(claudeHome, '.codex'), { recursive: true });
  writeFileSync(join(claudeHome, '.codex', 'auth.json'), '{}');
  writeFileSync(join(claudeHome, '.codex', 'config.toml'), '');
}

beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const out = () => plain(h.stdout);
/** The harness puts `HOME` one level above `~/.pagr`, which is where `~/.claude` belongs too. */
const realHome = () => join(h.home, '..');

/**
 * What a teardown leaves behind.
 *
 * Eleven PRs added state to this Mac — a journal of plaintext transcripts, transcript read
 * cursors, pinned phone keys, a user-scope MCP registration, a permission hook, a power
 * assertion. Every one of them has to go when the pairing does, and nothing belonging to Claude
 * Code or Codex may go with it.
 */
describe('logout and uninstall remove everything v2 added', () => {
  it('logout takes the journal, the tailer state, the replay set and the pinned phone keys', async () => {
    seedV2Home(h.home, realHome());
    const p = getPaths(h.home);
    await h.store.set(PRIVATE_KEY_SECRET, 'pem');
    const before = inventory(h.home);
    expect(before).toContain('journal/ses_1.log');
    expect(before).toContain('tailer-state.json');

    expect(await h.run(['logout'])).toBe(EXIT.ok);

    const after = inventory(h.home);
    expect(after).not.toContain('journal/ses_1.log');
    expect(after).not.toContain('journal/ses_1.idx');
    expect(after).not.toContain('journal/outbox.json');
    expect(after).not.toContain('tailer-state.json');
    expect(after).not.toContain('replay.json');
    expect(after).not.toContain('sessions.json');
    // `recipientKeys` lived in config.json, and config.json is the pairing.
    expect(existsSync(p.configFile)).toBe(false);
    expect(await h.store.get(PRIVATE_KEY_SECRET)).toBeNull();
    // A logout is not a purge: the projects you registered are yours, not the pairing's.
    expect(after).toContain('projects.json');
  });

  it('logout leaves ~/.claude and ~/.codex exactly as it found them', async () => {
    seedV2Home(h.home, realHome());
    const claudeBefore = inventory(join(realHome(), '.claude'));
    const codexBefore = inventory(join(realHome(), '.codex'));
    expect(await h.run(['logout', '--purge'])).toBe(EXIT.ok);
    expect(inventory(join(realHome(), '.claude'))).toEqual(claudeBefore);
    expect(inventory(join(realHome(), '.codex'))).toEqual(codexBefore);
  });

  it('logout asks Claude Code to drop the user-scope `pagr` MCP server', async () => {
    seedV2Home(h.home, realHome());
    // `claude mcp get pagr` answering means there IS a registration to remove.
    h.execImpl = (file, args) => {
      if (file === 'claude' && args[1] === 'get')
        return '  Args: /opt/pagr/dist/channel-server.mjs';
      return '';
    };
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(h.execCalls).toContainEqual(['claude', 'mcp', 'remove', '--scope', 'user', 'pagr']);
  });

  it('`daemon uninstall` removes the hook and the MCP entry but keeps the pairing', async () => {
    seedV2Home(h.home, realHome());
    const p = getPaths(h.home);
    h.execImpl = (file, args) => {
      if (file === 'claude' && args[1] === 'get')
        return '  Args: /opt/pagr/dist/channel-server.mjs';
      return '';
    };
    expect(await h.run(['daemon', 'uninstall'])).toBe(EXIT.ok);
    expect(h.execCalls).toContainEqual(['claude', 'mcp', 'remove', '--scope', 'user', 'pagr']);
    // Deliberately NOT a logout: the launch agent goes, the device key and journal stay, and
    // `pagr daemon install` puts it back without re-pairing.
    expect(existsSync(p.configFile)).toBe(true);
    expect(existsSync(join(p.journalDir, 'ses_1.log'))).toBe(true);
    expect(out()).toContain('launch agent');
  });

  it('`pagr uninstall --yes` leaves nothing of ~/.pagr at all', async () => {
    seedV2Home(h.home, realHome());
    expect(await h.run(['uninstall', '--yes'])).toBe(EXIT.ok);
    expect(existsSync(h.home)).toBe(false);
    // And still nothing of the agents'.
    expect(existsSync(join(realHome(), '.claude', 'projects', 'a.jsonl'))).toBe(true);
    expect(existsSync(join(realHome(), '.codex', 'config.toml'))).toBe(true);
  });

  it('a logout on a Mac with no journal and no tailer state is still a clean exit', async () => {
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(out()).toContain('session journals');
  });
});
