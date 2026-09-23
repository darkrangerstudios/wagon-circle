# Wagon Circle

> Circle the wagons: one room for you, Claude and Codex, with nothing exposed.

**Prototype 0.2.0.** Site: https://darkrangerstudios.github.io/wagon-circle/

One VS Code room where you, Claude and Codex talk in a single timeline.

**Question this prototype answers:** can one room carry a useful three-way conversation under safe relay rules (mention routing, a hop cap, fork-not-share threads)? The answer decides whether this becomes a real extension, and later a .dmg/.exe.

## How it works
- **Both agents are private child processes on stdio.** Codex runs as `codex app-server`, speaking newline-delimited JSON-RPC. Claude runs as `claude -p --input-format stream-json --output-format stream-json`. There is no daemon, no network port and no web server, and closing the room ends both processes.
- **Routing.** `@claude`, `@codex` and `@both` deliver immediately. A message with no mention goes to whoever you addressed last (both, at the start). An agent that writes `@other` hands off, capped at `wagonCircle.hopCap` hand-offs (default 4) per message you send.
- **Catch-up delivery.** Each agent receives everything said since its last turn, labelled by speaker. It never gets its own words echoed back. Agent text is always labelled "relayed by Wagon Circle, not <you>"; only messages labelled with your name carry authority. Your name comes from `wagonCircle.userName`, else the first name in `git config user.name`.
- **Joining existing conversations** works on both sides, and each side is optional. A Codex thread is forked (`thread/fork`) and a Claude session is forked (`--resume <id> --fork-session`), so each agent keeps its own full memory and the originals are never written to. Each side's last 8 exchanges are read from disk, with no model call, and given to the *other* agent as labelled history: `thread/turns/list` for Codex, `~/.claude/projects/**/<session>.jsonl` for Claude, keeping only text you typed and text Claude said. Forking a Claude session sets the room's working folder to that session's folder, because `--resume` only finds sessions there.
- **Reopening** resumes the room's own Codex fork and Claude session.
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
- `npm test` runs the router unit tests with fake agents (13 router tests + 2 Codex activity replay tests).
- `node test/live-claude-fork.js <claudeSessionId>` forks a saved Claude session into a room with a recording stand-in for Codex. It makes one small Claude turn and no Codex turn.
- `node test/token-ab.js <scratchCwd>` compares a persistent session sending deltas against a fresh process with the full transcript every turn. Measured 2026-09-23 over 4 turns on Sonnet: 4,801 vs 19,102 fresh tokens, $0.036 vs $0.086. Cache lifetime matches normal sessions because these are the same CLIs: Claude Code writes Anthropic's 1-hour tier (logged as `ephemeral_1h`), and Codex on GPT-5.6-or-later models keeps prefixes 30 minutes after last use.
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
