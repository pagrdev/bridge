import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookSettings, installHooks } from './install.js';

const HOOK = fileURLToPath(new URL('./permission.mjs', import.meta.url));

const stdinPayload = {
  session_id: 'abc81286-92f3-4c72-b6a8-72e216749504',
  cwd: '/p',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main', description: 'push' },
  prompt_id: '081d07a8-135e-4f69-bd5c-4300a55967aa',
  permission_suggestions: [],
};

interface Seen {
  method: string;
  params: Record<string, unknown>;
}

function fakeDaemon(
  sock: string,
  reply: (req: Seen) => { result?: unknown; error?: unknown } | null,
): { seen: Seen[]; close: () => Promise<void> } {
  const seen: Seen[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const m = JSON.parse(buf.slice(0, i)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      seen.push({ method: m.method, params: m.params });
      const r = reply({ method: m.method, params: m.params });
      if (r) conn.write(`${JSON.stringify({ id: m.id, ...r })}\n`);
    });
  });
  server.listen(sock);
  return {
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function runHook(
  input: unknown,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile('node', [HOOK], { env: { ...process.env, ...env } }, (err, stdout) =>
      resolve({ stdout: String(stdout), code: (err as { code?: number } | null)?.code ?? 0 }),
    );
    child.stdin?.end(JSON.stringify(input));
  });
}

describe('permission.mjs hook', () => {
  let dir: string;
  let sock: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-hook-'));
    sock = path.join(dir, 'd.sock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sends approval.request to the daemon and prints an allow decision', async () => {
    const d = fakeDaemon(sock, () => ({ result: { decision: 'allow' } }));
    const { stdout, code } = await runHook(stdinPayload, {
      PAGR_DAEMON_SOCK: sock,
      PAGR_SESSION_ID: 'ses_00000000000000000000000000000001',
    });
    await d.close();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', message: 'Approved by the user via Pagr' },
      },
    });
    expect(d.seen).toHaveLength(1);
    expect(d.seen[0]?.method).toBe('approval.request');
    expect(d.seen[0]?.params).toMatchObject({
      provider: 'claude',
      sessionId: 'ses_00000000000000000000000000000001',
      claudeSessionId: stdinPayload.session_id,
      providerRequestId: stdinPayload.prompt_id, // tool_use_id absent in 2.1.220 → prompt_id
      actionType: 'command_execution',
      preview: '$ git push origin main',
      hints: { gitPush: true },
      cwd: '/p',
    });
  });

  it('sends sessionId=null with cwd when not spawned by the bridge (finding 12)', async () => {
    const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
    await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock, PAGR_SESSION_ID: '' });
    await d.close();
    expect(d.seen[0]?.params).toMatchObject({
      sessionId: null,
      cwd: '/p',
      claudeSessionId: stdinPayload.session_id,
    });
  });

  it('prints a deny decision', async () => {
    const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
    const { stdout } = await runHook(
      { ...stdinPayload, tool_use_id: 'toolu_x' },
      { PAGR_DAEMON_SOCK: sock },
    );
    await d.close();
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(d.seen[0]?.params.providerRequestId).toBe('toolu_x');
  });

  it('prints nothing (no decision) on timeout, daemon error, or missing socket', async () => {
    const silent = fakeDaemon(sock, () => null);
    const t = await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock, PAGR_HOOK_TIMEOUT_MS: '200' });
    await silent.close();
    expect(t).toEqual({ stdout: '', code: 0 });

    const erroring = fakeDaemon(sock, () => ({ error: { code: 1, message: 'nope' } }));
    const e = await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock });
    await erroring.close();
    expect(e).toEqual({ stdout: '', code: 0 });

    const missing = await runHook(stdinPayload, { PAGR_DAEMON_SOCK: path.join(dir, 'nope.sock') });
    expect(missing).toEqual({ stdout: '', code: 0 });

    const wrongEvent = await runHook(
      { ...stdinPayload, hook_event_name: 'PreToolUse' },
      { PAGR_DAEMON_SOCK: sock },
    );
    expect(wrongEvent).toEqual({ stdout: '', code: 0 });
  });

  it('installHooks copies the script and hookSettings references it', () => {
    const { hookPath } = installHooks(dir);
    expect(hookPath).toBe(path.join(dir, 'hooks', 'permission.mjs'));
    expect(fs.statSync(hookPath).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('PermissionRequest');
    const s = hookSettings(hookPath);
    expect(s.hooks.PermissionRequest[0]?.hooks[0]).toMatchObject({ type: 'command', timeout: 600 });
    expect(s.hooks.PermissionRequest[0]?.hooks[0]?.command).toContain(hookPath);
  });
});
