---
description: Diagnose why Pagr cannot reach this Mac, and explain the fix in plain language.
---

Run `pagr doctor` and interpret the result for the user.

`pagr doctor` checks the install, pairing, the local daemon, the gateway connection, and whether
Claude Code or Codex is signed in. Its output is already fairly readable, so your job is not to
repeat it — it is to say which single thing is wrong and what to do about it.

Read the printed checks, not the exit code: `pagr doctor` exits 0 on a machine that is merely not
set up yet, and only non-zero for a real fault. A `!` line is a step the user has not taken; a `✗`
line is something broken.

Work through it in this order, because each one makes the next meaningless:

1. **Not installed** — `npm i -g @pagr/cli`.
2. **Not paired** — `pagr connect`. Needs a browser and a human; do not attempt it.
3. **Daemon not running** — start it as `pagr doctor` instructs.
4. **Gateway unreachable** — usually the network or a proxy. Report what `doctor` said rather than
   guessing.
5. **No agent signed in** — sign in to Claude Code or Codex on this Mac. Pagr drives the agents
   already installed here, using the user's own subscriptions; it has none of its own.
6. **Project not registered** — `pagr project add . --name <name>`. Ask first.

If `pagr doctor` reports everything healthy but the user still cannot reach a session from their
phone or from an assistant, the likely causes are: the session belongs to a project on a different
Mac, the session has ended or gone stale (follow-ups only work for about a day), or their
subscription is inactive. Say which one fits the evidence, and do not speculate beyond it.

Never paste the contents of `.env` files, tokens or keys into the conversation, and do not read
them to diagnose this — nothing here needs them.
