import { IpcDaemonLink } from './daemon-link.js';
import { createChannelServer } from './server.js';

/**
 * The process Claude Code spawns.
 *
 * It talks to exactly one thing: the local Pagr daemon's Unix-domain socket (0600, this user). No
 * network listener, no credentials, no filesystem access beyond that socket. stdout belongs to
 * the JSON-RPC transport, so every diagnostic goes to stderr.
 */

const num = (v: string | undefined): number | undefined => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function runChannelServer(env: NodeJS.ProcessEnv = process.env): void {
  const cwd = env.PAGR_CHANNEL_CWD || process.cwd();
  const pollTimeoutMs = num(env.PAGR_CHANNEL_POLL_TIMEOUT_MS);
  const approvalTimeoutMs = num(env.PAGR_CHANNEL_APPROVAL_TIMEOUT_MS);
  const link = new IpcDaemonLink({
    cwd,
    // `process.ppid` IS the `claude` that spawned us: the daemon reads
    // `~/.claude/sessions/<pid>.json` to learn which Claude session this channel belongs to.
    claudePid: num(env.PAGR_CHANNEL_CLAUDE_PID) ?? process.ppid,
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
  channel.start();
  process.stderr.write(`pagr-channel: attached to ${cwd} via ${link.socketPath}\n`);
  const stop = () => {
    channel.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
