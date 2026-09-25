'use strict';
// Token use from every local session on this computer, read from the CLIs' own logs: Claude Code's
// ~/.claude/projects/**/<session>.jsonl and Codex's ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Read-only and incremental (only files touched in the window, only bytes added since the last scan), no model
// calls. It sees this computer only: web apps, other machines and cloud tasks are not in these logs. Providers
// change their log formats; anything unrecognised is reported as unknown, never as zero.
//
// Besides the totals, each usage event keeps the model, the lane (main conversation or a subagent), thinking
// tokens and Claude's cache tiers, and tool calls are counted per tool with the size of what came back. Neither
// provider reports tokens per tool call, so result sizes are the characters the model received: an estimate.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const DAY = 864e5;
const CHUNK = 8 * 1024 * 1024;
const zero = () => ({ fresh: 0, cached: 0, cacheWrite: 0, output: 0 });
const add = (a, b) => { a.fresh += b.fresh; a.cached += b.cached; a.cacheWrite += b.cacheWrite; a.output += b.output; return a; };
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v) => (typeof v === 'string' && v ? v : null);

// Claude: one usage per API message, repeated on each content block of that message (dedupe by message id).
function claudeRecord(r) {
  if (!r || r.type !== 'assistant' || !r.message || !r.message.usage) return null;
  const u = r.message.usage;
  if (!Number.isFinite(u.input_tokens) && !Number.isFinite(u.output_tokens)) return null;
  const tiers = u.cache_creation && typeof u.cache_creation === 'object' ? { h1: num(u.cache_creation.ephemeral_1h_input_tokens), m5: num(u.cache_creation.ephemeral_5m_input_tokens) } : null;
  return {
    key: `${r.message.id || ''}:${r.requestId || ''}`, ts: Date.parse(r.timestamp),
    usage: { fresh: num(u.input_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) },
    model: str(r.message.model), lane: r.isSidechain === true ? 'subagent' : 'main',
    thinking: num(u.output_tokens_details && u.output_tokens_details.thinking_tokens), tiers,
  };
}

// Claude tool calls: tool_use blocks in assistant messages (one block per log line, dedupe by block id) and the
// tool_result blocks in the following user message, whose text is what the model received.
function claudeToolUses(r) {
  if (!r || r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) return [];
  return r.message.content.filter((b) => b && b.type === 'tool_use' && str(b.name)).map((b) => ({ id: str(b.id), name: b.name, ts: Date.parse(r.timestamp) }));
}
function claudeToolResults(r) {
  if (!r || r.type !== 'user' || !r.message || !Array.isArray(r.message.content)) return [];
  return r.message.content.filter((b) => b && b.type === 'tool_result').map((b) => ({ id: str(b.tool_use_id), chars: textChars(b.content) }));
}
// Characters of text in a tool result; images and other blocks have no text size (null = unknown).
function textChars(c) {
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return null;
  let n = 0, any = false;
  for (const b of c) if (b && typeof b.text === 'string') { n += b.text.length; any = true; }
  return any || !c.length ? n : null;
}

// Codex: token_count events carry the session's running total; usage is the growth between events.
// OpenAI input tokens include the cached ones.
function codexTotal(r) {
  const p = r && r.type === 'event_msg' && r.payload;
  const t = p && p.type === 'token_count' && p.info && p.info.total_token_usage;
  if (!t || !Number.isFinite(t.input_tokens)) return null;
  return { ts: Date.parse(r.timestamp), total: { fresh: num(t.input_tokens) - num(t.cached_input_tokens), cached: num(t.cached_input_tokens), cacheWrite: num(t.cache_write_input_tokens), output: num(t.output_tokens) }, reasoning: num(t.reasoning_output_tokens) };
}
// Codex rollout items: the model comes from turn_context; tool calls are function_call / custom_tool_call /
// local_shell_call items and their *_output items, matched by call_id.
function codexModel(r) { const p = r && r.type === 'turn_context' && r.payload; return p ? str(p.model) : null; }
function codexToolCall(r) {
  const p = r && r.type === 'response_item' && r.payload; if (!p) return null;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') return str(p.name) ? { id: str(p.call_id), name: p.name, ts: Date.parse(r.timestamp) } : null;
  if (p.type === 'local_shell_call') return { id: str(p.call_id), name: 'shell', ts: Date.parse(r.timestamp) };
  return null;
}
function codexToolOutput(r) {
  const p = r && r.type === 'response_item' && r.payload; if (!p) return null;
  if (p.type !== 'function_call_output' && p.type !== 'custom_tool_call_output') return null;
  return { id: str(p.call_id), chars: typeof p.output === 'string' ? p.output.length : textChars(p.output) };
}

// One turn's usage as the clients report it, in the same shape as the log totals.
const fromClaude = (u) => (u ? { fresh: num(u.input_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) } : null);
const fromCodex = (u) => (u ? { fresh: num(u.inputTokens) - num(u.cachedInputTokens), cached: num(u.cachedInputTokens), cacheWrite: num(u.cacheWriteInputTokens), output: num(u.outputTokens) } : null);
const sum = (a, b) => (b ? add(a || zero(), b) : a);

const UNKNOWN = 'unknown';
const MAX_TOOL_NAMES = 60; // the most-called names are kept; a runaway log with thousands of names stays bounded

// Model and tool names come from the logs, so they are untrusted text: aggregate in Maps and hand back
// prototype-less objects, so a name such as "__proto__" or "constructor" is just a key.
const plain = (map) => { const o = Object.create(null); for (const [k, v] of map) o[k] = v; return o; };

// Breakdown of the events and tool calls at or after `from`. A tool call is "unsized" when no text came back:
// an image result, a call that was interrupted, or one whose result is not in the log yet.
function breakdown(files, from) {
  const models = new Map(), tools = new Map();
  const out = { lanes: { main: zero(), subagent: zero() }, thinking: 0, tiers: null, toolCalls: 0 };
  for (const f of files) {
    for (const e of f.events) {
      if (e.ts < from) continue;
      const m = e.model || UNKNOWN;
      if (!models.has(m)) models.set(m, { ...zero(), thinking: 0 });
      add(models.get(m), e.usage); models.get(m).thinking += e.thinking || 0;
      add(out.lanes[e.lane === 'subagent' ? 'subagent' : 'main'], e.usage);
      out.thinking += e.thinking || 0;
      if (e.tiers) { out.tiers = out.tiers || { h1: 0, m5: 0 }; out.tiers.h1 += e.tiers.h1; out.tiers.m5 += e.tiers.m5; }
    }
    for (const t of f.tools) {
      if (t.ts < from) continue;
      if (!tools.has(t.name)) tools.set(t.name, { calls: 0, chars: 0, unsized: 0 });
      const x = tools.get(t.name); x.calls += 1; out.toolCalls += 1;
      if (Number.isFinite(t.chars)) x.chars += t.chars; else x.unsized += 1;
    }
  }
  if (tools.size > MAX_TOOL_NAMES) {
    const rest = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(MAX_TOOL_NAMES);
    const other = { calls: 0, chars: 0, unsized: 0 };
    for (const [name, x] of rest) { tools.delete(name); other.calls += x.calls; other.chars += x.chars; other.unsized += x.unsized; }
    tools.set('other', other);
  }
  return { models: plain(models), ...out, tools: plain(tools) };
}

class LocalUsage {
  constructor({ home = os.homedir(), now = Date.now, windowDays = 7 } = {}) {
    this.roots = { claude: path.join(home, '.claude', 'projects'), codex: path.join(home, '.codex', 'sessions') };
    this.now = now; this.windowDays = windowDays;
    this.files = new Map(); // path -> { size, offset, events, tools, calls, seen, last, lines, recognised, model, lane }
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

  _fresh(file, provider) {
    // Claude Code writes subagent transcripts under <session>/subagents/; their lines may not say isSidechain.
    // Judged on the path below the projects root, so a home folder named that way doesn't count.
    const rel = path.relative(this.roots[provider], file).split(path.sep);
    const lane = provider === 'claude' && rel.slice(0, -1).includes('subagents') ? 'subagent' : 'main';
    return { offset: 0, events: [], tools: [], calls: new Map(), seen: new Set(), last: null, lastReasoning: 0, lines: 0, recognised: 0, model: null, lane };
  }

  // Forget what is older than the window, so long-lived sessions don't grow without bound. A call that never
  // got its result (interrupted, or the process died) stays unsized once it leaves the matching map.
  _prune(f, since) {
    f.events = f.events.filter((e) => e.ts >= since);
    f.tools = f.tools.filter((t) => t.ts >= since);
    for (const [id, entry] of f.calls) if (entry.ts < since) f.calls.delete(id);
  }

  // Read the bytes added since the last scan, in bounded chunks; only complete lines are consumed.
  async _read(file, provider, since) {
    let st; try { st = await fsp.stat(file); } catch { return; }
    if (st.mtimeMs < since) return;
    let f = this.files.get(file);
    if (!f || st.size < f.offset) { f = this._fresh(file, provider); this.files.set(file, f); }
    this._prune(f, since);
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

  _tool(f, call) {
    if (!call || !Number.isFinite(call.ts)) return;
    if (call.id) { if (f.seen.has(`tool:${call.id}`)) return; f.seen.add(`tool:${call.id}`); }
    const entry = { ts: call.ts, name: call.name, chars: null };
    f.tools.push(entry);
    if (call.id) f.calls.set(call.id, entry);
  }
  _toolResult(f, res) {
    if (!res || !res.id) return;
    const entry = f.calls.get(res.id); if (!entry) return;
    entry.chars = Number.isFinite(res.chars) ? (entry.chars || 0) + res.chars : entry.chars;
    f.calls.delete(res.id);
  }

  _lines(f, provider, text) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      f.lines += 1;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (provider === 'claude') {
        for (const c of claudeToolUses(r)) this._tool(f, c);
        for (const x of claudeToolResults(r)) this._toolResult(f, x);
        const x = claudeRecord(r); if (!x) continue;
        f.recognised += 1;
        if (f.seen.has(x.key)) continue; f.seen.add(x.key);
        if (Number.isFinite(x.ts)) f.events.push({ ts: x.ts, usage: x.usage, model: x.model, lane: f.lane === 'subagent' ? 'subagent' : x.lane, thinking: x.thinking, tiers: x.tiers });
      } else {
        const model = codexModel(r); if (model) { f.model = model; continue; }
        const call = codexToolCall(r); if (call) { this._tool(f, call); continue; }
        const res = codexToolOutput(r); if (res) { this._toolResult(f, res); continue; }
        const x = codexTotal(r); if (!x) continue;
        f.recognised += 1;
        const prev = f.last; f.last = x.total;
        // A total that went down is a new session baseline, not negative use.
        const grew = prev && x.total.fresh + x.total.cached >= prev.fresh + prev.cached && x.total.output >= prev.output;
        const d = grew ? { fresh: x.total.fresh - prev.fresh, cached: x.total.cached - prev.cached, cacheWrite: Math.max(0, x.total.cacheWrite - prev.cacheWrite), output: x.total.output - prev.output } : x.total;
        const thinking = grew ? Math.max(0, x.reasoning - f.lastReasoning) : x.reasoning; f.lastReasoning = x.reasoning;
        if (Number.isFinite(x.ts) && (d.fresh || d.cached || d.output)) f.events.push({ ts: x.ts, usage: d, model: f.model, lane: 'main', thinking, tiers: null });
      }
    }
  }

  // Totals for today (since local midnight) and the last N days, per provider. null = no logs found; a provider
  // whose logs have lines but no recognisable usage is { unknown: true }. `detail` holds the breakdowns.
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
      out[provider] = { today, window, sessions: mine.filter((f) => f.events.some((e) => e.ts >= since)).length, detail: { today: breakdown(mine, midnight.getTime()), window: breakdown(mine, since) } };
    }
    return out;
  }
}

module.exports = { LocalUsage, claudeRecord, codexTotal, zero, add, fromClaude, fromCodex, sum, breakdown, textChars };
