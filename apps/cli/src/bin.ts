#!/usr/bin/env node
import { run } from './index.js';

run(process.argv.slice(2)).then(
  (code) => {
    // `daemon run` keeps the loop alive; anything else exits cleanly.
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  },
);
