# Privacy

The Pagr bridge is a daemon that runs on your Mac and lets the Pagr cloud drive your local
Claude Code and Codex sessions. This document states exactly what leaves your machine.

## No telemetry

The bridge sends **no analytics, crash reports, usage metrics, or tracking of any kind**.
The only bytes that leave your machine are:

1. **Protocol events** to the Pagr gateway over an outbound WebSocket (`packages/protocol/src/schemas.ts`,
   `EventPayloads`). Every event type is enumerated there; anything not in that file cannot be sent.
2. **Pairing requests** (`POST /v1/devices/pair/start`, `GET /v1/devices/pair/status/:id`) carrying your
   device's *public* key, a device name you choose, `platform: 'darwin'`, the macOS version, and the
   bridge version.
3. **Attachment downloads** — HTTPS GETs to short-lived, device-bound URLs the cloud hands the bridge for
   screenshots you sent from your phone.

If you want to verify this, grep `packages/core/src` for `fetch(` and `new WebSocket` — those are the only
network call sites: `transport.ts` (gateway), `pairing.ts` (pairing API), `attachments.ts` (downloads).

## What is in the protocol events

**What changed with the iPhone app.** Before protocol v2, the transcript of a session never left
this Mac: the cloud saw a clipped summary and nothing else. It does now — but **sealed**. The
words leave the Mac encrypted for the phones you have paired, and the Pagr cloud stores and relays
ciphertext it holds no key for. So the honest phrasing is not "your transcripts stay on your Mac";
it is *the cloud cannot read them*. The table below says exactly what it can.

| Event | Contains | The cloud cannot see |
| --- | --- | --- |
| `device.hello` / `device.heartbeat` | bridge + macOS version, agent install/auth status, project **ids + display names + git remote host/name**, session summaries, the capability names this Mac honours, the device-floor classes you lifted (by name), the Claude channel's state, the **fingerprints** of the phones sealed to | local filesystem paths, environment variables, file contents, the phones' private keys |
| `command.ack` | command id, status, error code, a short message, a command-specific result | secrets |
| `session.updated` / `session.event` | session id, status, control level, origin, a ≤2000-char summary produced by the adapter | the rest of the session; the summary is a clip, and everything else travels sealed |
| `approval.requested` | approval id, action type, the sha256 of the preview, the risk hints, expiry. On v2 the preview itself moves into a **sealed** frame and this field goes out empty | the command line or file list, once v2 is in force |
| `question.asked` | question id, how many options each question has, which take more than one, which must never be echoed back | the question's words and its option labels — those are in the sealed frame |
| `session.frame` | session/project/provider ids, a sequence number, the frame's **kind** (`assistant`, `tool_call`, `diff`, `terminal`…), a timestamp, its size, whether it was clipped, and the **sealed** body | the body. It is encrypted on this Mac for the phones you paired. A frame over 512 KiB is clipped for the wire (command output keeps its first 8 KiB and last 56 KiB) and the full text stays in `~/.pagr/journal/` |
| `imessage` (a field on the three events above) | **plaintext**, and only while you have an iMessage thread linked: the agent's final message of a turn clipped to 500 characters, an approval's one-liner, or "<Agent> asked: <header>" | nothing — this field is deliberately readable, because it is the line your iMessage thread shows. Unlink the thread and it stops on the very next event |
| `attachment.consumed` | attachment id and ok/error | image bytes |

**The phone → Mac direction is not sealed.** What you type on your phone — instructions, answers,
decisions — travels in the signed command payloads the cloud queues, re-mints and audits, and the
cloud can read those. `docs/SECURITY.md` § "What changed for the iPhone app" explains why.

### Backfill reads nothing new

`session.list_history` and `session.backfill` (protocol v2) let a phone ask this Mac for a part of a
transcript it does not have. Nothing about them widens what leaves the Mac in the clear:

- **Same files.** A backfill reads `~/.claude/projects/<project>/<session>.jsonl` and its superseded
  variants, the session's `subagents/agent-*.jsonl` and its `tool-results/` spill files, or Codex's
  own `thread/read` — exactly the files the transcript mirror already reads, under exactly the same
  rule that nothing in a directory outside a registered project is read, journaled or sealed.
- **Same envelope.** A backfilled frame is a `session.frame`, sealed for your phones with the same
  key and the same caps as a live one. The cloud relays the same ciphertext it cannot read. The only
  difference is one plaintext word in the routing metadata: `meta.source` says `backfill` instead of
  `transcript`, so the app can tell a replay from something happening now.
- **Same listing.** `session.list_history` sends session ids, project ids, display names, statuses
  and timestamps — the fields `device.hello` already sends. Never a path: a session whose directory
  is not a registered project is not listed at all, and one whose folder could be added travels as
  an `rh_…` handle only this Mac can resolve.
- **No new reach.** Both commands are signed, device-bound cloud commands like every other, refused
  on a v1 link, and one at a time. `pagr sessions backfill` runs the same code path locally.

## What stays local

Everything under `~/.pagr/` (mode 0700), and the device private key in the macOS Keychain:

| Path | Purpose |
| --- | --- |
| `config.json` | `deviceId`, `userId`, gateway URL, pinned server public keys, `recipientKeys` (the **public** X25519 key of each phone you paired, by fingerprint) and when they were last pinned, device name. No secrets: every key in this file is a public one. |
| `projects.json` | project id → **local path** mapping. This is the only place paths live; the cloud sees ids. |
| `project-id-salt.json` | 32 random bytes (0600) that ids are derived from, so the same folder keeps one id. Salted so an id cannot be tested against a guessed path off this Mac. Never transmitted. |
| `sessions.json` | session id → provider session id mapping. |
| `replay.json` | recently seen command nonces (anti-replay). |
| `policy.json` | the public approval policy synced from your dashboard settings. |
| `device-policy.json` | your local approval floor. Written only by you; no command can change it, and it is never sent anywhere. See `docs/SECURITY.md`. |
| `logs/daemon.log` | local JSON log. Home directory is rewritten to `~`. Never uploaded. |
| `journal/<sessionId>.log` | **plaintext copies of your own sessions, on your own disk** (0600, in a 0700 directory): one NDJSON line per transcript frame — the assistant's words, your messages, tool calls and their output, diffs, terminal blocks. It is the archive the phone's transcript is served from, and the reason a dropped connection costs a re-send rather than a hole. Pruned whole sessions at a time: nothing older than 30 days, and never more than 2 GiB in total, on the daemon's hourly tick or on demand with `pagr sessions purge [--older-than 30d] --yes` — which deletes journals and nothing else, never anything under `~/.claude`, and costs nothing permanent while the provider's own transcript is still there, since a later backfill rebuilds the journal from it. Never uploaded as it stands — what leaves this Mac is the sealed, capped copy described above. `pagr uninstall` deletes it with the rest of `~/.pagr/`. |
| `journal/<sessionId>.idx` | byte offsets into that log so a resume is a seek, not a scan (0600). Rebuilt from the log whenever it does not match it; holds no content of its own. |
| `journal/outbox.json` | per session, how far the frames have been sent and how far the cloud confirmed them (`{sent, acked}`). Ids and numbers only. |
| `tailer-state.json` | how far the transcript mirror has read each Claude transcript file: its inode, a byte offset, and the tail of a line that was still being written when the daemon last looked. It exists so a restart resumes instead of replaying every session on the Mac. Entries for files that are gone are swept on startup. |
| `tmp/att_*.{png,jpg,heic,webp}` | downloaded screenshots (0600), held for the agent turn that referenced them and deleted when that turn ends, whether it finished, failed or was stopped; a 1 h sweep is the backstop, and everything goes on daemon shutdown. |
| `run/` | `daemon.sock` — a Unix socket (0600) for the CLI, the Claude hook and the channel server, not reachable over the network — plus `daemon.lock` (the single-instance pid lock) and `daemon.sock.path` (the socket path in use, so hooks can find it). |
| `hooks/` | the `PermissionRequest` hook script `pagr claude hook-install` writes and points your Claude Code settings at. Executable, and it does one thing: ask the local daemon. |
| `bin/pagr-node` | a tiny launcher that resolves Node at start-up, so a Node upgrade cannot break the launch agent. No credentials. |
| Keychain `dev.pagr.bridge / device.private_key` | Ed25519 private key. Never transmitted. |

### What the daemon reads outside `~/.pagr`

| Path | Why | Written? |
| --- | --- | --- |
| `~/.claude/settings.json`, `.claude/settings.json` | the permission hook's entry, so `pagr doctor` can tell you whether prompts from your own `claude` reach your phone | only by `pagr claude hook-install` |
| `~/.claude/projects/<project>/<session>.jsonl` | Claude's own transcript. Two uses: the diff and terminal output of a tool call the stream did not carry, and **mirroring the Claude Code sessions you started yourself** — what you typed, what Claude said and did, in the same sealed frames a session you started from your phone produces. Only for a directory inside a project you have registered: in any other folder nothing is read, journaled or sealed. Superseded variants (`<session>.jsonl.superseded-…`) and the session's `tool-results/` spill files and `subagents/agent-*.jsonl` are part of the same transcript and are read the same way. | never |
| `~/.claude/sessions/<pid>.json` | which Claude Code processes are running, and where: pid, session id, working directory, version and the name you gave the session. It is how Pagr knows your own terminal session exists without reading the process table. Mode 0644; Claude writes it, Pagr only reads it. | never |
| `~/.claude/sessions/<pid>.<hash>.key` | **not read.** These are Claude's own 0600 messaging secrets. Pagr's discovery matches `<pid>.json` and nothing else, so a `.key` file is never opened. | never |
| `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) | existence only — whether you are logged in to Codex. The file is never opened. | never |
| `$CODEX_HOME/app-server-control/app-server-control.sock` | Codex's **shared app-server control socket**. Pagr connects to it as one more client (the same socket your `codex` TUI uses) to mirror terminal threads and relay their approvals. Everything it learns there — thread ids, working directories, the transcript items of threads you are running — is what it would learn from a session you started through Pagr, and it is sealed to your phones the same way. Nothing on a mirrored thread is ever written: no turn, no steer, no answer to a prompt Pagr was not asked. | never |
| `$CODEX_HOME` / `~/.codex` generally | not read. Pagr does not open `state_5.sqlite`, `logs_2.sqlite`, `config.toml` or `sessions/*.jsonl`; thread history comes from the app-server's own `thread/read`, which returns only what the phone would be shown. | never |

`PAGR_INSECURE_FILE_STORE=1` moves the private key to `~/.pagr/secrets.json` (0600). It exists for CI
and headless machines; the daemon logs a warning whenever it is in use.

### Processes the daemon may run

It spawns three kinds of child, all with argument arrays and never through a shell, and no secret
is ever passed as an argument (argv is visible in `ps` to every user on the machine):

| Process | When | What it is |
| --- | --- | --- |
| `claude` / `codex` | a session Pagr starts | the agent itself, as you would run it, in a registered project |
| `/usr/bin/caffeinate -i -s` | while a session is live or a prompt is waiting | the power assertion. **Idle sleep only** — closing the lid still sleeps the Mac. It is reference-counted, released 60 s after the last piece of work, and dies with the daemon. `PAGR_KEEP_AWAKE=0` removes it |
| `codex app-server` | only when there is no shared Codex daemon to attach to | a private app-server for Pagr's own sessions. When your shared daemon *is* running, Pagr attaches to it as one more client and starts nothing |

The Claude **channel server** (`dist/channel-server.mjs`) is not in that list because the daemon
never starts it: Claude Code does, as an MCP server, when you launch a session with `pagr claude`.
It has no network listener and no credentials, and talks only to the daemon's 0600 socket.

### Deleting what v2 added

`pagr logout` removes the journal directory whole, `tailer-state.json`, `replay.json`,
`sessions.json` and `config.json` — which is where `recipientKeys` lives — deletes the device
private key from the Keychain, takes Pagr's hook back out of your Claude Code settings, and asks
Claude Code to drop the user-scope `pagr` MCP server. It leaves `~/.claude` and `~/.codex`
otherwise exactly as it found them; a mirrored Codex thread is handed its subscription back rather
than left attached. `--purge` also drops the project registry. `pagr uninstall` does all of that
and removes `~/.pagr` entirely.

## Deleting your data

`pagr logout` deletes the Keychain entry and `config.json`; `pagr uninstall` removes the launch agent and
`~/.pagr/`. Revoking the device from the dashboard makes the cloud reject the key immediately.
