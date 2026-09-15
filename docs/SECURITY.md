# Security

## Threat model in one paragraph

The bridge is the only piece of Pagr that runs on your machine, so it is the piece an attacker
would most like to control. We assume the network is hostile, that the Pagr cloud could be
compromised or coerced, and that another local user or process might poke at the daemon. The design
goal is that **even a fully compromised cloud cannot turn the bridge into a remote shell**.

## What the bridge can be asked to do

Only the commands in `CommandPayloads` in `packages/protocol/src/schemas.ts`:

| Command | Effect on your machine |
| --- | --- |
| `device.probe`, `project.list`, `agent.get_status` | read-only status |
| `project.remove` | forget a project id (never deletes files) |
| `agent.start_session` | start a Claude Code / Codex session **in a project you registered locally**, with an instruction string and up to 4 image attachments |
| `agent.send_instruction` | send follow-up text to an existing session |
| `agent.stop_session` | interrupt a session |
| `agent.respond_to_approval` | answer a permission prompt the agent raised, bound to the exact preview you saw |
| `settings.sync_public_policy` | update the approval timeout / tier-A auto-approve flags |

There is deliberately **no** `shell.exec`, `fs.read`, `fs.write`, `process.spawn`, or "run this
binary". The cloud cannot send a filesystem path: project references are opaque `proj_…` ids that
only resolve against `~/.pagr/projects.json` on your machine (`projects.ts`). Sending a path where an
id is expected fails schema validation before anything else runs.

The coding agents themselves (Claude Code, Codex) still run with your user's permissions and their
own permission models. The bridge relays their approval prompts to you; it never auto-approves
anything unless you enable the tier-A policy in the dashboard, and it never widens what the agent can do.

## Command authentication (`commandGuard.ts`)

Every command is checked, in this order, and the first failure rejects it with a typed `command.ack`:

1. **Schema** — closed enum of command types, zod-validated payloads.
2. **Known signing key** — `keyId` must be in the server key set pinned at pairing and refreshed from
   `auth.result`. Keys can overlap during rotation.
3. **Ed25519 signature** over `canonicalize(body)` (sorted keys, no whitespace).
4. **Device binding** — `body.deviceId` must equal this device's id.
5. **Expiry** — `expiresAt` in the past, or `issuedAt` more than 2 minutes in the future, is rejected.
   A 15-minute ceiling is then enforced regardless of what the envelope claims: an `issuedAt` more than
   15 minutes old, or an `expiresAt` more than 15 minutes after its `issuedAt`, is rejected. A command
   therefore can never outlive the window its nonce is remembered for.
6. **Replay** — nonce and command id are recorded in a bounded LRU (`replay.ts`, persisted best-effort
   to `~/.pagr/replay.json`), for the full 15-minute ceiling plus a minute of slack. A *different*
   command reusing a seen nonce is rejected, as is a command id arriving with a different nonce.
7. **De-duplication** — a second copy of a command already accepted (the gateway resends an envelope it
   has had no ack for after 30 s, or the cloud retries under the same `idempotencyKey`) is never
   rejected and never executed twice: it is answered with the terminal ack of the single execution,
   waiting for it if that execution is still running. The command is recorded as in flight at receipt,
   before dispatch, so a command slower than the resend window is reported by its real outcome.
8. **Local existence** — referenced project / session ids must exist locally.

A compromised gateway that lacks the server signing key can therefore do nothing; a stolen signing key
still cannot target a different device, replay old commands, or reach unregistered directories.

## Device identity (`identity.ts`, `keychain.ts`)

- Ed25519 keypair generated locally with Node's `crypto`. Only the public key is sent at pairing.
- Private key lives in the macOS Keychain (`@napi-rs/keyring`, service `dev.pagr.bridge`), with a
  `/usr/bin/security` fallback. A plaintext file store exists only behind `PAGR_INSECURE_FILE_STORE=1`.
- Gateway auth is challenge/response: the bridge signs `${deviceId}.${nonce}`; no long-lived bearer token.
- Revoking the device in the dashboard removes the public key server-side; the bridge is then refused at
  the next connection.

## No inbound network surface

The bridge never listens on a TCP port. The gateway connection is outbound WebSocket over TLS with
exponential backoff. The only local endpoint is a Unix-domain socket at `~/.pagr/run/daemon.sock`:

- created mode `0600` inside a `0700` directory;
- on start, a stale socket is unlinked only if it is a socket owned by the current uid;
- ownership and mode are re-verified after bind;
- requests are newline-delimited JSON with a 1 MiB line cap; unknown methods are refused.

## Approvals (`approvals.ts`, `dispatcher.ts`)

Each pending approval is bound to session id, provider request id, and `sha256(preview)`. The cloud's
decision must echo all three; a mismatch is rejected. Entries are single-use and expire after the
policy timeout (default 600 s), at which point the provider is told **deny**. When the provider resolves
a request on its own (you answered in the terminal), the bridge records that and does not answer twice.

## Filesystem containment (`projects.ts`)

- Registration requires an existing directory that is a git repository (or `--allow-non-git`), resolved
  with `realpath`.
- Refused: `/`, `/System`, `/private/etc`, `/etc`, `/usr`, `/bin`, `/sbin`, `/Library`, your home
  directory itself, and anything under `~/.pagr`.
- `assertContained(projectId, path)` realpaths the candidate (following symlinks) and requires the result
  to remain under the project root.

## Attachments (`attachments.ts`)

Downloads use a 15 s timeout, are capped at the declared size (max 50 MiB by schema), must match the
declared sha256, and must sniff as PNG/JPEG/HEIC/WebP by magic bytes — the URL's extension and
`Content-Type` are ignored. The URL must be `https:` on a public hostname (never a literal IP,
loopback, or link-local address), and **redirects are refused, not followed** (`redirect: 'error'`):
the allow-list can only vet the URL the cloud handed us, so a permitted host must not be able to bounce
the download somewhere else.

Files are written `0600` into `~/.pagr/tmp/` and held by a lease (`attachmentLease.ts`) for the lifetime
of the agent turn that referenced them — an adapter call returns when the turn reaches the agent, not
when the agent has read the image, so deleting on return raced the model. A lease ends when its turn
reports `completed` / `failed`, when the session stops, at daemon shutdown, or — as a backstop for a
turn that never ends — after one hour, with `cleanupTmp` sweeping anything older than 24 h at startup.

## Supply chain

Runtime dependencies are `ws`, `zod`, and `@napi-rs/keyring`. Child processes (in adapters) are spawned
with argument arrays, never through a shell. There is no auto-update mechanism in this repository.

## Reporting a vulnerability

Email **security@pagr.dev** with a description and reproduction. Please do not open a public issue for
anything exploitable. We aim to acknowledge within 2 business days and to ship a fix, with credit if you
want it, before public disclosure.
