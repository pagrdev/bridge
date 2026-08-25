#!/usr/bin/env node
// Pagr channel server for Claude Code (ADR 0001 mode `approved-channel`).
//
// RESEARCH PREVIEW / DEV FLAG ONLY. Claude Code spawns this file as an MCP stdio subprocess when
// it is listed in `.mcp.json` AND named on the command line:
//
//     claude --dangerously-load-development-channels server:pagr
//
// It talks to exactly one thing: the local Pagr daemon's Unix-domain socket (0600, this user).
// No network listener, no credentials, no filesystem access beyond that socket.
//
// stdout belongs to the MCP transport — every diagnostic goes to stderr, which Claude Code
// captures in ~/.claude/debug/<session-id>.txt.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createChannelServer } from './channel.mjs';
import { IpcDaemonLink } from './daemon-link.mjs';

const num = (v: string | undefined): number | undefined => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cwd = env.PAGR_CHANNEL_CWD || process.cwd();
  const pollTimeoutMs = num(env.PAGR_CHANNEL_POLL_TIMEOUT_MS);
  const approvalTimeoutMs = num(env.PAGR_CHANNEL_APPROVAL_TIMEOUT_MS);
  const link = new IpcDaemonLink({
    cwd,
    ...(env.PAGR_DAEMON_SOCK ? { socketPath: env.PAGR_DAEMON_SOCK } : {}),
    ...(env.PAGR_HOME ? { home: env.PAGR_HOME } : {}),
    ...(env.PAGR_SESSION_ID ? { sessionId: env.PAGR_SESSION_ID } : {}),
    ...(pollTimeoutMs ? { pollTimeoutMs } : {}),
    ...(approvalTimeoutMs ? { approvalTimeoutMs } : {}),
  });
  const channel = createChannelServer({
    link,
    onError: (message) => process.stderr.write(`pagr-channel: ${message}\n`),
  });
  await channel.connect(new StdioServerTransport());
  process.stderr.write(`pagr-channel: attached to ${cwd} via ${link.socketPath}\n`);
  const stop = () => void channel.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.env.PAGR_CHANNEL_LIBRARY !== '1') {
  main().catch((err: unknown) => {
    process.stderr.write(`pagr-channel: fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
