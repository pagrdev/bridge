# `@pagr/claude-channel`

A [Claude Code **channel**](https://code.claude.com/docs/en/channels) that connects a running
Claude Code session to your Pagr-paired phone. It is the only path on which Pagr can steer an
**in-flight** Claude turn instead of queueing a follow-up.

> **Research preview. Development flag only. Pagr does not depend on this package.**
> See [Status](#status) below before installing it.

## What it does

`server.mjs` is an MCP stdio server. Claude Code spawns it as a subprocess and it does exactly
three things, all of them against the local Pagr daemon's Unix socket:

| Direction | Mechanism | Effect |
| --- | --- | --- |
| Phone → session | long-polls the daemon (`channel.poll`), then emits `notifications/claude/channel` | Your text lands in the session Claude is already working in, as `<channel source="pagr" origin="pagr" seq="N">…</channel>` |
| Session → phone | Claude calls the `reply` MCP tool → daemon (`channel.outbound`) | The daemon emits a `session.event` of kind `agent_message`; the cloud texts you |
| Approvals | `notifications/claude/channel/permission_request` → daemon (`approval.request`) → `notifications/claude/channel/permission` | A permission prompt from an interactive Claude Code session reaches your phone, and your answer closes the local dialog |

The daemon flips the Claude adapter into live-steering mode for a project the moment a channel
starts polling it. From then on `agent.send_instruction` for a session in that project is
delivered as `{ delivered: 'steered' }` — a real injection into the running turn — rather than
`'queued'`.

## Status

Channels are an Anthropic research preview, and custom channels are not on the approved
allowlist. Quoting the [channels reference](https://code.claude.com/docs/en/channels-reference)
(fetched 2026-08-24):

> During the research preview, custom channels aren't on the approved allowlist. Use
> `--dangerously-load-development-channels` to test locally.

and:

> Channels are a research preview feature. Availability is rolling out gradually, and the
> `--channels` flag syntax and protocol contract may change based on feedback.

and, on registration:

> Being in `.mcp.json` isn't enough to push messages: a server also has to be named in
> `--channels`.

**GA does not depend on this.** [ADR 0001](../../../platform/docs/adr/0001-claude-integration-mode.md)
makes `cli-hooks` the default and only shipping mode:

> **approved-channel:** feature-flagged; only enabled if Pagr's channel plugin is allowlisted by
> Anthropic. Custom channels currently require `--dangerously-load-development-channels` and are
> dev-only.

Without the flag, Pagr behaves exactly as it does today: instructions sent to a busy Claude
session become a *queued follow-up*, and that is what the cloud is told — never a faked steer.

Channels also require Anthropic authentication (claude.ai or a Console API key), are unavailable
on Bedrock / Google Cloud's Agent Platform / Microsoft Foundry, and on Team and Enterprise plans
an admin must set `channelsEnabled: true` before any channel delivers anything.

## Setup

```bash
npm i -g @pagr/claude-channel          # optional add-on; the CLI does not bundle it
pagr claude channel-setup --project .  # merges the `pagr` entry into ./.mcp.json
```

`channel-setup` never clobbers an existing `.mcp.json`: it merges one key under `mcpServers` and
refuses to touch a file it cannot parse. `--remove` takes just that key back out.

Then restart the daemon with the feature flag and start Claude Code with the development flag:

```bash
PAGR_CLAUDE_CHANNEL=1 pagr daemon run
claude --dangerously-load-development-channels server:pagr
```

Claude Code shows a full-screen warning listing the development channels it is loading, and asks
for consent for the new `.mcp.json` server the first time. Both are expected.

Without `PAGR_CLAUDE_CHANNEL=1` the daemon does not register `channel.poll` / `channel.outbound`
at all, and the channel server simply gets `unknown_method` and retries with backoff.

## Security

- **It talks to one thing.** The only socket this process opens is the Pagr daemon's
  `~/.pagr/run/daemon.sock` (mode `0600`, owned by you). No HTTP listener, no outbound network,
  no credentials read or stored. Compare the fakechat/Telegram reference channels, which bind a
  local HTTP port or poll a chat platform's API.
- **Sender gating is inherited, not reimplemented.** The reference channels warn that "an ungated
  channel is a prompt injection vector" and gate on the platform sender id. Here, the only thing
  that can put text on the queue is the daemon, and the only thing that can put text into the
  daemon is a schema-valid, server-signed, unexpired, non-replayed command bound to this device
  (`packages/core/src/commandGuard.ts`). That is why declaring
  `claude/channel/permission` is defensible: the docs say to declare it "only ... if your channel
  authenticates the sender."
- **Approvals fail closed by staying silent.** The docs are explicit that a verdict Claude Code
  does not recognise is dropped and "the local terminal dialog stays open." So when the daemon is
  down, the project is not registered, or nobody answers in time, the server sends *nothing*.
  It never invents a `deny`, which would reject a call the user never saw, and it never invents
  an `allow`.
- **Relayed prompt text is untrusted.** `description` and `input_preview` come from the model and
  the tool call; the docs say to treat both as untrusted. They are forwarded to the daemon as a
  preview string and never executed, interpolated into a shell, or logged to stdout.
- **stdout is sacred.** stdout is the MCP transport. Every diagnostic goes to stderr, which
  Claude Code captures in `~/.claude/debug/<session-id>.txt`.
- **Anyone who can text you can approve tool use.** That is inherent to permission relay — the
  channels docs say so directly: "Anyone who can reply through the channel can approve or deny
  tool use in your session." Under Pagr that set is the paired account, and nothing wider.

## Layout

| File | Role |
| --- | --- |
| `src/protocol.mts` | The Claude Code channel wire contract, transcribed from the docs |
| `src/channel.mts` | The MCP server: capabilities, `reply` tool, permission handler, poll loop |
| `src/daemon-link.mts` | The IPC client: `channel.poll`, `channel.outbound`, `approval.request` |
| `src/server.mts` | Entry point (`dist/server.mjs`) — env, stdio transport, signal handling |

Configuration is entirely environmental, because Claude Code owns the command line:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAGR_DAEMON_SOCK` | recorded `run/daemon.sock.path`, else the default | Daemon socket |
| `PAGR_HOME` | `~/.pagr` | Where to look for that socket |
| `PAGR_CHANNEL_CWD` | `process.cwd()` | Project this channel serves |
| `PAGR_SESSION_ID` | — | Bind replies to a specific `ses_…` |
| `PAGR_CHANNEL_POLL_TIMEOUT_MS` | 30000 | Must exceed the daemon's 25 s poll window |
| `PAGR_CHANNEL_APPROVAL_TIMEOUT_MS` | 540000 | Under Claude Code's 600 s prompt budget |
