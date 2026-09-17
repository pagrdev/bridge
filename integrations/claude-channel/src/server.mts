#!/usr/bin/env node
// DEPRECATED entry point, kept so an existing `{"command":"node","args":["…/server.mjs"]}`
// registration keeps working. The server itself lives in `@pagr/bridge-adapter-claude` and ships
// as `@pagr/cli`'s `dist/channel-server.mjs`; register that one with `pagr claude channel-install`.
import { runChannelServer } from '@pagr/bridge-adapter-claude';

export function main(env: NodeJS.ProcessEnv = process.env): void {
  runChannelServer(env);
}

if (process.env.PAGR_CHANNEL_LIBRARY !== '1') {
  try {
    main();
  } catch (err: unknown) {
    process.stderr.write(`pagr-channel: fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
