# Spike MOB-045 — Claude Code development channels on this Mac (2.1.220 vs 2.1.274)

Date: 2026-09-17. Research only; no product code. Everything below was observed on Waleed's Mac
(Darwin 25.6.0, node 22.11.0) with the throwaway server `/tmp/spike-channel/server.mjs` (raw
JSON-RPC over stdio, declares `experimental['claude/channel'] = {}` and
`experimental['claude/channel/permission'] = {}`, one `spike_reply` tool, emits one
`notifications/claude/channel` per file dropped in an inbox dir, logs every wire message).
Interactive runs were driven through a real pty (python `pty.fork`, 120x40, rendered with `pyte`);
headless runs through pipes exactly like `packages/adapter-claude/src/claude-process.ts` does.

## TL;DR

| # | Question | 2.1.220 | 2.1.274 |
|---|---|---|---|
| 1 | Hidden flags accepted? | Yes. Unknown `server:` name is a dim banner line, not an error | Same |
| 2 | Dev-channel warning | Full-screen dialog every launch; Enter accepts (option 1 preselected); banner lists the channel | Same text; banner line can be hidden behind `+N more · /status` |
| 3 | Acceptance persisted? | **No.** No key in `~/.claude.json` or `~/.claude/settings.json`; dialog returns every launch | Same |
| 4 | `claude mcp add-json --scope user` nameable as `server:<name>`? Project `.mcp.json`? | Both work. Project scope adds the "New MCP server found in this project" consent dialog **before** the warning | Same |
| 5 | Injection | Idle: `← pagr-spike: …` line in <1 s, model turn starts immediately. Mid-turn: line renders instantly, model handles it at the next turn boundary | Same |
| 6 | Permission relay | `permission_request` sent (Bash and MCP tools) **only when the server is named on the flag**; remote `allow` closes the local dialog | Same; dialog has an extra "switch to auto mode" option |
| — | Headless (`-p --input-format stream-json`, how the bridge spawns claude) | Server connects, no dialog, no hang, **events silently dropped** (not even on the next user turn) | Same |
| — | `--channels server:pagr` (non-dev flag) | "server: entries need --dangerously-load-development-channels" + "not on the approved channels allowlist"; no dialog | Same |
| 7 | Binary on PATH | `~/.local/bin/claude` → npm global; **was 2.1.220 at spike start, self-updated to 2.1.274 on the second interactive launch** | Cursor bundles 2.1.263…2.1.274 under `~/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude` |

## Environment and a caveat about "2.1.220"

| Item | Value |
|---|---|
| `which -a claude` | `/Users/waleed/.local/bin/claude` only |
| Resolves to | `~/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (Mach-O arm64), `installMethod: "global"` in `~/.claude.json` |
| Version at start | `2.1.220 (Claude Code)` |
| After the second interactive launch | banner `Claude Code v2.1.274 … Updated to latest. Got 67 features, 412 bugfixes, and 152 other changes.` — the npm global install auto-updated itself; `claude --version` on PATH now prints 2.1.274 |
| 2.1.220 for the rest of the spike | `npm install --prefix /tmp/spike-channel/cc220 @anthropic-ai/claude-code@2.1.220`, run with `DISABLE_AUTOUPDATER=1`; verified `2.1.220 (Claude Code)` and banner `v2.1.220` |
| Other binaries | `~/.cursor/extensions/anthropic.claude-code-{2.1.263,266,267,268,269,270,272,273,274}-darwin-arm64/resources/native-binary/claude` (2.1.274 verified with `--version`). No Claude under `~/.vscode/extensions`. This spike's own session ran under the 2.1.267 Cursor binary (`CLAUDE_CODE_EXECPATH`) |
| Model gotcha | 2.1.220 rejects the account default model: `API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is required.` (default is `claude-fable-5-1[1m]`). All 2.1.220 model turns below used `--model sonnet` |
| Permission default | 2.1.220 status bar: `⏸ manual mode on`. 2.1.274: `⏵⏵ auto mode on` plus the notice `Auto mode is now Claude Code's default permission mode` |

Only Q1 ran on the PATH binary while it was still 2.1.220; every other 2.1.220 result is from the
pinned install. Both binaries share `~/.claude.json`, so config observations cover both.

## Findings with evidence

### Q1 — flags exist but are hidden

`claude --help | grep -iE "channel|dangerously"` shows only `--dangerously-skip-permissions` and
`--allow-dangerously-skip-permissions`. `strings claude.exe` contains, with counts:
`--channels` (19), `dangerously-load-development-channels` (13), `claude/channel` (13),
`channelsEnabled` (12), `notifications/claude/channel` (11), `allowedChannelPlugins` (6),
`claude/channel/permission` (3), `notifications/claude/channel/permission_request` (2),
`development channels` (2). No string that looks like a persisted-acceptance key (the only
`hasAcknowledged*` is `hasAcknowledgedCostThreshold`).

`claude --dangerously-load-development-channels server:pagr-spike` with **no** such server
registered (PATH binary, still 2.1.220): the warning dialog appears anyway (listing
`Channels: server:pagr-spike`); after Enter the banner reads

```
 ▎ Channels (experimental) messages from server:pagr-spike inject directly in this session · restart without
 ▎ --dangerously-load-development-channels to stop
 ▎ server:pagr-spike · no MCP server configured with that name
   +1 more · /status
```

No error, no exit, no second prompt. (First launch in `/private/tmp/spike-channel` also showed the
normal folder-trust dialog first; that one persists as `hasTrustDialogAccepted` per project.)

### Q2 — the warning dialog, verbatim (identical on both versions)

```
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use this option to run
  channels you have downloaded off the internet.

  Please use --channels to run a list of approved channels.

  Channels: server:pagr-spike

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
```

| Detail | Observation |
|---|---|
| When | ~0.7–1.8 s after launch on a trusted folder; after the folder-trust dialog; after the `.mcp.json` consent dialog (see Q4); before the welcome banner |
| Accept | `Enter` (option 1 is preselected). `Esc` or option 2 exits |
| Banner after accept (registered server) | `▎ Channels (experimental) messages from server:pagr-spike inject directly in this session · restart without --dangerously-load-development-channels to stop` |
| 2.1.274 quirk | In one run the channel line was collapsed into `+3 more · /status` (auto-mode notice and "Introducing Fable 5.1" took the slots) |
| Server side | `initialize` from `clientInfo {name:"claude-code", title:"Claude Code", version:"2.1.220"|"2.1.274"}`, `protocolVersion 2025-11-25`, client capabilities `roots.listChanged`, `elicitation`; then `notifications/initialized`, `tools/list` |

### Q3 — nothing persists the acceptance

Relaunched with the same command 6+ times on 2.1.220 and 4+ times on 2.1.274. The dialog appeared
every time (`first screen containing 'WARNING: Loading development channels'` at 0.7–1.0 s).

Config diff, pre-spike snapshot vs after all runs:

| File | Result |
|---|---|
| `~/.claude/settings.json` | byte-identical |
| `~/.claude.json` | no key containing "channel", "dangerous", "acknowledg" or "accept" was added. New top-level keys during the spike: `mcpServers` (from `claude mcp add-json`), `hasSeenAutoDefaultNotice`, `mcpNeedsAuthNoticed`, `promptQueueUseCount`, `claudeInChromeDefaultEnabled`, `githubWebConnectionStatusCache`, `hasCompletedClaudeInChromeOnboarding`, `lastClawdEntranceVersion` — none channel-related. New per-project keys: the usual `hasTrustDialogAccepted`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedTools`, `last*` stats |

`grep -oiE '"[a-z]*channel[a-z]*"' ~/.claude.json ~/.claude/settings.json ~/.claude/settings.local.json` → nothing.

### Q4 — registration scopes

| Step | Output |
|---|---|
| `claude mcp add-json --scope user pagr-spike '{"command":"node","args":["/tmp/spike-channel/server.mjs"]}'` | `Added stdio MCP server pagr-spike to user config` — written to top-level `mcpServers.pagr-spike` in `~/.claude.json` |
| `claude mcp list` | `pagr-spike: node /tmp/spike-channel/server.mjs - ✔ Connected` |
| `claude mcp get pagr-spike` | `Scope: User config (available in all your projects)` |
| `--dangerously-load-development-channels server:pagr-spike` | registers (banner line + Q5 injection worked) — a user-scope entry is nameable as `server:<name>` |

Project scope, i.e. what `pagr claude channel-setup` writes today (`.mcp.json` →
`{"mcpServers":{"pagr-spike-proj":{"command":"node","args":[…]}}}`), launched with
`server:pagr-spike-proj` on 2.1.220:

```
  0.5s  New MCP server found in this project: pagr-spike-proj
        MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.
        ❯ 1. Use this MCP server
          2. Use this and all future MCP servers in this project
          3. Continue without using this MCP server
  3.1s  Enter
  3.4s  WARNING: Loading development channels   (Channels: server:pagr-spike-proj)
  9.0s  Enter
  9.1s  ▎ Channels (experimental) messages from server:pagr-spike-proj inject directly in this session · …
```

So the flag accepts project-scope entries too; the user answers two dialogs on the first launch in
that project. (Whether option 1 persisted into `enabledMcpjsonServers` could not be read reliably —
concurrent spike sessions were rewriting `~/.claude.json`; it read `[]` afterwards.)

### Q5 — injection semantics (2.1.220 pinned, `--model sonnet`; 2.1.274 matched)

Idle session, server emits
`{"method":"notifications/claude/channel","params":{"content":"spike ping: reply with the single word PONG and nothing else","meta":{"origin":"spike","seq":"1"}}}`:

| t | Terminal |
|---|---|
| 12.0 s | inbox file written (server polls every 250 ms) |
| 13.0 s | `← pagr-spike: spike ping: reply with the single word PONG and nothing else` (2.1.274: 0.5 s) |
| 13–22 s | model turn starts on its own; it called the server's `spike_reply` tool (`tools/call {"name":"spike_reply","arguments":{"text":"PONG"}}`, shown as `Called pagr-spike`) then printed `⏺ PONG` |

The terminal never shows a literal `<channel …>` tag; the arrow line is the UI rendering and it is
truncated to one row (`… and nothing …`). The tag is what the model receives.

Mid-turn (model asked to write a 500-word story and end with DONE; the server emitted during
generation):

| t | Event |
|---|---|
| 8.7 s | prompt submitted, streaming starts ~10 s |
| 17.1 s | emit |
| 17.2 s | `← pagr-spike: spike ping 2 …` line rendered **immediately, inside the running turn**, below the streaming text |
| 23.1 s | story ends (`DONE`), stop hooks run, `✻ Cooked for 14s` |
| 23.7 s | the queued event is delivered as a fresh turn (arrow line re-rendered under the finished turn) |
| 24.8 s | `⏺ PONG2` |

So: surfaced instantly in the UI, acted on at the next turn boundary (here 6.6 s later). Matches
the reference doc: "Events queue into the session and are processed in order. If several
notifications arrive while Claude is busy, they're delivered together on the next turn."

Note for the reply tool: when the model chose to answer via `spike_reply` in manual mode, that
tool call itself opened a permission dialog (and was relayed — see Q6). Pagr's `reply` tool will
hit the same dialog unless allowed (`mcp__pagr__reply`) — the docs' own walkthrough relies on it.

### Q6 — permission relay on 2.1.220

`--permission-mode default --dangerously-load-development-channels server:pagr-spike`, prompt
"Use the Bash tool to run exactly: touch /tmp/spike-channel/q6.txt" (`echo hi` is auto-approved in
default mode and never opens a dialog, so it is not a valid trigger):

| t | Terminal | Wire (server log) |
|---|---|---|
| 10.9 s | dialog `Bash command / touch /tmp/spike-channel/q6.txt / Create empty file q6.txt / Do you want to proceed? ❯ 1. Yes / 2. Yes, and always allow access to spike-channel/ from this project / 3. No` | `IN {"method":"notifications/claude/channel/permission_request","params":{"request_id":"ediwn","tool_name":"Bash","description":"Create empty file q6.txt","input_preview":"{ \"command\": \"touch /tmp/spike-channel/q6.txt\", \"description\": \"Create empty file q6.txt\" }"}}` |
| +3.0 s | — | server: `OUT {"method":"notifications/claude/channel/permission","params":{"request_id":"ediwn","behavior":"allow"}}` |
| 13.9 s | dialog gone | |
| 14.8 s | `Ran 1 shell command`; file exists | |

Also fired for an MCP tool: `{"request_id":"phfis","tool_name":"mcp__pagr-spike__spike_reply","description":"Reply to the spike channel","input_preview":"{ \"text\": \"PONG2\" }"}`.

2.1.274 identical (`request_id":"epkia"`, dialog gone 3.0 s after the allow) except the dialog now has
`3. Yes, and switch to auto mode · auto mode handles these prompts for you` and `4. No`, plus a
`Tip: auto mode handles these prompts for you` line.

**Without the flag** (plain `claude --model sonnet --permission-mode default`, server still
registered at user scope and still declaring both capabilities): the dialog opened at 10.9 s and
stayed open until my keystroke at 46.5 s; the server received **no** `permission_request`, and an
emitted channel event was **dropped** (no arrow line, no turn). So on 2.1.220 relay is already
gated on the server being named on the flag; the documented v2.1.234 tightening ("sends permission
requests only to servers it registered as channels") changes nothing for Pagr. (The other pre-2.1.234
difference in the docs — `false` treated as declared — is irrelevant; Pagr sets `{}`.)

`PermissionRequestSchema` in `integrations/claude-channel/src/protocol.mts` matches the payload
exactly (`request_id`, `tool_name`, `description`, `input_preview`).

### Headless: the way the bridge spawns claude

`packages/adapter-claude/src/claude-process.ts` spawns
`claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --permission-prompt-tool stdio …`.
Same shape here, plus `--dangerously-load-development-channels server:pagr-spike`, stdin kept open:

| t | 2.1.220 (`--model sonnet`) | 2.1.274 |
|---|---|---|
| 1.0–1.5 s | `system/init` — `mcp_servers: [{name:"pagr-spike", status:"connected"}]`; no channel field in init | same (`source:"user"` added) |
| 2–3.5 s | `assistant OK`, `result success` | same |
| 10 s | server emits `spike ping` | same |
| 10–30 s | **nothing** — no user/assistant event, no tool call | same |
| 30 s | second user message sent | same |
| 31.7 / 33.8 s | `assistant OK2` — the queued event was never delivered | same |

No dialog is shown and nothing hangs; there is also no "channel" line in the `--debug-file` log of
either version. All the debug log says about the server (both versions) is the plain MCP handshake:

```
MCP server "pagr-spike": Successfully connected (transport: stdio) in 110ms
MCP server "pagr-spike": Connection established with capabilities: {"hasTools":true,"hasPrompts":false,"hasResources":false,"hasResourceSubscribe":false,"serverVersion":{"name":"pagr-spike","version":"0.0.1"}}
…
MCP server "pagr-spike": Sending SIGINT to MCP server process        (on stdin close)
``` Consistent with the reference doc: "If the session hasn't loaded your server as a
channel … Claude Code drops the events silently and returns no error to your server." The dev-flag
bypass is only confirmed through the interactive dialog; headless sessions cannot confirm it, so the
channel is simply not registered.

### `--channels server:pagr-spike` (non-dev flag), both versions

No dialog. Banner:

```
 ▎ Channels (experimental) messages from server:pagr-spike inject directly in this session · restart without --channels
 ▎ to stop
 ▎ server:pagr-spike · server: entries need --dangerously-load-development-channels
```

then ~10 s later a notice line `server pagr-spike is not on the approved channels allowlist (use
--dangerously-load-development-channels for local d…`. A bare server can never ride `--channels`.

## Decision for MOB-037

| Topic | Decision | Why |
|---|---|---|
| Shim flag | Ship a `pagr claude` launcher (or shell alias) that `exec`s `claude --dangerously-load-development-channels server:pagr "$@"`. Register the server at **user scope** with `claude mcp add-json --scope user pagr '{"command":"node","args":["<abs path to server.mjs>"]}'` in `pagr claude channel-setup` (keep `.mcp.json` as an option for per-project use). | `--channels server:…` is rejected on both versions. User scope is nameable, works in every project, and avoids the extra "New MCP server found in this project" consent dialog on every new project. `claude mcp add-json` is the supported way to write `~/.claude.json` (it rewrites the whole file; never hand-edit). |
| "By default" | Default means: MCP entry registered and the launcher installed. The user still presses Enter on the warning **once per launch**. The launcher must print one line before exec ("Pagr channel attached — Claude Code will ask you to confirm the development-channel warning; press Enter") so the dialog is expected, not alarming. | No config key or env var pre-accepts the dialog on 2.1.220 or 2.1.274; it appears every launch. |
| Prompt handling | Do **not** automate the keystroke (no pty tricks, no expect). | It is the consent gate; its position varies (folder trust → `.mcp.json` consent → warning), option numbering differs by version, and the shim would be blind to whether the launch is interactive. |
| `--no-channel` | **Yes, required.** The launcher must skip the flag when (a) `--no-channel` / `PAGR_NO_CHANNEL=1` is given, (b) stdin or stdout is not a TTY, or (c) `-p`/`--print`/`--output-format` is present. The bridge's own `claude-process.ts` spawns must never add the flag. | Headless sessions cannot answer the dialog; the channel is silently unregistered and every event is dropped with no error. Adding the flag there is pure noise and a false sense of steering. |
| Permission relay vs the `PermissionRequest` hook | Keep the hook as the default approval path. Use relay **in addition**, only in channel mode (already implemented in `channel.mts`). Do not remove the hook on this version. | Relay works on 2.1.220 (Bash and MCP tools, full `input_preview`, remote `allow` closes the local dialog) but only for sessions launched with the flag; plain `claude` sessions and bridge-spawned headless sessions get nothing. With 2.1.274's auto-mode default, dialogs (and therefore relays) fire far less often, so relay is a convenience, not a transport. |
| `pagr doctor` | Report "steering reachable" only for interactive launches through the launcher; there is no observable signal from a headless session that the channel registered. | `system/init` has no channels field; debug log has no channel lines. |
| Version floor | State ≥ 2.1.251 in docs, not 2.1.220. | 2.1.220 cannot run the current default models; flag syntax and dialog are identical from 2.1.220 through 2.1.274. |

## Risks

| Risk | Evidence / note |
|---|---|
| Auto-update moves the target under us | The PATH binary went 2.1.220 → 2.1.274 during this spike on its second interactive launch. Any behaviour pinned to a version is stale within days. |
| Dialog copy/order may change | Research preview: "the `--channels` flag syntax and protocol contract may change based on feedback". 2.1.274 already changed the permission dialog options and the default permission mode. |
| Silent failure mode | An unregistered channel drops events with no error on either side. The bridge must not claim steering unless launched interactively with the flag. |
| Banner may hide the channel notice | 2.1.274 collapsed it into `+3 more · /status`; users may not see that the channel is live. |
| Prompt-injection surface | By design, anything the daemon relays lands in the model's context; the terminal shows one truncated line per event. The 0600 socket gating in `daemon-link.mts` is the only guard. |
| Reply-tool permission dialog | In manual mode the model's `reply` call opens a dialog; the relay can answer it remotely, which creates a loop (phone message → reply tool → dialog → phone approval). Pre-allow `mcp__pagr__reply` in the launcher or document it. |
| `~/.claude.json` clobbering | Claude Code rewrites the whole file; concurrent sessions overwrote each other's per-project keys during the spike. Register via `claude mcp add-json`, never by editing. |
| Two channel-enabled sessions | Events go to every session that named the server; the doc's advice is separate sessions per stream. Pagr's daemon should pin one session or the user gets duplicate reactions. |
| Side effects left on this Mac | PATH `claude` is now 2.1.274 (auto-updater, not this spike's doing but triggered by it); `/private/tmp/spike-channel` has a trusted-project entry in `~/.claude.json`; top-level `mcpServers` may remain as `{}` after removal. `~/.claude/settings.json` is byte-identical to before. |

## Cleanup performed

`claude mcp remove --scope user pagr-spike` → removed; `claude mcp list` no longer lists it and
`~/.claude.json` contains no `pagr-spike`. Spike server and pinned-binary processes killed. Nothing
written outside `/tmp/spike-channel` (pinned 2.1.220 install, throwaway server, pty driver, raw
captures, wire logs) and this note. No commit.
