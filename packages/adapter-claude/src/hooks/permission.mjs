#!/usr/bin/env node
// Pagr PermissionRequest hook for Claude Code.
//
// Registered by the user (see `hookSettings()` in @pagr/bridge-adapter-claude) so that permission
// prompts from THEIR OWN interactive Claude Code sessions can be answered from their phone.
// Sessions the bridge spawns itself do not use this hook; they use the stdio permission-prompt
// protocol instead.
//
// Doc basis (https://code.claude.com/docs/en/hooks, fetched 2026-08-24):
//   stdin:  {"session_id","cwd","permission_mode","hook_event_name":"PermissionRequest",
//            "tool_name","tool_input",("tool_use_id"),"permission_suggestions"}
//           NOTE: Claude Code 2.1.220 did not include `tool_use_id` in practice; we fall back to
//           `prompt_id`, then a random id.
//   stdout: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//            "decision":{"behavior":"allow"|"deny","message":"…"}}}
//   "Exit 0 with no output: The hook has no decision; normal permission flow applies."
//   "Exit code 2 is not honored for PermissionRequest."
//   Default hook timeout is 600 s; a timed-out hook "renders no decision".
//
// Safety: talks ONLY to the local daemon Unix socket. Prints nothing (=> no decision, native
// Claude Code prompt stays in control) on timeout, socket error, or any unexpected reply.
// Never auto-allows.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = Number(process.env.PAGR_HOOK_TIMEOUT_MS) || 540_000; // < Claude's 600 s hook cap
const PAGR_HOME = process.env.PAGR_HOME || path.join(os.homedir(), '.pagr');
// The daemon records the socket it actually listens on in run/daemon.sock.path (it moves to a
// short per-user runtime dir when PAGR_HOME would exceed the sun_path limit).
function recordedSocketPath() {
  try {
    const p = fs.readFileSync(path.join(PAGR_HOME, 'run', 'daemon.sock.path'), 'utf8').trim();
    if (p && path.isAbsolute(p)) return p;
  } catch {
    /* not written */
  }
  return null;
}
const SOCK =
  process.env.PAGR_DAEMON_SOCK ||
  recordedSocketPath() ||
  path.join(PAGR_HOME, 'run', 'daemon.sock');

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      s += d;
    });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

const str = (v) => (typeof v === 'string' ? v : undefined);

/**
 * Resolve symlinks for containment checks, falling back to the nearest existing ancestor for a
 * path that does not exist yet. On macOS `/tmp` IS `/private/tmp` and `/var` IS `/private/var`, so
 * without this the hook called `/tmp/x` and `/private/tmp/x` two different places and reported a
 * file inside the project as "outside the project".
 *
 * Deliberately duplicated from `@pagr/bridge-core`'s heuristics: this file is copied standalone to
 * `~/.pagr/hooks/permission.mjs` and runs inside the user's own `claude`, with no node_modules.
 */
export function realpathNearest(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return path.join(cur, ...tail);
  }
}

/** True when `p` is `root` or lives under it, after resolving both sides. */
export function isInside(p, root) {
  const rel = path.relative(realpathNearest(root), realpathNearest(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Rewrite absolute paths that live under `root` as root-relative. Absolute paths contain the
 * user's account name (`/Users/jane/...`), and the preview is the one field of this request that
 * is shown in the cloud, so it must not carry the local directory layout off the Mac. Paths
 * outside the root are left alone: they are the ones worth seeing in full.
 */
export function relativizePaths(text, root) {
  if (!root) return text;
  const real = realpathNearest(root);
  return text.replace(/(^|[\s="'(:,])(\/[^\s"'():,]+)/g, (m, lead, p) => {
    if (!isInside(p, root)) return m;
    const rel = path.relative(real, realpathNearest(p));
    return `${lead}${rel === '' ? '.' : rel}`;
  });
}

export function buildRequest(hook) {
  const toolName = str(hook.tool_name) ?? 'tool';
  const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input : {};
  const command = str(input.command);
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  let actionType = 'tool_use';
  let preview = toolName;
  if (toolName === 'Bash') {
    actionType = 'command_execution';
    preview = `$ ${command ?? ''}`;
  } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    actionType = 'file_change';
    preview = `${toolName} ${file ?? '?'}`;
  } else if (file) preview = `${toolName} ${file}`;
  else if (str(input.url)) preview = `${toolName} ${input.url}`;

  const text = `${command ?? ''} ${file ?? ''}`;
  const hints = {};
  if (/\b(curl|wget|ssh|scp|rsync|nc|http[s]?:\/\/)\b/i.test(text) || toolName === 'WebFetch')
    hints.networkAccess = true;
  if (
    /\b(rm\s+-[a-z]*r|rmdir|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|drop\s+(table|database))\b/i.test(
      text,
    )
  )
    hints.destructive = true;
  if (/\bgit\s+push\b/i.test(text)) hints.gitPush = true;
  if (/\b(npm|pnpm|yarn|pip3?|brew|cargo|gem)\s+(i|install|add)\b/i.test(text))
    hints.packageInstall = true;
  // Kept in step with `SECRETS` in @pagr/bridge-core: anchored on path shapes, not on the bare
  // words `secret`/`token`, because the device floor refuses on this hint and `src/token.ts` is an
  // ordinary source file.
  if (
    /(^|[/\s"'=(])\.env(\.[\w-]+)?($|[/\s"')])|(^|\/)(\.aws|\.ssh|\.gnupg|\.npmrc|\.netrc|\.pgpass|\.authinfo|\.git-credentials|credentials|id_(rsa|dsa|ecdsa|ed25519))($|[/\s"':])|\.(pem|p12|pfx|jks|keystore)($|[/\s"':])|\bkeychain\b|\bsecurity\s+(find|add|delete|dump)-(generic|internet)-password\b|(?:^|[^A-Za-z])(access|api|secret|private|service)[_-]?(key|token|role)(?![A-Za-z])/i.test(
      text,
    )
  )
    hints.secretsTouch = true;
  if (/\b(prod|production|deploy|migrate|release)\b/i.test(text)) hints.productionHint = true;
  const cwd = str(hook.cwd);
  if (cwd) {
    const outside = [
      ...(file && path.isAbsolute(file) ? [file] : []),
      ...((command ?? '')
        .match(/(?:^|\s|=|["'])(\/[^\s"']+)/g)
        ?.map((m) => m.replace(/^[\s="']+/, '')) ?? []),
    ].some((p) => !isInside(p, cwd));
    if (outside) hints.touchesOutsideProject = true;
  }

  const providerRequestId =
    str(hook.tool_use_id) ?? str(hook.prompt_id) ?? `hook_${randomBytes(8).toString('hex')}`;

  return {
    provider: 'claude',
    // Bridge-spawned sessions carry PAGR_SESSION_ID; the user's own interactive `claude` does
    // not, so the daemon maps `cwd` → registered project and mints a local session (finding 12).
    sessionId: process.env.PAGR_SESSION_ID || null,
    claudeSessionId: str(hook.session_id) ?? null,
    providerRequestId: providerRequestId.slice(0, 200),
    actionType,
    toolName,
    // Paths under the session's cwd become relative before the preview leaves this Mac, the same
    // way the bridge-spawned path does it in `@pagr/bridge-core`'s `relativizePaths`.
    preview: relativizePaths(preview, cwd).replace(/\s+/g, ' ').trim().slice(0, 1500),
    hints,
    cwd: cwd ?? null,
  };
}

/** Ask the daemon over the Unix socket. Resolves 'allow' | 'deny' | null (no decision). */
export function askDaemon(params, { sockPath = SOCK, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const sock = net.createConnection(sockPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id: 1, method: 'approval.request', params })}\n`);
    });
    sock.on('data', (d) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 1) {
            const r = m.result ?? {};
            const d = r.decision ?? r.behavior;
            return finish(d === 'allow' || d === 'deny' ? d : null);
          }
        } catch {
          /* ignore non-JSON */
        }
        i = buf.indexOf('\n');
      }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

export function hookOutput(decision, message) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: decision, message },
    },
  });
}

async function main() {
  let hook;
  try {
    hook = JSON.parse(await readStdin());
  } catch {
    return; // no decision
  }
  if (hook?.hook_event_name !== 'PermissionRequest') return;
  const params = buildRequest(hook);
  const decision = await askDaemon(params);
  if (decision === 'allow')
    process.stdout.write(hookOutput('allow', 'Approved by the user via Pagr'));
  else if (decision === 'deny')
    process.stdout.write(hookOutput('deny', 'Denied by the user via Pagr'));
  // else: print nothing → native permission flow stays in control
}

if (process.env.PAGR_HOOK_LIBRARY !== '1') {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
