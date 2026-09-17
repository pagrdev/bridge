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
    // Shape re-verified against the Claude Code hooks reference (2026-09-15):
    // `hookSpecificOutput.decision.behavior`, with `message` documented as deny-only.
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
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

  it('prints a deny decision, with the message Claude Code shows the model', async () => {
    const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
    const { stdout } = await runHook(
      { ...stdinPayload, tool_use_id: 'toolu_x' },
      { PAGR_DAEMON_SOCK: sock },
    );
    await d.close();
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied by the user via Pagr' },
      },
    });
    expect(d.seen[0]?.params.providerRequestId).toBe('toolu_x');
  });

  /**
   * The safety property the whole design rests on: when Pagr cannot answer, Claude Code must
   * behave exactly as if the hook were not installed. Exit 0 with no output is documented as
   * "no decision", so the ordinary permission flow takes over. Never an allow, never a deny.
   */
  it('never invents a decision when the daemon says something unexpected', async () => {
    for (const reply of [
      { result: {} },
      { result: { decision: 'maybe' } },
      { result: { decision: null } },
      { result: 'allow' },
    ]) {
      const d = fakeDaemon(sock, () => reply as { result: unknown });
      const r = await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock });
      await d.close();
      expect(r).toEqual({ stdout: '', code: 0 });
    }
  });

  it('exits 0 on garbage stdin rather than failing the tool call', async () => {
    const child = await new Promise<{ stdout: string; code: number }>((resolve) => {
      const c = execFile('node', [HOOK], { env: { ...process.env } }, (err, stdout) =>
        resolve({ stdout: String(stdout), code: (err as { code?: number } | null)?.code ?? 0 }),
      );
      c.stdin?.end('not json at all');
    });
    expect(child).toEqual({ stdout: '', code: 0 });
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

  it('relativizes paths under the session cwd so the preview carries no local layout (SEC-15)', async () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    try {
      const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
      await runHook(
        {
          ...stdinPayload,
          cwd: project,
          tool_name: 'Write',
          tool_input: { file_path: path.join(project, 'src', 'a.ts'), content: 'x' },
        },
        { PAGR_DAEMON_SOCK: sock },
      );
      await d.close();
      const params = d.seen[0]?.params as { preview: string; hints: Record<string, boolean> };
      // The absolute path contains the user's account name; only the project-relative part leaves.
      expect(params.preview).toBe('Write src/a.ts');
      expect(params.preview).not.toContain(project);
      expect(params.preview).not.toContain(os.homedir());
      expect(params.hints.touchesOutsideProject).toBeUndefined();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('treats /tmp and /private/tmp as one place, and still flags a real escape (SEC-15)', async () => {
    const aliased = fs.mkdtempSync(path.join('/tmp', 'pagr-alias-'));
    const real = fs.realpathSync(aliased);
    try {
      expect(real).not.toBe(aliased); // macOS: /tmp → /private/tmp
      const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
      await runHook(
        {
          ...stdinPayload,
          cwd: aliased,
          tool_name: 'Write',
          tool_input: { file_path: path.join(real, 'a.ts'), content: 'x' },
        },
        { PAGR_DAEMON_SOCK: sock },
      );
      await d.close();
      const inside = d.seen[0]?.params as { preview: string; hints: Record<string, boolean> };
      expect(inside.preview).toBe('Write a.ts');
      expect(inside.hints.touchesOutsideProject).toBeUndefined();

      const d2 = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
      await runHook(
        {
          ...stdinPayload,
          cwd: aliased,
          tool_name: 'Bash',
          tool_input: { command: 'cat /etc/hosts' },
        },
        { PAGR_DAEMON_SOCK: sock },
      );
      await d2.close();
      const outside = d2.seen[0]?.params as { preview: string; hints: Record<string, boolean> };
      expect(outside.hints.touchesOutsideProject).toBe(true);
      // A path outside the project is the one worth showing in full.
      expect(outside.preview).toBe('$ cat /etc/hosts');
    } finally {
      fs.rmSync(aliased, { recursive: true, force: true });
    }
  });

  /**
   * MOB-035. The hook relays a prompt from the user's own `claude`, so it has to carry the same
   * options a bridge-spawned session does — which means forwarding the rules Claude offered, and
   * handing them back when the person chooses "allow always".
   */
  it('forwards permission_suggestions so a hook-relayed prompt can offer "allow always"', async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] },
    ];
    const d = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
    await runHook(
      { ...stdinPayload, permission_suggestions: suggestions },
      {
        PAGR_DAEMON_SOCK: sock,
      },
    );
    await d.close();
    expect(d.seen[0]?.params.permissionSuggestions).toEqual(suggestions);

    // An empty list still travels, and says "there is nothing to persist here".
    const e = fakeDaemon(sock, () => ({ result: { decision: 'deny' } }));
    await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock });
    await e.close();
    expect(e.seen[0]?.params.permissionSuggestions).toEqual([]);
  });

  it("writes Claude's own rules back on allow_always, and nothing extra on a plain allow", async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] },
    ];
    const always = fakeDaemon(sock, () => ({
      result: { decision: 'allow', optionId: 'allow_always' },
    }));
    const r = await runHook(
      { ...stdinPayload, permission_suggestions: suggestions },
      {
        PAGR_DAEMON_SOCK: sock,
      },
    );
    await always.close();
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: suggestions },
      },
    });

    // "Allow once" is the same allow it has always been.
    const once = fakeDaemon(sock, () => ({
      result: { decision: 'allow', optionId: 'allow_once' },
    }));
    const r2 = await runHook(
      { ...stdinPayload, permission_suggestions: suggestions },
      {
        PAGR_DAEMON_SOCK: sock,
      },
    );
    await once.close();
    expect(JSON.parse(r2.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });

    // An "always" with nothing to persist cannot invent a rule.
    const empty = fakeDaemon(sock, () => ({
      result: { decision: 'allow', optionId: 'allow_always' },
    }));
    const r3 = await runHook(stdinPayload, { PAGR_DAEMON_SOCK: sock });
    await empty.close();
    expect(JSON.parse(r3.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
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
