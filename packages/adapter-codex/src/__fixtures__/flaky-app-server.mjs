#!/usr/bin/env node
// A deliberately unhealthy `codex app-server` for restart-policy tests.
//
//   FLAKY_MODE=crash  → completes the initialize handshake, then exits(1) shortly after.
//   FLAKY_MODE=mute   → never answers initialize at all (the client's request times out).
//
// FLAKY_SPAWN_LOG (required) gets one line per spawn: `<pid> <mode>`.

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.env.FLAKY_MODE ?? 'crash';
appendFileSync(process.env.FLAKY_SPAWN_LOG, `${process.pid} ${mode}\n`);

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.149.1\n');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method !== 'initialize') return;
  if (mode === 'mute') return; // hang forever; the client must time out and clean us up
  process.stdout.write(
    `${JSON.stringify({
      id: m.id,
      result: {
        userAgent: 'flaky/0.149.1',
        codexHome: '/tmp/flaky',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    })}\n`,
  );
  setTimeout(() => process.exit(1), 10);
});
// Deliberately NOT exiting on stdin close in `mute` mode: a child that ignores EOF is exactly
// what the orphan check has to survive.
if (mode !== 'mute') rl.on('close', () => process.exit(0));
