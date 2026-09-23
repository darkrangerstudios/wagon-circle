# Campfire (prototype 0.1.0)

One VS Code room where Dean, Claude and Codex talk in a single timeline.

**Question this prototype answers:** can one room carry a useful three-way conversation under safe relay rules (mention routing, a hop cap, fork-not-share threads)? The answer decides whether this becomes a real extension, and later a .dmg/.exe.

## How it works
- **Both agents are private child processes on stdio.** Codex runs as `codex app-server`, speaking newline-delimited JSON-RPC. Claude runs as `claude -p --input-format stream-json --output-format stream-json`. There is no daemon, no network port and no web server, and closing the room ends both processes.
- **Routing.** `@claude`, `@codex` and `@both` deliver immediately. A message with no mention goes to whoever you addressed last (both, at the start). An agent that writes `@other` hands off, capped at `campfire.hopCap` hand-offs (default 4) per Dean message.
- **Catch-up delivery.** Each agent receives everything said since its last turn, labelled by speaker. It never gets its own words echoed back. Agent text is always labelled "relayed by Campfire, not Dean"; only `[Dean]` carries authority.
- **Joining a Codex thread** forks it (`thread/fork`); the original is never written to. The last 8 turns are read locally with `thread/turns/list`, which makes no model call, and seeded to Claude as history.
- **Reopening** resumes the room's own Codex fork and Claude session.

## Safety defaults
- Codex runs with sandbox `read-only` and approvals `never`. Any approval or input request from the server is declined automatically.
- Claude runs with `--permission-mode dontAsk`, so only Read, Glob and Grep are allowed, and with no MCP servers (`--strict-mcp-config` with an empty config).
- A hard blocklist stops the room from ever calling `account/rateLimitResetCredit/consume`, logout/login or thread delete.
- The webview renders agent output with `textContent` only, under a strict CSP: nonce'd script, no network, no inline handlers.

## Try it
```
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$HOME/code/campfire" --new-window
```
Then, from the Command Palette, run **Campfire: New Room**, **Campfire: Join a Codex Thread (fork)** or **Campfire: Reopen a Room**. Logs appear in Output → Campfire.

## Tests
- `npm test` runs the router unit tests with fake agents (9 tests).
- `node test/live-smoke.js <codexThreadId> <scratchCwd>` runs a real private Codex server and a real Claude session. It forks the given thread and makes one small Claude turn plus one Codex turn, so it spends a little quota.

## Deliberately left out
- Live mirroring into the ChatGPT app or the Codex panel, which would need the shared daemon; see `_pipeline/CODEX_DAEMON_RELAY_HANDOFF.md` in Ranger Gems.
- Write or shell tools for either agent.
- Markdown beyond code fences, and images.
- Packaging, Windows, and multiple rooms sharing one Codex process.
- Claude cannot be stopped mid-reply. Stop kills its process, and the next message resumes the session.
- Both agents load the project instructions in `cwd` (for Ranger Gems, the large CLAUDE.md and AGENTS.md), which costs tokens on every turn.
