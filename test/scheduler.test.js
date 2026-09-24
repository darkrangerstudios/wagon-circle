'use strict';
// The host timer with a fake clock and synthetic sources: no model calls, no real timers.
const test = require('node:test');
const assert = require('node:assert');
const { Scheduler } = require('../src/scheduler');
const MIN = 60e3;

function rig() {
  let t = 0, timer = null;
  const s = new Scheduler({ now: () => t, setTimer: (fn, ms) => (timer = { fn, at: t + ms }), clearTimer: () => { timer = null; } });
  const advance = async (ms) => { const end = t + ms; while (timer && timer.at <= end) { t = timer.at; const f = timer.fn; timer = null; f(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); } t = end; };
  return { s, advance, now: () => t };
}

test('adaptive poll: 10 minutes, hourly after two quiet checks, back to 10 on substantive evidence', async () => {
  const { s, advance } = rig(); const outcomes = ['quiet', 'quiet', 'quiet', 'substantive', 'quiet']; let n = 0;
  s.add('p', { check: async () => outcomes[n++], policy: {} });
  await advance(10 * MIN); assert.strictEqual(s.get('p').intervalMs, 10 * MIN);
  await advance(10 * MIN); assert.strictEqual(s.get('p').intervalMs, 60 * MIN);
  await advance(60 * MIN); assert.strictEqual(n, 3);
  await advance(60 * MIN); assert.strictEqual(s.get('p').intervalMs, 10 * MIN); assert.strictEqual(s.get('p').quiet, 0);
});

test('errors and manual checks do not count as quiet; errors back off', async () => {
  const { s, advance } = rig(); let out = 'error';
  s.add('p', { check: async () => out, policy: {} });
  await advance(10 * MIN); await advance(20 * MIN);
  assert.strictEqual(s.get('p').quiet, 0); assert.strictEqual(s.get('p').errors, 2);
  out = 'quiet'; await s.runNow('p'); await s.runNow('p');
  assert.strictEqual(s.get('p').quiet, 0);
  assert.strictEqual(s.get('p').intervalMs, 10 * MIN);
});

test('a check never overlaps itself', async () => {
  const { s, advance } = rig(); let running = 0, max = 0, release;
  s.add('p', { check: () => { running++; max = Math.max(max, running); return new Promise((r) => { release = () => { running--; r('quiet'); }; }); }, everyMs: MIN });
  await advance(MIN); await s.runNow('p'); await advance(5 * MIN);
  assert.strictEqual(max, 1); release();
});

test('restoring an overdue record catches up once, not once per missed tick', async () => {
  const { s, advance, now } = rig(); let n = 0;
  await advance(500 * MIN);
  s.add('p', { check: async () => { n++; return 'quiet'; }, policy: {}, record: { id: 'p', revision: 3, intervalMs: 10 * MIN, quiet: 0, errors: 0, lastOk: 0, dueAt: 10 * MIN, paused: false, changedBy: 'default' } });
  await advance(1);
  assert.strictEqual(n, 1); assert.strictEqual(s.get('p').dueAt, now() - 1 + 10 * MIN);
});

test('update_polling: in-bounds agent change applies; stale, out-of-bounds and disallowed ones fail', () => {
  const { s } = rig();
  s.add('p', { check: async () => 'quiet', policy: { minMs: 5 * MIN, maxMs: 120 * MIN } });
  assert.match(s.update('p', { expectedRevision: 1, intervalMinutes: 20, actor: 'codex', reason: 'Scout still testing' }).text, /revision 2: every 20 min/);
  assert.strictEqual(s.update('p', { expectedRevision: 1, intervalMinutes: 30, actor: 'codex' }).ok, false);
  assert.match(s.update('p', { expectedRevision: 2, intervalMinutes: 1, actor: 'codex' }).text, /Out of bounds/);
  assert.strictEqual(s.update('p', { expectedRevision: 2, pause: true, actor: 'human' }).ok, true);
  assert.match(s.update('p', { expectedRevision: 3, pause: false, actor: 'claude' }).text, /Only the human/);
  s.add('q', { check: async () => 'quiet', policy: { agentAdjust: false } });
  assert.match(s.update('q', { expectedRevision: 1, intervalMinutes: 20, actor: 'claude' }).text, /turned off/);
});

test('a source removed by Stop while its check runs is not rescheduled by the late result', async () => {
  const { s } = rig(); let release;
  s.add('p', { check: () => new Promise((r) => { release = () => r('substantive'); }), everyMs: MIN });
  const run = s.runNow('p'); s.remove('p'); release(); await run;
  assert.strictEqual(s.get('p'), null); assert.strictEqual(s.timer, null);
});
