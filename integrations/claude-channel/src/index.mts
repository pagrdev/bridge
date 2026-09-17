/**
 * DEPRECATED. The Pagr channel server now ships inside `@pagr/cli` as `dist/channel-server.mjs`,
 * built from `@pagr/bridge-adapter-claude`, and it no longer depends on the MCP SDK.
 *
 * This package stays as a re-export so an existing `.mcp.json` or `claude mcp add-json` entry that
 * points at it keeps resolving. Register the channel with `pagr claude channel-install` and start
 * sessions with `pagr claude`; see the README.
 */
export {
  buildApprovalParams,
  CHANNEL_CAPABILITY,
  CHANNEL_NOTIFICATION,
  CHANNEL_PERMISSION_CAPABILITY,
  type ChannelPollResponse,
  type ChannelServer,
  type ChannelServerOptions,
  createChannelServer,
  type DaemonLink,
  INSTRUCTIONS,
  IpcDaemonLink,
  type IpcDaemonLinkOptions,
  PERMISSION_REQUEST_NOTIFICATION,
  PERMISSION_VERDICT_NOTIFICATION,
  type PermissionBehavior,
  type PermissionRequest,
  parsePermissionRequest,
  REPLY_TOOL,
  runChannelServer,
  SERVER_NAME,
  SERVER_VERSION,
} from '@pagr/bridge-adapter-claude';
