'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TaskLedger, PRESETS } = require('../src/tasks');

const clock = () => { let t = 1_000_000; const now = () => t; now.add = (ms) => { t += ms; }; return now; };
const ledger = (opts = {}) => { const now = clock(); return { L: new TaskLedger({ now, agents: ['claude', 'codex'], ...opts }), now }; };
const ask = (L, from, extra = {}) => L.requestAssistance(from, { to: from === 'claude' ? 'codex' : 'claude', purpose: 'review', question: 'Does Stop drop queued steers?', ...extra }, { originId: 7, objective: 'Review the Stop path', run: 1 });

test('the first assistance request in a run starts a task bound to the human message, and is accepted', () => {
  const { L } = ledger();
  const r = ask(L, 'claude');
  assert.strictEqual(r.ok, true);
  const t = L.active();
  assert.deepStrictEqual([t.id, t.originId, t.lead, t.status, t.generation], ['t1', 7, 'claude', 'active', 1]);
  assert.deepStrictEqual([r.request.id, r.request.from, r.request.to, r.request.task, r.request.status], ['r1', 'claude', 'codex', 't1', 'open']);
  assert.match(r.text, /accepted r1/);
});

test('the host stamps identity: an agent cannot address itself, an unknown agent or a bad purpose', () => {
  const { L } = ledger();
  assert.match(ask(L, 'claude', { to: 'claude' }).text, /yourself/);
  assert.match(ask(L, 'claude', { to: 'gemini' }).text, /not in this room/);
  assert.match(ask(L, 'claude', { purpose: 'deploy' }).text, /purpose/);
  assert.match(ask(L, 'claude', { question: '  ' }).text, /question/);
  assert.strictEqual(L.active(), null); // a denied first request starts nothing
});

test('an identical open request is a duplicate, not a second dispatch', () => {
  const { L } = ledger();
  ask(L, 'claude');
  const dup = ask(L, 'claude');
  assert.strictEqual(dup.ok, false); assert.match(dup.text, /already open as r1/);
  assert.strictEqual(L.active().requests.length, 1);
});

test('turns are counted against the task and the last ones are reserved for consolidation', () => {
  const { L } = ledger();
  ask(L, 'claude'); L.setLimits({ turns: 4, reserve: 2 });
  assert.strictEqual(L.admitTurn('codex').ok, true); L.recordTurn('codex');
  assert.strictEqual(L.admitTurn('claude').ok, true); L.recordTurn('claude');
  // 2 used of 4, 2 reserved: new requests are refused, but the requester can still get its result back.
  assert.match(ask(L, 'codex', { question: 'another?' }).text, /reserved for wrapping up/);
  assert.strictEqual(L.admitTurn('claude').ok, true); L.recordTurn('claude');
  L.recordTurn('claude');
  const out = L.admitTurn('claude');
  assert.strictEqual(out.ok, false); assert.match(out.reason, /turn allowance/);
  assert.strictEqual(L.active().status, 'exhausted');
});

test('time counts only while active; pause excludes it and the limit exhausts the task', () => {
  const { L, now } = ledger();
  ask(L, 'claude'); L.setLimits({ minutes: 10 });
  now.add(4 * 60e3); L.pause('human');
  now.add(60 * 60e3); // paused an hour: not counted
  assert.strictEqual(L.admitTurn('codex').ok, false); // paused: no dispatch
  L.resume('human');
  assert.strictEqual(Math.round(L.usedMs(L.active()) / 60e3), 4);
  now.add(6 * 60e3 + 1);
  assert.strictEqual(L.checkTime(), true);
  assert.strictEqual(L.active().status, 'exhausted');
});

test('only the human resumes a paused task; an agent request during pause is refused', () => {
  const { L } = ledger();
  ask(L, 'claude'); L.pause('human');
  assert.match(ask(L, 'codex', { question: 'x' }).text, /paused/);
  assert.strictEqual(L.resume('codex'), false);
  assert.strictEqual(L.resume('human'), true);
});

test('raising a limit adds capacity without erasing use or resuming; lowering to use stops dispatch', () => {
  const { L } = ledger();
  ask(L, 'claude'); L.setLimits({ turns: 3, reserve: 0 });
  for (let i = 0; i < 3; i++) L.recordTurn('codex');
  assert.strictEqual(L.admitTurn('codex').ok, false); assert.strictEqual(L.active().status, 'exhausted');
  L.setLimits({ turns: 5 });
  assert.strictEqual(L.active().used.turns, 3);
  assert.strictEqual(L.active().status, 'exhausted'); // raising does not resume by itself
  assert.strictEqual(L.resume('human'), true);
  assert.strictEqual(L.admitTurn('codex').ok, true);
  L.setLimits({ turns: 3 });
  assert.strictEqual(L.admitTurn('codex').ok, false);
});

test('a reply delivered with a request resolves it and names the requester to return it to', () => {
  const { L } = ledger();
  const { request } = ask(L, 'claude');
  L.markDelivered([request.id], 'codex');
  const back = L.resolveDelivered('codex', 42);
  assert.deepStrictEqual(back, [{ request: 'r1', to: 'claude' }]);
  assert.strictEqual(request.status, 'answered'); assert.strictEqual(request.answerId, 42);
  assert.deepStrictEqual(L.resolveDelivered('codex', 43), []); // nothing open: no second return
});

test('Stop cancels the task and every open request; late tool calls and results are inert', () => {
  const { L } = ledger();
  const { request } = ask(L, 'claude'); L.markDelivered([request.id], 'codex');
  const gen = L.active().generation;
  L.stop();
  const t = L.get('t1');
  assert.strictEqual(t.status, 'stopped'); assert.strictEqual(request.status, 'cancelled'); assert.ok(t.generation > gen);
  assert.deepStrictEqual(L.resolveDelivered('codex', 9), []);
  assert.strictEqual(L.active(), null);
  const late = L.requestAssistance('claude', { to: 'codex', purpose: 'test', question: 'late' }, { originId: 7, objective: 'x', run: 1, generation: gen, taskId: 't1' });
  assert.strictEqual(late.ok, false); assert.match(late.text, /stopped/);
});

test('finish_task is a proposal: refused while requests are open, accepted from the lead once reconciled', () => {
  const { L } = ledger();
  const { request } = ask(L, 'claude');
  assert.match(L.finish('claude', 'All good').text, /r1 is still open/);
  L.markDelivered([request.id], 'codex'); L.resolveDelivered('codex', 5);
  assert.match(L.finish('codex', 'done').text, /lead/);
  const ok = L.finish('claude', 'Stop path verified; one finding.');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(L.get('t1').status, 'completed'); assert.strictEqual(L.get('t1').summary, 'Stop path verified; one finding.');
});

test('a new human run does not start a second task while one is active; it joins the active task', () => {
  const { L } = ledger();
  ask(L, 'claude');
  const r = L.requestAssistance('codex', { to: 'claude', purpose: 'challenge', question: 'Is that right?' }, { originId: 9, objective: 'other', run: 2 });
  assert.strictEqual(r.request.task, 't1'); assert.strictEqual(L.tasks.length, 1);
});

test('Chat mode allows one consultation per human message and starts no task', () => {
  const { L } = ledger({ mode: 'chat' });
  assert.strictEqual(ask(L, 'claude').ok, true);
  assert.strictEqual(L.active(), null);
  assert.match(ask(L, 'codex', { question: 'back?' }).text, /Chat mode/);
  assert.strictEqual(L.requestAssistance('claude', { to: 'codex', purpose: 'review', question: 'q2' }, { originId: 8, objective: 'y', run: 2 }).ok, true);
});

test('presets set visible allowances and never touch permissions', () => {
  const { L } = ledger();
  ask(L, 'claude');
  L.setLimits(PRESETS.economy);
  assert.deepStrictEqual(Object.keys(PRESETS.thorough).sort(), ['minutes', 'reserve', 'turns']);
  assert.strictEqual(L.active().limits.turns, PRESETS.economy.turns);
});

test('the ledger round-trips through JSON and keeps consumption and state', () => {
  const { L, now } = ledger();
  const { request } = ask(L, 'claude'); L.recordTurn('codex'); now.add(5000);
  const copy = new TaskLedger({ now, agents: ['claude', 'codex'], state: JSON.parse(JSON.stringify(L.state)) });
  assert.strictEqual(copy.active().used.turns, 1);
  assert.strictEqual(copy.active().requests[0].id, request.id);
  assert.strictEqual(copy.requestAssistance('codex', { to: 'claude', purpose: 'test', question: 'n' }, { originId: 7, objective: 'x', run: 1 }).request.id, 'r2');
});

test('old saved rooms without a task ledger load cleanly', () => {
  const L = new TaskLedger({ agents: ['claude', 'codex'], state: undefined });
  assert.deepStrictEqual(L.tasks, []); assert.strictEqual(L.active(), null);
});

test('no bouncing: an agent answering a request from X cannot send X a new request until it has replied', () => {
  const { L } = ledger();
  const { request } = ask(L, 'claude');
  L.markDelivered([request.id], 'codex');
  const bounce = ask(L, 'codex', { question: 'Can you check line 5 independently?' });
  assert.strictEqual(bounce.ok, false); assert.match(bounce.text, /answering r1 from Claude/);
  L.resolveDelivered('codex', 3);
  assert.strictEqual(ask(L, 'codex', { question: 'Now a separate question' }).ok, true); // after replying, fine
});
