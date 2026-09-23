---
description: Install the Pagr bridge, pair this Mac, register the current project, link a phone.
---

Walk the user through connecting this Mac to Pagr. Do the steps in order and stop at the first one
that fails — later steps depend on earlier ones.

Pagr is a separate paid product from Stagberry Labs. It is not affiliated with or endorsed by
Anthropic. You never create an account, complete a pairing, or enter payment details on the user's
behalf: each of those needs a human, and each has a page that asks for exactly one thing.

**1. Is the CLI installed?**

Run `pagr --version`. If the command is not found, tell the user to run:

```
npm i -g @pagr/cli
```

Do not run the global install yourself — it writes outside the project and the user should choose
whether to allow it.

**2. Is this Mac paired?**

Run `pagr status`. It reports pairing, daemon, gateway, agent, project and account state.

- If it says the Mac is not paired, tell the user to run `pagr connect`. It opens a browser page
  where they confirm the device name and key fingerprint. **If they have no Pagr account yet, that
  page offers "Create an account" — a phone number and a code — and returns to the pairing by
  itself.** It needs a human; do not try to complete it.
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

**4. Is a phone linked?**

Run `pagr status --json` and read `phoneLinked`.

- `true` — nothing to do.
- `false` — a phone is what makes Pagr worth having: it is how an agent asks you a question and
  how you answer. Relay the number from `productNumber` in the same output:

  > Text **Hi Pagr** to `<productNumber>` from the phone number on your Pagr account. Any text
  > from that number links it — you will get a welcome message back.

  `pagr connect` also prints a QR code of that text on its last step, which is the easier path
  if they are about to run it anyway.

  If `productNumber` is `null`, tell them texting isn't set up on this Pagr deployment yet: there
  is no number to text, so there is no way to link a phone. Do not send them to the dashboard or
  suggest Pagr will text them — Pagr never sends the first message (iMessage providers forbid it);
  the person always texts Pagr first.
- `null` — the state could not be read (`accountUnknown` says why). Report the reason; do not
  guess that it is unlinked.

**5. Is there a trial or subscription?**

Read `entitled` from the same output.

- `true` — nothing to do.
- `false` — agents refuse to run without one. Tell the user to open `/welcome` on their Pagr
  deployment and start the trial there. Payment happens in a browser and nowhere else; never ask
  for card details in this conversation.
- `null` — as above: report the reason rather than a guess.

**6. Report back.**

Summarise in four lines: whether the Mac is paired, whether a coding agent is signed in, whether
Pagr can reach this project, and whether a phone is linked. Mention the trial if it is not active.
If anything is still outstanding, say exactly which command or URL fixes it. If everything is
done, tell them they can now reach this project from their phone, or from any assistant they have
connected Pagr to.
