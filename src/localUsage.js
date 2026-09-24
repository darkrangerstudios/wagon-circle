'use strict';
// Token use from every local session on this computer, read from the CLIs' own logs: Claude Code's
// ~/.claude/projects/**/<session>.jsonl and Codex's ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Read-only and incremental (only files touched in the window, only bytes added since the last scan), no model
// calls. It sees this computer only: web apps, other machines and cloud tasks are not in these logs. Providers
// change their log formats; anything unrecognised is reported as unknown, never as zero.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const DAY = 864e5;
const CHUNK = 8 * 1024 * 1024;
const zero = () => ({ fresh: 0, cached: 0, cacheWrite: 0, output: 0 });
const add = (a, b) => { a.fresh += b.fresh; a.cached += b.cached; a.cacheWrite += b.cacheWrite; a.output += b.output; return a; };
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// Claude: one usage per API message, repeated on each content block of that message (dedupe by message id).
function claudeRecord(r) {
  if (!r || r.type !== 'assistant' || !r.message || !r.message.usage) return null;
  const u = r.message.usage;
  if (!Number.isFinite(u.input_tokens) && !Number.isFinite(u.output_tokens)) return null;
  return { key: `${r.message.id || ''}:${r.requestId || ''}`, ts: Date.parse(r.timestamp), usage: { fresh: num(u.input_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) } };
}

// Codex: token_count events carry the session's running total; usage is the growth between events.
// OpenAI input tokens include the cached ones.
function codexTotal(r) {
  const p = r && r.type === 'event_msg' && r.payload;
  const t = p && p.type === 'token_count' && p.info && p.info.total_token_usage;
  if (!t || !Number.isFinite(t.input_tokens)) return null;
  return { ts: Date.parse(r.timestamp), total: { fresh: num(t.input_tokens) - num(t.cached_input_tokens), cached: num(t.cached_input_tokens), cacheWrite: num(t.cache_write_input_tokens), output: num(t.output_tokens) } };
}

// One turn's usage as the clients report it, in the same shape as the log totals.
const fromClaude = (u) => (u ? { fresh: num(u.input_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) } : null);
const fromCodex = (u) => (u ? { fresh: num(u.inputTokens) - num(u.cachedInputTokens), cached: num(u.cachedInputTokens), cacheWrite: num(u.cacheWriteInputTokens), output: num(u.outputTokens) } : null);
const sum = (a, b) => (b ? add(a || zero(), b) : a);

class LocalUsage {
  constructor({ home = os.homedir(), now = Date.now, windowDays = 7 } = {}) {
    this.roots = { claude: path.join(home, '.claude', 'projects'), codex: path.join(home, '.codex', 'sessions') };
    this.now = now; this.windowDays = windowDays;
    this.files = new Map(); // path -> { size, offset, events: [{ts, usage}], seen:Set, last:total, lines, recognised }
  }

  async _list(dir, depth) {
    let out = [];
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) out = out.concat(await this._list(p, depth - 1));
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  // Read the bytes added since the last scan, in bounded chunks; only complete lines are consumed.
  async _read(file, provider, since) {
    let st; try { st = await fsp.stat(file); } catch { return; }
    if (st.mtimeMs < since) return;
    let f = this.files.get(file);
    if (!f || st.size < f.offset) { f = { offset: 0, events: [], seen: new Set(), last: null, lines: 0, recognised: 0 }; this.files.set(file, f); }
    if (st.size === f.offset) return;
    const h = await fsp.open(file, 'r');
    try {
      let carry = Buffer.alloc(0);
      while (f.offset + carry.length < st.size) {
        const want = Math.min(CHUNK, st.size - f.offset - carry.length);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await h.read(buf, 0, want, f.offset + carry.length);
        if (!bytesRead) break;
        const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(10);
        if (end < 0) { carry = data; if (carry.length > 8 * CHUNK) break; continue; } // one huge unfinished line: retry later
        this._lines(f, provider, data.subarray(0, end).toString('utf8'));
        f.offset += end + 1; carry = data.subarray(end + 1);
      }
    } finally { await h.close(); }
  }

  _lines(f, provider, text) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      f.lines += 1;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (provider === 'claude') {
        const x = claudeRecord(r); if (!x) continue;
        f.recognised += 1;
        if (f.seen.has(x.key)) continue; f.seen.add(x.key);
        if (Number.isFinite(x.ts)) f.events.push({ ts: x.ts, usage: x.usage });
      } else {
        const x = codexTotal(r); if (!x) continue;
        f.recognised += 1;
        const prev = f.last; f.last = x.total;
        // A total that went down is a new session baseline, not negative use.
        const grew = prev && x.total.fresh + x.total.cached >= prev.fresh + prev.cached && x.total.output >= prev.output;
        const d = grew ? { fresh: x.total.fresh - prev.fresh, cached: x.total.cached - prev.cached, cacheWrite: Math.max(0, x.total.cacheWrite - prev.cacheWrite), output: x.total.output - prev.output } : x.total;
        if (Number.isFinite(x.ts) && (d.fresh || d.cached || d.output)) f.events.push({ ts: x.ts, usage: d });
      }
    }
  }

  // Totals for today (since local midnight) and the last N days, per provider. null = no logs found; a provider
  // whose logs have lines but no recognisable usage is { unknown: true }.
  async scan() {
    const now = this.now(), since = now - this.windowDays * DAY;
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const out = { scannedAt: now, windowDays: this.windowDays };
    for (const provider of ['claude', 'codex']) {
      const list = await this._list(this.roots[provider], 3);
      if (!list.length) { out[provider] = null; continue; }
      for (const file of list) await this._read(file, provider, since);
      const mine = list.map((p) => this.files.get(p)).filter(Boolean);
      const lines = mine.reduce((n, f) => n + f.lines, 0), recognised = mine.reduce((n, f) => n + f.recognised, 0);
      if (lines && !recognised) { out[provider] = { unknown: true }; continue; }
      const today = zero(), window = zero();
      for (const f of mine) for (const e of f.events) { if (e.ts >= since) add(window, e.usage); if (e.ts >= midnight.getTime()) add(today, e.usage); }
      out[provider] = { today, window, sessions: mine.filter((f) => f.events.some((e) => e.ts >= since)).length };
    }
    return out;
  }
}

module.exports = { LocalUsage, claudeRecord, codexTotal, zero, add, fromClaude, fromCodex, sum };
