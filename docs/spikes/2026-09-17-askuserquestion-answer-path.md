# Spike MOB-044: answering `AskUserQuestion` in a bridge-spawned `claude -p` session

Date: 2026-09-17. Claude Code 2.1.220 (`/Users/waleed/.local/bin/claude`). Research only; no product code changed.

Every run below used the bridge's exact argv from `packages/adapter-claude/src/claude-process.ts`, a fresh
`--session-id` (uuid), cwd `/tmp/spike-ask` (empty `git init`), and the same single user line. Seven runs,
one to two API calls each, all on the subscription (client-side estimate ~$0.31-0.49 per run, dominated by
the ~54k-token startup context this user's `~/.claude` loads). Raw logs: `/tmp/spike-ask/exp*.log`.

| Run | What was written after the `control_request` | Outcome |
|---|---|---|
| 1 observe | nothing (SIGTERM after 16s) | process idles until answered; SIGTERM -> `control_cancel_request`, rejected tool_result, `result` `is_error:true` `terminal_reason:"aborted_tools"`, exit 143 |
| 2 Path A | `allow` with the **original** input | tool resolves instantly: `"The user did not answer the questions."`, `answers:{}`; turn ends |
| 3 Path B (header key) | `allow`, `updatedInput.answers = {"<header>": "Option A"}` | **fails**: same `"The user did not answer the questions."` (answers echoed but not recognised) |
| 4 Path B (question key) | `allow`, `updatedInput.answers = {"<question text>": "Option A"}` | **works**: `"Your questions have been answered: ..."`, assistant: "You chose **Option A**." |
| 5 Path C (`response`) | `allow`, `updatedInput = {questions, answers:{}, response:"A please, and stop after that"}` | **works**: `"The user responded: A please, and stop after that"`, assistant: "Got it — option A noted." |
| 6 Path A + tool_result line | `allow` (original input) then immediately a `user` line with a `tool_result` block | `allow` resolves as run 2; the extra `tool_result` line is **silently ignored** (no stderr, no error event, no second `result`) |
| 0 (first attempt) | n/a | `API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is required` — see Risks |

## Findings

### 1. The question arrives as a `can_use_tool` control request, and the process blocks on it

Run 1, verbatim stdout (long fields elided), immediately after the `tool_use` assistant line:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_013Xzr69c4RL5NU4ovs5he1m","name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer option A or option B?","header":"Preference","options":[{"label":"Option A","description":"Choose option A"},{"label":"Option B","description":"Choose option B"}],"multiSelect":false}]},"caller":{"type":"direct"}}]},"parent_tool_use_id":null,"session_id":"49e5660b-…"}
{"type":"control_request","request_id":"fe120d30-4aea-4b9b-8072-16a8efd72c88","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer option A or option B?","header":"Preference","options":[{"label":"Option A","description":"Choose option A"},{"label":"Option B","description":"Choose option B"}],"multiSelect":false}]},"tool_use_id":"toolu_013Xzr69c4RL5NU4ovs5he1m","requires_user_interaction":true}}
```

- Order: `assistant`/`tool_use` line first, `control_request` ~40 ms later. Both carry the same `tool_use_id`.
- The `control_request` has a field the bridge's parser does not surface today: `"requires_user_interaction": true`. It is the signal that this prompt needs a person, not a yes/no. (`tool_name === "AskUserQuestion"` is sufficient and is what the docs say to key on.)
- Input shape is exactly `questions[{question, header, multiSelect, options[{label, description}]}]`. In one run the model also put a
  `preview` string inside an option (seen in a real transcript, not in the spike); treat it as optional.
- After the `control_request` the process wrote nothing for the 6-16 s it was left unanswered. It is blocked; nothing else happens
  in the session until a `control_response` arrives (no timeout observed).
- Unanswered at SIGTERM: `{"type":"control_cancel_request","request_id":"fe120d30-…"}`, then a `user` line whose `tool_result` is
  `"The user doesn't want to proceed with this tool use. …"` with `is_error:true`, then a `result` with `is_error:true`,
  `terminal_reason:"aborted_tools"`, `permission_denials:[{tool_name:"AskUserQuestion",…}]`, exit code 143.

### 2. Path A (allow with the original input, then send a `tool_result` line) — does not work

Written (run 2):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"5ff928c0-…","response":{"behavior":"allow","updatedInput":{"questions":[…unchanged…]}}}}
```
Received ~90 ms later:
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"The user did not answer the questions.","tool_use_id":"toolu_013kJfAbuoXUyUtE5mtZufS9"}]},"tool_use_result":{"questions":[…],"answers":{}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"No answer was given — let me know if you'd like to try again or provide your preference directly."}]}}
{"type":"result","subtype":"success","is_error":false,"num_turns":2,…}
```

The AskUserQuestion "tool" executes on the spot with whatever `updatedInput` carries; with no `answers` it reports "did not
answer" and the turn ends. There is no window in which a `tool_result` from stdin could be paired with the tool use.

Run 6 confirmed what a `tool_result` user line does if the bridge ever writes one:
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01TgoSs2uvue4yeTLmdTiB2G","content":"A"}]}}
```
Nothing. No stderr, no error event, no extra turn, process idle for 20 s then exited 0 on stdin close. A `tool_result` block on
`--input-format stream-json` is not an input the CLI acts on. **Path A is dead; do not implement it.**

### 3. Path B (answer in `updatedInput.answers`) — works, but only keyed by the `question` text

Keyed by `header` (run 3) fails with `"The user did not answer the questions."` even though the CLI echoes the answers back in
`tool_use_result.answers` unchanged. Keyed by the full `question` string (run 4) works:

Written:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"17bf07ea-a1e0-440a-bec4-e62e1ef39660","response":{"behavior":"allow","updatedInput":{"questions":[{"question":"Do you prefer option A or option B?","header":"A or B?","options":[{"label":"Option A","description":"Choose option A"},{"label":"Option B","description":"Choose option B"}],"multiSelect":false}],"answers":{"Do you prefer option A or option B?":"Option A"}}}}}
```
Received:
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Your questions have been answered: \"Do you prefer option A or option B?\"=\"Option A\". You can now continue with these answers in mind.","tool_use_id":"toolu_011YPrBF8YjzfhJZXE2ohPZv"}]},"tool_use_result":{"questions":[…],"answers":{"Do you prefer option A or option B?":"Option A"}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You chose **Option A**."}]}}
{"type":"result","subtype":"success","is_error":false,…}
```

This is the same encoding a real interactive session writes (finding 5) and the one the Agent SDK docs specify
(https://code.claude.com/docs/en/agent-sdk/user-input, "Return answers to Claude": key = `question` field, value = selected
option's `label`; `questions` must be passed through; multi-select = array of labels or `", "`-joined string).

### 4. Path C (freeform `response`) — works; the right fit for a typed iMessage reply

Written (run 5):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"ea8fda66-…","response":{"behavior":"allow","updatedInput":{"questions":[…],"answers":{},"response":"A please, and stop after that"}}}}
```
Received:
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"The user responded: A please, and stop after that","tool_use_id":"toolu_01SkjuZ4FFTPEDJD53fcL93Q"}]},"tool_use_result":{"questions":[…],"answers":{},"response":"A please, and stop after that"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Got it — option A noted."}]}}
```
Docs: `response` is "optional freeform reply the user typed instead of answering the structured questions"; when set, Claude
receives `The user responded: …` instead of the per-question list. Whether `answers` and `response` can be combined
meaningfully: **could not verify** (not tried; docs imply `response` wins).

The other "Path C" idea — that `--permission-prompt-tool stdio` might deliver the question as some other prompt type — is moot:
it is delivered as an ordinary `can_use_tool` request (finding 1) and the answer rides on that request's `control_response`.
There is no separate documented headless mechanism; the CLI reference and headless page only add that
`--permission-prompts none` (v2.1.259+) removes the tool entirely and that `dontAsk` mode denies it.

### 5. What a real interactive session records (read-only, `~/.claude/projects/-Users-waleed-Desktop-Safar/f044588e-….jsonl`)

Answered question (interactive TUI, not the bridge):
```json
"content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"Your questions have been answered: \"Trigger the Xcode Command Line Tools install dialog now?\"=\"Yes, trigger install\". You can now continue with these answers in mind."}]
"toolUseResult":{"questions":[…],"answers":{"Trigger the Xcode Command Line Tools install dialog now?":"Yes, trigger install"}}
```
Same encoding as run 4: `answers` keyed by `question` text, value is the option `label`. The same transcript also holds a
failure mode worth knowing: `"Tool permission request failed: Error: Tool permission stream closed before response received"`
— what Claude sees when the permission channel (for the bridge: stdin) closes while a question is pending.

## Decision for MOB-036

Implement **Path B, with Path C as the free-text variant**. One `control_response` line answers the question; nothing else is
written to stdin.

Exact line to write (built by `controlResponseLine(requestId, decision)` in `stream-json.ts`, which already produces this
envelope — only `updatedInput` changes):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<control_request.request_id>","response":{"behavior":"allow","updatedInput":{"questions":<control_request.request.input.questions, verbatim>,"answers":{"<questions[i].question>":"<chosen options[j].label>"}}}}}
```

Rules:
- `updatedInput.questions` must be the original array, passed through unchanged.
- `answers` keys are the full `question` strings, never `header`. Values are the option `label` string; for `multiSelect:true`
  use an array of labels or `", "`-joined (docs; **could not verify** multi-select in the spike).
- Free text (user typed something that is not one of the options): `{"questions":…,"answers":{},"response":"<their text>"}`.
  Alternatively put the text as `answers[question]` (docs' "Other" pattern; **could not verify**).
- The reply must go on the **same** `control_request.request_id`; there is no later opportunity.
- Deny stays `{"behavior":"deny","message":"…"}` and is the right answer for a timeout or cancel; Claude then ends the turn.

Bridge changes this implies (no code in this spike):
1. `stream-json.ts` `parseStreamLine`: nothing structural; optionally surface `request.requires_user_interaction` on
   `permission_request` so the adapter can distinguish without hard-coding the tool name.
2. `adapter.ts` `onPermissionRequest` (line ~672): branch on `ev.toolName === 'AskUserQuestion'` and emit a new event
   (e.g. `question_asked` with `questions[]`, `approvalId`, `providerRequestId`, `expiresAt`) instead of `approval_requested`.
   Today it falls into the generic path: `previewForTool` prints `AskUserQuestion questions=[{"question":"Do you…` (60-char
   clip) and an "allow" tap sends `updatedInput: p.input` (line 373-377), which is Path A = "The user did not answer the
   questions." The session then ends its turn and the person never sees the question.
3. `adapter.ts` `resolveApproval` (line ~360): accept an answers payload (`{ answers: Record<string,string|string[]> } |
   { response: string }`) and pass `updatedInput: { questions: p.input.questions, answers }` to `answerPermission`.
   `ClaudeProcess.answerPermission` needs no change (`updatedInput: Record<string, unknown>` already fits).
4. `fake-claude.mjs`: add an "ask" trigger that emits the `control_request` above with `requires_user_interaction:true` and
   answers `"Your questions have been answered: …"` only when `answers` is keyed by `question` text, `"The user did not answer
   the questions."` otherwise, `"The user responded: …"` when `response` is set. That encodes runs 2-5 as a regression test.
5. Timeout: the existing 600 s approval timer sends `deny`. For a question that is the wrong default — the docs' recommended
   long-wait pattern is a `PreToolUse` hook returning `defer` so the process can exit and be `--resume`d later; out of scope
   here but the reason not to reuse the approval timeout blindly.

## Risks

1. **The bridge's default model breaks 2.1.220 for this user.** `~/.claude/settings.json` pins `"model": "claude-fable-5-1[1m]"`
   and the bridge loads `--setting-sources user,…` with no `--model`. Every bridge-spawned session on this machine returns
   `API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is required` as a `result` with
   `is_error:true`, `api_error_status:400`, exit 1 (run 0). The spike passed `--model sonnet` to get past it. Either upgrade the
   pinned/verified Claude Code version (the flag audit in `claude-process.ts` is against 2.1.220) or surface this error class to
   the phone; it will look like "Claude is broken" otherwise.
2. **Answer key is the free-text question string.** The phone must send back the exact `question` text (or an index the Mac
   resolves against the retained `p.input.questions`). Resolving on the Mac from an index is safer than round-tripping a
   possibly-truncated string. Header-keyed answers fail silently (run 3: no error, just "did not answer").
3. **Every "allow" without `answers` ends the turn.** Reusing the approval card for a question is not a degraded experience,
   it is a wrong answer delivered instantly (run 2). MOB-036 must ship the question path before AskUserQuestion is reachable
   from Pagr, or deny it with a clear message meanwhile.
4. **Blocked process while waiting.** The child idles on the `control_request` indefinitely. Closing stdin (bridge restart,
   `end()`) produces `Tool permission stream closed before response received` in the transcript; SIGTERM leaves the prompt
   unanswered and the turn unfinished (exit 143). Resume of such a session was **not verified**.
5. **`updatedInput` is trusted verbatim.** Anything the bridge puts in `answers`/`response` is fed to the model as the user's
   words. Validate labels against the retained `questions` and length-cap `response`.
6. **Not verified in this spike:** multi-select answer encoding, `preview` on options, combining `answers` with `response`,
   `--resume` of a session killed mid-question, subagent questions (docs: AskUserQuestion is unavailable inside subagents).
7. **Cost/noise of the user's own config.** Each run loaded ~54k tokens of hooks/skills from `~/.claude` and one of this user's
   Stop hooks errors (`"stop-hook-error"` notification) on every turn. Unrelated to the answer path, but it is what the bridge's
   `user,local` setting sources buy, and it is the bulk of the per-run cost.
