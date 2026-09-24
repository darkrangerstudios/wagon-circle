'use strict';
// Slash commands the room understands, grouped by platform. The room runs them itself on each agent's
// real controls; the CLIs' interactive slash commands don't exist in headless mode.

// Picker catalogue. minCli: the Claude Code version that can run it. fast: supports fast mode.
const CLAUDE_CATALOG = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', minCli: '2.1.280', fast: true, note: 'Most capable' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', minCli: '2.1.0', note: 'Fast and capable' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', minCli: '2.1.251', note: 'Has its own weekly limit' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', minCli: '2.1.0', note: 'Quickest, cheapest' }
];
const CLAUDE_MODELS = [...CLAUDE_CATALOG.map((m) => m.id), 'sonnet', 'opus', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'];

// ctx: { codexModels: [{id, supportedReasoningEfforts:[{reasoningEffort}], defaultReasoningEffort}], codexModel }
function specs(ctx = {}) {
  const models = ctx.codexModels || [];
  const current = models.find((m) => m.id === ctx.codexModel) || models[0];
  const codexEfforts = current ? current.supportedReasoningEfforts.map((e) => e.reasoningEffort) : [];
  return [
    { group: 'Room', cmd: '/help', desc: 'List commands' },
    { group: 'Room', cmd: '/stop', desc: 'Stop both agents and cancel hand-offs' },
    { group: 'Room', cmd: '/default', args: ['claude', 'codex', 'both'], desc: 'Who answers a message with no @mention' },
    { group: 'Room', cmd: '/both', args: ['sequential', 'parallel'], desc: 'How @both works: take turns, or answer at once' },
    { group: 'Room', cmd: '/history add', desc: 'Add a local Claude Code session or Codex thread as reference both agents can read (local only)' },
    { group: 'Room', cmd: '/history remove', desc: 'Stop sharing a history source' },
    { group: 'Room', cmd: '/history all', desc: 'Include a shared source\'s earlier history (on) or only what is said from now on (off): /history all <h1|claude|codex> on|off' },
    { group: 'Room', cmd: '/history share', args: ['claude on', 'claude off', 'codex on', 'codex off'], desc: 'Share an agent\'s working session with the other agent (read-only reference)' },
    { group: 'Claude', cmd: '/claude model', args: CLAUDE_MODELS, desc: 'Switch Claude model (restarts on the same session)' },
    { group: 'Claude', cmd: '/claude effort', args: CLAUDE_EFFORTS, desc: 'Claude thinking effort' },
    { group: 'Claude', cmd: '/claude fast', args: ['on', 'off'], desc: 'Opus fast mode, ~2.5x faster; billed to usage credits' },
    { group: 'Claude', cmd: '/claude compact', desc: 'Summarize Claude\'s context to free space' },
    { group: 'Codex', cmd: '/codex model', args: models.map((m) => m.id), desc: 'Switch Codex model (applies from the next turn)' },
    { group: 'Codex', cmd: '/codex effort', args: codexEfforts, desc: `Codex reasoning effort${current ? ` for ${current.id}` : ''}` },
    { group: 'Codex', cmd: '/codex fast', args: ['on', 'off'], desc: 'Priority tier: faster, uses more of your Codex quota' },
    { group: 'Codex', cmd: '/codex compact', desc: 'Summarize Codex\'s thread to free space' }
  ];
}

// Longest matching command wins; the rest of the line is the argument.
function parse(text, list) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  const hit = list.filter((s) => t === s.cmd || t.startsWith(s.cmd + ' ')).sort((a, b) => b.cmd.length - a.cmd.length)[0];
  if (!hit) return { error: `Unknown command "${t.split(' ').slice(0, 2).join(' ')}". Type /help for the list.` };
  const arg = t.slice(hit.cmd.length).trim();
  if (hit.args && !arg) return { error: `${hit.cmd} needs a value: ${hit.args.join(', ')}` };
  if (hit.args && hit.args.length && !hit.args.includes(arg) && hit.cmd !== '/claude model') return { error: `${hit.cmd} accepts: ${hit.args.join(', ')}` };
  return { spec: hit, arg };
}

module.exports = { specs, parse, CLAUDE_MODELS, CLAUDE_EFFORTS, CLAUDE_CATALOG };
