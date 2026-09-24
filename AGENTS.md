# AGENTS.md: working on Wagon Circle

This file is for AI coding agents (Codex, Claude Code, others) working in this repository. The README describes the product; this file covers how to change it safely.

## What this is
Wagon Circle is a VS Code extension: one chat room where a human, Claude and Codex talk in a single timeline. The extension starts both agents as **private child processes over stdio**: `codex app-server` (newline-delimited JSON-RPC) and `claude -p --input-format stream-json --output-format stream-json`. It routes messages between them. There is no daemon, no network listener and no web server. Plain JavaScript (CommonJS), no build step, no runtime dependencies.

## Map
| File | Owns |
|---|---|
| `src/room.js` | The router. Who hears what: mention parsing, catch-up deltas, `@both` turn-taking, typed tool calls (`_onTool`), request/answer delivery and task turn admission, Pause/Resume/time limit, runs and Stop, delivery receipts (`knownBy`), steering, history seeding. Untyped agents only: line-start `@name` hand-offs (`handoffs()`), hop cap and the 2-replies-per-agent limit. Pure logic, no I/O; the most heavily tested file. |
| `src/tasks.js` | The task ledger: host-owned tasks, typed requests (`request_assistance`) and results, admission (recipient, duplicates, no bouncing, allowances), `finish_task`, Pause/Stop/generations, limits and presets, and the tool specs both agents get. Pure logic, injected clock. |
| `src/scheduler.js` | The one host timer: fixed checks and adaptive polls (10 min, hourly after two quiet checks), no overlap, one catch-up after sleep, bounded `update()` for agent schedule changes. |
| `src/prompts.js` | The standing brief each agent gets (typed and untyped variants). |
| `src/codexClient.js` | Private `codex app-server` over stdio: threads, turns, fork, `turn/steer`, `model/list`, rate limits, activity mapping (`describeItem`), typed tools (`dynamicTools` on `thread/start`, answered from `item/tool/call`). Holds the forbidden-method blocklist. |
| `src/claudeClient.js` | Persistent `claude -p` stream-json session: streaming, thinking and tool activity, clean interrupt (control_request), steer (interrupt, then continue), model/effort/fast restarts on the same session, typed tools as an in-process `sdk` MCP server answered over the same stdio. |
| `src/claudeBinary.js` | Picks the newest Claude Code CLI on the machine. Old CLIs refuse new models. |
| `src/claudeHistory.js` | Reads saved Claude sessions (`~/.claude/projects/**.jsonl`) for forking and briefing. Read-only. |
| `src/attachments.js` | Stores files in the room folder; converts them to each agent's native input. |
| `src/commands.js` | Slash commands (grouped Room / Claude / Codex) and the Claude model catalogue. |
| `src/diffs.js` | Unified-diff parser and in-memory patch applier (never writes to disk). |
| `src/ideContext.js` | Formats the IDE snapshot (active file, selection, tabs, problems). |
| `src/paths.js` | Containment checks (symlink-aware) for agent-supplied diff paths and the IDE snapshot. |
| `src/extension.js` | VS Code glue: commands, webview panel and markup, per-room settings, IDE tracking, diff opener, agent briefs (`roomPrompt`). |
| `media/room.js`, `media/room.css` | The webview UI. |
| `docs/` | GitHub Pages marketing site. |

## Run and test
- `npm test` runs the fast unit suite: router, hand-offs, commands, diffs, IDE context, attachments, Codex activity replay, version guard. It must stay green, and every behaviour change adds a test. Reproduce a bug as a failing test before fixing it (see the runaway test in `test/room.test.js`).
- Live tests spend real quota; run them only when a change touches the process boundary:
  - `node test/live-three-way.js <repoCwd> <imagePath>` (Claude and Codex together)
  - `node test/live-claude-fork.js <claudeSessionId>`
  - `node test/token-ab.js <scratchCwd>`
  - `node test/live-smoke.js <codexThreadId> <scratchCwd>`
  - `node test/live-stop.js <scratchCwd>` (Stop and steer against both real CLIs; run after touching either client's lifecycle)
  - `node test/live-tasks.js <scratchCwd>` (typed request → answer → finish_task with both real CLIs; run after touching tools, tasks or prompts)
- UI: launch an Extension Development Host with `code --extensionDevelopmentPath="$PWD" --new-window`. Press Cmd+R in that window to reload after changes. `package.json` `version` and `EXPECT` in `media/room.js` must match (a test enforces this); bump both together.

## Guardrails (do not weaken without the repo owner's explicit OK)
- **No listeners.** Never add a TCP/WebSocket port or a local web server. Agents stay stdio children. A localhost port is reachable by every web page in the user's browser.
- **Read-only by default.** Codex runs with `sandbox: read-only` and `approvalPolicy: never`, and server-to-client approval requests are auto-declined (only `item/tool/call` for our own typed tools is answered). Claude runs with `--permission-mode dontAsk`, Read/Glob/Grep plus our own typed tools only, and `--strict-mcp-config` with no MCP server except the in-process `wagon` one the extension answers over stdio. Write or shell access is planned work, behind explicit per-agent levels and approvals routed to the human.
- **Typed tools are requests, not authority.** The host stamps sender, task and generation and decides admission; tool arguments cannot widen permissions, refill allowances or resume paused or stopped work. Never route typed agents by parsing their prose.
- **Forbidden methods** in `codexClient.js` (quota reset-credit spend, logout/login, thread delete) stay blocked.
- **Untrusted output.** The webview renders model output with `textContent` only, under a strict CSP. Never use `innerHTML` with agent or file content.
- **Fork by default.** Joining an existing Codex thread or Claude session forks it. The only way to write to an existing conversation is the human choosing Continue in the Working session picker, after a warning that Wagon Circle cannot see whether another window has it open. Never continue a session implicitly.
- **Relay labels.** Agent text is always delivered as "relayed by Wagon Circle, not <human>". Only the human's messages carry authority.

## Conventions
- Match the surrounding style: small functions, a comment only where the *why* isn't obvious, no new dependencies without a clear reason.
- This is a **public repo, all rights reserved**. Never commit personal data, other projects' names or paths, tokens, or machine-specific absolute paths. Scan the staged diff before pushing.
- Commits use the repo's configured author (a GitHub no-reply address). Don't change `git config user.email`.
- One lane per branch or worktree when two agents work at once. Don't edit a file another lane is actively changing; coordinate first. `src/room.js` changes need tests in the same commit.
