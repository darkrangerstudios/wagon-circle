'use strict';
// Claude plan usage from Claude Code's headless `/usage` command. It makes no model call and costs nothing.
const { execFile } = require('child_process');

// "Current session: 7% used · resets Sep 23 at 7:40pm (America/Chicago)"
// "Current week (all models): 93% used · resets ..."   "Current week (Fable): 100% used · resets ..."
function parse(text) {
  const out = { session: null, week: null, models: {} };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s*(.+))?$/i);
    if (!m) continue;
    const v = { pct: Number(m[3]), resets: m[4] ? m[4].trim() : null };
    if (m[1].toLowerCase() === 'session') out.session = v;
    else if (!m[2] || /^all models$/i.test(m[2])) out.week = v;
    else out.models[m[2].trim()] = v;
  }
  return out;
}

function fetch(exe, cwd) {
  return new Promise((resolve) => {
    execFile(exe, ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '/usage'],
      { cwd, timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(parse(JSON.parse(stdout).result)); } catch { resolve(null); }
      });
  });
}

// A catalogue model is blocked when its own weekly limit is used up ("Fable 5.1" matches "Fable").
function blockFor(usage, modelName) {
  if (!usage) return null;
  const family = String(modelName).split(' ')[0].toLowerCase();
  for (const [k, v] of Object.entries(usage.models)) {
    if (k.toLowerCase() === family && v.pct >= 100) return `Weekly ${k} limit used${v.resets ? ` · resets ${v.resets}` : ''}`;
  }
  return null;
}

module.exports = { parse, fetch, blockFor };
