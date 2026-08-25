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

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.149.1\n');
  process.exit(0);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let seq = 1000;
const threads = new Map(); // id -> { cwd, activeTurn }
const pendingServerReqs = new Map(); // id -> resolve
let n = 0;

function requestFromServer(method, params) {
  const id = seq++;
  return new Promise((resolve) => {
    pendingServerReqs.set(id, resolve);
    out({ id, method, params });
  });
}

const textOf = (input) =>
  input
    .filter((i) => i.type === 'text')
    .map((i) => i.text)
    .join(' ');
const imagesOf = (input) => input.filter((i) => i.type === 'localImage').map((i) => i.path);

function agentMessage(threadId, turnId, text) {
  const itemId = `item_${n++}`;
  out({
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } },
  });
  for (const ch of text.match(/.{1,6}/g) ?? []) {
    out({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: ch } });
  }
  out({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text },
      completedAtMs: Date.now(),
    },
  });
}

function complete(threadId, turnId, status, error = null) {
  const t = threads.get(threadId);
  if (t) t.activeTurn = null;
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

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && m.method === undefined) {
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
      const t = threads.get(params.threadId) ?? { cwd: params.cwd, activeTurn: null };
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
    case 'thread/list':
      out({
        id,
        result: {
          data: [...threads.entries()].map(([tid, t]) => ({
            id: tid,
            preview: '',
            cwd: t.cwd,
            createdAt: 0,
            updatedAt: 0,
            status: { type: 'idle' },
            name: null,
            turns: [],
          })),
          nextCursor: null,
        },
      });
      return;
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
      out({
        id,
        result: {
          turn: { id: turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null },
        },
      });
      setImmediate(() => runTurn(params.threadId, turnId, params.input));
      return;
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
});
rl.on('close', () => process.exit(0));
