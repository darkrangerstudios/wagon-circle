'use strict';
// A/B: does a persistent session + deltas avoid re-sending context every turn?
// A = Wagon Circle: one long-lived `claude -p` stream-json session, each turn sends only the new message.
// B = naive: a fresh `claude -p` process per turn with the whole transcript pasted in.
// Usage: node test/token-ab.js <scratchCwd>
const os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { ClaudeClient } = require('../src/claudeClient');

const cwd = process.argv[2];
const exe = path.join(os.homedir(), '.local/bin/claude');
const SYS = 'You are a terse test assistant. Answer in one short line.';
const TURNS = [
  'Remember this password: ORCHID-42. Reply only: noted',
  'What is 17 times 3?',
  'Name one primary color.',
  'What was the password I gave you?'
];
const fmt = (u) => `fresh ${String(u.input + u.cacheWrite).padStart(6)} (input ${u.input}, cache-write ${u.cacheWrite}) | cache-read ${String(u.cacheRead).padStart(6)} | out ${u.output}`;

async function runA() {
  const c = new ClaudeClient({ exe, cwd, model: 'sonnet', systemPrompt: SYS });
  const rows = [];
  for (const t of TURNS) { const reply = await c.send(t); rows.push({ sent: t.length, reply, u: c.lastUsage, cost: c.totalCostUsd }); }
  c.stop();
  return rows;
}

function runB() {
  const rows = []; const transcript = []; let total = 0;
  for (const t of TURNS) {
    transcript.push(`User: ${t}`);
    const prompt = `${transcript.join('\n')}\nAssistant:`;
    const r = spawnSync(exe, ['-p', '--output-format', 'json', '--model', 'sonnet', '--permission-mode', 'dontAsk', '--allowedTools', 'Read',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--append-system-prompt', SYS, prompt], { cwd, encoding: 'utf8', timeout: 180000 });
    const m = JSON.parse(r.stdout);
    const u = { input: m.usage.input_tokens || 0, cacheWrite: m.usage.cache_creation_input_tokens || 0, cacheRead: m.usage.cache_read_input_tokens || 0, output: m.usage.output_tokens || 0 };
    total += m.total_cost_usd || 0;
    transcript.push(`Assistant: ${String(m.result).trim()}`);
    rows.push({ sent: prompt.length, reply: String(m.result).trim(), u, cost: total });
  }
  return rows;
}

(async () => {
  const a = await runA();
  const b = runB();
  for (const [name, rows] of [['A  Wagon Circle (persistent session, deltas)', a], ['B  naive (new process, full transcript)', b]]) {
    console.log(`\n${name}`);
    rows.forEach((r, i) => console.log(`  turn ${i + 1}: sent ${String(r.sent).padStart(4)} chars | ${fmt(r.u)} | "${r.reply.slice(0, 40)}"`));
    const fresh = rows.reduce((s, r) => s + r.u.input + r.u.cacheWrite, 0), read = rows.reduce((s, r) => s + r.u.cacheRead, 0);
    console.log(`  TOTAL fresh ${fresh} | cache-read ${read} | cost $${rows[rows.length - 1].cost.toFixed(4)}`);
  }
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
