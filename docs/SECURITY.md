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
there is no command for it (`packages/protocol/src/schemas.ts`). It cannot *choose* a directory:
every folder Pagr can reach was named by something running on this Mac, a project is an opaque id
that resolves only against the local registry, and an id the registry does not know is refused
without the filesystem being touched. It can now ask
this Mac to *list* the git repositories under your conventional code folders and register one of
them by an opaque handle — it still never names one, and it never learns where any of them are
(see "Projects a phone can add"). It cannot relay its own `allow` for anything this Mac classified as high risk
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
  against a tool set that can change between releases. The two headless runs handoff v1 added —
  the handoff writer and the reviewer — are neither of those things, and their confinement is
  weaker on the Codex side than on the Claude side: see "Headless runs" below, which states it in
  full rather than implying parity.

## What changed for the iPhone app

Protocol v2 added the phone. It is the largest change to this document since the bridge shipped,
so the whole of it is stated here in one place rather than left to be assembled from the sections
below.

### The sealing boundary

Content is sealed **on this Mac** for the set of phone keys the gateway delivered. The cloud
stores and relays the envelope and holds no key for it.

| Sealed — the cloud cannot read it | Plaintext — the cloud can | Why it has to be |
| --- | --- | --- |
| transcript frames: your messages, the agent's, thinking, tool calls, tool output, diffs, terminal blocks | session / project / device ids, `seq`, frame **kind**, timestamps, size, whether it was clipped | routing, ordering, de-duplication and the session list |
| the approval **preview** (its own sealed frame) | approval id, action type, `previewHash`, the risk hints (`networkAccess`, `destructive`, `gitPush`, …), `riskTier`, expiry | the cloud re-checks the tier and decides whether to ask for Face ID, without reading the command |
| a question's text, its option **labels**, any preview the model attached | question id, how many options each question has, which take more than one, which must never be echoed | the phone lays the answer sheet out before it has decrypted anything |
| — | project display names, git remote host/name, the Mac's name, session display names | you have to be able to tell your Macs and projects apart |
| — | approval option **ids and kinds** (`allow_once`, `reject_always`, …) | the phone renders the agent's real buttons; the words on them are the bridge's own generic labels |

Two deliberate exceptions, both stated rather than buried:

- **The phone → Mac direction is plaintext.** Instructions, answers and decisions travel in the
  command payloads the existing signed dispatcher carries, and those are not sealed. What you type
  on your phone is readable by the cloud. Sealing that direction would need the phone to hold a key
  for *the Mac*, which is a second key-distribution problem for a message the cloud must in any
  case queue, re-mint and audit.
- **`imessage` is plaintext, when you have linked a thread.** One field on `session.frame`,
  `approval.requested` and `question.asked`, carrying the line your iMessage thread shows. It only
  exists while `auth.result.features.imessage` is true, it stops on the next event when you unlink,
  and on frames it is the agent's final message of a turn clipped to 500 characters. iMessage is
  plaintext by nature; this field is how the thread keeps working now that the transcript is sealed.

`~/.pagr/journal/` is plaintext on your own disk. That is local, and `docs/PRIVACY.md` says so in
full.

### Recipient-key trust, and its limit

The phone key set arrives in `auth.result.recipientKeys` and live in `keys.updated`, and is
accepted under the same rule as the server key set: a set that grants no new trust — the same set
again, or a narrower one — is taken as it stands; **adding a phone, or re-pointing a pinned
fingerprint at a different key, requires `recipientKeysSignature`** from a server key this bridge
already pins. The bridge re-derives each fingerprint from the key and refuses a set where the two
disagree. `pagr status` prints the pinned fingerprints in full so you can compare them with what
your phone shows.

**What that does not defend against, stated plainly:** the signing key belongs to the Pagr API. An
attacker who holds it — or Pagr under legal compulsion — can sign a set containing one extra
recipient, and this bridge will accept it and seal to that recipient from then on. The
fingerprints in `pagr status` are what makes it *visible*; nothing here makes it impossible. If
that matters to you, check the list after every phone you pair and after anything unexpected.

### Everything else v2 added

- **Repository scan.** A paired phone can ask this Mac to list the git repositories under your
  conventional code folders and register one by opaque handle. This widens what the cloud can
  reach and has its own section below; `PAGR_REMOTE_PROJECT_PICK=0` removes both commands.
- **`allow_always` writes Claude Code's own settings.** Choosing a persistent grant on your phone
  makes Claude Code write the rule into **your** settings, where it applies to every future session
  including ones Pagr knows nothing about. The device floor judges a persistent grant harder than a
  one-off for exactly that reason, and `PAGR_ALLOW_ALWAYS=0` removes the option entirely.
- **Floor rules for persistent grants.** A floored class refuses a standing grant even where the
  host allow-list would have permitted the same action once. The classes lifted on this Mac travel
  in `device.hello.floor.lifted`, by name, so the app can show what is lifted and never guess.
- **The Claude channel is opt-in twice**, and a bound channel is a prompt-injection surface —
  see "The Claude Code channel" below, which states that in full.
- **Codex terminal threads are `mirror_only`.** The bridge mirrors them and relays their prompts;
  it never writes a turn, never steers, and never answers a request that was addressed to every
  subscriber rather than to Pagr — the person in front of that terminal owns it.

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
| `repo.scan` | list the git repositories under your conventional code folders as opaque handles — names, not paths. Rate limited to one every 30 s (see "Projects a phone can add") |
| `project.register_handle` | register one of those handles as a project. The handle resolves only in this daemon's memory, and only for an hour |
| `agent.answer_question` | answer a question the agent asked (`AskUserQuestion`, `requestUserInput`), bound to the exact prompt and the exact options it offered. Answering a question runs nothing |
| `session.list_history` | list this Mac's sessions for a time window — ids, project ids, names, statuses, timestamps. Never a path, and never a session outside a registered project |
| `session.backfill` | re-send part of a session's own transcript from `~/.pagr/journal/`, sealed, capped, one at a time. It reads the same files the mirror already reads and opens no new ones |
| `keys.sync` | ask the gateway to re-send the phone key set. Carries nothing and changes nothing on this Mac by itself |
| `session.handoff.capture` | write one handoff file under `<repo>/.pagr/handoff/` for a session you can already see, and — only if the tree is dirty — `git add -A && git commit` a WIP commit on the branch you are already on. It writes nowhere else, and the transcript it is written from never leaves this Mac |
| `review.start` | build a review packet under `<repo>/.pagr/review/` from a commit range and run the reviewing agent headless over the work tree, allowed to write only its own report directory (see "Headless runs" — the Codex side of that is weaker than the Claude side, and this document says how). The packet is the diff and one line of intent; no transcript and no reasoning from the agent that wrote the code |
| `review.apply` | hand a finished review's findings back to the builder. It sends text; it never applies a change by itself |
| `rules.migrate` | with `consent: true`, and only after you said yes by text, write ONE rules file (`AGENTS.md` or `CLAUDE.md`) that did not exist. An existing rules file is never modified, and with `consent: false` the command only reports what it would do |

That table is the whole surface — **nineteen commands** at this version, counting the three
read-only ones grouped in the first row. It is not fixed at that number: a bridge that gains a
command gains a row here in the same change, and `pagr doctor` reports which of the optional ones
this Mac will actually honour.

There is deliberately **no** `shell.exec`, `fs.read`, `fs.write`, `process.spawn`, or "run this
binary". The cloud cannot send a filesystem path: project references are opaque `proj_…` ids that
only resolve against `~/.pagr/projects.json` on your machine (`projects.ts`). Sending a path where an
id is expected fails schema validation before anything else runs. The reverse direction — a path
becoming an id — happens in two places, both on this Mac: `pagr project use` / `add` / `scan` and the
daemon acting on what you typed, and `project.register_handle` resolving a handle this Mac itself
minted from its own scan (below). Registering is a convenience, so any folder you name is reachable without setting
it up first; it is still the *naming*, locally, that creates the id. An id the registry does not
know is `unknown_project`, whether it was invented, guessed, or once belonged to a project you
removed. Nothing in this list can write
`device-policy.json` or change what the floor refuses.

## Git commits the bridge makes (`git.ts`)

**This is new, and it is the largest change to what a cloud-sent command can cause on your Mac
since the bridge shipped.** Before handoff v1 the bridge never ran `git` at all. It does now.

When you switch a task from one agent to another and the working tree is dirty, Pagr makes a
commit before it stops the first agent:

```
git add -A
git commit -m "wip(pagr): handoff claude → codex"
```

Said plainly, with nothing softened:

- **It commits everything**, exactly as your own `git add -A` would, and it respects your
  `.gitignore` exactly as your own `git add -A` would. `.pagr/` is not in it, because `.pagr/` is
  excluded through `.git/info/exclude`.
- **On the branch you are already on.** It never creates, switches or deletes a branch.
- **It never pushes.** There is no command in the protocol that makes the bridge push, and
  `git.ts` has no code that could. Network-reaching git is also a floored class
  (`network`), so a cloud `allow` for one is answered `deny`.
- **Only when the tree is dirty**, and only as part of a switch or a review you asked for.
- **Repository hooks are not skipped.** The bridge never passes `-c core.hooksPath=` and never
  `--no-verify`. Your `pre-commit` is your code and your policy: if it fails, the commit fails,
  the switch fails loudly with the hook's own first line of stderr, and the handoff file is kept
  so nothing is lost.
- **It rewrites no history.** No `reset --hard`, no `rebase`, no `commit --amend`, no
  `filter-branch`. Those are all in the `destructive` floor class as well.

Why that is acceptable rather than alarming: **a local commit is recoverable by anyone, and work
that was never committed and is then trampled by a second agent is not.** That asymmetry is the
whole argument. The switch exists to put a second agent into the same working tree; the commit is
what makes the first agent's uncommitted work survive it. `git reset HEAD~1` undoes the commit and
costs you nothing; there is no command that undoes an overwrite.

Every git subprocess in the bridge lives in one module, `packages/core/src/git.ts`, and a test
fails the build if a `git` call appears anywhere else. It runs with `GIT_TERMINAL_PROMPT=0` so a
credential prompt can never hang the daemon, with a 30 s timeout, and with the project root as its
working directory.

## Projects a phone can add (`repoScan.ts`, `scan.ts`)

With this version a paired phone can ask this Mac to list the git repositories it can see, and to
register one of them as a project. This is the one capability that widens what the cloud can
reach, so here is exactly what it does and does not open.

**What is looked at.** Only the conventional code folders directly under your home directory, in
the list `CONVENTIONAL_ROOT_NAMES` in `packages/core/src/scan.ts` — today `code`, `src`,
`Developer`, `Projects`, `projects`, `dev`, `repos`, `git`, `work`, `Sites` and `Desktop` — and
only the ones that exist. Never `~` itself, never `~/Library`, never a system location, never a
root the cloud names (the payload is `{}`; there is no field for a root). The walk stops at depth
3, stops at 500 repositories, never follows a symlink, skips hidden and vendor directories, and
treats a repository as a leaf. A folder without a `.git` in it is never reported and never
descended into past that depth.

**What leaves the Mac.** For each repository: the folder's name, the git remote's host and repo
name if `.git/config` has one, and a handle. Nothing else — no path, no parent, no sibling, no
count of what was skipped. The handle is `rh_` + a hash of the real path salted with the same
device secret `projectIdFor` uses; that salt never leaves this Mac, so off-device a handle cannot
be turned back into a path, and the same folder on two Macs produces two unrelated handles. The
handles live in the daemon's memory for one hour, are never written to disk, and are dropped as
soon as one of them is registered.

**What this widens.** Before, a compromised cloud could reach *the folders a local action on this
Mac had named*. Now it can also reach *any git repository under those folders*, because it can ask
for the list and register one from it. That is a real widening and it is stated here rather than
buried: a registered project is a project sessions can be started in.

**What it still cannot do.** It cannot name a folder — every path in this flow came from this
Mac's own scan. It cannot read a folder that is not a git repository under those roots. It cannot
see anything the scan did not return: a handle it did not receive, guesses at a handle, and a
handle from more than an hour ago are all `unknown_project`, answered without the filesystem being
touched. It cannot make the scan look somewhere else, and registering a project still grants only
what a project ever granted — the device floor, containment and approval rules above are unchanged.

**Turning it off.** `PAGR_REMOTE_PROJECT_PICK=0` in the daemon's environment removes both commands
(they answer `capability_unsupported`) and drops `repo_scan.v1` from `device.hello`, so the app
stops offering it. Projects are then added only on this Mac, with `pagr project add`.
`pagr doctor` prints which of the two you are in.

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

**Standing grants are judged harder than one-off answers.** A prompt now carries the agent's own
options, and "allow always" is a real one: it hands Claude Code back the `permission_suggestions`
it offered with the prompt, as `updatedPermissions`, so the rule is written into **Claude's own
settings** and outlives the session — Pagr stores no permission rules of its own and keeps no copy.
Because such a grant is forever, the floor never lets one through for a class it is holding: a
`network` class lifted only by `allowedHosts` covers this one action against those hosts, not a
rule, so `allow_always` and `allow_session` are refused for it while a plain `allow_once` is
carried. Only a class you lifted by hand — in `device-policy.json` or `PAGR_DEVICE_FLOOR` — permits
a persistent grant. Starting the daemon with `PAGR_ALLOW_ALWAYS=0` removes the option everywhere:
it never appears on the card, and an answer naming it is refused rather than downgraded.

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

## Headless runs: the handoff writer and the reviewer

Handoff v1 added two runs that have no person attached to them. One writes the handoff note when
the sending agent can no longer be talked to; the other reads a commit range and writes a review.
Both are started by the bridge, both end when their file appears or their timeout expires, neither
is offered as a session you can steer, and **both auto-deny every permission prompt they raise** —
a headless run has nobody to ask, so the honest answer to a prompt is no.

### What the reviewer is given, and what it is not

The review packet is the commit list, `git diff --stat`, the unified diff, and the full current
contents of changed files under `PAGR_REVIEW_MAX_FILE_LINES` lines, plus **one line of intent**:
what the builder was trying to do, capped at 500 characters and cut at the first newline.

It contains **no transcript, no handoff file, and no self-assessment from the agent that wrote the
code.** That is not a size optimisation. A reviewer that is handed the author's reasoning inherits
the author's confidence and approves almost everything, which is the failure every published
cross-vendor review workflow is built to avoid. Anything under `.pagr/` is stripped out of the
diff and the diffstat and is counted rather than named, so an earlier handoff or an earlier review
sitting in the range cannot leak in sideways.

The property is easy to erode by accident, so it is a test rather than a convention:
`review/packet.test.ts` plants a handoff note, a transcript dump, an earlier review and several
paragraphs of author reasoning inside the commit range, builds the packet, and greps the packet's
own output for session text — `ses_…` and `hnd_…` ids, transcript JSON, the handoff file's own
section headings, the planted sentences. If any of it appears, the build fails.

### The sandbox asymmetry, stated rather than implied

The two providers are **not** confined to the same degree, and no sentence in this document should
be read as saying they are.

**Claude.** The run is given an explicit tool list: `Read`, `Glob`, `Grep`, `NotebookRead`,
read-only `git` invocations (`status`, `log`, `diff`, `show`, `branch`, `rev-parse`), and
`Write` / `Edit` / `MultiEdit` narrowed to `.pagr/**` for the handoff writer and to
`.pagr/review/<reviewId>/**` for the reviewer. It runs sealed (`--setting-sources user,local`,
`--strict-mcp-config`). Two limits worth knowing: `--allowedTools` is an *allow* list rather than
a restriction — a tool outside it raises a permission prompt instead of being refused outright,
and what makes it a boundary here is that the run denies every prompt it is asked — and there is
no OS sandbox behind it, so a `permissions.allow` you have already put in your own
`~/.claude/settings.json`, or one in the checkout's `.claude/settings.local.json`, still applies.

**Codex.** The run gets a real OS sandbox, and it is *not* narrowed to the same paths. Codex's
sandbox has no way to express "read-only except this one directory": in the app-server protocol
the `readOnly` policy carries only a network flag, `writableRoots` exists solely on
`workspaceWrite`, and there is no permission-profile field on a turn. So `writable_roots` **widens
an otherwise read-only sandbox rather than narrowing a writable one** — the roots add to the
workspace, they do not replace it. Today the one-shot starts its thread with the repository root
as its working directory, which means the sandbox grants the repository, and
`writableRoots: ["<repo>/.pagr/…"]` adds nothing it did not already have. What actually keeps a
Codex writer or reviewer inside `.pagr/` today is **its prompt**, not the sandbox.

What the Codex sandbox does still enforce is the boundary at the edge of the repository: your home
directory, a sibling checkout, `$TMPDIR` and `/tmp` are all outside it, and network access is off
for the run.

**HND-015 is the open ticket to close this structurally**, by starting the one-shot's thread with
`<repo>/.pagr` as its working directory so a `workspace-write` sandbox cannot reach source files
at all. Until it lands, a Codex handoff writer or reviewer is a process that could write anywhere
in the repository it was pointed at, and is stopped from doing so by instructions rather than by
the kernel. The path is reached in exactly two cases: Codex is the agent *receiving* a handoff the
sender could no longer write for itself, or Codex is the agent doing a review. A handoff the
sending agent writes itself never starts a one-shot at all, and a run on the Claude side is
bounded by the tool list above instead.

## The Claude Code channel (`pagr claude`)

Opt-in, and twice over. Nothing happens until you run `pagr claude channel-install` (which
registers an MCP server at user scope through `claude mcp add-json`, never by editing
`~/.claude.json`), and nothing happens in a given session until you start it with `pagr claude`,
which adds `--dangerously-load-development-channels server:pagr` to the real `claude`. Plain
`claude` never loads a channel: registration alone changes nothing about it.

`pagr claude` also prints one line before it execs, because Claude Code shows a full-screen
"Loading development channels" warning on **every** such launch and nothing can pre-accept it (spike
`docs/spikes/2026-09-17-dev-channels-warning.md` verified this on 2.1.220 and 2.1.274). The launcher
never automates that keystroke: it is the consent gate, its position in the startup sequence varies,
and its option numbering differs by version.

The channel server itself is `@pagr/cli`'s `dist/channel-server.mjs`. It has no network listener, no
credentials, and no filesystem access: it speaks JSON-RPC on the stdio Claude Code gave it and talks
to exactly one other thing, the local daemon's 0600 Unix socket. The bridge's own headless spawns
never carry the flag — Claude Code drops channel events silently in `-p` mode — and a test asserts
`claude-process.ts` cannot grow it.

What a bound channel changes, stated exactly:

- The mirrored session's control level becomes `full`, and `agent.send_instruction` for it is
  accepted instead of refused. The text is injected as a user turn; it is answered `queued` and the
  phone watches it move `queued → picked_up → delivered`. Pagr never reports a steer.
- `agent.stop_session` stays refused. The `claude` process belongs to the terminal it runs in.
- Permission prompts raised by that session can be relayed to the phone and answered from it, in
  addition to the local dialog, which stays live the whole time and wins if it is answered first.
  No decision from the phone means silence: Pagr never invents a `deny`.

**Prompt injection, unchanged.** Anything the daemon relays lands in the model's context, and the
terminal shows one truncated line per event. Whoever can text your Pagr number can, while a channel
is bound, put instructions into that session and answer its prompts. That is the trade the warning
dialog is describing, and it is why the channel is per-session and dies with the terminal rather
than being a standing grant. Detach (two missed polls, ~50 s) puts the session back to
`approvals_only`.

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
Claude Code channel server (`@pagr/cli`'s `dist/channel-server.mjs`) has none of its own: it speaks
the handful of JSON-RPC messages Claude Code sends directly, rather than pulling an MCP SDK into a
process that runs inside the user's terminal.

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
