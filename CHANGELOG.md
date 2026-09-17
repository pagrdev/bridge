# Changelog

Every published package in this repository shares one version. Dates are the merge date.

## 0.2.0 — protocol v2

The bridge now speaks protocol v2 as well as v1, which is what the Pagr iPhone app is built on. It
is a minor bump rather than a patch because the **offer** changed: a 0.2 bridge offers version 2 in
its handshake, and a gateway that only speaks v1 answers 1 and gets exactly what it got before.

### The link

- **Version negotiation.** The bridge offers 2; the gateway answers 1 or 2; nothing v2-only is sent
  until the answer says 2, and the version resets to 1 the moment the socket closes. A gateway that
  refuses the offer gets one retry offering 1.
- **`device.hello` v2.** Reports the negotiated version (it was hard-coded 1), the capability names
  this Mac actually honours, the device-floor classes you lifted, the Claude channel's state, the
  fingerprints of the phones it seals to, and sessions as `SessionSummaryV2` — control level,
  origin, project status, journal position, and the handle for an unregistered folder. On a v1 link
  the hello is byte-identical to the one a pre-v2 bridge sent.
- **`agent.connection` on change.** Both adapters are re-probed every 60 s and on a channel
  binding; the event is emitted only when an agent's status actually differs, never once per tick.

### Content

- **Sealed transcript frames**, journaled in plaintext on your own disk and encrypted on this Mac
  for the phones you paired. The cloud relays ciphertext it holds no key for.
- **Questions**, **the agent's own approval options**, **`approval.applied`**, **backfill** from
  this Mac's journal, and **repository scan** by opaque handle. Each is gated on its own capability
  name, so the cloud never offers a button for something this Mac will not do.
- **iMessage summaries.** A plaintext `imessage` field on `session.frame`, `approval.requested` and
  `question.asked`, present only while an iMessage thread is linked, re-read on every event so
  unlinking takes effect immediately, and on frames only on the agent's final message of a turn.

### The Mac

- **Keep-awake** against idle sleep while a session is live or a prompt is waiting. Closing the lid
  still sleeps the Mac, and Pagr says so.
- **`pagr claude`**, an opt-in launcher that starts Claude Code with the Pagr channel so a terminal
  session can be given a turn from your phone. There is no `claude` shim; plain `claude` is
  untouched and its sessions stay approvals-only.
- **`pagr status`** gained a *Phone link* block: protocol version, phone-key fingerprints,
  keep-awake, channel, mirror and journal size.
- **`pagr logout` / `pagr uninstall`** now remove everything v2 added — the journal,
  `tailer-state.json`, `replay.json`, the pinned phone keys, the permission hook and the user-scope
  `pagr` MCP registration — and hand back any Codex thread subscription Pagr was holding.
  `~/.claude` and `~/.codex` are otherwise left exactly as they were found.

### Documentation

`PROTOCOL.md` has a coherent v2 section (negotiation, capability gating, sealing, control levels,
delivery states, and the hello field table). `SECURITY.md` has one consolidated *What changed for
the iPhone app*, including what recipient-key signing does **not** defend against. `PRIVACY.md`
states what the cloud can and cannot see now that transcripts leave the Mac sealed, and completes
the `~/.pagr` inventory and the list of processes the daemon may run. `TROUBLESHOOTING.md` indexes
the new entries.

## 0.1.0

First public release: the daemon, the device identity and command guard, the project registry, the
Codex and Claude Code adapters, the device-side approval floor, and the `pagr` CLI.
