# Troubleshooting the Pagr bridge

Start with `pagr doctor`. It checks Node, `~/.pagr` (existence, writability, 0700/0600 permissions), `config.json` and `projects.json` integrity, the secret store (with a real read/write round-trip), the device key, pairing, API reachability, clock skew, the daemon socket, the gateway handshake, gateway reachability, the `codex`/`claude` CLIs and the launch agent — printing a fix for each failure.

- `pagr doctor --json` produces a support-ready report. Every error message in the CLI points here.
- `pagr doctor --fix` tightens any file permissions that are too permissive.
- `pagr doctor --offline` skips the network checks.
- `pagr status` shows the live picture; `pagr daemon logs -f` streams `~/.pagr/logs/daemon.log`.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pagr status` says **daemon not running** | launch agent not installed / not loaded, or crashed at start | `pagr daemon install`, then `pagr daemon logs`. Foreground debugging: `pagr daemon run` |
| gateway shows `connecting` / `disconnected` forever | outbound 443 blocked, wrong `gatewayUrl`, or device revoked | see below |
| `pairing failed: pairing code expired` | more than a few minutes passed before approving in the browser | run `pagr connect` again for a fresh code |
| macOS asks for your login password / "pagr wants to use the keychain" | the device key lives in the login Keychain | click **Always Allow**; see below |
| Codex sessions fail immediately | Codex CLI not logged in | `codex login` |
| Claude approvals never reach your phone | session not started by Pagr, or the daemon lost the gateway | see below |
| daemon logs `auth failed` or `device revoked` | this device was revoked from the dashboard | `pagr logout && pagr connect` |
| `connect` prints an HTML excerpt / "returned an HTML page, not JSON" | a captive portal or proxy is intercepting HTTPS, or `--api-url` points at the website | join the network properly, or fix `--api-url` / `PAGR_API_URL` |
| `this Mac's clock is … the Pagr server` | the clock is off by more than a minute; signed commands expire on a schedule | System Settings → General → Date & Time → *Set automatically* |
| `keychain read failed … is locked` | the login Keychain is locked | Keychain Access → File → Unlock login, then re-run |
| `config.json is not valid JSON` | a partial write (crash or full disk) | `pagr connect --force`, or delete the file and `pagr connect` |
| `this Mac is paired, but the background daemon did not start` | launchd started the job but it died | `pagr daemon logs -n 50`, then `pagr daemon install` — **do not** re-run `connect`, the pairing is saved |

## Daemon not connecting

1. `pagr daemon status` — is the launch agent installed **and** loaded? If installed but not loaded: `pagr daemon install` re-bootstraps it.
2. `pagr daemon logs -n 100` — look for `gateway disconnected` with a reason.
   - `ECONNREFUSED` / `ENOTFOUND`: the `gatewayUrl` in `~/.pagr/config.json` is wrong (a dev URL on a prod pairing?). Re-pair: `pagr connect --force`.
   - `ETIMEDOUT`: outbound TLS on port 443 is blocked (corporate proxy / VPN / firewall). The bridge only ever makes one outbound WebSocket; no inbound ports are needed.
   - `bridge too old; update required`: `npm i -g @pagr/cli@latest`, then `pagr daemon install`.
   - `auth failed`: see *Revoked device*.
3. `pagr doctor` — the **gateway** check does a raw TCP connect to the gateway host. If it fails while a browser can reach the dashboard, a proxy is intercepting WebSockets.
4. The launch agent runs with the `PATH` captured at `pagr connect`/`pagr daemon install` time. If you installed Node or the agent CLIs afterwards, run `pagr daemon install` again to refresh the plist.

## `pagr connect`

`connect` runs in six visible steps: check this Mac → prepare the device key → contact Pagr → approve in the browser → save the pairing → verify the gateway handshake. It only reports success once the daemon has actually connected to the gateway, and it is safe to run twice: on an already-paired Mac it changes nothing and exits 0.

**Nothing is written until the approval completes.** Ctrl-C at any point before that leaves no config, no plist and no half-state (exit 130).

| What you see | What happened | What to do |
| --- | --- | --- |
| `cannot resolve api.pagr.dev` | DNS | check the network; `--api-url` / `PAGR_API_URL` for a local stack |
| `… refused the connection` | nothing listening at that URL | fix `--api-url` / `PAGR_API_URL` |
| `… did not respond (connection timed out)` | outbound TLS blocked | the bridge only needs outbound 443; check VPN/proxy |
| `… returned an HTML page, not JSON` | captive portal / proxy / wrong URL | see the table above |
| `… returned a malformed JSON body` | a broken or intercepting server | `npm i -g @pagr/cli@latest`, then `pagr doctor --json` |
| `… has no pairing endpoint (HTTP 404)` | wrong API URL, or an API older than this CLI | check `--api-url` |
| `this version of the pagr CLI is no longer supported` | the server requires a newer bridge | `npm i -g @pagr/cli@latest` |
| `the API speaks device protocol vN` | protocol mismatch | update the CLI, or point at the right environment |
| `the pairing code expired before it was approved` | you did not approve in time | run `pagr connect` again — nothing was registered |
| `the pairing request was declined in the dashboard` | someone clicked deny | run `pagr connect` again, approve with the right account |
| `that pairing code was already used by another device` | the code was redeemed elsewhere | run `pagr connect` again for a fresh code |
| `nobody approved this Mac within N minutes` | the wait timed out (`--timeout <minutes>`) | run `pagr connect` again |
| `lost contact with the API while waiting for approval` | the network dropped for several consecutive polls | reconnect and run `pagr connect` again |
| `could not open a browser here` | headless, SSH or no default browser | open the printed URL yourself — `connect` keeps waiting |
| `already paired as dev_…` | this Mac already has an identity | nothing to do; `pagr connect --force` to re-pair, or `pagr logout` first |

Transient trouble does **not** abort the flow: a connection reset or a 5xx mid-poll is retried (up to five consecutive failures), and `pair/start` retries 5xx twice before giving up. `PAGR_HTTP_TIMEOUT_MS` caps each individual HTTP request if your network hangs rather than fails.

`pagr connect --force` re-pairs cleanly: it **deletes the old device key from the Keychain and mints a new one**, and tells the server which device this pairing replaces. Revoked key material is never reused. Revoke the old device in the dashboard as well.

## Keychain prompt

The device's Ed25519 private key is stored in the macOS login Keychain under the service `dev.pagr.bridge`. macOS may prompt once when the daemon (or `pagr connect`) first reads it. Choose **Always Allow** so the background daemon can start after a reboot without a prompt.

- If the prompt keeps returning after every update, open Keychain Access → search `dev.pagr.bridge` → Access Control → allow all applications, or simply `pagr logout && pagr connect` to mint a fresh key under the new binary.
- `pagr doctor` shows which store is in use: `keyring` (native), `security-cli` (fallback to `/usr/bin/security`) or `file`. `file` only appears when `PAGR_INSECURE_FILE_STORE=1` is set — never use that outside CI. The check does a real write/read/delete round-trip, so a locked or denied Keychain shows up as a failure rather than as "no key".
- A Keychain that is **locked** or where you clicked **Deny** is reported as such and the command stops. It is never treated as "no key yet": minting a second device key would silently break a working pairing.
- If the native module cannot load (wrong architecture after a Node upgrade), the bridge falls back to `/usr/bin/security`; `pagr doctor` names the reason.
- Never copy `secrets.json` or the Keychain item to another machine; re-pair instead.

## Codex not logged in

The bridge drives `codex app-server`; it never touches your OpenAI credentials. If sessions fail with an auth error:

```bash
codex --version      # must be on PATH for the launch agent (see PATH note above)
codex login          # completes the ChatGPT/API-key login locally
pagr daemon install  # restart the daemon so it re-probes
pagr status          # codex line should show installed
```

If `codex` is installed but `pagr doctor` says *not found on PATH*, it lives somewhere the launch agent cannot see (e.g. a shell-only `PATH` entry). Symlink it into `/usr/local/bin` or re-run `pagr daemon install` from a shell where `which codex` works.

## Claude approvals not reaching your phone

Approvals only work for Claude Code sessions **Pagr itself started or resumed** — i.e. ones you asked for from your phone or the dashboard ("start claude on tonight"). No Claude settings file is touched and no hook is installed: the daemon spawns the `claude` binary with `--permission-prompt-tool stdio` and reads each permission request off the process's stdout as a control message, answering it on stdin once you reply (`packages/adapter-claude/src/{adapter,claude-process}.ts`). A request that gets no decision within the approval timeout (10 minutes by default) is **denied** locally, and Pagr reports it as `timed_out`.

If a Pagr-started Claude session runs but you never see approval requests:

1. `pagr status` / `pagr sessions` — the session must be listed and owned by the daemon. If it is not there, Pagr did not spawn it; see *Sessions you started yourself* below.
2. `pagr status` — the gateway line must read `connected`. Approval requests travel over that one WebSocket; if it is down they queue on this Mac and nothing reaches your phone. See *Daemon not connecting*.
3. `pagr daemon logs -n 100` — a spawn failure (`claude spawn error`, `claude exited`) means the session died before it could ask for anything. `claude --version` must be recent enough to support `-p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`; update with `npm i -g @anthropic-ai/claude-code`.
4. Nothing is auto-allowed on this side, so a missing request is never "Pagr approved it for you". Tier A auto-approval, when you have enabled it, happens in the cloud and is recorded in the audit log.
5. `PAGR_LOG_LEVEL=debug pagr daemon run` prints each permission request and the decision written back.

### Sessions you started yourself

Answering approvals from a `claude` **you** launched in a terminal is not wired up today. The pieces exist but nothing connects them: `@pagr/bridge-adapter-claude` ships a `PermissionRequest` hook script (`src/hooks/permission.mjs`) and the daemon accepts hook-shaped approval requests (it maps the session's `cwd` onto a registered project and mints a local session for it), but `installHooks()` is never called by the bridge, and neither it nor anything else writes an entry into `~/.claude/settings.json` or a project's `.claude/settings.local.json` — `installHooks()` only copies the script, and `hookSettings()` only returns a JSON fragment. Until that is wired up, your own interactive sessions keep using Claude Code's native prompt.

(The one command that does write into a project is `pagr claude channel-setup`, which adds a `pagr` entry to `.mcp.json` for the research-preview channel mode. It is opt-in, unrelated to permission hooks, and not needed for normal use.)

Note that Claude Code cannot be steered mid-turn: instructions sent while a turn is active are queued and delivered when it ends (`queued_followup` → `followup_delivered` in `pagr sessions`).

## Revoked device

Revoking a device in the dashboard closes its socket and rejects its signatures. The daemon logs `auth failed` and stops reconnecting. Re-pairing creates a **new** identity — revoked key material is never reused:

```bash
pagr logout          # bootout the agent, delete the private key, drop config (projects kept)
pagr connect         # new key, new dev_… id
pagr projects        # still there; the cloud learns the ids on the next connect
```

Use `pagr logout --purge` to also forget the project registry, or `pagr uninstall --yes` to remove `~/.pagr` entirely.

## `~/.pagr` problems

- **Unwritable / full disk / read-only volume** — reported before anything else happens, with the path and a fix (exit 10). Nothing is written.
- **Corrupt `config.json` or `projects.json`** — a partial write reads as "not paired", which sends you down the wrong path. `pagr doctor` and `pagr status` now name the damaged file, and `pagr connect` reports it and starts fresh. All state writes are atomic (temp file + rename), so a crash never truncates a file.
- **Wrong permissions** — anything under `~/.pagr` that is group- or world-readable is flagged. `pagr doctor --fix` (and `pagr connect`) tighten it back to 0700/0600.
- **A very long `PAGR_HOME`** — a unix socket path is capped at ~104 bytes, so the daemon socket moves to a short per-user runtime directory and its location is recorded in `run/daemon.sock.path`. `pagr doctor` shows which path is in use.

## launchd problems

- **`/bin/launchctl` missing** (not macOS, or a container) — `connect` says so, keeps the pairing, and tells you to run `pagr daemon run` in the foreground.
- **`launchctl bootstrap` refused** — the error carries launchctl's own words plus the path of `launchd.err.log`. The pairing is already saved; fix the cause and re-run `pagr daemon install`, not `pagr connect`.
- **Already loaded** — the job is kickstarted with the freshly written plist instead of failing.
- **A stale plist** from an older install (a binary that no longer exists, or a different `PAGR_HOME`) is flagged by `pagr doctor`; `pagr daemon install` rewrites it.

## Many projects, many sessions

**"a codex session is already running in the same working tree"** — a second write-capable
session was refused because the first one holds that checkout. Codex (`workspace-write`) and
Claude Code both edit files in place with no locking, so two of them in one checkout silently
overwrite each other. Your options, in order of preference:

1. wait for (or stop) the session that holds it — the refusal names its `ses_…`, `pagr sessions`
   shows it;
2. start the second one **read-only**; read-only sessions may share a tree with a writer;
3. work in a separate `git worktree` and register it as its own project — different path,
   different tree, no conflict;
4. as a last resort, run the daemon with `PAGR_ALLOW_CONCURRENT_WRITERS=1` and accept the race.

Nesting counts: registering both `~/code/app` and `~/code/app/packages/api` makes them one tree.

**"N claude sessions are already running, which is this device's limit"** — the process pool is
full. Defaults: 4 live sessions per provider, 8 in total, and at most 6 live `claude` children.
Raise the first two on the daemon with `PAGR_MAX_SESSIONS_PER_PROVIDER` and `PAGR_MAX_SESSIONS`.
"Live" means starting / working / waiting for approval / waiting for you; finished sessions never
count. Idle `claude` processes are ended (and resumed later with `--resume`) before the pool is
allowed to grow.

**A session says it is working but nothing is running** — the daemon reconciles every session
against its provider at startup, so this should not survive a restart. Force the same pass with
`pagr sessions --reconcile`: each session is either re-attached (Codex `thread/resume`, Claude
`--resume`, reported `resumable` and moved to `idle`) or reported terminated. A session whose
provider says its turn is genuinely still running is left alone — reconciling is safe to run at
any time and never stops work in progress. A provider that dies mid-turn surfaces as a **failed**
session with the exit code in its `session.event`, never as a session that hangs.

**`sessions.json` growing** — terminal sessions are kept for a week (well past the cloud's 24h
follow-up window) and the file is capped at 500 records, oldest terminal first. Both the retention
sweep and the cap run at startup and hourly.

## Registering lots of projects

`pagr project scan [roots...]` finds git repositories under a few conventional folders (`~/code`,
`~/src`, `~/Developer`, `~/Projects`, `~/dev`, `~/repos`, `~/git`, `~/work`, `~/Sites`, `~/Desktop`,
plus the parent of your current directory) — only the ones that exist.

- It refuses to walk your home directory or `/` outright, never descends into `~/Library`,
  `node_modules`, caches, vendor directories or anything hidden, never follows symlinks, stops at
  each `.git`, and walks at most 3 levels (`--depth`) and 500 repositories (`--limit`).
- Already-registered repos are skipped, so running it twice changes nothing.
- Names come from the folder, plus the GitHub repo name as an alias when it differs — text either.
- Two folders that would get the same name are qualified with their parent (`two/app`), and an
  alias already claimed by another project is dropped rather than making a word ambiguous.
  `pagr project add --name X` refuses outright if `X` is taken, instead of quietly renaming.
- `--dry-run` previews, `--all` takes everything without asking, `--json` prints the plan.
  Without a TTY and without `--all` it prints the plan and stops rather than guessing.

`pagr projects` lists name, aliases, live sessions, path and id; `pagr project remove` accepts any
of name, alias or id and refuses an ambiguous reference instead of picking one.

## Live steering vs queued follow-ups

By default a follow-up you text while Claude Code is mid-turn is **queued** and delivered when the
turn ends. Live steering exists only through a Claude Code *channel*, which is an Anthropic
research preview.

- `pagr claude channel-setup --dry-run` explains what a channel is, what
  `--dangerously-load-development-channels` means, and prints the exact `.mcp.json` change without
  writing anything.
- `pagr doctor` reports two separate things: **claude channel** (is the server in this project's
  `.mcp.json`?) and **live steering** (can the daemon steer *right now*?).
- The capability the cloud sees follows the second one. `PAGR_CLAUDE_CHANNEL=1` alone reports
  `canSteerActiveTurn: false` and says follow-ups will be QUEUED; it flips to `true` only while a
  channel server is actually polling, and back to `false` within ~50 s of it stopping. Pagr never
  says it interrupted your agent when it merely queued a message.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | error (uncategorised) |
| 2 | usage / aborted |
| 3 | daemon not running |
| 4 | not paired |
| 5 | precondition failed (doctor failures, project registry refusals, launchd refused) |
| 6 | the Pagr API could not be used (offline, DNS, refused, 5xx, HTML, wrong URL) |
| 7 | pairing did not complete (expired, declined, already used, nobody approved) |
| 8 | version mismatch — this CLI is too old (or too new) for that API |
| 9 | the device key could not be read or written (Keychain locked / denied / missing) |
| 10 | `PAGR_HOME` is unusable (unwritable, full, read-only, corrupt state file) |
| 130 | interrupted (Ctrl-C) |

Every command accepts `--json` (before or after the command name). In JSON mode **stdout carries exactly one JSON document** — `{...}` on success, `{"ok":false,"error":{"code","message","exitCode","hint"}}` on failure — and all human narration goes to stderr.
