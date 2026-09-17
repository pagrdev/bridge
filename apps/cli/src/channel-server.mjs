#!/usr/bin/env node
// The Pagr channel server, as Claude Code spawns it:
//
//     claude mcp add-json --scope user pagr '{"command":"node","args":["…/channel-server.mjs"]}'
//     pagr claude          # adds --dangerously-load-development-channels server:pagr
//
// It talks to exactly one thing: the local Pagr daemon's Unix-domain socket (0600, this user).
// No network listener, no credentials, no filesystem access beyond that socket. stdout belongs to
// the JSON-RPC transport, so every diagnostic goes to stderr — Claude Code captures it in
// ~/.claude/debug/<session-id>.txt.
//
// A file rather than a bin entry because `claude mcp add-json` records `node <path>`: the path has
// to exist inside this package's own install, so an upgrade moves the CLI and the server together.
import { runChannelServer } from '@pagr/bridge-adapter-claude';

try {
  runChannelServer();
} catch (err) {
  process.stderr.write(`pagr-channel: fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
