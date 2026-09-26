'use strict';
// Claude models as Claude Code itself presents them: the CLI reports its model menu (names, descriptions, effort
// levels, fast mode) in its initialize response, with no model call. Wagon Wheel shows that list in tier order, the
// current model of each family first and older ones grouped after. FALLBACK is the same native text from Claude Code
// 2.1.282, used when the CLI can't be asked.
const { spawn } = require('child_process');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Claude Code's own labels for its Effort control (webview Q95 in 2.1.282).
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const TIER = { mythos: 6, fable: 5, opus: 4, sonnet: 3, haiku: 1 };

const FALLBACK = [
  { id: 'default', name: 'Default (recommended)', note: 'Fable 5.1', resolves: 'claude-fable-5-1', efforts: EFFORTS, fast: false, minCli: '2.1.251' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'Most capable for your hardest and longest-running tasks', efforts: EFFORTS, fast: false, minCli: '2.1.251' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Best for everyday, complex tasks', efforts: EFFORTS, fast: true, minCli: '2.1.280' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', note: 'Efficient for routine tasks', efforts: EFFORTS, fast: false, minCli: '2.1.0' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', note: 'Fastest for quick answers', efforts: [], fast: false, minCli: '2.1.0' },
];

function familyOf(id) { const m = /^claude-(mythos|fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(String(id)); return m ? { family: m[1], version: Number(m[2]) + (m[3] && m[3].length <= 2 ? Number(m[3]) / 10 : 0) } : null; }

// The CLI's list -> [{ id, name, note, resolves, efforts, fast, older }], tier-sorted: Default first, then the newest
// model of each family from the most capable down, then older models (older: true) in the same order.
function fromCli(models) {
  if (!Array.isArray(models) || !models.length) return null;
  const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
  const out = [];
  for (const m of models) {
    if (!m || typeof m !== 'object' || typeof m.resolvedModel !== 'string') continue;
    const isDefault = m.value === 'default';
    const id = isDefault ? 'default' : m.resolvedModel;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, name: clean(m.displayName, 60) || id, note: clean(m.description, 120), resolves: m.resolvedModel,
      efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => EFFORTS.includes(e)) : [], fast: m.supportsFastMode === true });
  }
  return tierSort(out);
}

function tierSort(list) {
  const rank = (x) => { const f = familyOf(x.resolves || x.id); return f ? [TIER[f.family] || 0, f.version] : [0, 0]; };
  const def = list.filter((x) => x.id === 'default');
  const rest = list.filter((x) => x.id !== 'default').sort((a, b) => { const [ta, va] = rank(a), [tb, vb] = rank(b); return tb - ta || vb - va; });
  const newest = new Set(), main = [], older = [];
  for (const x of rest) { const f = familyOf(x.resolves || x.id), key = f ? f.family : x.id; if (newest.has(key)) older.push({ ...x, older: true }); else { newest.add(key); main.push({ ...x, older: false }); } }
  return [...def.map((x) => ({ ...x, older: false })), ...main, ...older];
}

// Ask the Claude CLI for its model menu: an initialize control request, then the process is stopped. No model call.
function query(exe, { cwd = require('os').tmpdir(), timeoutMs = 15000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let done = false, buf = '', p;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { p && p.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      p = spawnFn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted', '--tools', 'Read', '--permission-mode', 'dontAsk', '--strict-mcp-config'],
        { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { finish(null); return; }
    p.on('error', () => finish(null)); p.on('exit', () => finish(null));
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'control_response' && m.response && m.response.request_id === 'ww-models') finish(fromCli(m.response.response && m.response.response.models));
      }
    });
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'ww-models', request: { subtype: 'initialize' } }) + '\n');
  });
}

module.exports = { FALLBACK: tierSort(FALLBACK), EFFORTS, EFFORT_LABELS, fromCli, tierSort, familyOf, query };
