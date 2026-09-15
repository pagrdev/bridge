---
description: Install the Pagr bridge, pair this Mac, and register the current project.
---

Walk the user through connecting this Mac to Pagr. Do the steps in order and stop at the first one
that fails — later steps depend on earlier ones.

Pagr is a separate paid product from Stagberry Labs. It is not affiliated with or endorsed by
Anthropic. If the user does not have an account, point them at your Pagr deployment's sign-up page and stop; do not
attempt to create one.

**1. Is the CLI installed?**

Run `pagr --version`. If the command is not found, tell the user to run:

```
npm i -g @pagr/cli
```

Do not run the global install yourself — it writes outside the project and the user should choose
whether to allow it.

**2. Is this Mac paired?**

Run `pagr status`. It reports pairing, daemon, gateway, agent and project state.

- If it says the Mac is not paired, tell the user to run `pagr connect`. That command opens a
  browser page where they confirm the device name and key fingerprint. It needs a human — do not
  try to complete it for them.
- If it says the daemon is not running, run `pagr doctor` and follow what it prints.

**3. Can Pagr reach this project?**

Pagr reaches folders that have been named on this Mac. Check the project list in the `pagr status`
output. If the current repository is missing, offer to add it:

```
pagr project add . --name <a short name the user will recognise>
```

Use `pagr project use .` instead when the user does not care what it is called, or when this
folder is not a git repository — it registers it on the spot and returns its id.

Ask before running either — it grants Pagr access to this directory. Suggest a name based on the
repository, and confirm it with the user.

**4. Report back.**

Summarise in three lines: whether the Mac is paired, whether a coding agent is signed in, and
whether Pagr can reach this project. If anything is still outstanding, say exactly which command
fixes it. If everything is done, tell them they can now reach this project from their phone, or
from any assistant they have connected Pagr to.
