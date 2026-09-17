# Pagr bridge

**Your coding agents have a phone number.** Pagr lets you start, steer, unblock, approve, and coordinate Claude Code and Codex from iMessage while they keep working on your Mac.

This repository is the open-source half of Pagr: the daemon and CLI that run on *your* machine. It exists in public so you can read exactly what software on your computer can be asked to do by our cloud.

## What the bridge is

- A user-level macOS daemon (`pagr daemon`) that opens **one outbound TLS WebSocket** to Pagr's gateway. No inbound ports.
- A device identity: an **Ed25519 keypair generated locally**, private key in **macOS Keychain**, public key registered with your account during pairing.
- Typed adapters for **Codex** (local `codex app-server` over stdio) and **Claude Code** (the unmodified `claude` CLI). Sessions the bridge starts relay their permission prompts over Claude Code's own stdio permission protocol. Sessions **you** start are covered too: `pagr connect` registers a `PermissionRequest` hook in `~/.claude/settings.json`, which fires only when Claude Code actually needs a decision — anything your own settings auto-approve never reaches Pagr. If the daemon is down or nobody answers, the hook says nothing and your terminal prompt behaves exactly as before. Your provider credentials never leave your Mac; the bridge does not read them.
- A local **project registry** mapping opaque `proj_…` IDs to folders. Any folder on your disk can be reached — naming one on this Mac (`pagr project use`, `project add`, or `project scan`) mints its id — but only this Mac can turn a path into an id. The cloud only ever sees the ID and a display name, and an id it invents resolves to nothing.
- A **command guard** that rejects anything that isn't a schema-valid, server-signed, unexpired, non-replayed command bound to this device.
- A **device-side approval floor**: every permission prompt is classified on your Mac, and a decision from the cloud is refused for remote scripts, network egress, paths outside the project, credential files, privilege escalation and destructive or history-rewriting git — unless *you* lift that class in `~/.pagr/device-policy.json` or `PAGR_DEVICE_FLOOR`. No command can lift it. `pagr doctor` shows what is in force.

## What the bridge is not

There is no `shell.exec`, no arbitrary file read/write, no process spawn command. The complete list of commands the cloud can send is in [`packages/protocol/src/schemas.ts`](packages/protocol/src/schemas.ts) — it is short on purpose.

It is *not* a sandbox, and instruction text is a real capability: the cloud can ask an agent to try anything, and the agent runs as you. What the device floor guarantees is that the cloud cannot approve the dangerous half of that by itself. [`docs/SECURITY.md`](docs/SECURITY.md) states exactly what is and is not covered; see also [`docs/PRIVACY.md`](docs/PRIVACY.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Install

```bash
npm install -g @pagr/cli
pagr connect          # generates device key, opens browser to pair with your account
pagr project use      # make the current folder reachable (repo or not) — no setup needed
pagr project add      # …or register it under a name you choose
pagr project scan     # …or find every repo under ~/code, ~/src, ~/Developer… and pick
pagr projects         # what is reachable, and what is running in each
pagr status
pagr claude           # start Claude Code with the Pagr channel (see below)
```

`pagr project scan [roots...]` walks a few conventional folders (never your whole home
directory), stops at each `.git`, skips `node_modules`/caches/hidden folders, and offers what it
found. Add `--dry-run` to preview, `--all` to take everything, `--json` for a machine-readable
plan. Names come from the folder plus the GitHub repo name, so you can text either; collisions
are qualified (`two/app`) rather than silently duplicated. Running it twice is a no-op.

## Control a terminal session from your phone

Pagr watches the `claude` sessions you start yourself and relays their permission prompts. To go
further and send one a follow-up from your phone, start it through the launcher:

```bash
pagr claude channel-install   # once: registers the Pagr channel with Claude Code (all projects)
pagr claude                   # then: use this instead of `claude`
```

`pagr claude` runs the real `claude` with a Pagr *channel* loaded, passing your arguments through
unchanged. Claude Code asks you to confirm development channels on **every** launch — it cannot be
pre-accepted, so the launcher prints one line warning you and you press Enter. Plain `claude` is
left exactly as it was, and its sessions stay approvals-only.

A follow-up you text into a channel-bound session appears in that terminal immediately and Claude
acts on it at the next turn boundary. It is not an interruption, and Pagr never says it was:
`pagr doctor` reports delivery as *queued, surfaced at the next turn boundary*, and the phone
watches each message move `queued → picked_up → delivered`.

`pagr claude --no-channel` (or `PAGR_NO_CHANNEL=1`) starts plain `claude`; so does any headless
run (`-p`, `--print`, `--output-format`), where Claude Code would silently drop channel events.
`pagr claude channel-status` says what is registered and what is bound; `pagr claude channel-remove`
undoes the registration, as do `pagr logout` and `pagr daemon uninstall`.

## Many sessions at once

The bridge runs sessions across many projects concurrently, with two rules it enforces rather
than races:

- **One writer per working tree.** Codex (`workspace-write`) and Claude Code both edit files in
  place with no locking, so a second write-capable session in a checkout another session already
  holds is refused with an explanation naming the session that holds it. Read-only sessions may
  share a tree — and really are read-only: Codex uses its own `read-only` sandbox, and Claude Code,
  which has no sandbox, is started with `Bash` and every edit tool withheld. A separate
  `git worktree` is a separate tree. Set `PAGR_ALLOW_CONCURRENT_WRITERS=1` on the daemon to override.
- **A bounded pool.** At most 4 live sessions per provider and 8 in total
  (`PAGR_MAX_SESSIONS_PER_PROVIDER`, `PAGR_MAX_SESSIONS`), and at most 6 live `claude` children.
  Past the limit you get a clear refusal, not a Mac that swaps.

Sessions are reconciled on daemon startup: anything that claimed to be working when the daemon
died is either re-attached (Codex `thread/resume`, Claude `--resume`) or reported terminated.
`pagr sessions --reconcile` forces the same pass by hand.

## Layout

```
packages/protocol         canonical command/event schemas (zod)
packages/core             daemon, device auth, transport, guard, projects, IPC, attachments
packages/adapter-codex    Codex app-server adapter
packages/adapter-claude   Claude Code CLI + hooks adapter
apps/cli                  the `pagr` command
integrations/             optional add-ons, not part of the default install
packaging/                Homebrew formula template + release runbook
```

`integrations/claude-channel` is deprecated: the channel server it used to hold now ships inside
`@pagr/cli` (see **Control a terminal session from your phone** above).

## Develop

```bash
pnpm install
pnpm gate            # lint + typecheck + tests
```

Apache-2.0. Security reports: see `docs/SECURITY.md`.
