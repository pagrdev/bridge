# Pagr plugin for Claude Code

Two commands and a skill that make setting up and troubleshooting [Pagr](https://pagr.dev)
something you can do without leaving Claude Code.

> Pagr is a paid product from Stagberry Labs. This plugin is not affiliated with or endorsed by
> Anthropic, and it is not listed in any directory yet.

## What it contains

| Path | What it is |
| --- | --- |
| `commands/setup.md` | `/pagr:setup` — install the CLI, pair this Mac, register the current project, in order, stopping at the first failure |
| `commands/doctor.md` | `/pagr:doctor` — run `pagr doctor` and explain the one thing that is actually wrong |
| `skills/pagr-setup/SKILL.md` | Background knowledge: the CLI surface, what Pagr can and cannot see, the diagnosis order, and the things not to do |

No MCP server, no hooks, no agents. It shells out to the `pagr` CLI the user has already installed
and otherwise only supplies knowledge.

## Why it is separate from `../claude-channel`

`integrations/claude-channel` is a Claude Code **channel**, which is an Anthropic research preview:
custom channels are not on the approved allowlist and need
`--dangerously-load-development-channels`. It cannot be listed anywhere and Pagr does not depend on
it.

This plugin is an ordinary Claude Code plugin. It has no research-preview dependency, needs no
flags, and — unlike a remote MCP connector — can be submitted to Anthropic's community marketplace
by an individual developer through a free Console account.

## Install (local, today)

```bash
/plugin marketplace add pagrdev/bridge
/plugin install pagr
```

Or point Claude Code at a local checkout while developing:

```bash
claude --plugin-dir integrations/claude-code-plugin
```

## Before submitting

```bash
claude plugin validate integrations/claude-code-plugin
```

Submission goes to `https://platform.claude.com/plugins/submit`. Requirements as of 2026-08-25:

- The repository must be **public** — closed-source plugins are not accepted.
- A Developer, Admin or Owner role on an Anthropic Console organisation. Individual authors who are
  not in a Team or Enterprise organisation can sign up for Console and submit there.
- Accepted submissions land in `anthropics/claude-plugins-community`. The official marketplace is
  curated separately and has no application process.
- Approved plugins are pinned to a commit SHA; CI bumps the pin as commits land, and the public
  catalog syncs nightly. Updates need no resubmission.
- "Anthropic Verified" cannot be applied for and must never be claimed.

See `platform/docs/DIRECTORY-SUBMISSIONS.md` for the full picture, including the connector
programme this plugin deliberately avoids depending on.
