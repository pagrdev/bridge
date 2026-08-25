# Troubleshooting the Pagr bridge

Start with `pagr doctor`. It checks Node, `~/.pagr` permissions, the secret store, pairing, the daemon socket, gateway reachability, the `codex`/`claude` CLIs and the launch agent, and prints a fix for each failure. `pagr status` shows the live picture; `pagr daemon logs -f` streams `~/.pagr/logs/daemon.log`.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pagr status` says **daemon not running** | launch agent not installed / not loaded, or crashed at start | `pagr daemon install`, then `pagr daemon logs`. Foreground debugging: `pagr daemon run` |
| gateway shows `connecting` / `disconnected` forever | outbound 443 blocked, wrong `gatewayUrl`, or device revoked | see below |
| `pairing failed: pairing code expired` | more than a few minutes passed before approving in the browser | run `pagr connect` again for a fresh code |
| macOS asks for your login password / "pagr wants to use the keychain" | the device key lives in the login Keychain | click **Always Allow**; see below |
| Codex sessions fail immediately | Codex CLI not logged in | `codex login` |
| Claude approvals never reach your phone | permission hook not installed / not firing | see below |
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

## Claude hook not firing

Claude Code approvals reach your phone through a project-scoped `PermissionRequest` hook (`~/.pagr/hooks/permission.mjs`) that talks to the daemon socket. If Claude runs but you never see approval requests:

1. `pagr daemon status` — the socket `~/.pagr/run/daemon.sock` must exist; the hook returns *no decision* (Claude falls back to its own prompt) when it cannot connect.
2. Check the project's `.claude/settings.local.json` contains the hook entry. The adapter installs it when the first session starts; if you edited settings by hand, restart the session.
3. `claude --version` must be ≥ the version that supports `PermissionRequest` hooks. Update with `npm i -g @anthropic-ai/claude-code`.
4. Sessions started **outside** Pagr (a plain `claude` in a terminal) are not steered by the bridge; only sessions the daemon started or resumed carry the hook.
5. `PAGR_LOG_LEVEL=debug pagr daemon run` prints each hook call and its decision.

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
