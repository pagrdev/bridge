#!/usr/bin/env node
// Fake `claude` binary for tests. Mimics Claude Code 2.1.220's stream-json protocol as observed
// on 2026-08-24, incl. the stdio permission-prompt control protocol.
//
//   fake-claude.mjs --version            → "2.1.220 (Claude Code)"
//   fake-claude.mjs auth status          → {"loggedIn":true,...}   (FAKE_CLAUDE_LOGGED_OUT=1 → false, exit 1)
//   fake-claude.mjs -p --input-format stream-json --output-format stream-json ... [--session-id X | --resume X]
//       reads user messages from stdin; per message:
//         "write"  → control_request can_use_tool (Write) → waits for control_response → tool_result → result
//         "fail"   → result subtype error_during_execution
//         "hang"   → no result until SIGINT (then result success "interrupted") / SIGTERM exits 143
//         "crash"  → process.exit(7) mid-turn
//         else     → assistant text + result success
//       exits 0 when stdin closes.

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
// FAKE_CLAUDE_TRACE=<file> records every invocation (one line of argv per process), so a test can
// prove the adapter is not forking `claude` on every probe.
if (process.env.FAKE_CLAUDE_TRACE)
  appendFileSync(process.env.FAKE_CLAUDE_TRACE, `${argv.join(' ')}\n`);
if (argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(
    `${JSON.stringify({ loggedIn, authMethod: 'claude.ai', email: 'redacted@example.com' })}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
}

const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = flagValue('--session-id') ?? flagValue('--resume') ?? 'fake-session';
const resumed = argv.includes('--resume');
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: sessionId })}\n`);
// Assert the flags the adapter must pass.
for (const req of [
  '-p',
  '--input-format',
  '--output-format',
  '--permission-prompt-tool',
  '--permission-mode',
  '--setting-sources',
]) {
  if (!argv.includes(req)) {
    process.stderr.write(`fake-claude: missing required flag ${req}\n`);
    process.exit(2);
  }
}
// In sealed mode `--setting-sources` and `--strict-mcp-config` are load bearing together: without
// them `claude -p` reads the cloned repo's own .claude/settings.json and .mcp.json, which can
// auto-allow tools so no approval is ever raised (SEC-3). Outside sealed mode the person's own
// configuration is honoured in full, which is the default and is a deliberate choice.
const settingSources = (flagValue('--setting-sources') ?? '').split(',').map((s) => s.trim());
if (process.env.PAGR_CLAUDE_SEALED === '1') {
  if (settingSources.includes('project')) {
    process.stderr.write('fake-claude: sealed mode must not include "project"\n');
    process.exit(2);
  }
  if (!argv.includes('--strict-mcp-config')) {
    process.stderr.write('fake-claude: sealed mode must pass --strict-mcp-config\n');
    process.exit(2);
  }
} else if (argv.includes('--strict-mcp-config')) {
  process.stderr.write('fake-claude: --strict-mcp-config outside sealed mode\n');
  process.exit(2);
}
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    process.env.FAKE_CLAUDE_ARGS_FILE,
    JSON.stringify({
      argv,
      env: {
        PAGR_SESSION_ID: process.env.PAGR_SESSION_ID,
        PAGR_DAEMON_SOCK: process.env.PAGR_DAEMON_SOCK,
      },
      cwd: process.cwd(),
    }),
  );
}

let n = 0;
let inited = false;
let hanging = null; // { resolve }
const pendingControl = new Map();

function init() {
  if (inited) return;
  inited = true;
  out({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Write'],
    model: 'fake',
    permissionMode: 'default',
    resumed,
  });
}

function assistant(content) {
  out({
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: null,
    uuid: `u${n++}`,
  });
}

function result(ok, text) {
  out(
    ok
      ? {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: text,
          num_turns: 1,
          total_cost_usd: 0,
        }
      : {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: text,
          num_turns: 1,
        },
  );
}

function askPermission(toolName, input, toolUseId) {
  const request_id = `req_${n++}`;
  return new Promise((resolve) => {
    pendingControl.set(request_id, resolve);
    out({
      type: 'control_request',
      request_id,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        display_name: toolName,
        input,
        tool_use_id: toolUseId,
        permission_suggestions: [],
      },
    });
  });
}

async function handleUser(text) {
  init();
  if (/crash/i.test(text)) process.exit(7);
  if (/hang/i.test(text)) {
    assistant([{ type: 'text', text: 'Working on it…' }]);
    await new Promise((resolve) => {
      hanging = { resolve };
    });
    return;
  }
  if (/fail/i.test(text)) {
    result(false, 'Something went wrong');
    return;
  }
  if (/write/i.test(text)) {
    const toolUseId = `toolu_${n++}`;
    assistant([
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Write',
        input: { file_path: `${process.cwd()}/hello.txt`, content: 'hi\n' },
      },
    ]);
    const res = await askPermission(
      'Write',
      { file_path: `${process.cwd()}/hello.txt`, content: 'hi\n' },
      toolUseId,
    );
    const allowed = res?.behavior === 'allow';
    out({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: allowed
              ? 'File created successfully'
              : `Permission denied: ${res?.message ?? ''}`,
            is_error: !allowed,
          },
        ],
      },
      parent_tool_use_id: null,
    });
    assistant([
      { type: 'text', text: allowed ? 'Wrote hello.txt. DONE' : 'Could not write hello.txt.' },
    ]);
    result(true, allowed ? 'Wrote hello.txt. DONE' : 'Could not write hello.txt.');
    return;
  }
  assistant([{ type: 'text', text: `Echo: ${text}` }]);
  result(true, `Echo: ${text}`);
}

process.on('SIGINT', () => {
  if (hanging) {
    const h = hanging;
    hanging = null;
    result(true, 'interrupted');
    h.resolve();
  }
});
process.on('SIGTERM', () => process.exit(143));

const rl = readline.createInterface({ input: process.stdin });
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const t = queue.shift();
    await handleUser(t);
  }
  busy = false;
}
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_response') {
    const r = pendingControl.get(m.response?.request_id);
    if (r) {
      pendingControl.delete(m.response.request_id);
      r(m.response.response);
    }
    return;
  }
  if (m.type === 'user') {
    const c = m.message?.content;
    queue.push(typeof c === 'string' ? c : JSON.stringify(c));
    void pump();
  }
});
rl.on('close', () => process.exit(0));
