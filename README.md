# Pagr bridge

**Your coding agents have a phone number.** Pagr lets you start, steer, unblock, approve, and coordinate Claude Code and Codex from iMessage while they keep working on your Mac.

This repository is the open-source half of Pagr: the daemon and CLI that run on *your* machine. It exists in public so you can read exactly what software on your computer can be asked to do by our cloud.

## What the bridge is

- A user-level macOS daemon (`pagr daemon`) that opens **one outbound TLS WebSocket** to Pagr's gateway. No inbound ports.
- A device identity: an **Ed25519 keypair generated locally**, private key in **macOS Keychain**, public key registered with your account during pairing.
- Typed adapters for **Codex** (local `codex app-server` over stdio) and **Claude Code** (the unmodified `claude` CLI plus a narrowly scoped permission hook). Your provider credentials never leave your Mac; the bridge does not read them.
- A local **project registry** mapping opaque `proj_…` IDs to folders you explicitly added. The cloud only ever sees the ID and a display name.
- A **command guard** that rejects anything that isn't a schema-valid, server-signed, unexpired, non-replayed command bound to this device.

## What the bridge is not

There is no `shell.exec`, no arbitrary file read/write, no process spawn command. The complete list of commands the cloud can send is in [`packages/protocol/src/schemas.ts`](packages/protocol/src/schemas.ts) — it is short on purpose. See [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/PRIVACY.md`](docs/PRIVACY.md), and [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Install

```bash
npm install -g @pagr/cli
pagr connect          # generates device key, opens browser to pair with your account
pagr project add . --name Tonight
pagr status
```

## Layout

```
packages/protocol         canonical command/event schemas (zod)
packages/core             daemon, device auth, transport, guard, projects, IPC, attachments
packages/adapter-codex    Codex app-server adapter
packages/adapter-claude   Claude Code CLI + hooks adapter
apps/cli                  the `pagr` command
```

## Develop

```bash
pnpm install
pnpm gate            # lint + typecheck + tests
```

Apache-2.0. Security reports: see `docs/SECURITY.md`.
