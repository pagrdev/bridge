#!/usr/bin/env node
// Fake `claude` binary for tests. Mimics Claude Code 2.1.220's stream-json protocol as observed
// on 2026-08-24, incl. the stdio permission-prompt control protocol.
//
//   fake-claude.mjs --version            → "2.1.220 (Claude Code)"
//   fake-claude.mjs auth status          → {"loggedIn":true,...}   (FAKE_CLAUDE_LOGGED_OUT=1 → false, exit 1)
//   fake-claude.mjs -p --input-format stream-json --output-format stream-json ... [--session-id X | --resume X]
//       reads user messages from stdin; per message:
//         "frames" → one assistant message carrying thinking + two tool_use blocks + an unknown
//                     block, then a Bash tool_result (stdout/stderr in tool_use_result), an Edit
//                     tool_result (structuredPatch in tool_use_result), a final text, and a result
//         "bare"   → an Edit whose tool_result carries NO tool_use_result (an older CLI, or a
//                     tool that records none): the diff has to come from the transcript, or be
//                     approximated
//         "write"  → control_request can_use_tool (Write) → waits for control_response → tool_result → result
//         "write always" → the same, but the request carries `permission_suggestions`, so an
//                     "allow always" has rules to persist. Every control_response line is appended
//                     to FAKE_CLAUDE_CONTROL_FILE when that env var is set, so a test can read
//                     back exactly what the adapter wrote (incl. `updatedPermissions`).
//         "ask"    → AskUserQuestion: a can_use_tool control_request carrying
//                     `requires_user_interaction:true` and `questions[]`, then the EXACT outcomes
//                     spike MOB-044 measured against Claude Code 2.1.220 —
//                       allow with `updatedInput.answers` keyed by the full question text
//                         → "Your questions have been answered: …"   (run 4)
//                       allow with `updatedInput.response`
//                         → "The user responded: …"                   (run 5)
//                       allow with anything else (the original input, or answers keyed by header)
//                         → "The user did not answer the questions."  (runs 2 and 3: today's bug)
//                     "ask multi" makes the question multi-select with three options.
//         "elsewhere" → asks permission and then answers it ITSELF, as a terminal user would:
//                     the tool_result arrives with no control_response, which is what
//                     `answeredElsewhere` looks like on the wire
//         "write file <path>" → a one-shot run's write. The fake honours `--permission-mode`
//                     the way the real permission engine does: under `acceptEdits` a write
//                     inside the working directory happens with NO prompt at all; a write
//                     outside it raises a can_use_tool request, and a denial means the file is
//                     never written.
//         "fail"   → result subtype error_during_execution
//         "hang"   → no result until SIGINT (then result success "interrupted") / SIGTERM exits 143
//         "crash"  → process.exit(7) mid-turn
//         else     → assistant text + result success
//       exits 0 when stdin closes.

import { appendFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
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
/**
 * What `--permission-mode acceptEdits` does for a `Write`: an edit inside the working directory
 * runs with no prompt. Anything outside it still prompts — and a one-shot run denies every
 * prompt it is asked, which is what makes it non-interactive rather than what confines it.
 */
function writeAllowed(absPath) {
  if (flagValue('--permission-mode') !== 'acceptEdits') return false;
  const rel = nodePath.relative(process.cwd(), absPath);
  return !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

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

/**
 * A `user` line carrying one tool result, plus the `tool_use_result` sidecar Claude Code 2.1.220
 * puts there under `--verbose` (verified 2026-09-17 against the real binary: Bash results carry
 * `{stdout, stderr, interrupted, …}`, Edit results `{structuredPatch, originalFile, oldString,
 * newString, replaceAll, …}`).
 */
function toolResult(toolUseId, content, toolUseResult, isError = false) {
  out({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: `u${n++}`,
    tool_use_result: toolUseResult,
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

/** The rules a real Claude offers alongside "always allow" for a Write. */
const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: '//tmp/**' }], behavior: 'allow' },
];

function askPermission(toolName, input, toolUseId, suggestions = [], extra = {}) {
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
        permission_suggestions: suggestions,
        ...extra,
      },
    });
  });
}

const SINGLE_QUESTIONS = [
  {
    question: 'Do you prefer option A or option B?',
    header: 'Preference',
    multiSelect: false,
    options: [
      { label: 'Option A', description: 'Choose option A' },
      { label: 'Option B', description: 'Choose option B' },
    ],
  },
];

const MULTI_QUESTIONS = [
  {
    question: 'Which checks should run before I push?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'lint', description: 'biome' },
      { label: 'typecheck', description: 'tsc' },
      { label: 'test', description: 'vitest', preview: '1238 tests' },
    ],
  },
];

/**
 * What the real CLI does with a `control_response` for AskUserQuestion. Verbatim from spike
 * MOB-044: an allow EXECUTES the tool on the spot with whatever `updatedInput` carries, so a
 * plain allow is not a deferred prompt — it is an instant "did not answer" and the end of the
 * turn. `answers` is only recognised when keyed by the full `question` string.
 */
function answerOf(questions, res) {
  if (res?.behavior !== 'allow')
    return {
      error: true,
      content: `Permission denied: ${res?.message ?? ''}`,
      toolUseResult: { questions, answers: {} },
    };
  const ui = res.updatedInput ?? {};
  const answers = ui.answers && typeof ui.answers === 'object' ? ui.answers : {};
  if (typeof ui.response === 'string' && ui.response.length > 0)
    return {
      content: `The user responded: ${ui.response}`,
      toolUseResult: { questions, answers, response: ui.response },
    };
  const recognised = Object.entries(answers).filter(([k]) =>
    questions.some((q) => q.question === k),
  );
  if (recognised.length === 0)
    return {
      // Runs 2 and 3: the answers are echoed back untouched and still count for nothing.
      content: 'The user did not answer the questions.',
      toolUseResult: { questions, answers },
    };
  const rendered = recognised.map(([k, v]) => `"${k}"="${v}"`).join(', ');
  return {
    content: `Your questions have been answered: ${rendered}. You can now continue with these answers in mind.`,
    toolUseResult: { questions, answers },
  };
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
  if (/frames/i.test(text)) {
    const bashId = `toolu_${n++}`;
    const editId = `toolu_${n++}`;
    // One message, four blocks: the model's reasoning, two tool calls, and a block type this
    // parser has never seen. Collapsing this to `tools[0]` is exactly what B4 stops doing.
    assistant([
      { type: 'thinking', thinking: 'Check the tree, then fix the typo.', signature: 'sig' },
      { type: 'tool_use', id: bashId, name: 'Bash', input: { command: 'ls -a' } },
      {
        type: 'tool_use',
        id: editId,
        name: 'Edit',
        input: {
          file_path: `${process.cwd()}/t.txt`,
          old_string: 'bravo',
          new_string: 'BRAVO',
          replace_all: false,
        },
      },
      { type: 'server_tool_use_unknown_to_pagr' },
    ]);
    toolResult(bashId, '.\n..\nt.txt\nls: nope: No such file', {
      stdout: '.\n..\nt.txt',
      stderr: 'ls: nope: No such file',
      interrupted: false,
      isImage: false,
    });
    toolResult(editId, `The file ${process.cwd()}/t.txt has been updated successfully.`, {
      filePath: `${process.cwd()}/t.txt`,
      oldString: 'bravo',
      newString: 'BRAVO',
      originalFile: 'alpha\nbravo\ncharlie\n',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [' alpha', '-bravo', '+BRAVO', ' charlie'],
        },
      ],
      userModified: false,
      replaceAll: false,
    });
    assistant([{ type: 'text', text: 'Fixed the typo. DONE' }]);
    result(true, 'Fixed the typo. DONE');
    return;
  }
  if (/bare/i.test(text)) {
    const editId = `toolu_${n++}`;
    assistant([
      {
        type: 'tool_use',
        id: editId,
        name: 'Edit',
        input: {
          file_path: `${process.cwd()}/t.txt`,
          old_string: 'bravo',
          new_string: 'BRAVO',
          replace_all: false,
        },
      },
    ]);
    toolResult(editId, `The file ${process.cwd()}/t.txt has been updated successfully.`, undefined);
    assistant([{ type: 'text', text: 'Edited. DONE' }]);
    result(true, 'Edited. DONE');
    return;
  }
  if (/\bask\b/i.test(text)) {
    const questions = /multi/i.test(text) ? MULTI_QUESTIONS : SINGLE_QUESTIONS;
    const toolUseId = `toolu_${n++}`;
    assistant([{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions } }]);
    const res = await askPermission('AskUserQuestion', { questions }, toolUseId, [], {
      // The field the real 2.1.220 puts on this request and on no other (spike finding 1).
      requires_user_interaction: true,
    });
    const answer = answerOf(questions, res);
    toolResult(toolUseId, answer.content, answer.toolUseResult, answer.error === true);
    const text2 = answer.error
      ? 'I could not ask you. DONE'
      : `Noted: ${answer.content.slice(0, 120)} DONE`;
    assistant([{ type: 'text', text: text2 }]);
    result(true, text2);
    return;
  }
  if (/elsewhere/i.test(text)) {
    // Asks, and then answers itself: the person hit "yes" in the terminal, so the tool runs and
    // its result arrives while Pagr is still holding the prompt open on a phone.
    const toolUseId = `toolu_${n++}`;
    assistant([
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Write',
        input: { file_path: `${process.cwd()}/hello.txt`, content: 'hi\n' },
      },
    ]);
    void askPermission(
      'Write',
      { file_path: `${process.cwd()}/hello.txt`, content: 'hi\n' },
      toolUseId,
      SUGGESTIONS,
    );
    await new Promise((r) => setTimeout(r, 50));
    toolResult(toolUseId, 'File created successfully', undefined);
    assistant([{ type: 'text', text: 'Wrote hello.txt in the terminal. DONE' }]);
    result(true, 'Wrote hello.txt in the terminal. DONE');
    return;
  }
  const wants = /write file (\S+)/i.exec(text);
  if (wants) {
    const target = nodePath.resolve(process.cwd(), wants[1]);
    const toolUseId = `toolu_${n++}`;
    const input = { file_path: target, content: 'written by fake-claude\n' };
    assistant([{ type: 'tool_use', id: toolUseId, name: 'Write', input }]);
    if (writeAllowed(target)) {
      // Covered by a rule: the real CLI runs it without asking anybody.
      writeFileSync(target, input.content);
      toolResult(toolUseId, 'File created successfully', undefined);
      assistant([{ type: 'text', text: `Wrote ${target}. DONE` }]);
      result(true, `Wrote ${target}. DONE`);
      return;
    }
    const res = await askPermission('Write', input, toolUseId);
    if (res?.behavior === 'allow') {
      writeFileSync(target, input.content);
      toolResult(toolUseId, 'File created successfully', undefined);
      assistant([{ type: 'text', text: `Wrote ${target}. DONE` }]);
      result(true, `Wrote ${target}. DONE`);
      return;
    }
    toolResult(toolUseId, `Permission denied: ${res?.message ?? ''}`, undefined, true);
    const denied = `Could not write ${target}: permission denied. DONE`;
    assistant([{ type: 'text', text: denied }]);
    result(true, denied);
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
      /always/i.test(text) ? SUGGESTIONS : [],
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
    // Recorded verbatim so a test can assert what the adapter actually sent back — an allow with
    // `updatedPermissions` is the whole of "allow always".
    if (process.env.FAKE_CLAUDE_CONTROL_FILE)
      appendFileSync(process.env.FAKE_CLAUDE_CONTROL_FILE, `${line}\n`);
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
