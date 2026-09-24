# Wagon Circle

> Circle the wagons: one room for you, Claude and Codex, with nothing exposed.

**Prototype 0.5.0.** Site: https://darkrangerstudios.github.io/wagon-circle/

One VS Code room where you, Claude and Codex talk in a single timeline.

**Question this prototype answers:** can one room carry a useful three-way conversation under safe relay rules (mention routing, a hop cap, fork-not-share threads)? The answer decides whether this becomes a real extension, and later a .dmg/.exe.

## How it works
- **Both agents are private child processes on stdio.** Codex runs as `codex app-server`, speaking newline-delimited JSON-RPC. Claude runs as `claude -p --input-format stream-json --output-format stream-json`. There is no daemon, no network port and no web server, and closing the room ends both processes.
- **Routing.** `@claude`, `@codex` and `@both` deliver immediately. A message with no mention goes to the lead agent you pick.
- **Agents ask each other with a typed request, not an @mention.** Each agent has a `request_assistance` tool. Claude gets it from an in-process MCP server that Wagon Circle answers over Claude's own stdio; Codex gets it as a dynamic tool on threads the room starts. Wagon Circle records the request, delivers it once and returns the answer to the asker automatically, so there are no "thanks / acknowledged" turns and no need for you to type "continue". Text in a reply is never routing: an agent that has no tool (an older or forked Codex thread) can only *suggest* a hand-off, which you send with one click.
- **Tasks with allowances.** The first request starts a task tied to your message, shown as a card with its turns and minutes used, open requests, and Pause, Resume and Stop. **Task controls** set the mode (Auto: a task starts when an agent asks for help; Chat: one consultation per message; Work: every message is a task), presets (Economy, Balanced, Thorough) and the allowances. **Apply to this task** changes only that task; **Save as my defaults** is separate. Accepted requests reserve their answer turn; the last turns are kept for wrapping up; at the time limit running work is stopped. The lead's `finish_task` is accepted only when nothing is open. An agent answering a request cannot bounce it back to the asker. Controls never change the model, fast mode or permissions.
- **Local session history as context.** `/history add` picks any Claude Code session or Codex thread on this machine as read-only reference; each model panel can also share that agent's working session with the other. Agents pull passages with the `read_session_history` tool, labelled with their source; old requests or approvals in history are evidence, never instructions. Sharing is off until you turn it on, can be removed, and a new working session starts private. **Local sessions only: cloud sessions are managed in each provider's own tools.**
- **Working session per agent.** Each model panel offers New, Continue… and Fork…. Fork leaves the original untouched. Continue writes to the chosen session itself, after a warning, because Wagon Circle cannot see whether another window has it open. Switching keeps the room's tasks and allowances and does not replay the room into the new session.
- **Catch-up delivery.** Each agent receives everything said since its last turn, labelled by speaker. It never gets its own words echoed back. Agent text is always labelled "relayed by Wagon Circle, not <you>"; only messages labelled with your name carry authority. Your name comes from `wagonCircle.userName`, else the first name in `git config user.name`.
- **Joining existing conversations** works on both sides, and each side is optional. A Codex thread is forked (`thread/fork`) and a Claude session is forked (`--resume <id> --fork-session`), so each agent keeps its own full memory and the originals are never written to. Each side's last 8 exchanges are read from disk, with no model call, and given to the *other* agent as labelled history: `thread/turns/list` for Codex, `~/.claude/projects/**/<session>.jsonl` for Claude, keeping only text you typed and text Claude said. Forking a Claude session sets the room's working folder to that session's folder, because `--resume` only finds sessions there.
- **Attachments.** Paste a screenshot, drag files in (hold Shift while dropping onto a VS Code panel), or use 📎. Files are copied into the room's own folder. Images reach Claude as image blocks and Codex as local image inputs. Text files (`.md`, code, JSON, CSV…) up to 200 KB are inlined; larger files and PDFs are passed as a path the agent opens with its read-only tools (Claude gets `--add-dir` for the attachment folder). An agent that missed a message gets its files in its next catch-up. Limits: 5 MB per image, 25 MB per file.
- **Reopening** resumes the room's own Codex fork and Claude session.
- **A lead you choose.** The Lead chip (or `/default`) picks who drives: Claude, Codex, or both taking turns. Untagged messages go to the lead, and a room notice tells both agents about the change. Each picker also has "Use these settings for new rooms", which saves that vendor's model and effort as your defaults.
- **Routing that doesn't run away.** An untagged message goes to the lead, never to "whoever spoke last". `@both` takes turns in mention order (`/both parallel` to answer at once). Agent-to-agent work is bounded by the task's turn and time allowance; outside a task, each agent gets at most 2 replies per message from you. The agents are told these rules, so they don't speculate about routing.
- **Model, effort and fast mode per vendor.** Composer chips open pickers with the models this machine can actually run. Claude: Opus 5.5, Sonnet 5, Fable 5.1, Haiku 4.5, gated by the Claude Code version; changes restart Claude on the same session, so it keeps its memory. Codex: the live `model/list`, with each model's own effort levels. Fast mode: Claude's Opus fast mode (`--settings {"fastMode":true}`, billed to usage credits) and Codex's priority tier. The same controls are slash commands, grouped by platform, with autocomplete (`/` and `@`).
- **Plan usage for both vendors.** The header shows Codex's rate-limit windows and Claude's session, week and per-model limits, read from Claude Code's headless `/usage` (no model call, free). A model whose own weekly limit is used up, such as Fable, stays listed but greyed out with its reset time.
- **Newest Claude CLI automatically.** Wagon Circle uses the newest Claude Code it finds, including the one bundled with the VS Code Claude extension, because older CLIs refuse newer models.
- **IDE context.** Your active file, selection (or visible lines), open tabs and Problems ride along with each message. The 📍 chip shows what will be sent; click it to turn it off.
- **Diffs.** Unified diffs in replies, and Codex's per-turn diff, render as file cards with +/− counts. **Open in diff editor** applies the patch in memory and shows it in VS Code's diff view; nothing is written to disk.
- **Steer.** While an agent is working, the send button becomes ↪: Enter steers it mid-turn (Cmd/Ctrl+Enter queues the message instead). Codex uses its native `turn/steer`, so your input joins the running turn. Claude is interrupted cleanly over stream-json and continued with your instruction as the same reply; plain mid-turn injection exists too, but Sonnet 5 ignored it in testing. A steer goes to the busy agents it @mentions, or all busy agents; the other agent sees it later, labelled as a mid-turn message.
- **Clean Stop.** Stop sends Claude a proper interrupt (the session and process stay alive) and interrupts Codex's turn; the room shows "Claude stopped." rather than an error.
- **Version guard.** If the extension code and the page files come from different versions (the window wasn't reloaded after an update), the room says so instead of rendering a broken layout.
- **Live status.** Each agent shows what it is doing right now, with a timer: waiting, thinking (with its thinking text, collapsible), each tool step such as "reading room.js" or "running rg …", then writing. Finished replies keep a collapsed list of their steps.

## Safety defaults
- Codex runs with sandbox `read-only` and approvals `never`. Any approval or input request from the server is declined automatically.
- Claude runs with `--permission-mode dontAsk`, so only Read, Glob, Grep and the room's own typed tools are allowed. `--strict-mcp-config` allows no MCP server except the in-process `wagon` one that the extension answers over stdio (no extra process, no port).
- Typed tools are requests, not authority: Wagon Circle stamps who asked, under which task and generation, and decides admission. A tool call cannot widen permissions, refill an allowance or resume paused or stopped work.
- A hard blocklist stops the room from ever calling `account/rateLimitResetCredit/consume`, logout/login or thread delete.
- The webview renders agent output with `textContent` only, under a strict CSP: nonce'd script, no network, no inline handlers.

## Try it
```
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$HOME/code/wagon-circle" --new-window
```
Then, from the Command Palette, run **Wagon Circle: New Room**, **Wagon Circle: Join Existing Conversations (fork)** or **Wagon Circle: Reopen a Room**. Logs appear in Output → Wagon Circle.

## Tests
- `npm test` runs every offline suite with fake agents and transports (router, typed requests and tasks, allowances and Pause/Stop races, the host scheduler on a fake clock, typed tools at both process boundaries, shared history access, setup checks, Stop and steer, delivery receipts, diff path containment, commands, diffs, IDE context, attachments, Codex activity replay, version guard).
- `node test/live-tasks.js <scratchCwd>` runs real Claude and real Codex with their typed tools on a small fixture: one request, one answer returned automatically, `finish_task`, no acknowledgment turns.
- **Stop means stopped.** Stop cancels the whole run: queued steers are dropped, a Stop pressed before an agent's turn is live is held and delivered, and a reply that lands afterwards is shown but never starts more work.
- **Nothing goes missing.** A message counts as delivered to an agent only once that agent actually received it. A turn limit, a failed send or a steer the agent couldn't take keeps it queued for the agent's next turn.
- `node test/live-claude-fork.js <claudeSessionId>` forks a saved Claude session into a room with a recording stand-in for Codex. It makes one small Claude turn and no Codex turn.
- `node test/token-ab.js <scratchCwd>` compares a persistent session sending deltas against a fresh process with the full transcript every turn. Measured 2026-09-23 over 4 turns on Sonnet: 4,801 vs 19,102 fresh tokens, $0.036 vs $0.086. Cache lifetime matches normal sessions because these are the same CLIs: Claude Code writes Anthropic's 1-hour tier (logged as `ephemeral_1h`), and Codex on GPT-5.6-or-later models keeps prefixes 30 minutes after last use.
- `node test/live-three-way.js <repoCwd> <imagePath>` runs real Claude and real Codex in one room: `@both` turn-taking, an image to Codex, and Codex's token and cache usage.
- `node test/live-smoke.js <codexThreadId> <scratchCwd>` runs a real private Codex server and a real Claude session. It forks the given thread and makes one small Claude turn plus one Codex turn, so it spends a little quota.

## Customization
Today: `wagonCircle.userName`, `claudeModel`, `claudePath`, `codexPath`, `hopCap` and `cwd`. Planned: editable agent instructions and display names, per-agent tool levels, model per room, history depth, and single-agent rooms.

## Deliberately left out
- Cloud sessions. Wagon Circle works with local sessions only; manage cloud sessions in each provider's own tools.
- Live mirroring into the ChatGPT app or the Codex panel. That would need Codex's shared app-server daemon, which OpenAI's desktop app deliberately won't attach to locally.
- Write or shell tools for either agent.
- Markdown beyond code fences, and images.
- Packaging, Windows, and multiple rooms sharing one Codex process.
- Both agents load the project instructions in `cwd` (for example a large CLAUDE.md or AGENTS.md), which costs tokens on every turn.

## License
Copyright (c) 2026 Dean Buttry. All rights reserved. See [LICENSE](LICENSE).
