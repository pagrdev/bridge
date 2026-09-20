# Agent instructions — Pagr bridge (public, Apache-2.0)

> The **open-source half** of Pagr: the macOS daemon and `pagr` CLI that run on the user's own Mac.
> It is public so anyone can read exactly what our cloud may ask software on their computer to do.
> The private hosted half is a sibling repo, `../platform`.

Read this fully before acting.

## What is here, and what is not

No database, no hosted service, no secrets: the daemon opens one outbound TLS WebSocket, executes
typed signed commands, and seals transcript frames for the user's phone. The commonest mistake a
new agent makes is editing the wrong half — if the change is about *what the cloud may send*, it
starts here; if it is about storing, routing or signing, it is the platform.

| | bridge (here) | platform (private) |
|---|---|---|
| Daemon, CLI, Claude/Codex adapters | yes | no |
| Protocol schemas | **source of truth** — `packages/protocol/src/schemas.ts` | a generated copy |
| Gateway, API, web, worker, iOS, Postgres, billing | no | yes |
| Ticket boards | no | `docs/handoff/LINEAR-PROJECT.md`, `docs/mobile/TICKETS.md` |

## Package map

| Path | Package | What it is |
|---|---|---|
| `packages/protocol` | `@pagr/protocol` | Typed cloud→bridge commands and bridge→cloud events (zod), v1 + v2. The audit surface. |
| `packages/core` | `@pagr/bridge-core` | Daemon, IPC, signed-command guard, device approval floor, transport, project registry, journal, seal, handoff/review, `git.ts`. |
| `packages/adapter-claude` | `@pagr/bridge-adapter-claude` | Drives the unmodified `claude` CLI: stream-json, transcript tailer, `PermissionRequest` hook, channel server. |
| `packages/adapter-codex` | `@pagr/bridge-adapter-codex` | Drives `codex app-server` over stdio JSON-RPC: daemon attach, items, questions. |
| `apps/cli` | `@pagr/cli` | The `pagr` binary users install. |
| `integrations/claude-channel` | `@pagr/claude-channel` | **Deprecated** re-export so old registrations resolve. Do not add to it. |
| `integrations/claude-code-plugin` | — | A Claude Code plugin (`commands/`, `skills/`); no `package.json`, ships via a marketplace. |
| `scripts`, `packaging` | — | `release.mjs` (the publish gate), its tests, `docs.test.mjs`; Homebrew formula, `RELEASING.md`. |

## Running it

```bash
pnpm install                                   # pnpm 10.14.0, pinned in packageManager
pnpm gate                                      # lint (biome) → typecheck (turbo) → test (vitest)
pnpm vitest run --project core                 # one package; project name = package dir name
pnpm vitest run packages/core/src/git.test.ts  # one file
```

Nothing to start first — no Docker, no database, no services. Every test here is hermetic and
builds its own temp home or temp repo. Keep it that way.

## Ground rules

1. **Ship from an isolated worktree off `origin/main`** (`git worktree add -b <branch> ../.wt/<name>
   origin/main`) — several agents share this checkout, and working in place means two of them
   editing the same files with no way to tell whose change broke the gate.
2. **`export DEVELOPER_DIR=/Library/Developer/CommandLineTools` before any git command** — the Xcode
   licence on this Mac is unaccepted, so git refuses to run at all without it.
3. **Never use bare `git stash`** — the stash stack is shared between worktrees, so you will pop
   another agent's work into your tree or bury yours under theirs.
4. **Never let a test touch real state** — no deleting, mutating or reading real user data, the real
   `~/.claude`, the real `~/.codex`, or any real repo; use temp homes (`PAGR_HOME`,
   `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and fixtures, because that state is the founder's live work
   and is not recoverable.
5. **No GitHub Actions** — the gate runs locally on purpose (solo repo, CI minutes buy nothing), and
   `scripts/release.mjs` is the release gate CI would otherwise be.
6. **Never take browser or simulator screenshots** — that is not how work is reviewed here.
7. **pnpm only, at the pinned `packageManager` version** — npm is used for exactly one thing,
   publishing the CLI from `scripts/release.mjs`; a second lockfile writer corrupts the graph.
8. **Never print, echo, log or commit a secret** — this repo is public, so a key that reaches a
   commit is public the moment it is pushed and rewriting history does not un-publish it.
9. **Commit trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, PR body ending
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, `gh pr create`, and do not
   merge** — the founder merges.

## Invariants with teeth

Breaking one of these fails a named test, not just taste.

1. **Only `packages/core/src/git.ts` may spawn git.** `packages/core/src/git.test.ts` → *"git · no
   git subprocess outside this module"* greps `packages/`, `apps/`, `integrations/` and `scripts/`
   for `exec|execFile|spawn(…'git'` and for `GIT_TERMINAL_PROMPT`; only `git.ts` and its own test
   are exempt. The same suite asserts `git.ts` contains no `no-verify`, `hooksPath`, `push`,
   `fetch`, `pull` or `remote` — it runs the user's hooks and never reaches a network. Everything
   else takes an `execFile` seam and fakes it.
2. **`packages/protocol/src/schemas.ts` is the source of truth and is copied into the platform.**
   Change it and sync the platform in the **same session** — `cd ../platform/packages/device-protocol
   && PAGR_BRIDGE_DIR=<abs path to bridge> node sync-from-bridge.mjs` — or the platform's
   `packages/device-protocol/src/drift.test.ts` goes red on a byte compare. Three more platform
   tests read this repo the same way: `security/src/seal.test.ts` (shared `seal-vectors.json`),
   `gateway/src/keyRotation.test.ts` (`core/src/transport.ts`), `web/components/docs/cli-data.test.ts`
   (`apps/cli/src/commands`). A protocol change is a two-repo, two-PR change.
3. **The cloud relays sealed content it cannot read.** Frames are sealed on the Mac
   (`packages/core/src/seal.ts`, `pagr.seal.v1`) for paired phone keys; the cloud holds no key.
   Nothing may weaken that — no unsealed copy "for debugging", no decrypt path the platform could
   import. `seal-vectors.json` is a known-answer fixture shared with the platform and the iOS app.
4. **The public documents are tested.** `scripts/docs.test.mjs` fails the gate when `README.md` or
   `docs/{PROTOCOL,SECURITY,PRIVACY,TROUBLESHOOTING}.md` claims something the code no longer does.
5. **Published-package metadata is asserted.** `scripts/release.test.mjs` fails the gate if a
   publishable package loses `license`, `repository`, `files`, `exports`, `engines.node` or
   `publishConfig.access`.

## Where the work is tracked

The markdown boards are canonical and live in the **platform** repo; Linear mirrors them, not the
other way round. `platform/docs/handoff/LINEAR-PROJECT.md` holds Handoff v1 (`HND-…`), the North
Star (`NS-…`), the **Status log** and *Follow-ups raised during implementation*;
`platform/docs/mobile/TICKETS.md` holds the iPhone app (`MOB-…`). If `platform/docs/LINEAR.md`
exists, read it — another agent is building the sync and that file describes the mirror.

## Suggested working order

1. **Claim the ticket** — set its status to `in progress` in the board and push that *before*
   starting; a claim that lands after the work is not a claim, and two agents build the same thing.
2. **Cut a worktree** off `origin/main`, one ticket per worktree.
3. **Work, then gate** — `pnpm gate` green here, and the platform gate with `PAGR_BRIDGE_DIR` set
   if you touched the protocol.
4. **Close it in the same PR** that finishes the work: update the board's status log row and the
   ticket's Status / PR columns there, never in a separate tidy-up PR.
5. **Record any premise in the ticket that turned out to be wrong** in the follow-ups section
   instead of quietly working around it. This has already caught several real bugs — see HND-010a
   in `LINEAR-PROJECT.md`, where a sandbox assumption was refuted mid-implementation. A wrong
   ticket is information; a workaround that hides it is a future outage.
