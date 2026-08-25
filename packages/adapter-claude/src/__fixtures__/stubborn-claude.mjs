#!/usr/bin/env node
// A `claude` that answers normally but IGNORES EOF on stdin — the case where closing stdin is
// not enough and the adapter has to escalate to a signal rather than orphan the child.
// STUBBORN_PID_LOG (required) gets one line per spawn.

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}
appendFileSync(process.env.STUBBORN_PID_LOG, `${process.pid}\n`);

const sessionId = (() => {
  const i = argv.indexOf('--session-id');
  const j = argv.indexOf('--resume');
  return (i >= 0 ? argv[i + 1] : undefined) ?? (j >= 0 ? argv[j + 1] : undefined) ?? 'stubborn';
})();
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: sessionId })}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], model: 'stubborn' });
  out({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    parent_tool_use_id: null,
    uuid: 'u0',
  });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 });
});
// Deliberately no `rl.on('close', …)`: EOF is ignored, and an interval keeps the loop alive.
setInterval(() => {}, 1 << 30);
