#!/usr/bin/env node
// Fake `codex app-server` for tests. Speaks the same JSONL JSON-RPC (no `jsonrpc` field).
// Usage: node fake-app-server.mjs app-server   (or `--version`)
//
// Behaviour (scripted):
//  - initialize → result; expects `initialized` notification.
//  - account/read → { account: null, requiresOpenaiAuth: true } unless FAKE_CODEX_AUTHED=1.
//  - thread/start, thread/resume, thread/list.
//  - turn/start: emits turn/started, agentMessage delta+completed ("Working…"), then:
//      * if the instruction contains "approve": sends item/commandExecution/requestApproval
//        and waits for the client's response; accept → completes, decline → completes with note.
//      * if it contains "permission": sends item/permissions/requestApproval.
//      * if it contains "crash": process.exit(3) mid-turn.
//      * if it contains "wait": stays inProgress until turn/interrupt.
//      * else completes immediately.
//  - turn/steer: acknowledges and emits an agentMessage echoing the steer text.
//  - turn/interrupt: emits turn/completed with status interrupted.
//
// B9 (the shared daemon) additions:
//  - FAKE_CODEX_SOCK=<path>: listen as the daemon's control socket does — a WebSocket server on a
//    Unix socket, one JSON-RPC message per text frame — instead of stdio. Every client gets its
//    own connection; notifications and server requests are broadcast to all of them, which is what
//    the real app-server does and what makes the "first answer wins" race real.
//  - thread/list (cursor paginated), thread/loaded/list, thread/read {includeTurns}, thread/unsubscribe.
//  - FAKE_CODEX_TUI_THREADS=<id,id>: threads a foreign process owns. Seeded into the store,
//    refused by thread/resume with "already has an active writer", readable by thread/read.
//  - FAKE_CODEX_QUESTION=1: a turn containing "ask" sends item/tool/requestUserInput.
//  - outputDelta / reasoning textDelta / fileChange patchUpdated notifications.
//
// HND-010 (headless runs) additions:
//  - thread/start remembers `sandbox` and `config.sandbox_workspace_write`; turn/start's
//    `sandboxPolicy` overrides them for the turn.
//  - a turn containing "write file <path>" tries to write it and is REFUSED by the sandbox
//    unless the path is under the thread's cwd or one of its writable roots — which is what
//    Codex's own `workspace-write` allows (the roots ADD to the workspace; they do not narrow
//    it). A refusal writes nothing and reports itself as a failed command item.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import nodePath from 'node:path';
import readline from 'node:readline';

// FAKE_CODEX_TRACE=<file> records every invocation (one line of argv per process), so a test can
// prove how many times the adapter forked `codex` and whether it started an app-server at all.
if (process.env.FAKE_CODEX_TRACE)
  appendFileSync(process.env.FAKE_CODEX_TRACE, `${process.argv.slice(2).join(' ')}\n`);

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.149.1\n');
  process.exit(0);
}

// FAKE_CODEX_COALESCE=1 buffers every line of a turn and writes them as ONE chunk, so the
// `turn/start` response and the whole turn (including `turn/completed`) reach the adapter
// together. That is the ordering a fast real turn produces under load, and it used to leave the
// session stuck at "working" with a dead activeTurnId.
const COALESCE = process.env.FAKE_CODEX_COALESCE === '1';
const SOCK = process.env.FAKE_CODEX_SOCK ?? '';
/** Live WebSocket connections, in socket mode. */
const conns = new Set();
/** The connection whose request we are answering right now; null for broadcasts. */
let replyTo = null;
let buffered = '';

const writeOut = (text, only) => {
  if (!SOCK) {
    process.stdout.write(text);
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // One JSON-RPC message per text frame: the framing the control socket really uses.
    for (const c of only ? [only] : conns) {
      if (c.readyState === 1) c.send(line);
    }
  }
};

const out = (o) => {
  const line = `${JSON.stringify(o)}\n`;
  // A response goes back to the connection that asked; a notification goes to everyone, exactly
  // like the real server's broadcast path.
  const only = o.id !== undefined && o.method === undefined ? replyTo : null;
  if (COALESCE) buffered += line;
  else writeOut(line, only);
};
const flush = () => {
  if (!buffered) return;
  const chunk = buffered;
  buffered = '';
  writeOut(chunk, null);
};
let seq = 1000;
/**
 * id -> { cwd, activeTurn, turns: [{id, items, status}], loaded, foreign, subscribers:Set }
 *
 * `foreign` threads stand in for the ChatGPT desktop app / an IDE extension / `codex exec`: they
 * exist in the store and are readable, and `thread/resume` refuses them with the writer-lock error.
 */
const threads = new Map();
const pendingServerReqs = new Map(); // id -> resolve
let n = 0;

/**
 * Ask every subscriber the same question with the same id and take the FIRST answer, dropping the
 * rest — `ThreadScopedOutgoingMessageSender::send_request` in the real server (spike finding 5).
 */
function requestFromServer(method, params) {
  const id = seq++;
  return new Promise((resolve) => {
    pendingServerReqs.set(id, (result) => {
      // Every other subscriber is told the request is gone, so a mirror can withdraw its card.
      out({
        method: 'serverRequest/resolved',
        params: { threadId: params.threadId, requestId: id },
      });
      flush();
      resolve(result);
    });
    // `out` broadcasts anything that carries a method, so every subscriber sees this one.
    out({ id, method, params });
    // Must reach the client now, or a coalesced run would deadlock waiting for its own answer.
    flush();
  });
}

const textOf = (input) =>
  input
    .filter((i) => i.type === 'text')
    .map((i) => i.text)
    .join(' ');
const imagesOf = (input) => input.filter((i) => i.type === 'localImage').map((i) => i.path);

/** Record an item on its turn so `thread/read` can hand the whole thread back later. */
function record(threadId, turnId, item) {
  const t = threads.get(threadId);
  if (!t) return;
  t.turns ??= [];
  let turn = t.turns.find((x) => x.id === turnId);
  if (!turn) {
    turn = { id: turnId, items: [], itemsView: 'full', status: 'inProgress', error: null };
    t.turns.push(turn);
  }
  const at = turn.items.findIndex((i) => i.id === item.id);
  if (at >= 0) turn.items[at] = item;
  else turn.items.push(item);
}

function agentMessage(threadId, turnId, text) {
  const itemId = `item_${n++}`;
  out({
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } },
  });
  for (const ch of text.match(/.{1,6}/g) ?? []) {
    out({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: ch } });
  }
  const item = { type: 'agentMessage', id: itemId, text, phase: null };
  record(threadId, turnId, item);
  out({
    method: 'item/completed',
    params: { threadId, turnId, item, completedAtMs: Date.now() },
  });
}

/** A command execution with streamed output, then the completed item. */
function commandExecution(threadId, turnId, command, output, exitCode = 0) {
  const itemId = `item_${n++}`;
  const started = {
    type: 'commandExecution',
    id: itemId,
    command,
    cwd: threads.get(threadId)?.cwd ?? '/',
    status: 'inProgress',
    aggregatedOutput: '',
    exitCode: null,
  };
  out({ method: 'item/started', params: { threadId, turnId, item: started } });
  for (const chunk of output.match(/.{1,8}/gs) ?? []) {
    out({
      method: 'item/commandExecution/outputDelta',
      params: { threadId, turnId, itemId, delta: chunk },
    });
  }
  const item = {
    ...started,
    status: exitCode === 0 ? 'completed' : 'failed',
    aggregatedOutput: output,
    exitCode,
  };
  record(threadId, turnId, item);
  out({ method: 'item/completed', params: { threadId, turnId, item } });
}

/** A reasoning item streamed as textDelta, then completed with a summary. */
function reasoning(threadId, turnId, text) {
  const itemId = `item_${n++}`;
  out({
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'reasoning', id: itemId, summary: [], content: [] } },
  });
  for (const chunk of text.match(/.{1,5}/gs) ?? []) {
    out({
      method: 'item/reasoning/textDelta',
      params: { threadId, turnId, itemId, delta: chunk, contentIndex: 0 },
    });
  }
  const item = { type: 'reasoning', id: itemId, summary: [text], content: [] };
  record(threadId, turnId, item);
  out({ method: 'item/completed', params: { threadId, turnId, item } });
}

/** A patch: patchUpdated while it is being built, then the completed fileChange item. */
function fileChange(threadId, turnId) {
  const itemId = `item_${n++}`;
  const changes = [
    {
      path: `${threads.get(threadId)?.cwd ?? '/'}/src/app.ts`,
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,2 +1,3 @@\n line one\n+added line\n line two\n',
    },
    {
      path: `${threads.get(threadId)?.cwd ?? '/'}/src/new.ts`,
      kind: { type: 'add' },
      diff: '@@ -0,0 +1,1 @@\n+brand new\n',
    },
  ];
  out({ method: 'item/fileChange/patchUpdated', params: { threadId, turnId, itemId, changes } });
  const item = { type: 'fileChange', id: itemId, changes, status: 'completed' };
  record(threadId, turnId, item);
  out({ method: 'item/completed', params: { threadId, turnId, item } });
}

function complete(threadId, turnId, status, error = null) {
  const t = threads.get(threadId);
  if (t) {
    t.activeTurn = null;
    const turn = (t.turns ?? []).find((x) => x.id === turnId);
    if (turn) turn.status = status;
  }
  out({
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: 'summary',
        status,
        error,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  });
  out({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
}

/**
 * The sandbox, as Codex enforces it: under `workspace-write` a path is writable when it is inside
 * the thread's cwd or inside one of its writable roots. Anything else is refused by the OS
 * sandbox before the tool ever runs.
 */
function writeAllowed(t, absPath) {
  if (t?.sandbox !== 'workspace-write') return false;
  const roots = [t.cwd, ...(t.writableRoots ?? [])].filter(Boolean).map((r) => nodePath.resolve(r));
  return roots.some((root) => absPath === root || absPath.startsWith(root + nodePath.sep));
}

/** A write the sandbox refused: nothing on disk, a failed item, and the agent says so. */
function refusedWrite(threadId, turnId, absPath) {
  const itemId = `item_${n++}`;
  const item = {
    type: 'commandExecution',
    id: itemId,
    command: `apply_patch ${absPath}`,
    cwd: threads.get(threadId)?.cwd ?? '/',
    status: 'failed',
    aggregatedOutput: `sandbox: write to ${absPath} denied (not under a writable root)`,
    exitCode: 1,
  };
  record(threadId, turnId, item);
  out({ method: 'item/completed', params: { threadId, turnId, item } });
  agentMessage(threadId, turnId, `Sandbox denied the write to ${absPath}. Nothing was changed.`);
}

async function runTurn(threadId, turnId, input) {
  const text = textOf(input);
  const images = imagesOf(input);
  out({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null },
    },
  });
  out({
    method: 'thread/status/changed',
    params: { threadId, status: { type: 'active', activeFlags: [] } },
  });
  agentMessage(
    threadId,
    turnId,
    `Working on: ${text}${images.length ? ` (with ${images.length} image(s))` : ''}`,
  );
  if (/crash/i.test(text)) process.exit(3);
  const wants = /write file (\S+)/i.exec(text);
  if (wants) {
    const t = threads.get(threadId);
    const target = nodePath.resolve(t?.cwd ?? '/', wants[1]);
    if (writeAllowed(t, target)) {
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, 'written by fake-app-server\n');
      agentMessage(threadId, turnId, `Wrote ${target}.`);
    } else {
      refusedWrite(threadId, turnId, target);
    }
    complete(threadId, turnId, 'completed');
    return;
  }
  if (/think/i.test(text)) reasoning(threadId, turnId, 'Considering the options carefully.');
  if (/run/i.test(text)) commandExecution(threadId, turnId, 'pnpm test', 'ok 1\nok 2\nall good\n');
  if (/patch/i.test(text)) fileChange(threadId, turnId);
  if (/ask/i.test(text)) {
    const itemId = `item_${n++}`;
    const res = await requestFromServer('item/tool/requestUserInput', {
      threadId,
      turnId,
      itemId,
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'q1',
          header: 'Deploy target',
          question: 'Which environment should I deploy to?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'staging', description: 'safe' },
            { label: 'production', description: 'careful' },
          ],
        },
        {
          id: 'q2',
          header: 'Token',
          question: 'Paste the deploy token',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    });
    agentMessage(threadId, turnId, `Answered: ${JSON.stringify(res?.answers ?? {})}`);
    complete(threadId, turnId, 'completed');
    return;
  }
  if (/wait/i.test(text)) return; // until interrupt
  if (/approve/i.test(text)) {
    const itemId = `item_${n++}`;
    out({
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: itemId,
          command: 'npm run db:migrate',
          status: 'inProgress',
        },
      },
    });
    const res = await requestFromServer('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      environmentId: null,
      command: 'npm run db:migrate',
      cwd: threads.get(threadId)?.cwd ?? '/',
      reason: 'needs write access',
    });
    if (threads.get(threadId)?.activeTurn !== turnId) return; // interrupted meanwhile
    const decision = res?.decision;
    agentMessage(
      threadId,
      turnId,
      decision === 'accept'
        ? 'Migration ran. All 12 tests pass.'
        : `Command ${decision}; skipped migration.`,
    );
    complete(threadId, turnId, 'completed');
    return;
  }
  if (/filechange/i.test(text)) {
    const itemId = `item_${n++}`;
    const cwd = threads.get(threadId)?.cwd ?? '/';
    const res = await requestFromServer('item/fileChange/requestApproval', {
      threadId,
      turnId,
      itemId,
      reason: 'apply patch',
      grantRoot: `${cwd}/src`,
    });
    agentMessage(threadId, turnId, res?.decision === 'accept' ? 'Patched.' : 'Not patched.');
    complete(threadId, turnId, 'completed');
    return;
  }
  if (/permission/i.test(text)) {
    const itemId = `item_${n++}`;
    const res = await requestFromServer('item/permissions/requestApproval', {
      threadId,
      turnId,
      itemId,
      environmentId: null,
      startedAtMs: Date.now(),
      cwd: '/',
      reason: 'fetch docs',
      permissions: { network: { allowAll: true }, fileSystem: null },
    });
    agentMessage(
      threadId,
      turnId,
      res?.permissions?.network ? 'Network granted.' : 'Network denied.',
    );
    complete(threadId, turnId, 'completed');
    return;
  }
  if (/fail/i.test(text)) {
    complete(threadId, turnId, 'failed', {
      message: 'model exploded',
      codexErrorInfo: null,
      additionalDetails: null,
    });
    return;
  }
  agentMessage(threadId, turnId, 'All 12 tests pass.');
  complete(threadId, turnId, 'completed');
}

/** `thread/read` renumbers items `item-1`, `item-2`, … exactly as the real server does. */
function describeThread(tid, t, includeTurns) {
  const turns = includeTurns
    ? (t.turns ?? []).map((turn) => ({
        ...turn,
        items: turn.items.map((item, i) => ({ ...item, id: `item-${i + 1}` })),
      }))
    : [];
  return {
    id: tid,
    sessionId: tid,
    preview: t.preview ?? '',
    cwd: t.cwd ?? '/',
    createdAt: 0,
    updatedAt: t.updatedAt ?? 0,
    recencyAt: null,
    status: t.activeTurn ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    name: null,
    source: t.foreign ? 'vscode' : 'cli',
    cliVersion: '0.149.1',
    turns,
  };
}

// Threads another process owns: listed, readable, never resumable.
for (const spec of (process.env.FAKE_CODEX_TUI_THREADS ?? '').split(',')) {
  const [tid, cwd] = spec.split('=');
  if (!tid) continue;
  threads.set(tid, {
    cwd: cwd || '/tmp/tui-project',
    activeTurn: null,
    foreign: true,
    loaded: false,
    preview: 'fix the failing test',
    updatedAt: 1,
    turns: [
      {
        id: 'turn-1',
        itemsView: 'full',
        status: 'completed',
        error: null,
        items: [
          {
            type: 'userMessage',
            id: 'x1',
            content: [{ type: 'text', text: 'fix the failing test' }],
          },
          { type: 'agentMessage', id: 'x2', text: 'Looking at it now.', phase: null },
        ],
      },
    ],
  });
}

// Threads hosted by this server that somebody else started (a TUI attached to the daemon).
for (const spec of (process.env.FAKE_CODEX_DAEMON_THREADS ?? '').split(',')) {
  const [tid, cwd] = spec.split('=');
  if (!tid) continue;
  threads.set(tid, {
    cwd: cwd || '/tmp/tui-project',
    activeTurn: null,
    foreign: false,
    loaded: true,
    preview: 'ship the release',
    updatedAt: 2,
    turns: [],
  });
}

if (SOCK) {
  // The control socket: a WebSocket server on a Unix socket. `ws` answers pings itself, and a
  // server ping every 200 ms proves the client keeps the link alive the way the real one demands.
  const { WebSocketServer } = await import('ws');
  try {
    rmSync(SOCK, { force: true });
  } catch {
    /* nothing to clean up */
  }
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws) => {
    conns.add(ws);
    ws.on('message', (data) => {
      replyTo = ws;
      try {
        if (!handleLine(data.toString())) flush();
      } finally {
        replyTo = null;
      }
    });
    ws.on('close', () => conns.delete(ws));
    // Sent to every new connection by the real server, before anything else.
    ws.send(
      JSON.stringify({
        method: 'remoteControl/status/changed',
        params: {
          status: 'disabled',
          serverName: 'fake',
          installationId: 'x',
          environmentId: null,
        },
        emittedAtMs: Date.now(),
      }),
    );
    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
      else clearInterval(ping);
    }, 200);
    ping.unref?.();
  });
  http.listen(SOCK, () => {
    process.stdout.write(`listening ${SOCK}\n`);
  });
  const shutdown = () => {
    try {
      rmSync(SOCK, { force: true });
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!handleLine(line)) flush();
  });
  rl.on('close', () => process.exit(0));
}

/** Returns true when the reply is deferred (the turn flushes its own coalesced chunk). */
function handleLine(line) {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && m.method === undefined) {
    // Recorded so a test can prove what the client answered — and, for a thread it does not own,
    // that it answered nothing at all.
    if (process.env.FAKE_CODEX_RPC_LOG) {
      appendFileSync(
        process.env.FAKE_CODEX_RPC_LOG,
        `${JSON.stringify({ method: '<response>', params: { id: m.id, result: m.result } })}\n`,
      );
    }
    const r = pendingServerReqs.get(m.id);
    if (r) {
      pendingServerReqs.delete(m.id);
      r(m.result);
    }
    return;
  }
  const { id, method, params = {} } = m;
  if (process.env.FAKE_CODEX_RPC_LOG) {
    appendFileSync(process.env.FAKE_CODEX_RPC_LOG, `${JSON.stringify({ method, params })}\n`);
  }
  switch (method) {
    case 'initialize':
      out({
        id,
        result: {
          userAgent: 'fake-app-server/0.149.1',
          codexHome: '/tmp/fake-codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
      return;
    case 'initialized':
      return;
    case 'account/read':
      out({
        id,
        result:
          process.env.FAKE_CODEX_AUTHED === '1'
            ? {
                account: { type: 'chatgpt', email: null, planType: 'plus' },
                requiresOpenaiAuth: false,
              }
            : { account: null, requiresOpenaiAuth: true },
      });
      return;
    case 'thread/start': {
      const threadId = `thr_${n++}`;
      threads.set(threadId, {
        cwd: params.cwd,
        activeTurn: null,
        approvalPolicy: params.approvalPolicy,
        sandbox: params.sandbox,
        writableRoots: params.config?.sandbox_workspace_write?.writable_roots ?? [],
        turns: [],
        loaded: true,
        foreign: false,
      });
      const thread = {
        id: threadId,
        preview: '',
        cwd: params.cwd,
        createdAt: 0,
        updatedAt: 0,
        status: { type: 'idle' },
        name: null,
        turns: [],
      };
      out({
        id,
        result: {
          thread,
          model: 'fake',
          modelProvider: 'openai',
          cwd: params.cwd,
          approvalPolicy: params.approvalPolicy,
          sandbox: params.sandbox,
        },
      });
      out({ method: 'thread/started', params: { thread } });
      return;
    }
    case 'thread/resume': {
      const known = threads.get(params.threadId);
      if (known?.foreign) {
        // The issue-44449 refusal, verbatim in shape: another process holds the writer lock.
        out({
          id,
          error: {
            code: -32600,
            message: `thread ${params.threadId} already has an active writer`,
          },
        });
        return;
      }
      if (known && known.turns?.length === 0 && known.materialized === false) {
        out({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` },
        });
        return;
      }
      const t = known ?? { cwd: params.cwd, activeTurn: null, turns: [], loaded: true };
      t.loaded = true;
      t.subscribed = true;
      threads.set(params.threadId, t);
      out({
        id,
        result: {
          thread: {
            id: params.threadId,
            preview: '',
            cwd: t.cwd,
            createdAt: 0,
            updatedAt: 0,
            status: { type: 'idle' },
            name: null,
            turns: [],
          },
        },
      });
      return;
    }
    case 'thread/list': {
      // Cursor paginated, one thread per page when a limit of 1 is asked for, so a test can prove
      // the client follows `nextCursor` instead of reading only the first page.
      const all = [...threads.entries()].filter(([, t]) => t.listed !== false);
      const limit = params.limit ?? all.length;
      const from = params.cursor ? Number(params.cursor) : 0;
      const page = all.slice(from, from + limit);
      out({
        id,
        result: {
          data: page.map(([tid, t]) => describeThread(tid, t, false)),
          nextCursor: from + limit < all.length ? String(from + limit) : null,
          backwardsCursor: null,
        },
      });
      return;
    }
    case 'thread/loaded/list':
      out({
        id,
        result: {
          data: [...threads.entries()].filter(([, t]) => t.loaded).map(([tid]) => tid),
          nextCursor: null,
        },
      });
      return;
    case 'thread/read': {
      const t = threads.get(params.threadId);
      if (!t) {
        out({ id, error: { code: -32602, message: 'unknown thread' } });
        return;
      }
      if (t.materialized === false) {
        out({
          id,
          error: {
            code: -32600,
            message: `thread ${params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
          },
        });
        return;
      }
      out({ id, result: { thread: describeThread(params.threadId, t, params.includeTurns) } });
      return;
    }
    case 'thread/unsubscribe': {
      const t = threads.get(params.threadId);
      const status = !t ? 'notLoaded' : t.subscribed ? 'unsubscribed' : 'notSubscribed';
      if (t) t.subscribed = false;
      out({ id, result: { status } });
      return;
    }
    case 'turn/start': {
      const t = threads.get(params.threadId);
      if (!t) {
        out({ id, error: { code: -32602, message: 'unknown thread' } });
        return;
      }
      if (t.activeTurn) {
        out({ id, error: { code: -32000, message: 'turn already active' } });
        return;
      }
      const turnId = `turn_${n++}`;
      t.activeTurn = turnId;
      if (params.sandboxPolicy) {
        t.sandbox =
          params.sandboxPolicy.type === 'workspaceWrite' ? 'workspace-write' : 'read-only';
        t.writableRoots = params.sandboxPolicy.writableRoots ?? [];
      }
      out({
        id,
        result: {
          turn: { id: turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null },
        },
      });
      setImmediate(() => void runTurn(params.threadId, turnId, params.input).then(flush, flush));
      return true;
    }
    case 'turn/steer': {
      const t = threads.get(params.threadId);
      if (!t?.activeTurn || t.activeTurn !== params.expectedTurnId) {
        out({ id, error: { code: -32000, message: 'no matching active turn' } });
        return;
      }
      out({ id, result: { turnId: t.activeTurn } });
      agentMessage(params.threadId, t.activeTurn, `Steer received: ${textOf(params.input)}`);
      return;
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId);
      out({ id, result: {} });
      if (t?.activeTurn === params.turnId) complete(params.threadId, params.turnId, 'interrupted');
      return;
    }
    default:
      out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}
