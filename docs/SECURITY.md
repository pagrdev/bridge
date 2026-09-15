# Security

## The guarantee, precisely

The bridge is the only piece of Pagr that runs on your machine, so it is the piece an attacker
would most like to control. We assume the network is hostile, that the Pagr cloud could be
compromised or coerced, and that another local process running as you might poke at the daemon.

**What a compromised cloud can do.** It can start and stop Claude Code and Codex sessions in
projects *a local action on this Mac made reachable*, send them arbitrary instruction text, and answer the permission
prompts those sessions raise. Instruction text is a real capability: "run `curl … | sh`" is a
sentence an agent may act on. So the honest statement is not "the cloud cannot make the agent try
anything"; it is that **the cloud cannot, by itself, make a high-risk action succeed**.

**What it cannot do.** It cannot send a shell command, a filesystem path, or a binary to run —
there is no command for it (`packages/protocol/src/schemas.ts`). It cannot name a directory at all: an id
resolves only to a folder something running on this Mac put in the registry, and an id the
registry does not know is refused without the filesystem being touched. It cannot relay its own `allow` for anything this Mac classified as high risk
(below). It cannot lift that classification: no command changes it, and there is no command that
can. It cannot make the bridge answer a prompt for you — there is no such code path at all. It
never sees your device private key, and the bridge never reads your provider credentials.

**The device-side floor** (`packages/core/src/deviceFloor.ts`) is what makes the second paragraph
true. Every permission prompt is classified *on this Mac*, from the command string and the paths
the provider itself asked for — before the cloud is told the prompt exists, and never from anything
the cloud echoes back. If the local classification puts the action in one of these classes, a cloud
`allow` is answered **deny** instead, the agent is told, and your phone gets a message saying which
class blocked it and how to opt in:

| Class | Refused by default |
| --- | --- |
| `remote_code` | a script fetched from the network and piped or substituted into an interpreter (`curl … \| sh`, `bash <(curl …)`, `eval "$(curl …)"`) |
| `network` | anything that reaches a host: `curl`/`wget`/`ssh`/`scp`, `git push`/`pull`/`clone`, package installs, `WebFetch`/`WebSearch` |
| `outside_project` | reading or writing a path outside the registered project root, or running with a cwd outside it |
| `credentials` | `.env*`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `id_rsa`/`id_ed25519`, `*.pem`/`*.p12`/`*.pfx`, `…_API_KEY`-shaped names, Keychain access |
| `privilege` | `sudo`, `doas`, setuid, `launchctl`, `csrutil`, `spctl`, AppleScript `with administrator privileges` |
| `destructive` | `rm -rf`, `mkfs`, `dd of=/dev/…`, and history-rewriting git: `reset --hard`, force-push, `filter-branch`, `rebase`, `branch -D` |

**Lifting it is a local act, and only a local act.** Either edit `~/.pagr/device-policy.json`:

```json
{ "version": 1, "allow": ["network"], "allowedHosts": ["api.github.com"] }
```

…or start the daemon with `PAGR_DEVICE_FLOOR=network,destructive` (or `PAGR_DEVICE_FLOOR=all`).
`allowedHosts` is the narrow form of the `network` lift: egress is permitted when *every* host the
action names is on the list, so `git push`, which names no host, is never covered by it. An
unrecognised class name is ignored rather than guessed at — a typo can never widen the floor. A
corrupt or wrong-shaped policy file reads as the strict default, never as "allow". `pagr doctor`
prints the floor and reports `warn` when any class has been lifted, so a lift is never invisible.

**The floor is not a second opinion about risk.** This distinction matters, because the two are
easy to confuse and only one of them is defensible:

| | Who decides | Can the cloud change it? |
| --- | --- | --- |
| *Which actions need a decision at all* | Claude Code / Codex, from **your** settings | n/a — Pagr is not in that decision |
| *Who answers a prompt that was raised* | You, on your phone or in your terminal | n/a — Pagr relays, it never answers |
| *Whether a cloud `allow` is carried out* | This Mac's device floor | **no**, and there is no command that can |

The bridge has **no path by which it answers a permission prompt on your behalf**. An earlier
version did: a `smartApprovalsTierA` dashboard setting let it auto-approve what it classified as
carrying no risk. That is removed — the setting, the classification flag behind it, and the
registry method that answered an approval locally. Claude Code and Codex already have approval
settings, and a second layer in the bridge was a second thing to configure and a second thing to
get wrong. A cloud that still sends the retired flag is not rejected; the field is dropped.

What remains is the floor, and it only ever says **no**. It never raises a prompt, never answers
one, and never turns a `deny` into an `allow`. Its single job is to refuse to be used as a weapon:
a *cloud-sent allow* for an action this Mac classified as dangerous is answered `deny` instead. It
cannot be lifted remotely, which is the whole reason it is worth having.

**What is still trusted, and what this does not cover.** Read this part before relying on any of
the above:

- **The agents themselves.** Claude Code and Codex run as your user with your provider
  credentials. The bridge does not sandbox them, and cannot. Once an action is approved, what it
  does is between you and the agent.
- **Reading is not always an approval.** The floor only sees actions the provider *prompts* for.
  Claude Code does not prompt to read a file inside the project it was started in, so an
  instruction can make an agent read a `.env` that is committed to your repo, and whatever the
  agent then says about it travels back through the cloud in the session transcript. Keep secrets
  out of registered project directories; the floor is not a data-exfiltration control.
- **The classifier is patterns, not semantics.** It is deterministic and conservative, and it is
  applied to the command the provider asked to run — but an attacker who controls the instruction
  can try to phrase a command so it does not match (obfuscation, a helper script written in one
  approved step and run in the next, an unusual interpreter). Treat the floor as a floor: it
  removes the one-step remote-shell path and makes the interesting cases loud, not as a proof.
- **Anything already running as you.** The IPC socket is uid-checked, not capability-checked. Any
  process running as your user can open it. Dropping `PAGR_DAEMON_SOCK` from the environment of
  cloud-started `claude` children stops the bridge *handing over* the path; it is not a boundary,
  because the path is well known.
- **A repository's own `.claude/settings.json`, by default.** Bridge-spawned sessions load
  `--setting-sources user,project,local`: the same settings your own `claude` loads in that
  checkout. **The risk is real and is not reduced by describing it carefully.** A repository you
  cloned can ship `.claude/settings.json` with `permissions.allow: ["Bash(*)"]`, or a `PreToolUse`
  hook that returns `allow`. In a session started in that checkout, Claude Code then needs no
  permission decision — so no prompt is raised, your phone is never asked, and **the device floor
  never sees the action**, because the floor only judges prompts that exist. The same goes for a
  repository's `.mcp.json`, which can add tools to the session. A cloned repository can therefore
  arrange for a bridge-started session to act without asking you.

  It is the default anyway, because the alternative was worse in a quieter way: overriding your
  configuration meant a Pagr-started session silently ignored permission rules, hooks and tool
  settings that worked in every other session you run, and you had no way to tell. Pagr does not
  get to decide which of your Claude Code settings count.

  If you work in checkouts you do not trust, set **`PAGR_CLAUDE_SEALED=1`** on the daemon. Sealed
  mode loads `user,local` only and adds `--strict-mcp-config`, so neither the repository's
  settings nor its MCP servers apply. `PAGR_CLAUDE_SETTING_SOURCES=user` drops
  `.claude/settings.local.json` as well — it is gitignored by convention but still lives in the
  project directory, so a repo that commits one anyway can grant permissions through it.
- **Your `~/.claude/settings.json`.** `pagr connect` and `pagr daemon install` add one
  `PermissionRequest` hook entry to it, at user scope, so prompts from the Claude Code sessions
  *you* start can be answered from your phone. Everything else in the file is copied through
  untouched, a copy of the previous contents is left as `settings.json.pagr.bak`, exactly what
  changed is printed, and `pagr logout` / `pagr uninstall` / `pagr claude hook-remove` take the
  entry back out. If you already have a `PermissionRequest` hook of your own, Pagr refuses to
  install beside it rather than racing it, and says so. Prompts raised this way go through the
  same floor — but the hook only sees what Claude Code hands it, which is less than the
  bridge-spawned path sees, so its classification is coarser.
- **Codex `read-only` vs Claude read-only.** Codex enforces read-only with a real sandbox. Claude
  Code has none, so read-only there is enforced by withholding tools (below). That is a deny-list
  against a tool set that can change between releases.

## What the bridge can be asked to do

Only the commands in `CommandPayloads` in `packages/protocol/src/schemas.ts`:

| Command | Effect on your machine |
| --- | --- |
| `device.probe`, `project.list`, `agent.get_status` | read-only status |
| `project.remove` | forget a project id (never deletes files) |
| `agent.start_session` | start a Claude Code / Codex session **in a project this Mac made reachable**, with an instruction string and up to 4 image attachments |
| `agent.send_instruction` | send follow-up text to an existing session |
| `agent.stop_session` | interrupt a session |
| `agent.respond_to_approval` | answer a permission prompt the agent raised, bound to the exact preview you saw — and subject to the device floor above |
| `settings.sync_public_policy` | update the approval timeout. Nothing else: there is no cloud setting that makes the bridge answer a prompt |

There is deliberately **no** `shell.exec`, `fs.read`, `fs.write`, `process.spawn`, or "run this
binary". The cloud cannot send a filesystem path: project references are opaque `proj_…` ids that
only resolve against `~/.pagr/projects.json` on your machine (`projects.ts`). Sending a path where an
id is expected fails schema validation before anything else runs. The reverse direction — a path
becoming an id — happens only here: `pagr project use` / `add` / `scan`, and the daemon acting on
what you typed. Registering is a convenience, so any folder you name is reachable without setting
it up first; it is still the *naming*, locally, that creates the id. An id the registry does not
know is `unknown_project`, whether it was invented, guessed, or once belonged to a project you
removed. Nothing in this list can write
`device-policy.json` or change what the floor refuses.

## Server key rotation (`transport.ts`)

`auth.result` is not itself signed, so it cannot on its own authenticate a **widening** of what the
bridge trusts. The rule is therefore about what a key set grants, not about whether it overlaps:

| Offered set | Accepted |
| --- | --- |
| nothing pinned yet | yes — pairing (over HTTPS) is the trust root |
| identical to the pinned set | yes |
| a subset of the pinned set (same key for every id it keeps) | yes — retiring a key only narrows trust |
| adds a key id, or re-points a pinned id at a different key | **only** with `serverKeysSignature` |

`serverKeysSignature` is `{keyId, signature}`, an Ed25519 signature by a key the bridge **already**
pins, over `pagr.server-keys.v1:` + `canonicalize(serverKeys)`. The domain prefix means a command
signature can never be replayed as a key-set signature. A set that fails the rule is neither trusted
nor written to `config.json`, and the refusal is logged.

Rotation stays a two-step, both of which this allows: publish `{old, new}` signed by `old`, then,
once every bridge has it, publish `{new}` unsigned. What it stops is the additive attack — anyone who
obtains one server key appending a key of their own and having the bridge persist it forever.

## Command authentication (`commandGuard.ts`)

Every command is checked, in this order, and the first failure rejects it with a typed `command.ack`:

1. **Schema** — closed enum of command types, zod-validated payloads.
2. **Known signing key** — `keyId` must be in the server key set pinned at pairing and refreshed from
   `auth.result`, under the rule below.
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
still cannot target a different device, replay old commands, reach a directory no local action named, or get a
high-risk approval past the device floor.

## Device identity (`identity.ts`, `keychain.ts`)

- Ed25519 keypair generated locally with Node's `crypto`. Only the public key is sent at pairing.
- Private key lives in the macOS Keychain (`@napi-rs/keyring`, service `dev.pagr.bridge`), with a
  `/usr/bin/security` fallback that passes the key on stdin, never on the command line. A plaintext
  file store exists only behind `PAGR_INSECURE_FILE_STORE=1`.
- Gateway auth is challenge/response: the bridge signs `${deviceId}.${nonce}`; no long-lived bearer token.
- Revoking the device in the dashboard removes the public key server-side; the bridge is then refused at
  the next connection.

## No inbound network surface

The bridge never listens on a TCP port. The gateway connection is outbound WebSocket over TLS with
exponential backoff. The only local endpoint is a Unix-domain socket at `~/.pagr/run/daemon.sock`:

- created mode `0600` inside a `0700` directory;
- on start, a stale socket is unlinked only if it is a socket owned by the current uid;
- ownership and mode are re-verified after bind;
- requests are newline-delimited JSON with a 1 MiB line cap; unknown methods are refused;
- `agent.event` must name a session this daemon owns and agree with that record about provider and
  project, so a local script cannot push fabricated session events to your phone. The socket is
  uid-checked, so this is a same-user boundary, not a trust boundary.

## Approvals (`approvals.ts`, `dispatcher.ts`, `deviceFloor.ts`)

Each pending approval is bound to session id, provider request id, and `sha256(preview)`. The cloud's
decision must echo all three; a mismatch is rejected. Entries are single-use and expire after the
policy timeout (default 600 s), at which point the provider is told **deny**. When the provider resolves
a request on its own (you answered in the terminal), the bridge records that and does not answer twice.

Those three checks only prove the cloud echoed back what the bridge had just told it, so they are
not on their own an authorisation of anything. The decision that matters is the local one: when the
prompt is registered, the bridge classifies the action itself (see "The guarantee, precisely") and
keeps the result. A cloud `allow` is checked against **that** classification. A refusal answers the
provider `deny`, emits a `session.event` naming the class and the opt-in, and acks the command
`failed` / `capability_unsupported`. There is no path that turns a refusal into a quieter allow, and
none that answers the same prompt twice.

## Agents the bridge spawns (`adapter-claude`, `adapter-codex`)

`claude` is started with `--setting-sources user,project,local` and no `--strict-mcp-config`: the
configuration you already have, whole. A repository you had merely cloned can therefore ship
`permissions.allow: ["Bash(*)"]`, or a PreToolUse hook that returns allow, or an `.mcp.json`, and a
bridge-started session in that checkout will honour it — no approval is raised, you are not asked,
and the device floor never sees the action. That is the cost of not overriding your configuration,
and it is stated plainly under "What is still trusted" above.

`PAGR_CLAUDE_SEALED=1` is the opt-in for untrusted checkouts: `--setting-sources user,local` plus
`--strict-mcp-config`. Those two flags move together because they are the same attack with two
filenames — a repo that cannot grant itself a permission through `settings.json` should not be able
to hand itself a tool through `.mcp.json`.

A **read-only** Claude session is given
`--disallowedTools Bash,BashOutput,KillShell,Edit,Write,MultiEdit,NotebookEdit,Task,Agent`. `Bash`
has to be in that list: `sed -i`, `tee` and `>` are writes, so a read-only session that kept `Bash`
could edit the checkout while `concurrency.ts` recorded it as `writeCapable: false` and let a second
write-capable session into the same working tree — the exact race the one-writer rule exists to
prevent. Codex read-only sessions use the provider's own `sandbox: 'read-only'`.

Cloud-started `claude` children do not receive `PAGR_DAEMON_SOCK`.

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

Third-party runtime dependencies across the published packages are `zod` (all), `ws` and
`@napi-rs/keyring` (`@pagr/bridge-core`), and `commander` and `picocolors` (`@pagr/cli`). The
optional `integrations/claude-channel` add-on, which is not part of the default install, also uses
`@modelcontextprotocol/sdk`.

Child processes are spawned with argument arrays, never through a shell. Secrets are never passed
as argv: the `/usr/bin/security` fallback writes the device private key to the tool's stdin, because
argv is visible in `ps` to every user on the machine. There is no auto-update mechanism in this
repository.

## Reporting a vulnerability

Report privately through GitHub Security Advisories at
https://github.com/pagrdev/bridge/security/advisories/new, with a description and reproduction.
Please do not open a public issue for
anything exploitable. We aim to acknowledge within 2 business days and to ship a fix, with credit if you
want it, before public disclosure.
