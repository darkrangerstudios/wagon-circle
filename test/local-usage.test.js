'use strict';
// This-computer token totals from synthetic Claude and Codex logs in a temp home. No real logs are read.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { LocalUsage } = require('../src/localUsage');

const H = 36e5, NOW = Date.parse('2026-09-24T15:00:00');
const iso = (ms) => new Date(ms).toISOString();
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wwlu-'));
  fs.mkdirSync(path.join(h, '.claude', 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(path.join(h, '.codex', 'sessions', '2026', '09', '24'), { recursive: true });
  return h;
}
const claudeLine = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), requestId: `req-${id}`, message: { id, usage: { input_tokens: u[0], cache_read_input_tokens: u[1], cache_creation_input_tokens: u[2], output_tokens: u[3] } } }) + '\n';
const codexLine = (ts, t) => JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: t[0], cached_input_tokens: t[1], cache_write_input_tokens: 0, output_tokens: t[2] } } } }) + '\n';

test('Claude: one count per API message even when its usage repeats on every content block', async () => {
  const h = home(); const f = path.join(h, '.claude', 'projects', 'proj', 's1.jsonl');
  fs.writeFileSync(f, claudeLine('m1', NOW - H, [10, 100, 5, 20]) + claudeLine('m1', NOW - H, [10, 100, 5, 20]) + claudeLine('m2', NOW - 2 * 24 * H, [1, 2, 3, 4]) + 'not json\n' + JSON.stringify({ type: 'user' }) + '\n');
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  assert.deepStrictEqual(r.claude.today, { fresh: 10, cached: 100, cacheWrite: 5, output: 20 });
  assert.deepStrictEqual(r.claude.window, { fresh: 11, cached: 102, cacheWrite: 8, output: 24 });
  assert.strictEqual(r.codex, null); // no Codex logs: unknown, not zero
});

test('Codex: usage is the growth of the running total; duplicate events add nothing; a reset starts a new baseline', async () => {
  const h = home(); const f = path.join(h, '.codex', 'sessions', '2026', '09', '24', 'rollout-a.jsonl');
  fs.writeFileSync(f, codexLine(NOW - 3 * H, [1000, 800, 50]) + codexLine(NOW - 2 * H, [1000, 800, 50]) + codexLine(NOW - H, [1500, 1100, 70]) + JSON.stringify({ timestamp: iso(NOW), type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n');
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  assert.deepStrictEqual(r.codex.today, { fresh: 400, cached: 1100, cacheWrite: 0, output: 70 });
  fs.appendFileSync(f, codexLine(NOW - 0.5 * H, [300, 200, 10])); // new session in the same file: counted as is
  const r2 = await new LocalUsage({ home: h, now: () => NOW }).scan();
  assert.deepStrictEqual(r2.codex.today, { fresh: 500, cached: 1300, cacheWrite: 0, output: 80 });
});

test('rescans read only what was appended and never double count; partial last lines wait', async () => {
  const h = home(); const f = path.join(h, '.claude', 'projects', 'proj', 's1.jsonl');
  fs.writeFileSync(f, claudeLine('m1', NOW - H, [10, 0, 0, 1]));
  const lu = new LocalUsage({ home: h, now: () => NOW });
  assert.strictEqual((await lu.scan()).claude.today.fresh, 10);
  const next = claudeLine('m2', NOW - H, [5, 0, 0, 1]);
  fs.appendFileSync(f, next.slice(0, 20)); // half-written line
  assert.strictEqual((await lu.scan()).claude.today.fresh, 10);
  fs.appendFileSync(f, next.slice(20));
  assert.strictEqual((await lu.scan()).claude.today.fresh, 15);
  assert.strictEqual((await lu.scan()).claude.today.fresh, 15);
});

test('an unrecognised log format is unknown, not zero; old files outside the window are skipped', async () => {
  const h = home();
  const f = path.join(h, '.claude', 'projects', 'proj', 'new-format.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: iso(NOW), message: { id: 'x', tokens: { in: 5 } } }) + '\n');
  const old = path.join(h, '.codex', 'sessions', '2026', '09', '24', 'rollout-old.jsonl');
  fs.writeFileSync(old, codexLine(NOW - 30 * 24 * H, [100, 0, 1]));
  fs.utimesSync(old, new Date(NOW - 30 * 24 * H), new Date(NOW - 30 * 24 * H));
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  assert.deepStrictEqual(r.claude, { unknown: true });
  assert.deepStrictEqual(r.codex.window, { fresh: 0, cached: 0, cacheWrite: 0, output: 0 });
});

// ---------- breakdowns: model, lane, thinking, cache tiers, tool calls ----------
const claudeFull = (id, ts, { model = 'claude-sonnet-5', side = false, thinking = 0, h1 = 0, m5 = 0, content = [] } = {}, u = [10, 100, 5, 20]) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), requestId: `req-${id}`, isSidechain: side, message: { id, model, content, usage: { input_tokens: u[0], cache_read_input_tokens: u[1], cache_creation_input_tokens: u[2], output_tokens: u[3], output_tokens_details: { thinking_tokens: thinking }, cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } }) + '\n';
const claudeResult = (ts, id, content) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }) + '\n';

test('Claude breakdown: per model, main vs subagent, thinking, cache tiers, and tool calls with result sizes', async () => {
  const h = home(); const dir = path.join(h, '.claude', 'projects', 'proj');
  const tool = (id, name) => ({ type: 'tool_use', id, name, input: {} });
  fs.writeFileSync(path.join(dir, 's1.jsonl'),
    claudeFull('m1', NOW - H, { model: 'claude-opus-5-5', thinking: 7, h1: 5, content: [tool('t1', 'Read')] }) +
    claudeFull('m1', NOW - H, { model: 'claude-opus-5-5', thinking: 7, h1: 5, content: [tool('t1', 'Read')] }) + // same message, next block line: no double count
    claudeResult(NOW - H + 1000, 't1', 'x'.repeat(1500)) +
    claudeFull('m2', NOW - H + 2000, { model: 'claude-opus-5-5', content: [tool('t2', 'Grep'), tool('t3', 'Read')] }, [1, 2, 3, 4]) +
    claudeResult(NOW - H + 3000, 't2', [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]) +
    claudeResult(NOW - H + 3000, 't3', [{ type: 'image', source: {} }]) + // no text: unsized, not zero
    claudeFull('m3', NOW - 2 * 24 * H, { model: 'claude-sonnet-5', m5: 9 }, [100, 0, 9, 50])); // outside today, inside the window
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), claudeFull('m4', NOW - H, { model: 'claude-haiku-4-5', thinking: 2 }, [50, 0, 0, 10]));
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  const t = r.claude.detail.today, w = r.claude.detail.window;
  assert.deepStrictEqual(Object.keys(t.models).sort(), ['claude-haiku-4-5', 'claude-opus-5-5']);
  assert.deepStrictEqual(t.models['claude-opus-5-5'], { fresh: 11, cached: 102, cacheWrite: 8, output: 24, thinking: 7 });
  assert.deepStrictEqual(t.lanes, { main: { fresh: 11, cached: 102, cacheWrite: 8, output: 24 }, subagent: { fresh: 50, cached: 0, cacheWrite: 0, output: 10 } });
  assert.strictEqual(t.thinking, 9);
  assert.deepStrictEqual(t.tiers, { h1: 5, m5: 0 });
  assert.deepStrictEqual(w.tiers, { h1: 5, m5: 9 });
  assert.strictEqual(w.models['claude-sonnet-5'].output, 50);
  assert.deepStrictEqual(t.tools, { Read: { calls: 2, chars: 1500, unsized: 1 }, Grep: { calls: 1, chars: 4, unsized: 0 } });
  assert.strictEqual(t.toolCalls, 3);
  assert.deepStrictEqual(r.claude.today, { fresh: 61, cached: 102, cacheWrite: 8, output: 34 }); // totals include the subagent
});

test('Codex breakdown: model from turn_context, reasoning growth, function calls matched to their outputs', async () => {
  const h = home(); const f = path.join(h, '.codex', 'sessions', '2026', '09', '24', 'rollout-a.jsonl');
  const tc = (ts, t, reasoning) => JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: t[0], cached_input_tokens: t[1], cache_write_input_tokens: 0, output_tokens: t[2], reasoning_output_tokens: reasoning } } } }) + '\n';
  const item = (ts, payload) => JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload }) + '\n';
  fs.writeFileSync(f,
    JSON.stringify({ timestamp: iso(NOW - 3 * H), type: 'turn_context', payload: { model: 'gpt-5.6-codex' } }) + '\n' +
    item(NOW - 3 * H, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' }) +
    item(NOW - 3 * H + 500, { type: 'function_call_output', call_id: 'c1', output: 'y'.repeat(300) }) +
    tc(NOW - 3 * H + 1000, [1000, 800, 50], 20) +
    item(NOW - 2 * H, { type: 'local_shell_call', call_id: 'c2' }) +
    item(NOW - 2 * H, { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: '' }) +
    item(NOW - 2 * H + 500, { type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' }) +
    tc(NOW - 2 * H + 1000, [1500, 1100, 70], 25) +
    tc(NOW - H, [300, 200, 10], 4)); // reset: new session baseline, its reasoning counted as is
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  const t = r.codex.detail.today;
  assert.deepStrictEqual(t.models, { 'gpt-5.6-codex': { fresh: 500, cached: 1300, cacheWrite: 0, output: 80, thinking: 29 } });
  assert.strictEqual(t.thinking, 29);
  assert.strictEqual(t.tiers, null);
  assert.deepStrictEqual(t.tools, { shell: { calls: 2, chars: 300, unsized: 1 }, apply_patch: { calls: 1, chars: 2, unsized: 0 } });
  assert.deepStrictEqual(t.lanes.subagent, { fresh: 0, cached: 0, cacheWrite: 0, output: 0 });
});

test('a model that was never logged shows as unknown, and events before the window are left out of the breakdown', async () => {
  const h = home(); const f = path.join(h, '.codex', 'sessions', '2026', '09', '24', 'rollout-b.jsonl');
  const tc = (ts, t) => JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: t[0], cached_input_tokens: 0, output_tokens: t[1] } } } }) + '\n';
  fs.writeFileSync(f, tc(NOW - 20 * 24 * H, [100, 1]) + tc(NOW - H, [150, 3]));
  const r = await new LocalUsage({ home: h, now: () => NOW }).scan();
  assert.deepStrictEqual(r.codex.detail.window.models, { unknown: { fresh: 50, cached: 0, cacheWrite: 0, output: 2, thinking: 0 } });
  assert.deepStrictEqual(r.codex.window, { fresh: 50, cached: 0, cacheWrite: 0, output: 2 });
});
