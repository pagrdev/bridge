import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppServerClient } from './app-server.js';
import { FileLogger } from './logger.js';
import type { GetAccountResponse, ThreadStartResponse } from './protocol.js';

/**
 * The one test that talks to the REAL `codex app-server` on this machine. Fixtures prove the
 * bridge's own logic; only this proves the handshake, method names and shapes still match a
 * shipped Codex.
 *
 * It is skipped, not failed, when Codex is absent (CI, a contributor's Linux box) and it never
 * touches the user's `~/.codex`: a temp `CODEX_HOME` is handed to the child, so the run leaves
 * no threads, logs or state behind. Nothing here starts a turn, so it costs no tokens and works
 * whether or not `codex login` has been run.
 */

function codexVersion(): string | null {
  if (process.env.PAGR_SKIP_REAL_CODEX === '1') return null;
  try {
    return execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

const version = codexVersion();
const describeReal = version ? describe : describe.skip;

describeReal(`real codex app-server (${version ?? 'not installed'})`, () => {
  it('handshakes, reports an account, starts a thread in a git repo, and shuts down clean', async () => {
    const codexHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-real-codexhome-')),
    );
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-real-proj-')));
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    const client = new AppServerClient({
      command: ['codex', 'app-server'],
      clientVersion: '0.1.0-test',
      logger: new FileLogger(null),
      requestTimeoutMs: 30_000,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    try {
      // 1. the initialize/initialized handshake the adapter relies on
      const init = await client.start();
      expect(client.running).toBe(true);
      expect(init.userAgent).toContain('pagr-bridge');
      // proof the child really used our isolated home and not the user's
      expect(fs.realpathSync(init.codexHome)).toBe(codexHome);

      // 2. account/read — the call `probe()` uses to decide authStatus
      const account = await client.request<GetAccountResponse>('account/read', {});
      expect(account).toHaveProperty('requiresOpenaiAuth');
      if (!account.account) {
        // Not logged in on this machine: `probe()` would say "run `codex login`".
        expect(account.requiresOpenaiAuth).toBe(true);
      }

      // 3. thread/start with exactly the params CodexAdapter.startSession sends
      const started = await client.request<ThreadStartResponse>('thread/start', {
        cwd: project,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      });
      expect(typeof started.thread.id).toBe('string');
      expect(started.thread.id.length).toBeGreaterThan(0);

      // 4. thread/resume with the params `ensureLoaded()` sends after an app-server restart.
      //    On 0.149.1 a thread that has never run a turn has no rollout on disk, so resume is
      //    refused — which is the honest outcome (the adapter surfaces a failed session rather
      //    than resuming into some other history). Accept either, but never a different id.
      let resumed: { thread: { id: string } } | null = null;
      let resumeError: string | null = null;
      try {
        resumed = await client.request<{ thread: { id: string } }>('thread/resume', {
          threadId: started.thread.id,
          cwd: project,
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
        });
      } catch (err) {
        resumeError = (err as Error).message;
      }
      if (resumed) expect(resumed.thread.id).toBe(started.thread.id);
      else expect(resumeError).toMatch(/rollout|not found|unknown/i);
    } finally {
      await client.stop();
      expect(client.running).toBe(false);
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);
});
