# Device protocol

Canonical source: `packages/protocol/src/schemas.ts`. One file describes **both** versions: v1, the
baseline every deployed gateway speaks, and v2, which adds the iPhone app. This page walks through
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
                            auth.result {ok, error?, serverKeys?, serverKeysSignature?,
                                         minBridgeVersion?, protocolVersion?,
                                         recipientKeys?, recipientKeysSignature?, features?}
event {event: DeviceEvent}  command {envelope: CommandEnvelope}
pong                        ping
                            ack {cursors} (v2)
                            keys.updated {recipientKeys, recipientKeysSignature?} (v2)
                            settings.updated {features} (v2)
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

## Protocol v2

v2 is strictly additive. No v1 shape was narrowed, every field v2 introduces is optional, and one
schema describes both — because a bridge and a gateway of different vintages have to understand
each other's frames on the same socket.

### Version negotiation

| Step | Who | What |
| --- | --- | --- |
| offer | bridge | `auth.response.protocolVersion` — the highest version this bridge speaks (2) |
| answer | gateway | `auth.result.protocolVersion` — the version it accepts. **Absent means 1** |
| in force | both | `min(offer, answer)`. Nothing v2-only may be sent until it is 2 |
| refusal | gateway | `auth.result{ok:false, error:'protocol_version'}` — the bridge retries **once**, offering 1, and stays there for the life of the process |
| reset | bridge | back to 1 the moment the socket closes: a version is a property of a connection, not of a daemon |

A gateway cannot promote a bridge past what it offered — it answers an offer, it does not make one.

### What each version carries

| | v1 | v2 |
| --- | --- | --- |
| session content | `session.event.summary` ≤ 2000 chars, `approval.requested.preview` ≤ 1500 chars, both plaintext | sealed `session.frame`s; the preview moves into its own sealed frame and `preview` goes out empty |
| approvals | `allow` / `deny` | the agent's own option list, `optionId`, `approval.applied` |
| questions | none — a question is an approval-shaped prompt or nothing | `question.asked` / `agent.answer_question` / `question.answered` |
| history | whatever the cloud kept | `session.list_history`, `session.backfill` from this Mac's journal |
| projects | added on the Mac | `repo.scan` + `project.register_handle`, by opaque handle |
| key material | pinned server keys | + the recipient (phone) key set, signed |

### Capability gating

The negotiated version says what the *link* can carry. `device.hello.capabilities` says what this
*Mac* will actually do, and the cloud gates features on it so a button is never offered for
something that would fail:

| Capability | Present when | Gates |
| --- | --- | --- |
| `frames.v1` | the daemon has a frame journal | `session.frame` |
| `seal.v1` | frames, and somewhere to learn phone keys from | sealing at all; `recipientKeyIds` says which phones are pinned right now |
| `questions.v1` | an adapter can write an answer back | `question.asked`, `agent.answer_question` |
| `approval_options.v1` | always, on a v2 bridge | `approval.requested.options`, `agent.respond_to_approval.optionId`, `approval.applied` |
| `backfill.v1` | a history source is wired up | `session.list_history`, `session.backfill` |
| `repo_scan.v1` | `PAGR_REMOTE_PROJECT_PICK` is not `0` | `repo.scan`, `project.register_handle` |
| `keep_awake.v1` | macOS, and `PAGR_KEEP_AWAKE` is not `0` | the "your Mac will not idle-sleep while this runs" promise |
| `channel.v1` | the Claude channel is registered on this Mac | giving a terminal Claude session a turn from the phone |
| `handoff.v1` | this Mac has a handoff engine wired up | `session.handoff.capture`, `review.start`, `review.apply`, `rules.migrate`, the `handoff.updated` / `review.completed` events and the `handoff` / `review` frame kinds |

A v2-only command sent on a v1 link acks `failed` / `not_negotiated`; one whose capability is
absent acks `failed` / `capability_unsupported`. The two are different answers to different
questions — "this connection cannot carry that" and "this Mac will not do that" — and neither is
ever answered with a quiet success.

### Sealing, in one paragraph

Frame bodies, the approval preview and a question's words are sealed on the Mac for the set of
phone keys the gateway delivered (`auth.result.recipientKeys`, refreshed live by `keys.updated`).
The envelope is `pagr.seal.v1`: X25519 + HKDF-SHA256 + ChaCha20-Poly1305, one wrapped content key
per phone, with `canonicalize({sessionId, seq, kind, chunk?})` as the AAD, so a frame cannot be
replayed as another session's, another sequence number's or another chunk's. The cloud stores and
relays the envelope opaquely and holds no key for it. Everything **outside** the seal is plaintext
by design — ids, statuses, timestamps, project and Mac names, option ids and kinds, approval hints
— because routing, push and the session list have to work without the cloud reading content.
`docs/SECURITY.md` § "What changed for the iPhone app" states the boundary exactly, and is the
public counterpart of the platform's ADR 0018.

The recipient key set is trusted under the same rule as the server key set: a set that grants no
new trust (the same set, or a narrower one) is accepted as it stands; adding a phone, or
re-pointing a pinned `kid`, needs `recipientKeysSignature` from a server key the bridge already
pins. See `docs/SECURITY.md` § "Server key rotation" for the mechanism and its limits.

### Control levels

Every v2 session summary carries how much of it Pagr may drive. It is a fact about the session,
not a permission the cloud grants, and the bridge refuses anything above it regardless of what it
is asked:

| Level | Which sessions | The phone may |
| --- | --- | --- |
| `full` | started by Pagr, or a terminal Claude session with a channel bound | everything: instruct, steer (queued), stop, answer prompts |
| `approvals_only` | your own `claude`, no channel bound | answer its prompts, and see that it exists |
| `mirror_only` | a Codex thread the shared daemon owns | watch it and answer its prompts; the writer lock forbids writing to it |
| `none` | a session in a directory no project covers | nothing — it is never described to the cloud at all |

### Delivery states

`agent.send_instruction` acks `{ delivered }`, because "sent" is not one thing:

| `delivered` | meaning |
| --- | --- |
| `steered` | the agent took it mid-turn |
| `queued` | accepted, and the agent will see it at the next turn boundary. Channel delivery to a terminal Claude is **always** this |
| `new_turn` | there was no turn running; it started one |

The phone labels `queued` as *Queued* until a `session.event` of kind `followup_delivered` says
otherwise. Nothing anywhere claims an interruption the bridge cannot perform.

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
| `agent.respond_to_approval` | `{ approvalId, sessionId, providerRequestId, previewHash, decision: allow\|deny, optionId? }` | `{ approvalId, decision }` |
| `agent.answer_question` (v2) | `{ questionId, sessionId, providerRequestId, answers: [{ questionIndex, optionIndexes[], freeText? }] }` | `{ questionId }` |
| `settings.sync_public_policy` | `{ approvalTimeoutSeconds }` | the stored policy |
| `session.list_history` | `{ provider?, projectId?, sinceDays ≤ 365 (default 30), limit ≤ 200 (default 50) }` | `{ sessions: SessionSummaryV2[] }` |
| `session.backfill` | `{ sessionId, fromSeq, toSeq?, maxBytes ≤ 8 MiB (default 1 MiB) }` | `{ frames, bytes, lastSeq, truncated }` |
| `repo.scan` | `{}` | `RepoScanResult`: `{ repos: [{ handle: rh_<32hex>, displayName, repoHint?, registeredAs? }], truncated }` |
| `project.register_handle` | `{ handle, displayName? }` | `ProjectSummary` |

`settings.sync_public_policy` once also carried `smartApprovalsTierA`, which let the bridge answer
"obviously safe" prompts itself. The bridge no longer decides approvals at all, so the field was
removed. A cloud that still sends it is **not** rejected — unknown keys are dropped by the payload
schema — it simply has no effect.

`agent.respond_to_approval.optionId` (v2) names one of the options the matching
`approval.requested` published. `decision` stays required and the two must agree — `allow_once`,
`allow_always` and `allow_session` mean `allow`, `reject_once` and `reject_always` mean `deny` —
and a disagreement, or an id this prompt never offered, is `invalid_payload`. A row without
`optionId` is the v1 shape and behaves exactly as it always has: the agent is told allow or deny,
once.

`sessionId` for `agent.start_session` is pre-allocated by the cloud so both sides share one id.
`mode: auto` resolves to `steer` when the adapter reports `canSteerActiveTurn` **and** the session has an
active turn; otherwise `queue`, and a `session.event` of kind `queued_followup` is emitted.

`AttachmentRef` = `{ attachmentId, downloadUrl, sha256, sizeBytes ≤ 50 MiB, mimeType (png/jpeg/heic/webp),
expiresAt }`. The bridge downloads, verifies, passes a local temp path to the adapter, and deletes it.

`repo.scan` takes no arguments — deliberately, since a scan root would be a path from the cloud. The
bridge walks its own conventional code folders (`scan.ts`, depth 3, 500 repositories, never `~`
itself and never `~/Library`) and answers with handles: `rh_` + a device-salted hash of the real
path, resolvable only in this daemon's memory and only for an hour. `registeredAs` is set when the
repository is already a project, so the phone offers "open" rather than "add".

`project.register_handle` resolves a handle from the last scan and registers that folder
(`ProjectRegistry.ensure`), emitting `project.registered` when it is new. A handle that is unknown,
expired, or invented is `unknown_project` — the filesystem is not touched to find out.

Both commands are v2, are gated on `PAGR_REMOTE_PROJECT_PICK` (default on) and appear as
`repo_scan.v1` in `device.hello.capabilities` exactly when they will run. With the flag off they
ack `failed` / `capability_unsupported`. A second `repo.scan` within 30 s acks `failed` /
`rate_limited`. `docs/SECURITY.md` § "Projects a phone can add" states what this widens.

### Handing a task over, and reviewing one

Four commands let a person say "hand this to codex" or "have codex review this" from their phone
and have it happen on their Mac. They are v2 commands behind `handoff.v1`, all `mutate` risk:

| Command | What it does here |
| --- | --- |
| `session.handoff.capture` | writes `<repo>/.pagr/handoff/<hnd_…>.md` for one session and, if the tree is dirty, WIP-commits it. Acks `{writer, summary, wipCommit?, filesChanged, truncated}` |
| `review.start` | builds a review packet for a commit range — the diff plus one line of intent, never a transcript — and starts the reviewing agent read-only on it. Acks `{reviewId}` |
| `review.apply` | sends a finished review's findings to the builder. Never automatic: it is the answer to a person saying *fix it* |
| `rules.migrate` | decides the one `CLAUDE.md` ↔ `AGENTS.md` conversion a switch may need, and performs it only with `consent: true`. Acks `{action, sourceFile?, lineCount?, targetFile?}` and never modifies an existing rules file |

The file itself never travels in the clear: the cloud gets the `# Goal` line as `summary` and,
sealed, a frame of kind `handoff` (a review report is a frame of kind `review`). The transcript a
handoff is written from stays on the Mac in every path. `handoff.updated` reports each state of a
switch — `requested → capturing → committing → stopping → starting → running → done`, or `failed`
with a reason — and `review.completed` carries the verdict line.

`agent.start_session` grew `context?: { handoffId?, reviewId? }` for this, which is how a session
the bridge starts is joined to the switch that asked for it. It is optional, and so is everything
inside it: a payload written before any of this existed parses exactly as it did.

### History and backfill

`session.list_history` and `session.backfill` are both v2; on a link that negotiated v1 they ack
`failed` / `not_negotiated`. They exist because of one retention decision: **the cloud keeps sealed
frames for 30 days, the phone keeps them forever, and anything older comes from the Mac on demand.**

`session.list_history` answers with every session this Mac can still produce frames for, newest
first, merged by session id from three places:

- the journal (`~/.pagr/journal/`), for anything this bridge has already framed;
- `~/.claude/projects/*/*.jsonl`, for Claude sessions that ran before Pagr was installed or in a
  folder that was registered later. Superseded and orphaned variants of one session are folded into
  that session; `agent-*.jsonl` (a subagent's own transcript) and `memory/` are not sessions and are
  skipped. The name comes from a `custom-title` record, else `agent-name`, else `summary`; the times
  come from the file's own; the working directory comes from the records, never from the encoded
  directory name;
- Codex's `thread/list`, when the app-server is attached.

Ids are the same `ses_…` the rest of the bridge uses — `sha256("<provider>:<provider id>")` — so a
session found by the hook, by the mirror and by history is ONE session on the phone. A session in a
directory no project covers is not listed: a `SessionSummary` has to name a `proj_…`. A session that
is not running right now is reported with `controlLevel: 'none'` and the `origin` its source implies
(`terminal` for a transcript or a Codex thread); a session that IS live is described by its own live
summary instead, which knows its real control level.

`session.backfill` streams journaled frames from `fromSeq` as ordinary `session.frame` events — same
sealing, same chunking, same caps — with `meta.source: 'backfill'`. Two paths:

- **The journal has the session.** Frames are re-read and re-sealed. The seqs and bodies are exactly
  the ones the phone would have received live; only `meta.source` differs.
- **It does not.** The provider's own record is replayed into the journal FIRST, which is what
  allocates the seqs, and then streamed. For Claude that is a one-shot pass of the transcript tailer
  over every file of the session; for Codex it is `thread/read {includeTurns}`, whose item ids are
  renumbered `item-1`, `item-2`, … so its frames dedupe on (turn, position) rather than on an item
  id (`docs/spikes/2026-09-17-codex-daemon-attach.md`, finding 7). Either way the journal's
  `providerRecordId` dedupe means replaying a session that was partly streamed live costs no
  duplicate frames, and asking twice costs one replay.

Limits and refusals:

- `maxBytes` bounds what goes on the wire for one request; the stream stops before the frame that
  would exceed it and the result says `truncated: true`, so the phone asks again from
  `lastSeq + 1`. At least one frame is always sent, so a budget smaller than the first frame still
  makes progress. The command schema caps a request at 8 MiB; the local trigger
  (`pagr sessions backfill`) uses the core defaults instead — 16 MiB, up to 64 MiB.
- **One backfill at a time on this Mac.** A second request while one is running acks `failed` /
  `rate_limited` rather than queueing: a backfill competes with live frames for the socket and the
  disk. `pagr sessions backfill` contends for the same single slot.
- A `sessionId` nothing can produce frames for — no journal, no transcript, no thread — is `failed`
  / `unknown_session`. Note that the command guard deliberately does NOT check `sessionId` against
  `sessions.json` the way `agent.stop_session` does: a backfill is *for* sessions this Mac no longer
  has a row for.
- Progress is reported as a `session.event` of kind `progress` every 100 frames, and once at the
  end. The Mac is held awake (`keepAwake` reason `backfill`) for the duration.

Both commands need the frame journal; a bridge built without one answers `capability_unsupported`.

## Device events (bridge → cloud)

Every event carries `{ version: 1, eventId, deviceId, at, inReplyTo?, type, payload }`.

| `type` | when | payload |
| --- | --- | --- |
| `device.hello` | after each successful auth, before anything else | see *`device.hello`, field by field* below |
| `device.heartbeat` | every 20 s | `{ activeSessions }` |
| `command.ack` | exactly once per received command (`inReplyTo = commandId`) | `{ commandId, status: accepted\|rejected\|completed\|failed\|duplicate, errorCode?, message?, result? }` |
| `project.registered` / `project.removed` | local CLI or `project.remove` | `ProjectSummary` / `{ projectId }` |
| `agent.connection` | adapter status change | `AgentConnectionStatus` |
| `session.updated` | session created or state changed | `SessionSummaryV2` — `SessionSummary` plus `controlLevel?`, `origin?`, `projectStatus?`, `lastSeq?`, `repoHandle?` |
| `session.event` | progress, messages, completion… | `{ sessionId, projectId, provider, kind, summary ≤ 2000, providerEventId?, at }` |
| `approval.requested` | agent asked permission | `{ approvalId, sessionId, projectId, provider, providerRequestId, actionType, preview ≤ 1500, previewHash, hints, expiresAt, options?, riskTier?, frameSeq?, imessage? }` |
| `approval.resolved_locally` | timeout, terminal answer, or shutdown | `{ approvalId, resolution: allowed\|denied\|timed_out\|canceled, source?, answeredElsewhere }` |
| `approval.applied` | after the agent was told (v2 only) | `{ approvalId, sessionId, optionId, applied, appliedAs?, error? }` |
| `question.asked` | agent asked the user something (v2 only) | `{ questionId, sessionId, projectId, provider, providerRequestId, seq, meta: { answerable, reason?, multiSelect[], optionCount[], secret[] }, expiresAt, imessage? }` |
| `question.answered` | the question is no longer pending (v2 only) | `{ questionId, answeredElsewhere, reason? }` |
| `session.frame` | one transcript frame, v2 only | `{ sessionId, projectId, provider, seq, kind, at, providerRecordId?, sealed, meta, imessage? }` — see *Transcript frames and cursors* |
| `attachment.consumed` | after a download attempt | `{ attachmentId, ok, error? }` |

`errorCode` values: `bad_signature`, `expired`, `replayed`, `wrong_device`, `unknown_project`,
`unknown_session`, `unknown_approval`, `unknown_question`, `rate_limited`, `not_negotiated`,
`capability_unsupported`, `provider_error`, `invalid_payload`.
`status: rejected` means the guard refused the command before dispatch; `failed` means dispatch ran and
the adapter or a precondition failed. A second copy of a command already accepted — the gateway's 30 s
resend, or a retry under the same `idempotencyKey` — is answered with the terminal ack of the single
execution (waiting for it if it is still running), so the same `commandId` can be acked more than once
with the same result. (`duplicate` remains a valid status in the schema for older bridges; a bridge at
this version answers a duplicate with the genuine terminal status instead.) `unknown_approval` distinguishes an approval that expired or was already answered
from a session that no longer exists.

### Approval options, and what actually happened to them

`approval.requested.options` is the agent's own list, in the agent's order, as
`[{ optionId, kind, label }]` with `kind ∈ allow_once | allow_always | allow_session | reject_once
| reject_always`. `optionId === kind` for Claude and Codex; the labels are the bridge's generic
wording, because the phone renders them verbatim. The phone never invents an option: a request
with no `options` is answered with `decision` alone.

Which options appear is what the agent can really do, never a Pagr policy:

- **Claude Code** — `allow_once` and `reject_once` always; `allow_always` only when the
  `can_use_tool` request carried `permission_suggestions`. Those suggestions *are* the rules the
  grant would write, so answering with `allow_always` sends them straight back as
  `updatedPermissions` and Claude Code writes them into its own settings.
- **Codex** — `allow_once`, `allow_session` and `reject_once`, mapped onto the app server's
  `accept | acceptForSession | decline` (see `adapter-codex/src/approvals.ts`). There is no
  "always": the enums have none.
- `PAGR_ALLOW_ALWAYS=0` on the daemon removes `allow_always` everywhere, and an answer naming it
  is refused rather than downgraded. The device floor refuses a persistent grant for any class it
  is holding, even one an `allowedHosts` entry would have lifted for a single action — see
  docs/SECURITY.md.

On v2 the preview travels sealed, in its own `approval_preview` frame: `approval.requested.preview`
is then `''` and `frameSeq` points at the frame carrying it. `previewHash` is unchanged and is
still what binds the answer. A v1 gateway, which has never heard of frames, keeps receiving the
plaintext preview exactly as before.

`approval.applied` is emitted once the agent has actually been told, and is what moves a phone's
card from *sending* to *acknowledged* — `command.ack` only says the bridge received the tap.
`applied: false` with `error` is the honest report when the relay failed or the device floor
refused the answer; `appliedAs` is what the agent was told when that differs from the option
chosen (a refused persistent grant is relayed as a plain `deny`). It is also emitted, with
`applied: true`, for a prompt the bridge observed somebody answering elsewhere.

`approval.resolved_locally.source` says where an answer that was not the cloud's came from
(`terminal`, `provider`, `timeout`, `shutdown`), and `answeredElsewhere: true` marks the case
where somebody answered in the terminal — or another client of the same agent did — while the
phone still had the card open. The phone dismisses it rather than reporting an error.

### Questions (protocol v2)

A question is not an approval, and the difference is not cosmetic. An approval asks whether one
action may run, and "allow" is a complete answer. A question asks the person to **choose**, and
the choice is fed back to the model as the user's own words — so an approval-shaped "allow" is not
a degraded answer to a question, it is a wrong one delivered instantly (see
`docs/spikes/2026-09-17-askuserquestion-answer-path.md`).

`question.asked` carries only the shape: how many questions, how many options each has, which take
more than one (`multiSelect`), which must never be echoed back or stored in the clear (`secret`),
and whether the phone can answer at all. The words — question text, headers, option labels and any
`preview` the model attached — travel sealed in the `question` frame at `seq`:

```json
{ "kind": "question",
  "questions": [{ "question": "…", "header": "…", "multiSelect": false,
                  "options": [{ "label": "…", "description": "…", "preview": "…" }] }] }
```

`meta.answerable: false` means only the Mac can answer it, and `meta.reason` says why —
`mirror_only` for a Codex thread another client owns, `terminal_dialog` for a prompt Pagr can see
but cannot type into, `not_supported` for an adapter with no answer path. Answering one of those
acks `failed` / `capability_unsupported` rather than pretending.

`agent.answer_question` sends **indexes, never text**. The options came from the agent, the Mac
still holds them, and resolving positions here is what stops a compromised cloud putting words in
the user's mouth. Every index is checked against the retained question — out of range, repeated,
two options on a single-select question, or `freeText` over 2000 characters are all
`invalid_payload`, and the question stays pending. An id that is not pending any more (expired,
already answered, answered on the Mac) is `unknown_question`, which is deliberately not
`unknown_session`: the session is usually alive and only the prompt has lapsed.

`question.answered` is emitted once, whatever ended it. `answeredElsewhere: true` means somebody
answered on the Mac while the phone still had the sheet open, so the phone dismisses rather than
errors; `reason` (`timed_out`, `canceled`, `shutdown`, `answered_elsewhere`) says what happened
when it was not the phone's own answer.

**How the answer reaches each agent**

- **Claude Code** — `AskUserQuestion` arrives on the same `can_use_tool` control request as any
  other tool, with `requires_user_interaction: true`. The answer is an *allow* whose
  `updatedInput` carries it, written on that request id (there is no later opportunity):

  ```json
  {"behavior":"allow",
   "updatedInput":{"questions":<the request's own array, verbatim>,
                   "answers":{"<the full question text>":"<the chosen option's label>"}}}
  ```

  Keyed by `header` instead of the question text it fails **silently** — the CLI echoes the answers
  back and still reports "The user did not answer the questions." A multi-select answer joins the
  chosen labels with `", "` (Agent SDK docs; the spike could not exercise it). Free text goes in
  `response` instead, and Claude reports it as "The user responded: …". A timeout writes
  `{"behavior":"deny", …}`, because the child process blocks on this request indefinitely.

- **Codex** — `item/tool/requestUserInput` is answered with the JSON-RPC response for that request,
  `{ answers: { "<question id>": { answers: ["<label>", …] } } }`, by option index. A thread the
  bridge only mirrors is `answerable: false` / `mirror_only`: the person sitting in front of it is
  the one who answers.

`docs/TROUBLESHOOTING.md` § "A question never reached my phone" covers what to check when one does
not arrive.

### `device.hello`, field by field

Sent once per connection, before any frame, so the gateway knows what this Mac is before it is
handed a transcript.

| Field | Version | What it says |
| --- | --- | --- |
| `bridgeVersion`, `platform`, `osVersion?` | 1 | what is running here |
| `protocolVersion` | 1 | the version **in force on this connection** — the negotiated value, not an offer |
| `agents` | 1 | `AgentConnectionStatus[]`: install, version, sign-in and per-agent capabilities |
| `projects` | 1 | `ProjectSummary[]`: ids, display names, git remote host/name. Never a path |
| `sessions` | 1 / 2 | `SessionSummaryV2[]`, bounded (below). On v1 the v2 fields are absent |
| `capabilities?` | 2 | the names in *Capability gating* above, and only those that are true right now |
| `floor?` | 2 | `{ lifted: [...] }` — the device-floor classes lifted **on this Mac**, by class name. Present and empty when nothing is lifted, because "nothing is lifted" is a fact the app states |
| `channel?` | 2 | `{ serverInstalled, registered, boundSessions, mode }`, `mode ∈ queued_next_turn \| off`. Four separate truths; never `steered` |
| `recipientKeyIds?` | 2 | fingerprints of the phones this Mac seals to, sorted. Omitted when there are none |

On a link that negotiated v1 the hello is byte-identical to what a pre-v2 bridge sent: the v2
fields are simply not there, because a gateway that answered 1 has told us it has never heard of
them. `capabilities` on v1 carries `repo_scan.v1` alone, exactly as it did before.

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

## Transcript frames and cursors (protocol v2)

A `session.frame` event carries one piece of a transcript: `{ sessionId, projectId, provider, seq,
kind, at, providerRecordId?, sealed, meta }`. Everything outside `sealed` is routing metadata the
cloud indexes on; the body is encrypted for the phones this Mac has pinned and the cloud holds no
key for it.

- **`seq` is the bridge's.** It is allocated by the per-session journal (`~/.pagr/journal/`) and
  nowhere else, monotonic from 1, one per frame. That is what makes "the phone has everything up
  to 412" mean something exact.
- **Journal first, send second.** The full body is on disk before anything is sealed. A daemon
  killed in between loses nothing: the frame is journaled with its cursor still behind it.
- **Chunking.** A body over 160 KiB is split into parts that all carry the same `seq` and `kind`
  and differ only by `meta.chunk = {group, index, total}`, which is also inside the AAD both
  crypto layers authenticate. The phone reassembles a group by `index` and parses once.
- **Caps.** A frame is a live view, not the archive: over 512 KiB the body is clipped and
  `meta.truncated` is true, with command output keeping its first 8 KiB and last 56 KiB. The whole
  body stays in the journal for `session.backfill`.

### `ack {cursors}` and resume

```
gateway → bridge     ack { cursors: { "<sessionId>": <seq>, … } }
```

The gateway sends it after persisting a batch of frames; `cursors[sessionId]` is the highest `seq`
it has stored for that session. The bridge keeps `{sent, acked}` per session in
`~/.pagr/journal/outbox.json` and applies the ack as `acked = max(acked, min(seq, sent))` — never
backwards, and never past what this bridge actually sent, so a cursor the bridge cannot account for
can't mark unsent frames as delivered.

On every connection, in this order:

1. `device.hello` — the gateway learns what this Mac is before it is handed any transcript;
2. every session with `sent > acked`, re-read from the journal and re-sealed, in `seq` order, up
   to 500 frames per session (the rest follows on the next connection, or a `session.backfill`);
3. the in-memory buffer of everything else — statuses, acks, heartbeats.

Frames are never held in that in-memory buffer: the journal is their buffer, so a frame produced
while the socket is down goes out exactly once, from disk, when it comes back. The gateway
de-duplicates on `(sessionId, seq, kind)`, so a re-send after an ack that never arrived is
harmless.

Frames are v2-only. Against a gateway that negotiated v1 they are journaled and nothing is sent,
`sent` stays where it was, and the backlog goes out unchanged the first time a v2 gateway answers.
With no phone key pinned the same thing happens for a different reason: nothing in the world could
open the envelope, so none is made (`pagr doctor` says so under *phone keys*, and *journal* reports
how much is waiting).

Implementation: `packages/core/src/{frames,journal}.ts`, `Dispatcher.emitFrame`,
`GatewayClient.resume`.

### The one plaintext field: `imessage`

`session.frame`, `approval.requested` and `question.asked` may each carry an `imessage` string
(≤ 1500 chars). It is the line the user's **iMessage thread** shows, and iMessage is plaintext by
nature, so this one field is not sealed. Three rules keep that honest:

- **Only when a thread is linked.** The gateway says so in `auth.result.features.imessage`, and
  changes it mid-connection with `settings.updated {features}`. The bridge re-reads the flag on
  every event, so unlinking stops the plaintext on the very next event, without a reconnect. With
  the flag false the field is absent — not empty, absent.
- **Only the agent's last word of a turn.** On frames it appears exactly once per turn, on the
  final `assistant` frame — the message that calls no tool, which is how both agents end a turn —
  clipped to 500 characters. Not once per paragraph, and never on a backfilled frame: replaying
  last week's transcript must not put last week's answers back into the thread.
- **Only what the thread already showed.** For an approval it is the same one-liner preview the
  thread has always carried; for a question it is `"<Agent> asked: <header>"`, never the options,
  because answering happens on the phone where they are legible.

Nothing else about this changes what is journaled: `~/.pagr/journal/` is plaintext on your own
disk either way, and that is local (`docs/PRIVACY.md`).

### Frame bodies

The body inside the seal is one of: `assistant {text}`, `thinking {text}`, `user {text, images?}`,
`tool_call {toolCallId, toolName, toolKind, title, input}`, `tool_result {toolCallId, content,
isError}`, `diff {path, changeKind: add|update|delete, oldText?, newText?, hunks?, approx?}`,
`terminal {command, stdout, stderr, exitCode?, interrupted}`, `question {questions[]}`,
`approval_preview {preview, suggestions?}`, `system {subtype, text}`. Two field names differ from
the shared contract's table only because a discriminated union cannot carry two `kind`s: the ACP
tool kind is `toolKind` and the diff's add/update/delete is `changeKind`.

`approx: true` on a diff means the bridge reconstructed the hunks from the replacement strings
because the agent supplied none: no context lines, and line numbers starting at 1. The phone is
told rather than shown a patch that looks authoritative and is not.

### Claude Code → frames

One frame per content block, in the order Claude emitted them. `meta.parentFrameId` is the
`tool_use_id` on the call itself and on everything downstream of it — the result, the command
output, the patch — which is all the phone needs to group them.

| Claude block / result | Frame | Notes |
|---|---|---|
| `thinking` | `thinking` | `signature` dropped; it is a model artefact |
| `text` | `assistant` | the turn's final text also becomes the `completed` session event, as before |
| `tool_use` | `tool_call` | every one of them, not just the first in a message |
| `tool_result` | `tool_result` | `meta.status` is `error` when `is_error` |
| `tool_result` of a `Bash` call | + `terminal` | streams split from `tool_use_result`; `persistedOutputPath` read in full for the journal, tail-biased on the wire |
| `tool_result` of an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call | + `diff` | Claude's own `structuredPatch` + `originalFile` |
| unrecognised block type | — | no frame; logged once per type, never silently dropped |

`tool_use_result` rides on the stream-json `user` line under `--verbose`, which the bridge already
passes (verified 2026-09-17 against Claude Code 2.1.220), so diffs and terminal output normally
cost no file read. When it is absent the same object is in the session transcript
(`~/.claude/projects/<cwd with /, space and . → ->/<session id>.jsonl`, as `toolUseResult`) and is
read with a 2 s ceiling; past that the diff is the bridge's own and carries `approx: true`.

`toolName` → `toolKind` (ACP), so a phone never needs a table of Claude's tool names:

| `toolKind` | Claude tools |
|---|---|
| `read` | `Read`, `NotebookRead` |
| `search` | `Glob`, `Grep` |
| `edit` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| `execute` | `Bash`, `BashOutput`, `KillShell` |
| `fetch` | `WebFetch`, `WebSearch` |
| `switch_mode` | `ExitPlanMode` |
| `other` | `Task`/`Agent`, `AskUserQuestion`, `TodoWrite`, every `mcp__*` tool, anything unrecognised |

Implementation: `packages/adapter-claude/src/{stream-json,diffs}.ts` and `ClaudeAdapter.onRecord`.

### Codex → frames

Codex speaks items, not blocks. One frame per completed `ThreadItem`, plus coalesced frames while
one is still streaming: deltas accumulate and leave every 750 ms or 2 KiB as a frame with
`meta.status: 'streaming'`, `meta.final: false` and `providerRecordId = <itemId>#<n>`. The
`item/completed` that follows carries the whole thing with `meta.final: true`, keyed on the item
id — it REPLACES the stream on the phone rather than appending to it.

| Codex item / notification | Frame | Notes |
|---|---|---|
| `item/agentMessage/delta` | streaming `assistant` | coalesced; `#n` on the record id |
| `item/completed` `agentMessage` | `assistant` | `meta.final`; the turn's last one is also the `completed` session event |
| `item/reasoning/textDelta`, `…/summaryTextDelta` | streaming `thinking` | both streams coalesce into one |
| `item/completed` `reasoning` | `thinking` | `summary` then `content`, blank-line separated |
| `item/commandExecution/outputDelta` | streaming `terminal` | each chunk still names the command |
| `item/completed` `commandExecution` | `terminal` | `{command, stdout: aggregatedOutput, stderr: '', exitCode, interrupted}`; the app-server merges the two streams, so `stderr` is empty rather than guessed |
| `item/completed` `fileChange` | one `diff` per `changes[]` | `changeKind` from the item's `PatchChangeKind`; hunks parsed from Codex's own unified diff, kept whole in `newText` if it is in a shape the parser does not know |
| `item/completed` `mcpToolCall` / `dynamicToolCall` | `tool_call` + `tool_result` | `toolName` is `server/tool` (MCP) or `namespace.tool` |
| `item/completed` `webSearch` | `tool_call` + `tool_result` | `toolKind: fetch` |
| `item/completed` `userMessage` | `user` | images counted, never carried |
| `item/tool/requestUserInput` | `question` + `question.asked` | `meta.secret[]` from each question's `isSecret` |
| anything else (`plan`, `collabAgentToolCall`, `contextCompaction`, …) | — | no frame; an item with no mapping is skipped, never guessed at |

`toolKind` for Codex: `other` for MCP and dynamic tool calls, `fetch` for `webSearch`. Command
execution and file changes are `terminal` and `diff` frames, so they need no tool kind at all.

Approval options come from the two Codex enums and nothing else — `allow_once → accept`,
`allow_session → acceptForSession`, `reject_once → decline`; for `item/permissions/requestApproval`
the same ids mean `scope: 'turn'`, `scope: 'session'` and an empty grant (which is how that API
spells a denial). There is no `reject_always` in either enum, so it is never offered.

A `backfill` (`thread/read {includeTurns:true}`) runs through the same mapper with
`meta.source: 'backfill'` and keys each frame on (turnId, position) rather than the item id,
because `thread/read` renumbers items `item-1`, `item-2`, … while live notifications use UUIDv7.

Frames for a thread the bridge does not own — a terminal session mirrored through the shared
app-server daemon — are identical; what differs is the session: `controlLevel: 'mirror_only'`,
`origin: 'terminal'`. See TROUBLESHOOTING.md § "Codex daemon not running".

Implementation: `packages/adapter-codex/src/{items,mirror,daemon,approvals}.ts`.

## Control levels

Every v2 `SessionSummary` says how much of the session Pagr may actually drive. It is derived on
the Mac, from facts the Mac can check, and it is never widened by anything the cloud sends.

| `controlLevel` | What the phone may do | When the bridge says it |
|---|---|---|
| `full` | start a turn, steer one, stop it, answer its prompts | a session Pagr started; or a Claude session with a **channel bound to that Claude session id** (opt-in through `pagr claude`, B8) |
| `approvals_only` | watch, and answer the prompts it raises | a Claude session you started yourself, in a **registered** project, with the permission hook installed |
| `mirror_only` | watch | a Claude session you started yourself in a registered project with **no hook installed**; a Codex thread owned by another process |
| `none` | nothing, and no frames are produced at all | the session's working directory is in **no registered project** |

The other two v2 fields go with it. `origin` is `pagr` for a session the bridge started,
`terminal` for one found in your own shell, `ide` when the Claude process reports an `entrypoint`
that is not the plain CLI (`claude-vscode` and friends), `unknown` otherwise. `projectStatus` is
`registered` or `unregistered`.

### Claude sessions you started yourself

Discovery is `~/.claude/sessions/<pid>.json`, which Claude Code writes for every interactive
process: `{pid, sessionId, cwd, entrypoint, name, version}`. Liveness is `process.kill(pid, 0)`,
with `EPERM` counted as alive. A transcript touched in the last ten minutes whose pid file has
gone is reported too, as a session whose liveness is unknown.

The session id is `ses_` + a hash of `claude:<Claude session id>` — the **same** id the permission
hook's adopted sessions get, so a terminal session that raises a prompt and the same session being
tailed are one card on the phone, not two.

Frames come from `~/.claude/projects/<encoded cwd>/<session>.jsonl` with `meta.source:
'transcript'`, through the same mappers the stdio path uses, with the same `providerRecordId`s
(`<record uuid>:<block index>`, `<tool_use_id>[:result|:terminal|:diff]`) — so a session the bridge
is ALSO driving over its own pipe produces one frame per record, not two, and a transcript replayed
after a rotation allocates no new sequence numbers. A subagent's frames carry
`meta.subagent {id, depth}`, hang off the `Task` call in `meta.parentFrameId`, and have their record
ids scoped by the subagent so two subagents cannot collide.

`AskUserQuestion` is an ordinary `tool_call` with `toolKind: other` until B7 turns it into a
`question` event. Adopted sessions still refuse `agent.send_instruction` and `agent.stop`.

### An unregistered working directory

A session in a folder you have not registered is still reported — someone really is running
`claude` there — but with `controlLevel: 'none'`, `projectStatus: 'unregistered'`, **no frames**,
a `projectId` derived from the nearest enclosing git root, a `displayName` of that folder's
basename, and a `repoHandle`. One `project.register_handle` with that handle registers the folder;
the next refresh re-evaluates the level and the frames start. `PAGR_MIRROR_UNREGISTERED=0` keeps
the pre-B5 behaviour (the session is not reported at all); `PAGR_MIRROR=0` disables the mirror.

Implementation: `packages/adapter-claude/src/transcript/{paths,records,tailer,discovery,mirror}.ts`
and `packages/core/src/mirrorBridge.ts`.

## Approval hints

`hints` are deterministic booleans computed locally by adapters (`touchesOutsideProject`, `networkAccess`,
`destructive`, `gitPush`, `packageInstall`, `secretsTouch`, `productionHint`). The cloud applies the final
risk tiering; the bridge only ever reports.

## Local IPC (not part of the cloud protocol)

`~/.pagr/run/daemon.sock`, newline-delimited JSON `{ id, method, params }` → `{ id, result }` |
`{ id, error: { code, message } }`. Methods: `status`, `projects.list`, `projects.add`, `projects.remove`,
`sessions.list`, `sessions.journal`, `sessions.history`, `sessions.backfill`, `sessions.purge`,
`sessions.reconcile`, `channel.status`, `approvals.list`, `approval.request` (blocks
until decision/timeout, returns `{ approvalId, decision, resolution, optionId? }`; the Claude
PermissionRequest hook passes `permissionSuggestions` so the prompt can offer "allow always", and
hands those same rules back to Claude Code itself when `optionId` comes back `allow_always`),
`agent.event`. `approval.request` is also how the hook relays an `AskUserQuestion`: it sends
`toolName: 'AskUserQuestion'` plus that tool's `questions`, the daemon registers a question rather
than an approval, and the result comes back as `{ decision: 'allow', updatedInput }` for the hook
to print as its `PermissionRequest` decision. `channel.poll` and `channel.outbound` are registered
by default (`PAGR_CLAUDE_CHANNEL=0` takes them away; `=1` is a no-op kept for older launchd plists).
See `packages/core/src/ipc.ts` and `daemon.ts`.

- `sessions.reconcile` → `[{ sessionId, provider, projectId, status, outcome, reason }]`, where
  `outcome` is `resumable` | `terminated` | `failed`. The daemon runs this itself on startup, so a
  session that was working when the daemon died never survives as a zombie.
- `sessions.journal` → `{ [sessionId]: { lastSeq, bytes, sent, acked, updatedAt } }`, which is what
  `pagr sessions` puts in its SEQ and JOURNAL columns.
- `sessions.history` → the `session.list_history` answer, and `sessions.backfill` → the
  `session.backfill` result, both through the exact code path a phone's command takes, so the
  feature can be exercised from the Mac alone (`pagr sessions backfill <id>`).
- `sessions.purge` → `{ removed, bytesFreed, totalBytes }`. Deletes whole journals under
  `~/.pagr/journal` and nothing else; `~/.claude` is never touched.
- `channel.status` → `{ enabled, attachedProjects, canSteerLive, boundSessions? }`. `enabled` only
  means the methods are registered. `boundSessions` is the number that matters: how many Claude
  sessions a channel is bound to by **Claude session id**, which is what decides whether any one
  terminal can be handed a follow-up.
- `channel.poll` takes `{ cwd, cursor?, claudePid? }`. `claudePid` is the channel server's
  `process.ppid`, i.e. the `claude` that spawned it; the daemon reads
  `~/.claude/sessions/<pid>.json` to learn that process's Claude session id and binds
  `syntheticSessionId('claude', <id>)` to the project. Without it the binding falls back to the
  directory index, which cannot tell two `claude` processes in one project apart.

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
*at that moment*. For Claude Code it is **always false**: nothing Pagr has interrupts a running
turn. A bound channel sets `canQueueIntoActiveTurn` instead — the follow-up renders in the terminal
at once and the model acts on it at the next turn boundary — and only while a channel is actually
polling. `canQueueIntoActiveTurn` is optional and additive: a bridge that predates it simply does
not send the field, which reads as `false`.

## Follow-up delivery states

`agent.send_instruction` into a channel-bound session is acknowledged `{ delivered: 'queued' }` and
then reported through `FrameMeta.delivery`, on `system` frames that share one `followupId`:

| state | emitted when | by |
| --- | --- | --- |
| `queued` | the instruction is accepted and put on the channel queue | the Claude adapter |
| `picked_up` | the channel server's long poll takes it off that queue | the Claude adapter, from the bridge's pick-up signal |
| `delivered` | the injected turn appears in the transcript as `<channel source="pagr" … followup="…">` | the transcript mirror |

`delivered` also emits `session.event` `followup_delivered`. The follow-up id rides out to Claude
Code as a `<channel>` attribute (`meta.followup`), which is the only thing that lets the tailer tie
a transcript record back to the message a phone sent. A follow-up that never reaches `delivered`
stops at `picked_up`: the bridge does not guess.
