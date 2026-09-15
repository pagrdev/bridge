# Device protocol

Canonical source: `packages/protocol/src/schemas.ts` (`PROTOCOL_VERSION = 1`). This page walks through
it; if they disagree, the schema wins.

## Identifiers

All ids are `prefix_` + 32 lowercase hex: `usr_`, `dev_`, `proj_`, `ses_`, `cmd_`, `apr_`, `att_`. They are
opaque. The cloud never sends filesystem paths, phone numbers, or provider-native ids as identifiers.

## Transport frames

The bridge opens one outbound WebSocket to the gateway. Frames are JSON objects discriminated by `kind`.

```
bridge → gateway            gateway → bridge
----------------            ----------------
auth.request {deviceId}
                            auth.challenge {nonce}
auth.response {deviceId, nonce, signature, bridgeVersion, protocolVersion}
                            auth.result {ok, error?, serverKeys?, serverKeysSignature?, minBridgeVersion?}
event {event: DeviceEvent}  command {envelope: CommandEnvelope}
pong                        ping
```

- `signature` is base64url Ed25519 over the UTF-8 string `${deviceId}.${nonce}` using the device key.
- `serverKeys` is `keyId → base64url raw 32-byte Ed25519 public key`. The bridge pins this set
  (`config.json`) and uses it to verify commands. A set that adds a key id, or re-points a pinned id
  at a different key, is only accepted with `serverKeysSignature` — see *Server key rotation* in
  `docs/SECURITY.md`. Narrowing the set (the second half of a rotation) needs no signature.
- If `minBridgeVersion` is greater than the running version the bridge stops reconnecting and logs an
  update-required error.
- The bridge answers `ping` with `pong` and sends `device.heartbeat` every 20 s. It also sends a
  WebSocket ping on the same schedule and tears the socket down if the peer has sent nothing at all
  for three heartbeats — a slept laptop leaves a half-open socket that still reads as connected.
- The authentication phase has its own deadline (20 s). A proxy that accepts the upgrade and then
  says nothing gets retried, not waited on forever.

### `auth.result{ok:false}` and close codes

`error` is a machine-readable code, and the bridge acts on which one it is:

| `error` | bridge |
| --- | --- |
| `revoked`, `bad_signature`, `device_mismatch`, `protocol_version` | stops. The identity is refused; only `pagr connect` (or an update) fixes it |
| `rate_limited` | transient. Backs off at least a minute and retries — a per-IP limit is shared by every bridge behind one NAT and is **not** a revocation |
| `nonce_expired`, `nonce_mismatch`, `invalid_frame`, anything unrecognised | transient. Normal backoff |

| close | meaning | bridge |
| --- | --- | --- |
| 4000 | a newer connection took this device identity | backs off hard (5 min) and reports that another machine is using this pairing, rather than racing it |
| 4001 | handshake failed | per the `error` code above |
| 4002 | below `minBridgeVersion` | stops; update required |
| 1009 | frame over the gateway's 256 KiB cap | never provoked: the bridge measures every frame and refuses to send an oversized one |

Implementation: `packages/core/src/transport.ts`.

## Command envelope (cloud → bridge)

```json
{
  "keyId": "k2026-08",
  "signature": "<base64url Ed25519 over canonicalize(body)>",
  "body": {
    "version": 1,
    "commandId": "cmd_…",
    "userId": "usr_…",
    "deviceId": "dev_…",
    "issuedAt": "2026-08-24T12:00:00.000Z",
    "expiresAt": "2026-08-24T12:05:00.000Z",
    "nonce": "…≥16 chars…",
    "idempotencyKey": "…≥8 chars…",
    "type": "agent.start_session",
    "payload": { "…": "…" }
  }
}
```

`canonicalize` = `JSON.stringify` with recursively sorted keys, no whitespace, `undefined` dropped
(exported from `@pagr/protocol`). Verification order is documented in `docs/SECURITY.md`.

### Commands

| `type` | payload | result in `command.ack.result` |
| --- | --- | --- |
| `device.probe` | `{}` | a `device.hello` payload: agents, projects, sessions |
| `project.list` | `{}` | `{ projects: ProjectSummary[] }` |
| `project.remove` | `{ projectId }` | `{ projectId }` |
| `agent.start_session` | `{ provider, projectId, instruction, sessionId, displayName?, attachments[≤4], readOnly }` | `SessionSummary` |
| `agent.send_instruction` | `{ sessionId, instruction, mode: auto\|steer\|queue, attachments[≤4] }` | `{ sessionId, mode, delivered: steered\|queued\|new_turn }` |
| `agent.stop_session` | `{ sessionId }` | `{ sessionId }` |
| `agent.get_status` | `{ sessionId? }` | `{ sessions: SessionSummary[] }` |
| `agent.respond_to_approval` | `{ approvalId, sessionId, providerRequestId, previewHash, decision: allow\|deny }` | `{ approvalId, decision }` |
| `settings.sync_public_policy` | `{ approvalTimeoutSeconds }` | the stored policy |

`settings.sync_public_policy` once also carried `smartApprovalsTierA`, which let the bridge answer
"obviously safe" prompts itself. The bridge no longer decides approvals at all, so the field was
removed. A cloud that still sends it is **not** rejected — unknown keys are dropped by the payload
schema — it simply has no effect.

`sessionId` for `agent.start_session` is pre-allocated by the cloud so both sides share one id.
`mode: auto` resolves to `steer` when the adapter reports `canSteerActiveTurn` **and** the session has an
active turn; otherwise `queue`, and a `session.event` of kind `queued_followup` is emitted.

`AttachmentRef` = `{ attachmentId, downloadUrl, sha256, sizeBytes ≤ 50 MiB, mimeType (png/jpeg/heic/webp),
expiresAt }`. The bridge downloads, verifies, passes a local temp path to the adapter, and deletes it.

## Device events (bridge → cloud)

Every event carries `{ version: 1, eventId, deviceId, at, inReplyTo?, type, payload }`.

| `type` | when | payload |
| --- | --- | --- |
| `device.hello` | after each successful auth | bridge/OS version, `agents: AgentConnectionStatus[]`, `projects: ProjectSummary[]`, `sessions` (bounded — see below) |
| `device.heartbeat` | every 20 s | `{ activeSessions }` |
| `command.ack` | exactly once per received command (`inReplyTo = commandId`) | `{ commandId, status: accepted\|rejected\|completed\|failed\|duplicate, errorCode?, message?, result? }` |
| `project.registered` / `project.removed` | local CLI or `project.remove` | `ProjectSummary` / `{ projectId }` |
| `agent.connection` | adapter status change | `AgentConnectionStatus` |
| `session.updated` | session created or state changed | `SessionSummary` |
| `session.event` | progress, messages, completion… | `{ sessionId, projectId, provider, kind, summary ≤ 2000, providerEventId?, at }` |
| `approval.requested` | agent asked permission | `{ approvalId, sessionId, projectId, provider, providerRequestId, actionType, preview ≤ 1500, previewHash, hints, expiresAt }` |
| `approval.resolved_locally` | timeout, terminal answer, or shutdown | `{ approvalId, resolution: allowed\|denied\|timed_out\|canceled }` |
| `attachment.consumed` | after a download attempt | `{ attachmentId, ok, error? }` |

`errorCode` values: `bad_signature`, `expired`, `replayed`, `wrong_device`, `unknown_project`,
`unknown_session`, `unknown_approval`, `capability_unsupported`, `provider_error`, `invalid_payload`.
`status: rejected` means the guard refused the command before dispatch; `failed` means dispatch ran and
the adapter or a precondition failed. A second copy of a command already accepted — the gateway's 30 s
resend, or a retry under the same `idempotencyKey` — is answered with the terminal ack of the single
execution (waiting for it if it is still running), so the same `commandId` can be acked more than once
with the same result. (`duplicate` remains a valid status in the schema for older bridges; a bridge at
this version answers a duplicate with the genuine terminal status instead.) `unknown_approval` distinguishes an approval that expired or was already answered
from a session that no longer exists.

### `device.hello` is bounded

The hello is sent on **every** connect, so it can never be allowed to grow past the frame cap — an
oversized one is a 1009 close followed by an identical oversized one, forever. Three things bound it:

- each adapter prunes its own session map (terminal entries past a week, then a 500-entry ceiling,
  live sessions never evicted);
- the hello carries at most 100 sessions, live first and then most-recently-updated;
- the serialised payload is measured before it is sent and sheds sessions (then projects) until it
  fits, logging what it dropped.

A session left out is not forgotten — it is still resumable by id and still answers
`agent.get_status`. Statuses in the hello are the real ones: a session this Mac knows finished is
reported `completed` / `failed` / `stopped`, never downgraded to `idle`, because the cloud upserts
these summaries and a downgrade shows a dead session on the user's phone as resumable.

## Approval hints

`hints` are deterministic booleans computed locally by adapters (`touchesOutsideProject`, `networkAccess`,
`destructive`, `gitPush`, `packageInstall`, `secretsTouch`, `productionHint`). The cloud applies the final
risk tiering; the bridge only ever reports.

## Local IPC (not part of the cloud protocol)

`~/.pagr/run/daemon.sock`, newline-delimited JSON `{ id, method, params }` → `{ id, result }` |
`{ id, error: { code, message } }`. Methods: `status`, `projects.list`, `projects.add`, `projects.remove`,
`sessions.list`, `sessions.reconcile`, `channel.status`, `approvals.list`, `approval.request` (blocks
until decision/timeout, returns `{ approvalId, decision, resolution }`), `agent.event`. Under
`PAGR_CLAUDE_CHANNEL=1` two more are registered: `channel.poll` and `channel.outbound`.
See `packages/core/src/ipc.ts` and `daemon.ts`.

- `sessions.reconcile` → `[{ sessionId, provider, projectId, status, outcome, reason }]`, where
  `outcome` is `resumable` | `terminated` | `failed`. The daemon runs this itself on startup, so a
  session that was working when the daemon died never survives as a zombie.
- `channel.status` → `{ enabled, attachedProjects, canSteerLive }`. `enabled` only means the flag is
  set; `canSteerLive` is the one that says a follow-up would really interrupt a turn.

## Concurrency rules (bridge-side, no protocol change)

`agent.start_session` is refused with `errorCode: capability_unsupported` and a human-readable
`message` when:

| situation | why |
| --- | --- |
| a write-capable session already holds that working tree (or one containing it) | neither provider isolates the other; two agents in one checkout overwrite each other. Read-only sessions may share a tree, and a separate `git worktree` is a separate tree. Override locally with `PAGR_ALLOW_CONCURRENT_WRITERS=1` |
| this provider already has `PAGR_MAX_SESSIONS_PER_PROVIDER` (default 4) live sessions | bounded process pool |
| the device already has `PAGR_MAX_SESSIONS` (default 8) live sessions | bounded process pool |

"Live" means `starting`, `working`, `waiting_for_approval` or `waiting_for_user`. There is no
protocol field for "the user explicitly asked for two writers in one tree", so that consent is
expressed locally on the device (see `packages/core/src/concurrency.ts`).

`AgentCapabilities.canSteerActiveTurn` is reported per probe and reflects what the device can do
*at that moment*: Claude Code reports `true` only while a channel is actually attached and polling,
never merely because `PAGR_CLAUDE_CHANNEL=1` is set.
