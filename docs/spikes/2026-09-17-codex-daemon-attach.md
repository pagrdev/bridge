# Spike MOB-043 — attaching the bridge to Codex's shared app-server daemon

Date: 2026-09-17. Machine: Waleed's Mac mini (macOS 26.6.2, arm64). `codex-cli 0.149.1` installed via npm (`~/.local/bin/codex` -> `@openai/codex` wrapper -> native binary under `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`). Research only; no product code. Upstream source quoted at tag `rust-v0.149.1` (sha `980a6d12…`) unless noted.

Hard constraint hit early: `codex login status` -> `Not logged in`, no `~/.codex/auth.json`, `codex doctor` -> `auth: no Codex credentials were found`. Every `turn/start` therefore failed with `401 Unauthorized` from `api.openai.com`. Everything that requires a model response (agent messages, command execution items, live approval requests, file changes) is marked **could not verify**. Everything about sockets, transport, subscriptions, locks, `thread/read` and storage was verified live.

## Findings

### 1. Control socket path and the `daemon` subcommands

- Path is `$CODEX_HOME/app-server-control/app-server-control.sock` (default `~/.codex/...`). Evidence, with no daemon running:
  ```
  $ codex app-server daemon version
  Error: failed to connect to /Users/waleed/.codex/app-server-control/app-server-control.sock
  Caused by: No such file or directory (os error 2)
  ```
  The native binary also contains the constants `app-server-control`, `app-server-control.sock`, `app-server-startup.lock`, `app-server-daemon`, `app-server.pid`, `daemon.lock`, `settings.json`, `packages/standalone`.
- `codex app-server daemon start` **does not work with an npm install**:
  ```
  Error: managed standalone Codex install not found at /Users/waleed/.codex/packages/standalone/current/codex
  This command requires the standalone install managed by the Codex installer, because the daemon starts and updates app-server from that fixed path.
  Install it with: curl -fsSL https://chatgpt.com/codex/install.sh | sh
  ```
  It creates `~/.codex/app-server-daemon/{daemon.lock,app-server.pid.lock}` and `~/.codex/app-server-control/app-server-startup.lock` (all zero bytes) before failing. I removed those afterwards. Upstream (`app-server-daemon/src/lib.rs`): `current_managed_codex_bin()` / `ensure_managed_codex_bin()`; comment: "old CLIs must not mistake a daemon-owned installation for their backend".
- To observe the mechanism without touching the user's home I used an isolated `CODEX_HOME=/tmp/spike-codex/home` with `packages/standalone/current/codex` symlinked to the npm binary:
  ```
  $ CODEX_HOME=/tmp/spike-codex/home codex app-server daemon start
  {"status":"started","backend":"pid","pid":63886,"managedCodexPath":".../packages/standalone/current/codex","managedCodexVersion":"0.149.1","socketPath":"/private/tmp/spike-codex/home/app-server-control/app-server-control.sock","cliVersion":"0.149.1","appServerVersion":"0.149.1"}
  $ CODEX_HOME=... codex app-server daemon version
  {"status":"running","backend":"pid",...,"appServerVersion":"0.149.1"}
  $ CODEX_HOME=... codex app-server daemon stop
  {"status":"notRunning",...}
  ```
  What it spawned (detached, ppid 1): `node .../packages/standalone/current/codex app-server --listen unix://` (bare `unix://` = the default control-socket path). Files created: `app-server-control/{app-server-control.sock (srw-------), app-server-startup.lock}`, `app-server-daemon/{app-server.pid ({"pid":63886,"processStartTime":...}), app-server.pid.lock, daemon.lock, app-server.stderr.log}`. Backend `pid` = plain pid file; a `launchd` backend exists but was not used. `daemon bootstrap` installs "durable local app-server management for SSH-driven use" (has `--remote-control`); `enable-remote-control` / `disable-remote-control` toggle the ChatGPT-backend remote-control websocket (`remoteControl/status/changed` notification arrives on every connect; `remote_control_enrollments` table in `state_5.sqlite`).
- macOS `SUN_LEN` (104 bytes) applies. A first attempt under the long scratchpad path failed with `path must be shorter than SUN_LEN` (both for the daemon and for `--listen unix://PATH`). `~/.codex/app-server-control/app-server-control.sock` is 62 bytes, fine.
- `codex app-server proxy --help`: `--sock <SOCKET_PATH>` ("Path to the app-server Unix domain socket to connect to", optional -> defaults to the control socket), plus `-c`, `--enable/--disable`. Description: "Proxy stdio bytes to the running app-server control socket". It is a raw byte relay (see finding 3).
- `codex app-server --listen` accepts `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`; `--ws-auth capability-token|signed-bearer-token` only applies to non-loopback websocket listeners. Server log on start: `app-server control socket listening socket_path=...` (`codex_app_server_transport::transport::unix_socket`).

### 2. `~/.codex/ipc/ipc.sock` is not the daemon

`lsof -U`: `ipc.sock` is held by the **ChatGPT desktop app's main Electron process** (PID 34536, 9 fds) — no `codex` process has it. The desktop app runs its app-server as a **stdio child**: `/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled` (bundled version `codex-cli 0.154.0-alpha.6.1`). The Cursor "openai.chatgpt" extension had three more stdio `app-server` children (its own 26.903 binary). So on this Mac there was **no shared daemon at all** at baseline, and the desktop/IDE threads live in private stdio processes the bridge cannot reach (see finding 6). `~/.codex/.codex-global-state.json` says the desktop app's host is `local:/Users/waleed/.codex`; `state_5.sqlite` had 0 thread rows, i.e. no local threads had ever been created on this machine.

### 3. The control socket speaks WebSocket, and `proxy` does not hide that

- Writing newline-delimited JSON-RPC straight to the unix socket (with or without `"jsonrpc":"2.0"`) gets the connection closed with no bytes back. Server log (`logs_2.sqlite`, target `codex_app_server_transport::transport::unix_socket`, `unix_socket.rs:82`):
  `failed to upgrade control socket websocket connection: WebSocket protocol error: httparse error: invalid token`
- A manual HTTP/1.1 `Upgrade: websocket` handshake (`GET / HTTP/1.1`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`) gets `HTTP/1.1 101 Switching Protocols`; then one JSON-RPC message per masked text frame, **`jsonrpc` header omitted works** (exactly the bridge's `encode()` payload, framed instead of newline-terminated):
  ```
  {"id":1,"result":{"userAgent":"wsprobe/0.149.1 (Mac OS 26.6.2; arm64) unknown (wsprobe; 0)","codexHome":"/Users/waleed/.codex","platformFamily":"unix","platformOs":"macos"}}
  {"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"Waleeds-Mac-mini.local","installationId":"...","environmentId":null},"emittedAtMs":1789659740220}
  ```
  Upstream daemon client (`app-server-daemon/src/client.rs`): `connect_at(socket_path, "ws://localhost/")` via `tokio_tungstenite::client_async`, `clientInfo.name = "codex_app_server_daemon"`, 2 s response timeout; version is parsed from the `initialize` `userAgent`.
- `codex app-server proxy --sock PATH`: the same handshake bytes written to the proxy's stdin came back as the same `101` and frames (verified against both my own `--listen unix://` server and the isolated daemon). So the proxy is only useful as an SSH `ProxyCommand`-style byte pipe; a client behind it still needs a WebSocket implementation. It gives the bridge nothing over a direct unix-socket WebSocket.
- Server -> client pings (opcode 9) must be answered; the initial `remoteControl/status/changed` notification arrives before/around the `initialize` response.

### 4. Does the TUI / `exec` use the daemon?

Measured against the isolated daemon by counting `initialize` rows in its `logs_2.sqlite` (each new connection logs `app-server request: initialize connection_id=ConnectionId(N)`).

- Plain `codex` TUI (driven under a pty with `expect`, 12–15 s, twice): the daemon logged a new connection each time — `initialize connection_id=ConnectionId(6) request_id=String("initialize")`, then `account/read connection_id=ConnectionId(6)` — preceded by one `failed to upgrade ... Handshake not finished` warning (the TUI's 50 ms socket probe). So **0.149.1's TUI auto-attaches to the shared daemon when its socket exists**. Upstream `tui/src/lib.rs`: `app_server_target_for_launch(...)` -> `AppServerTarget::LocalDaemon { allow_embedded_fallback: true, endpoint: RemoteAppServerEndpoint::UnixSocket { socket_path } }`; `AUTO_CONNECT_DAEMON_CONNECT_TIMEOUT = 50ms`; on failure `"local daemon connection failed; starting embedded app server"`. Reuse is disabled by explicit `--remote`, workload identity, an executor URL, and `can_reuse_implicit_local_daemon == false` (invocation-specific overrides). Because the account is not logged in the TUI stopped at the login screen: **could not verify** that threads/turns of a logged-in TUI actually run inside the daemon (no `thread/start` was observed), nor whether `-C`/`-c`/`-m` overrides force embedded mode.
- `codex agents` ("Browse all agent sessions on the shared local app-server daemon"): with `-C <dir>` it exits immediately with `Error: \`codex agents\` cannot attach to shared sessions with invocation-specific configuration overrides`; run from the cwd without overrides it connected (`initialize connection_id=ConnectionId(10)`).
- `codex exec --skip-git-repo-check -C /tmp/spike-codex/repo --json "say hi"` (isolated home): created thread `01a0b00c-d5dd-7ae3-ac32-d2f7960abb2f` (`threads.source = 'exec'`), **no new daemon connection**, and no lock file left after exit. `exec` runs its own in-process core; its threads are visible to the daemon only via the shared state DB / rollout (read-only) after the fact.
- `codex --remote unix://<daemon sock>` (TUI): no daemon connection within 15 s, terminal output unreadable — **could not verify**.
- `thread-writer-locks/`: baseline `.coordination.lock` only. `<threadId>.lock` appears at `thread/start` (before any turn) and disappears when the owning process exits or the thread is deleted. Verified in both `~/.codex` and the isolated home.

### 5. Multi-client behaviour inside one app-server process

Two WebSocket clients A and B on one server (run both through `codex app-server proxy --sock` children and directly; identical results), `initialize {capabilities:{experimentalApi:true}}` + `initialized`, `thread/start {cwd:/tmp/spike-codex/repo, approvalPolicy:'untrusted', sandbox:'workspace-write'}` from A. Thread `01a0b00a-e3c0-77b1-88c5-416fa1545aa4` in `~/.codex` (deleted afterwards).

| Step | Result |
|---|---|
| A `thread/start` | ok in 271 ms; **B also receives `thread/started`** (broadcast). `thread/status/changed`, `thread/goal/cleared` are broadcast too (server log `targeted_connections=0` = broadcast path). |
| B `thread/loaded/list` | `{"data":["01a0b00a-…"],"nextCursor":null}` — sees A's in-memory thread. |
| B `thread/list {limit:5}` | `{"data":[]}` before the first user message; after it, the thread is listed with `preview` = first message. From a *different process* the same thread shows `"status":{"type":"notLoaded"}` — status is per process. |
| B `thread/read {includeTurns:true}` before first user message | `{"code":-32600,"message":"thread 01a0b00a-… is not materialized yet; includeTurns is unavailable before first user message"}` |
| B `thread/resume {threadId}` before first user message | `{"code":-32600,"message":"no rollout found for thread id 01a0b00a-…"}` (A's own re-resume fails identically). No writer-lock error. |
| B `thread/resume` after the first turn | ok (8 ms), full `ThreadResumeResponse`; server log: `resume_running_thread` / `composing running thread resume response ... active_turn_present=false`. Upstream `thread_lifecycle.rs`: `try_add_connection_to_thread(conversation_id, connection_id)` then `replay_requests_to_connection_for_thread` (pending server requests are replayed to the new subscriber). |
| A `turn/start` while B is *not* subscribed | A gets `turn/started, item/started, item/completed, error…, turn/completed` (`targeted_connections=1`); **B gets only the broadcast `thread/status/changed`**. |
| A `turn/start` after B `thread/resume` | **both** get `turn/started, item/started(userMessage), item/completed, error, turn/completed` (`targeted_connections=2`). |
| B `turn/start` on A's thread *without* having resumed | accepted (`turn/started` returned to B as the response) but the notifications for that turn went to **A only** — `turn/start` does not subscribe the caller. |
| B `thread/unsubscribe {threadId}` | `{"status":"unsubscribed"}`; next A turn: B back to `thread/status/changed` only. |
| Approval requests (`item/commandExecution/requestApproval`, …) | **Could not verify live** (turns 401'd before any command). Source at `rust-v0.149.1`: `bespoke_event_handling.rs` handles `EventMsg::ExecApprovalRequest` / `ApplyPatchApprovalRequest` / `RequestPermissions` with `outgoing.send_request(ServerRequestPayload::CommandExecutionRequestApproval(..))` where `outgoing: &ThreadScopedOutgoingMessageSender`; `ThreadScopedOutgoingMessageSender::send_request` -> `send_request_to_connections(Some(self.connection_ids.as_slice()), ..)`, which allocates **one request id** and sends the same request to **every subscribed connection**, with a single `oneshot` callback -> **first response wins**, later responses are dropped. `thread_state.rs` keeps `ThreadEntry.connection_ids: HashSet<ConnectionId>` (`try_ensure_connection_subscribed`, `unsubscribe_connection_from_thread`, `remove_connection`) and `subscribed_connection_ids`. So approvals go to all subscribers (A and B after B resumed), not to the turn starter alone and not to unsubscribed connections. `serverRequest/resolved` exists in `ServerNotification`; where it is emitted was not found in `outgoing_message.rs` — **not verified**. |
| Subscriber lifecycle | `thread_lifecycle.rs`: when the last subscriber disconnects and the thread is idle: `"thread {thread_id} has no subscribers and is idle; shutting down"` -> `unload_thread_without_subscribers` -> writer lock released. |

Notes: `remoteControl/status/changed` is sent to each new connection; `mcpServer/startupStatus/updated` (node_repl, cua_repl from the user's config) went to the starter only. The bridge's `classifyLine` logic is unchanged — only framing differs.

### 6. Cross-process: the writer lock

With my unix-socket server holding `01a0b00a-….lock`, a second `codex app-server` (stdio, same `~/.codex`):
```
thread/loaded/list -> {"data":[]}
thread/list        -> ok, thread listed, "status":{"type":"notLoaded"}
thread/read {includeTurns:true} -> ok, full turns (read-only works despite the lock)
thread/resume      -> {"error":{"code":-32600,"message":"thread 01a0b00a-e3c0-77b1-88c5-416fa1545aa4 already has an active writer"},"id":5}
stderr: ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread … already has an active writer
```
Source: `codex-rs/rollout/src/writer_lock.rs` — `WRITER_LOCK_DIR = "thread-writer-locks"`, `COORDINATION_LOCK_FILE = ".coordination.lock"`; `acquire(thread_id)` takes the coordination lock, opens `<id>.lock`, exclusive lock, `WouldBlock` -> `"thread {thread_id} already has an active writer"`; `remove_stale_thread_locks` on acquire; `Drop` closes then deletes the file. This is the issue-44449 behaviour ("Remote Control: threads viewed in the iOS app stay locked in the daemon, desktop fails with 'already has an active writer'"; daemon 0.153.1 held locks for ~50 min for idle threads the phone had resumed; author proposes read-only access like PR #43253 did for the TUI). Practical consequence: threads owned by the ChatGPT desktop app's stdio app-server, by Cursor, by `codex exec`, or by a TUI running embedded are **read-only** to the bridge (`thread/read`, `thread/list`), never resumable.

### 7. `thread/read {threadId, includeTurns:true}`

- Latency 3–44 ms, 1.5–2.1 KB for a thread with two failed turns; same-process and cross-process both fine. Not measured on a large thread (**could not verify** cost at scale).
- Shape: `{thread:{id, sessionId, forkedFromId, parentThreadId, preview, ephemeral, section, projectId, historyMode:"legacy", modelProvider, createdAt, updatedAt, recencyAt, status, path (rollout .jsonl), cwd, cliVersion, source:"vscode", canAcceptDirectInput, gitInfo, name, turns:[{id, items:[…], itemsView:"full", status:"failed", error:{message, codexErrorInfo, additionalDetails}, startedAt, completedAt, durationMs}]}}`.
- Item ids in `thread/read` are rollout-derived `item-1`, `item-2`, … while the live `item/started` notifications carried UUIDv7 ids (`01a0b00c-6ed8-…`). Backfill dedupe must key on (turnId, index/content), not item id.
- `agentMessage`, `commandExecution{command, cwd, status, aggregatedOutput, exitCode, durationMs, commandActions, processId}`, `fileChange{changes:[{path, kind, diff}], status}` shapes come from `generated/v2/ThreadItem.ts` / `FileUpdateChange.ts` — **not observed live**.
- `source` was recorded as `vscode` for threads started over the app-server by an arbitrary client; `ThreadSourceKind` also has `cli`, `exec`, `appServer`, `subAgent*`. `thread/list` defaults to "interactive sources" unless `sourceKinds` is passed.

### 8. Where 0.149.1 stores threads

- `~/.codex/state_5.sqlite` (sqlx, 54 migrations). Tables: `threads` (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_*, cli_version, first_user_message, agent_nickname/role, memory_mode, model, reasoning_effort, agent_path, *_ms columns, thread_source, preview, recency_at, history_mode DEFAULT 'legacy', name, is_pinned, thread_section_id, section_position, project_id, originator, daybreak_enabled), `thread_dynamic_tools`, `thread_spawn_edges`, `thread_artifacts`, `thread_sections`, `projects`, `project_roots`, `project_idempotency_keys`, `remote_control_enrollments`, `external_agent_config_imports`, `rollout_migration_state`, `rollout_migration_skipped_rollouts`, `backfill_state`. Row counts at baseline: `threads 0`, `backfill_state 1`, `thread_sections 1`, rest 0. A spike `thread/start` inserted one row immediately (`rollout_path=/Users/waleed/.codex/sessions/2026/09/17/rollout-2026-09-17T10-44-58-<id>.jsonl`, `source=vscode`, `cli_version=0.149.1`, `history_mode=legacy`, `approval_mode=untrusted`, `sandbox_policy` = full managed-profile JSON).
- Rollouts: **yes, `sessions/*.jsonl` still exist in 0.149.1.** `~/.codex/sessions/` did not exist at baseline (never used); it was created on `thread/start`. The spike file was 26 lines / 52 KB after two failed turns: `session_meta` (includes full base instructions, ~10 KB), `event_msg` (`task_started`, `user_message`, `task_complete`), `response_item` (`message` with developer/user roles), `turn_context`. `ThreadListParams.useStateDbOnly` ("return from the state DB without scanning JSONL rollouts to repair thread metadata") and `codex migrate-rollouts` ("migrate legacy local sessions to paginated thread history") plus feature `background_paginated_rollout_migration` (under development) show the JSONL layout is transitional.
- `~/.codex/logs_2.sqlite`: tracing sink shared by every process in the home (`logs(ts, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid = "pid:<pid>:<uuid>")`). It contains TRACE-level JSON-RPC lines (`app-server request: <method> connection_id=…`, `app-server event: <notification> targeted_connections=N`), which is how most of finding 5 was confirmed. Grows fast (3.5 MB + 4.5 MB WAL here).
- `~/.codex/sqlite/codex-dev.db` belongs to the desktop app (28 `codex_schema_migrations`; `inbox_items`, `automations`, `automation_runs`, `local_thread_catalog*`, `thread_timeline_ledger`, …) — not the CLI's store.
- Also present: `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite` (`codex queue`).

### 9. Misc facts worth keeping

- `initialize` response: `{userAgent, codexHome, platformFamily, platformOs}` — `codexHome` tells the bridge which home the server it attached to is using.
- `codex features list`: `remote_control` is `removed` (it is now the built-in daemon/remote-control machinery); `multi_agent stable true`; nothing named like "shared daemon" is gated behind a flag.
- Version skew on this Mac: CLI 0.149.1, desktop bundle 0.154.0-alpha.6.1, `codex doctor` says 0.154.0 available. `daemon version` reports `cliVersion` and `appServerVersion` separately, presumably because they can differ.
- Process names: the native binary, the npm `node` wrapper and the daemon child are all named `codex`; the desktop app's and Cursor's app-servers are too. Never signal by name.

## Recommendation for MOB-038

- **Transport**: implement a second `AppServerClient` transport — WebSocket over the unix control socket, one JSON-RPC message per text frame, same `encode()` payload (no `jsonrpc` header needed), same `classifyLine`, plus ping/pong. Connect directly to `$CODEX_HOME/app-server-control/app-server-control.sock`; do not spawn `codex app-server proxy` (it is a byte relay that still requires a WebSocket client and adds a process). Keep the existing stdio JSONL child as the embedded fallback. Node's `ws` package can dial unix sockets (`ws+unix://<path>:/`), or keep a ~60-line hand-rolled client like the spike used.
- **Discovery**: `CODEX_HOME` env else `~/.codex`; `stat` the socket; probe with `initialize` under a ~2 s timeout (the daemon client's own timeout) and read `codexHome` back. If absent, run embedded. Do **not** try `codex app-server daemon start` automatically: it needs the installer-managed standalone package, which npm installs lack; surface a doctor hint instead (`codex app-server daemon version` gives machine-readable status). Also expect the daemon to be absent for desktop-app-only users — the desktop app does not use it.
- **`mirror_only` feasibility**: feasible only for threads hosted **in the same daemon process**: `thread/loaded/list` (or `thread/list`) -> `thread/resume {threadId}` subscribes the bridge and it then receives `turn/*`, `item/*`, `error`, `turn/completed` for the TUI's turns; `thread/unsubscribe` to stop; `thread/started` is broadcast so new TUI threads can be picked up live. Constraints: (a) `thread/resume` fails with `no rollout found` until the first user message — retry on `thread/status/changed` / after the first `turn/started`; (b) staying subscribed keeps the thread loaded and its writer lock held (issue 44449) — unsubscribe on idle; (c) threads owned by other processes (desktop app, Cursor, `codex exec`, embedded TUI) are mirrorable only by polling `thread/read {includeTurns:true}` (cheap, read-only, works across processes) keyed on `updatedAt`. Whether a logged-in TUI actually runs its threads in the daemon (rather than only calling `account/read` there) **could not be verified** on this machine and must be re-checked once an account is logged in.
- **Relaying approvals for TUI threads**: for daemon-hosted threads, yes in principle — after `thread/resume` the bridge receives the same `item/commandExecution/requestApproval` (same request id) as the TUI; the first `respond` wins and the loser is silently ignored. Design consequences: never auto-answer or answer on timeout from the bridge; treat a `turn/completed`/`item/completed` for the item as "resolved elsewhere"; watch for `serverRequest/resolved` (present in the notification enum, emission not verified). For threads outside the daemon there is no channel at all. Live fan-out is inferred from `rust-v0.149.1` source, **not observed**.
- **Backfill source**: `thread/read {threadId, includeTurns:true}` — works across processes and under a foreign writer lock, millisecond latency on small threads, already-normalised `ThreadItem` shapes. Use `thread/list {useStateDbOnly:true, cwd:[…], sourceKinds:[…]}` for enumeration. Do not parse `sessions/*.jsonl` (contains full system prompts, layout is being migrated to "paginated thread history") or `state_5.sqlite` (version-suffixed file name, 54 migrations) except as a last-resort diagnostic. Dedupe backfilled items by (turnId, position) because `thread/read` item ids (`item-N`) differ from live UUIDv7 item ids.

## Risks

1. **No daemon on npm installs** (needs `~/.codex/packages/standalone/current/codex`); the desktop app and Cursor never use it either. The attach path may serve only users who ran the official installer and use the TUI.
2. **Unverified TUI ownership**: only `initialize` + `account/read` from the TUI were observed on the daemon. If the TUI runs threads embedded despite the daemon, mirroring degrades to `thread/read` polling.
3. **Approval race**: all subscribers get the same request id; first responder wins silently. A bridge bug (or a late iMessage reply after the TUI answered) is harmless only if the bridge never answers unsolicited; a bridge answering before the user sees it in the TUI would hijack the decision.
4. **Writer-lock retention**: a subscribed bridge keeps the thread loaded and locked (issue 44449 shows ~50 min holds). Must unsubscribe when idle and on shutdown; otherwise the desktop app / another process gets `already has an active writer`.
5. **Not-materialised threads**: `thread/resume` and `thread/read includeTurns` both error before the first user message.
6. **Version drift**: control-socket protocol, `thread/loaded/list`, `thread/unsubscribe`, `useStateDbOnly` are experimental-era APIs; the desktop bundle is already at 0.154 while the CLI is 0.149. The spike used `experimentalApi: true`; whether `thread/loaded/list` / `thread/unsubscribe` are gated behind it was **not checked** (the bridge currently sends `false`).
7. **Notification volume / broadcast noise**: `thread/started`, `thread/status/changed`, `thread/goal/cleared`, `remoteControl/status/changed` are broadcast to every connection; deltas (`item/agentMessage/delta`, reasoning deltas) arrive per subscriber.
8. **Item-id mismatch** between live notifications and `thread/read` (see finding 7).
9. **Process naming**: every Codex process is named `codex`. During this spike a `pkill -x codex` meant for my pty-driven TUI also killed the ChatGPT desktop app's stdio app-server (PID 34597) and Cursor's three (35183–35185); the parents (ChatGPT.app 34536, Cursor extension hosts) stayed alive and had not respawned them at the end of the spike. The bridge must only ever signal PIDs it spawned.
10. **Log growth**: `logs_2.sqlite` receives TRACE rows for every JSON-RPC message from every process in the home.

## What this spike touched and how it was cleaned up

- Created and removed: `/tmp/spike-codex/` (isolated `CODEX_HOME`, git repo, sockets, scripts), scratchpad probe scripts, my own `codex app-server --listen unix://` server, the isolated daemon (`daemon stop` reported `notRunning` because the earlier `pkill` had already killed its child; socket removed).
- In `~/.codex`: one spike thread (`01a0b00a-e3c0-77b1-88c5-416fa1545aa4`, four 401'd turns) — deleted with `codex delete --force`, its `sessions/` directory tree removed (did not exist at baseline), `thread-writer-locks/` back to `.coordination.lock` only; the empty `app-server-control/` and `app-server-daemon/` lock dirs created by the failed `daemon start` were removed. Not reversible: TRACE rows my processes appended to `~/.codex/logs_2.sqlite`. `config.toml` untouched.
- Processes I did not start but killed by mistake: see risk 9. Restarting the ChatGPT desktop app / reloading the Cursor ChatGPT extension will respawn them.
