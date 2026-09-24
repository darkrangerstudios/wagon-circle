# Choose where the work happens

Each agent has its own working session. The room is where you ask questions, see results and coordinate help.

Select a new session or an existing local one from the agent's model panel. **Fork** creates a separate conversation and leaves the original untouched. **Continue** writes to the chosen session itself: Wagon Wheel warns you first because it cannot see whether another Claude Code or Codex window has that session open, so close it there before continuing. Claude can only continue sessions started in the room's folder.

**Local sessions only.** Cloud sessions are managed in each provider's own tools.

Session-history sharing is separate from selecting a working session. History starts private. Share an agent's working session from its model panel, or add any local session with `/history add`; the agents then retrieve relevant passages as reference, and old requests in it do not start new work. Changing an agent's session turns its sharing off until you share again.

Capabilities vary by provider and session. An unavailable control does not become available just by choosing Work mode.
