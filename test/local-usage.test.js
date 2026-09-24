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
