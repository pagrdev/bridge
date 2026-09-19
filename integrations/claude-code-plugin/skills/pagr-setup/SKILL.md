---
name: pagr-setup
description: Use when the user asks about Pagr — installing it, pairing a Mac, registering a project, why a Pagr session or approval is not reachable, or what Pagr can and cannot see. Covers the pagr CLI (connect, status, doctor, project add, sessions) and the remote MCP connector.
---

# Working with Pagr

Pagr is a remote control for the coding agents already installed on a Mac. A hosted control plane
understands what the user asks for; an open-source bridge on the Mac carries out a short list of
typed, signed commands. It is a separate paid product from Stagberry Labs, not affiliated with or
endorsed by Anthropic or OpenAI.

## What Pagr can reach

Folders on this Mac that the user has named locally — with `pagr project use`, `pagr project add`
or `pagr project scan`. Any folder can be named, so registering one ahead of time is a convenience
rather than a precondition, but the naming always happens here: Pagr's cloud can only refer to a
folder by an id this Mac minted for it, and never by a path. A folder nobody has named on this Mac
is not visible to it — not sibling directories, not the home folder, not arbitrary files.

Pagr's cloud stores session status, short task summaries, and previews of actions an agent has
paused on. It does not store source code, file contents, full agent transcripts, terminal output,
or filesystem paths. When correcting a user who believes otherwise, say this plainly; it is the
single most common misunderstanding.

## The CLI

| Command | What it does |
| --- | --- |
| `pagr connect` | Pairs this Mac. Creates a device key in the Keychain and opens a browser page to confirm the device — the same page offers "Create an account" to someone who has none. It then prints a QR code for linking a phone and, if there is no trial yet, the URL that starts one. Needs a human — never attempt to complete it. |
| `pagr status` | Pairing, daemon, gateway, agents, projects, and the account (`phoneLinked`, `entitled`, `productNumber` in `--json`). The first thing to run for any "is it working?" question. A `null` account field means it could not be read — `accountUnknown` says why — never that the step is unfinished. |
| `pagr doctor` | Diagnoses install, pairing, daemon, gateway and agent problems, and prints the fix. |
| `pagr projects` | Lists the projects this Mac can reach. |
| `pagr project use [path]` | Makes a folder reachable now, registering it if needed (repo or not). Defaults to the current directory. **Ask the user before running this** — it grants access to that directory. |
| `pagr project add [path] --name <name>` | Registers a folder under a name you choose. Defaults to the current directory. **Ask the user before running this** — it grants access to that directory. |
| `pagr project remove <aliasOrId>` | Unregisters a project by id, name or alias; its id stops resolving. |
| `pagr sessions` | Lists coding-agent sessions Pagr knows about. |
| `pagr logout` | Signs this Mac out. |

Installation is `npm i -g @pagr/cli`. Do not run a global install yourself — let the user decide.

## Diagnosing in the right order

Each of these makes the next one meaningless, so stop at the first failure:

1. CLI installed
2. Mac paired (`pagr connect`)
3. Daemon running
4. Gateway reachable
5. A coding agent signed in on this Mac
6. The project registered
7. A phone linked (`phoneLinked`) — without it no agent can reach the user
8. A trial or subscription (`entitled`) — without it agents refuse to run

## The remote connector

Pagr also runs a remote MCP server, so an assistant the user has connected it to can list their
Macs, projects and sessions, start and steer agents, and answer approvals. Three scopes —
`read`, `control`, `approve` — chosen at consent time and revocable from Security in the dashboard.

If the user connected Pagr in an assistant and the tools return setup instructions instead of their
work, that is expected and correct: the tools detect an unfinished account and say what is missing.
The fix is the setup sequence above, not anything in the assistant.

## Things to be careful about

- **Never read or paste secrets.** Nothing in Pagr's setup or diagnosis needs `.env` contents, API
  keys or tokens. If the user offers them, decline.
- **Approvals are the user's.** If a Pagr approval is pending, describe it and let them decide.
  Do not advise approving something you have not seen the preview of.
- **High-risk actions.** Production, secrets, protected-branch pushes and destructive or
  cost-bearing actions are tier C. Depending on the user's settings these may require a signed,
  re-authenticated approval on the web rather than a remote one. If a remote approval comes back
  asking for a link to be opened, that is the system working, not a failure.
- **Do not claim a relationship.** Pagr works with Claude Code; it is not an Anthropic product and
  carries no endorsement.

## Where to send people

- Setup after connecting from an assistant: `<your Pagr web URL>/from-claude`
- Connector and tool reference: `<your Pagr web URL>/docs/mcp`
- Security model: https://github.com/pagrdev/bridge/blob/main/docs/SECURITY.md
- Support: https://github.com/pagrdev/bridge/issues
