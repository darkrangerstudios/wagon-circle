# Wagon Circle

> Circle the wagons: one room for you, Claude and Codex, with nothing exposed.

**Prototype 0.4.3.** Site: https://darkrangerstudios.github.io/wagon-circle/

One VS Code room where you, Claude and Codex talk in a single timeline.

**Question this prototype answers:** can one room carry a useful three-way conversation under safe relay rules (mention routing, a hop cap, fork-not-share threads)? The answer decides whether this becomes a real extension, and later a .dmg/.exe.

## How it works
- **Both agents are private child processes on stdio.** Codex runs as `codex app-server`, speaking newline-delimited JSON-RPC. Claude runs as `claude -p --input-format stream-json --output-format stream-json`. There is no daemon, no network port and no web server, and closing the room ends both processes.
- **Routing.** `@claude`, `@codex` and `@both` deliver immediately. A message with no mention goes to the lead agent you pick. An agent hands off by starting a line with `@other`, capped at `wagonCircle.hopCap` hand-offs (default 2) per message you send.
- **Catch-up delivery.** Each agent receives everything said since its last turn, labelled by speaker. It never gets its own words echoed back. Agent text is always labelled "relayed by Wagon Circle, not <you>"; only messages labelled with your name carry authority. Your name comes from `wagonCircle.userName`, else the first name in `git config user.name`.
- **Joining existing conversations** works on both sides, and each side is optional. A Codex thread is forked (`thread/fork`) and a Claude session is forked (`--resume <id> --fork-session`), so each agent keeps its own full memory and the originals are never written to. Each side's last 8 exchanges are read from disk, with no model call, and given to the *other* agent as labelled history: `thread/turns/list` for Codex, `~/.claude/projects/**/<session>.jsonl` for Claude, keeping only text you typed and text Claude said. Forking a Claude session sets the room's working folder to that session's folder, because `--resume` only finds sessions there.
- **Attachments.** Paste a screenshot, drag files in (hold Shift while dropping onto a VS Code panel), or use 📎. Files are copied into the room's own folder. Images reach Claude as image blocks and Codex as local image inputs. Text files (`.md`, code, JSON, CSV…) up to 200 KB are inlined; larger files and PDFs are passed as a path the agent opens with its read-only tools (Claude gets `--add-dir` for the attachment folder). An agent that missed a message gets its files in its next catch-up. Limits: 5 MB per image, 25 MB per file.
- **Reopening** resumes the room's own Codex fork and Claude session.
- **A lead you choose.** The Lead chip (or `/default`) picks who drives: Claude, Codex, or both taking turns. Untagged messages go to the lead, and a room notice tells both agents about the change. Each picker also has "Use these settings for new rooms", which saves that vendor's model and effort as your defaults.
- **Routing that doesn't run away.** An untagged message goes to the lead, never to "whoever spoke last". `@both` takes turns in mention order (`/both parallel` to answer at once). An agent wakes the other only with a line that starts with `@name`: "I agree with @codex", quotes, blockquotes and code don't count, and agents can't use `@both`. Each agent gets at most 2 replies per message from you, and hand-offs are capped (default 2). The agents are told these rules, so they don't speculate about routing.
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
- Claude runs with `--permission-mode dontAsk`, so only Read, Glob and Grep are allowed, and with no MCP servers (`--strict-mcp-config` with an empty config).
- A hard blocklist stops the room from ever calling `account/rateLimitResetCredit/consume`, logout/login or thread delete.
- The webview renders agent output with `textContent` only, under a strict CSP: nonce'd script, no network, no inline handlers.

## Try it
```
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$HOME/code/wagon-circle" --new-window
```
Then, from the Command Palette, run **Wagon Circle: New Room**, **Wagon Circle: Join Existing Conversations (fork)** or **Wagon Circle: Reopen a Room**. Logs appear in Output → Wagon Circle.

## Tests
- `npm test` runs every offline suite with fake agents and transports (58 tests: router, hand-off and turn limits, Stop and steer at the process boundary, delivery receipts, diff path containment, commands, diffs, IDE context, attachments, Codex activity replay, version guard).
- **Stop means stopped.** Stop cancels the whole run: queued steers are dropped, a Stop pressed before an agent's turn is live is held and delivered, and a reply that lands afterwards is shown but never starts more work.
- **Nothing goes missing.** A message counts as delivered to an agent only once that agent actually received it. A turn limit, a failed send or a steer the agent couldn't take keeps it queued for the agent's next turn.
- `node test/live-claude-fork.js <claudeSessionId>` forks a saved Claude session into a room with a recording stand-in for Codex. It makes one small Claude turn and no Codex turn.
- `node test/token-ab.js <scratchCwd>` compares a persistent session sending deltas against a fresh process with the full transcript every turn. Measured 2026-09-23 over 4 turns on Sonnet: 4,801 vs 19,102 fresh tokens, $0.036 vs $0.086. Cache lifetime matches normal sessions because these are the same CLIs: Claude Code writes Anthropic's 1-hour tier (logged as `ephemeral_1h`), and Codex on GPT-5.6-or-later models keeps prefixes 30 minutes after last use.
- `node test/live-three-way.js <repoCwd> <imagePath>` runs real Claude and real Codex in one room: `@both` turn-taking, an image to Codex, and Codex's token and cache usage.
- `node test/live-smoke.js <codexThreadId> <scratchCwd>` runs a real private Codex server and a real Claude session. It forks the given thread and makes one small Claude turn plus one Codex turn, so it spends a little quota.

## Customization
Today: `wagonCircle.userName`, `claudeModel`, `claudePath`, `codexPath`, `hopCap` and `cwd`. Planned: editable agent instructions and display names, per-agent tool levels, model per room, history depth, and single-agent rooms.

## Deliberately left out
- Live mirroring into the ChatGPT app or the Codex panel. That would need Codex's shared app-server daemon, which OpenAI's desktop app deliberately won't attach to locally.
- Write or shell tools for either agent.
- Markdown beyond code fences, and images.
- Packaging, Windows, and multiple rooms sharing one Codex process.
- Claude cannot be stopped mid-reply. Stop kills its process, and the next message resumes the session.
- Both agents load the project instructions in `cwd` (for example a large CLAUDE.md or AGENTS.md), which costs tokens on every turn.

## License
Copyright (c) 2026 Dean Buttry. All rights reserved. See [LICENSE](LICENSE).
