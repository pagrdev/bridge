# Troubleshooting the Pagr bridge

Start with `pagr doctor`. It checks Node, `~/.pagr` permissions, the secret store, pairing, the daemon socket, gateway reachability, the `codex`/`claude` CLIs and the launch agent, and prints a fix for each failure. `pagr status` shows the live picture; `pagr daemon logs -f` streams `~/.pagr/logs/daemon.log`.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pagr status` says **daemon not running** | launch agent not installed / not loaded, or crashed at start | `pagr daemon install`, then `pagr daemon logs`. Foreground debugging: `pagr daemon run` |
| gateway shows `connecting` / `disconnected` forever | outbound 443 blocked, wrong `gatewayUrl`, or device revoked | see below |
| `pairing failed: pairing code expired` | more than a few minutes passed before approving in the browser | run `pagr connect` again for a fresh code |
| macOS asks for your login password / "pagr wants to use the keychain" | the device key lives in the login Keychain | click **Always Allow**; see below |
| Codex sessions fail immediately | Codex CLI not logged in | `codex login` |
| Claude approvals never reach your phone | session not started by Pagr, or the daemon lost the gateway | see below |
| daemon logs `auth failed` or `device revoked` | this device was revoked from the dashboard | `pagr logout && pagr connect` |

## Daemon not connecting

1. `pagr daemon status` — is the launch agent installed **and** loaded? If installed but not loaded: `pagr daemon install` re-bootstraps it.
2. `pagr daemon logs -n 100` — look for `gateway disconnected` with a reason.
   - `ECONNREFUSED` / `ENOTFOUND`: the `gatewayUrl` in `~/.pagr/config.json` is wrong (a dev URL on a prod pairing?). Re-pair: `pagr connect --force`.
   - `ETIMEDOUT`: outbound TLS on port 443 is blocked (corporate proxy / VPN / firewall). The bridge only ever makes one outbound WebSocket; no inbound ports are needed.
   - `bridge too old; update required`: `npm i -g @pagr/cli@latest`, then `pagr daemon install`.
   - `auth failed`: see *Revoked device*.
3. `pagr doctor` — the **gateway** check does a raw TCP connect to the gateway host. If it fails while a browser can reach the dashboard, a proxy is intercepting WebSockets.
4. The launch agent runs with the `PATH` captured at `pagr connect`/`pagr daemon install` time. If you installed Node or the agent CLIs afterwards, run `pagr daemon install` again to refresh the plist.

## Pairing code expired

Codes are short-lived. `pagr connect` prints the code and opens `…/device/pair?code=…`; if you did not approve in time you get `pairing failed: pairing code expired`. Just run `pagr connect` again — the device key is reused, nothing was registered.

Other pairing failures:

- `could not reach https://api.pagr.dev` — network, or you meant a local stack: `pagr connect --api-url http://localhost:4000` (or `PAGR_API_URL`).
- `pairing rejected` — someone declined the request in the dashboard.
- `already paired as dev_…` — this Mac already has an identity. Use `pagr connect --force` to re-pair or `pagr logout` first.

## Keychain prompt

The device's Ed25519 private key is stored in the macOS login Keychain under the service `dev.pagr.bridge`. macOS may prompt once when the daemon (or `pagr connect`) first reads it. Choose **Always Allow** so the background daemon can start after a reboot without a prompt.

- If the prompt keeps returning after every update, open Keychain Access → search `dev.pagr.bridge` → Access Control → allow all applications, or simply `pagr logout && pagr connect` to mint a fresh key under the new binary.
- `pagr doctor` shows which store is in use: `keyring` (native), `security-cli` (fallback to `/usr/bin/security`) or `file`. `file` only appears when `PAGR_INSECURE_FILE_STORE=1` is set — never use that outside CI.
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

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | error |
| 2 | usage / aborted |
| 3 | daemon not running |
| 4 | not paired |
| 5 | precondition failed (doctor failures, project registry refusals) |
