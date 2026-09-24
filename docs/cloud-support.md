# Cloud support and the transcript gap

Verified against Codex CLI 0.153.1 and Claude Code 2.1.280 on 24 September 2026.
These are adapter modules under development, not a completed cloud room UI.

| Operation | Codex CLI adapter | Claude CLI adapter |
|---|---|---|
| List | Paginated task metadata | Unavailable |
| Start | `cloud exec`, one attempt, selected environment | Unattended creation not verified; unavailable |
| Read | Status snapshot; diff through a separate read | Transcript/status read unavailable |
| Follow-up | Unavailable | `-p --cloud ID --output-format json`, message on stdin |
| Cancel | Unavailable | Unavailable |
| Full chat sync | **Not available through the verified interface** | **Not available through the verified interface** |

The [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
documents paginated JSON listing. The installed CLI also exposes exec, status,
diff and apply. This adapter never invokes apply. A read-only authenticated
listing returned the documented `tasks`/`cursor` envelope with zero tasks. No
cloud task was created; nonempty results and submissions have synthetic tests
only. Task URLs parsed from submission output remain a live-verification gap.

The [Claude cloud guide](https://code.claude.com/docs/en/claude-code-on-the-web)
documents JSON follow-up receipts and repository upload/clone behavior. A
follow-up receipt confirms queue acceptance, not work completion. Its documented
teleport flow changes the local checkout and creates a separate local continuation;
it is not used as an automatic transcript sync operation. The current adapter
does not initiate repository uploads. The installed current CLI exposes `--cloud`,
but no cloud transcript export/list command was verified. Desktop remote control
and local background-agent logs do not establish cloud history access.

`cloudInbox.js` retains incoming events, cursor, provenance and acknowledgments in
one state object. The host must save that object atomically **before** displaying
it as durable or acknowledging delivery. It never runs an agent. Replay is
deduplicated within a binding generation; stopped/paused bindings retain evidence
without becoming dispatch candidates. Missing providers, malformed pages and
retention limits fail visibly without advancing the cursor. Parent task usage
and polling live in the shared scheduler, not in a second cloud budget.

Integration contract: use `capabilities()` to label unavailable actions;
`read({remoteId, environmentId, cursor, signal})` returns normalized events and
honest coverage. Feed results to `receiveCloudEvents`, save once, then publish.
Use `acknowledgeCloudEvent` only after the intended recipient accepts delivery.
Stop must invalidate the task generation and abort local I/O; it cannot promise
remote cancellation when the provider capability is absent. Never automatically
retry an uncertain create/follow-up or auto-merge a returned diff.

Full automatic chat synchronization remains a product requirement. Status-only
results must not be presented as meeting it. A supported provider transcript API
or CLI command is still needed before full cloud parity can pass acceptance.

## Local history reference access

`SessionHistory` keeps source bindings and sharing grants separate from the room
timeline. Imported bindings start private. Only a human settings handler calls
`configure`; an agent-facing read handler must stamp `requester` from its actual
connection, not accept a caller identity from model arguments. Pass the current
binding generation and policy revision; rebind/revoke invalidates pending reads.

`claudeHistoryReader` reads only a host-selected JSONL file inside the selected
history root. `codexHistoryReader` uses the existing app-server's paginated
`thread/turns/list`. These first readers expose **text-only** user/assistant
history and explicitly exclude reasoning, tool payloads and images. They preserve
source IDs/timestamps; dates unavailable from a provider remain unknown. Text is
retrieved in pages with a character allowance, not prepended to every task turn.
Oversized excerpts retain a continuation cursor; a changed underlying page
requires a restart rather than silently skipping text. Search is within each
retrieved page; a caller can continue to later pages. No claim of whole-history
semantic search is made.

The UI must display these pages as reference records and never submit their
text through `postFromHuman`. Native history can contain old instructions and
approvals; they are evidence, not current authority. Turning sharing off prevents
future reads, including a response currently in flight. It cannot remove content
already read by a peer. A new working-session binding starts private again.

Evidence: 81 offline tests pass on this support branch (58 existing, 14 cloud,
9 history). Real local subprocess argv/stdin and temporary JSONL/symlink tests
ran. No model call, cloud submission, original-session write or credential change
was part of these tests. Main room controls and shared task-scheduler integration
remain separate work; these modules alone do not establish end-to-end UI proof.
