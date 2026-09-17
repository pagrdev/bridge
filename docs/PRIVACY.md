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

| Event | Contains | Never contains |
| --- | --- | --- |
| `device.hello` / `device.heartbeat` | bridge + macOS version, agent install/auth status, project **ids + display names + git remote host/name**, session summaries | local filesystem paths, environment variables, file contents |
| `command.ack` | command id, status, error code, a short message, a command-specific result | secrets |
| `session.updated` / `session.event` | session id, status, a ≤2000-char summary produced by the adapter | full transcripts, diffs, file bodies |
| `approval.requested` | a ≤1500-char **preview** of the action (the command line or file list) and its sha256 | full file contents |
| `session.frame` | session/project/provider ids, a sequence number, the frame's **kind** (`assistant`, `tool_call`, `diff`, `terminal`…), a timestamp, its size, whether it was clipped, and the **sealed** body | anything readable. The body is encrypted on this Mac for the phones you have paired, and the cloud relays ciphertext it holds no key for. A frame over 512 KiB is clipped for the wire (command output keeps its first 8 KiB and last 56 KiB) and the full text stays in `~/.pagr/journal/` |
| `attachment.consumed` | attachment id and ok/error | image bytes |

## What stays local

Everything under `~/.pagr/` (mode 0700), and the device private key in the macOS Keychain:

| Path | Purpose |
| --- | --- |
| `config.json` | `deviceId`, `userId`, gateway URL, pinned server public keys, device name. No secrets. |
| `projects.json` | project id → **local path** mapping. This is the only place paths live; the cloud sees ids. |
| `project-id-salt.json` | 32 random bytes (0600) that ids are derived from, so the same folder keeps one id. Salted so an id cannot be tested against a guessed path off this Mac. Never transmitted. |
| `sessions.json` | session id → provider session id mapping. |
| `replay.json` | recently seen command nonces (anti-replay). |
| `policy.json` | the public approval policy synced from your dashboard settings. |
| `device-policy.json` | your local approval floor. Written only by you; no command can change it, and it is never sent anywhere. See `docs/SECURITY.md`. |
| `logs/daemon.log` | local JSON log. Home directory is rewritten to `~`. Never uploaded. |
| `journal/<sessionId>.log` | **plaintext copies of your own sessions, on your own disk** (0600, in a 0700 directory): one NDJSON line per transcript frame — the assistant's words, your messages, tool calls and their output, diffs, terminal blocks. It is the archive the phone's transcript is served from, and the reason a dropped connection costs a re-send rather than a hole. Pruned whole sessions at a time: nothing older than 30 days, and never more than 2 GiB in total. Never uploaded as it stands — what leaves this Mac is the sealed, capped copy described above. `pagr uninstall` deletes it with the rest of `~/.pagr/`. |
| `journal/<sessionId>.idx` | byte offsets into that log so a resume is a seek, not a scan (0600). Rebuilt from the log whenever it does not match it; holds no content of its own. |
| `journal/outbox.json` | per session, how far the frames have been sent and how far the cloud confirmed them (`{sent, acked}`). Ids and numbers only. |
| `tmp/att_*.{png,jpg,heic,webp}` | downloaded screenshots (0600), held for the agent turn that referenced them and deleted when that turn ends, whether it finished, failed or was stopped; a 1 h sweep is the backstop, and everything goes on daemon shutdown. |
| `run/daemon.sock` | Unix socket (0600) for the CLI and Claude hooks. Not reachable over the network. |
| Keychain `dev.pagr.bridge / device.private_key` | Ed25519 private key. Never transmitted. |

`PAGR_INSECURE_FILE_STORE=1` moves the private key to `~/.pagr/secrets.json` (0600). It exists for CI
and headless machines; the daemon logs a warning whenever it is in use.

## Deleting your data

`pagr logout` deletes the Keychain entry and `config.json`; `pagr uninstall` removes the launch agent and
`~/.pagr/`. Revoking the device from the dashboard makes the cloud reject the key immediately.
