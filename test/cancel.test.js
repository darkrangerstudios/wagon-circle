'use strict';
// Stop and steer at the process boundary, with the transport faked. Codex review of v0.4.3, F1.
const test = require('node:test');
const assert = require('node:assert');
const { ClaudeClient } = require('../src/claudeClient');
const { CodexClient } = require('../src/codexClient');
const tick = () => new Promise((r) => setImmediate(r));

function claudeWithFakeProc() {
  const writes = [];
  const c = new ClaudeClient({ exe: 'unused', cwd: __dirname, systemPrompt: '' });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } }, kill() {} };
  return { c, writes, users: () => writes.filter((w) => w.type === 'user') };
}
const result = (c, m) => c._onLine(JSON.stringify({ type: 'result', ...m }));

test('Claude: Stop after a steer drops the queued steer and ends the reply as stopped', async () => {
  const { c, users } = claudeWithFakeProc();
  const pending = c.send('original');
  assert.strictEqual(c.steer('new work'), true);
  c.interrupt();
  result(c, { is_error: true, subtype: 'error_during_execution' });
  await assert.rejects(pending, (e) => e.stopped === true);
  assert.strictEqual(users().length, 1); // nothing sent after Stop
  assert.strictEqual(c.steer('late'), false); // no reply open
  clearTimeout(c.intTimer);
});

test('Claude: a steer without Stop still continues the same reply', async () => {
  const { c, users } = claudeWithFakeProc();
  const pending = c.send('original');
  c.steer('new work');
  result(c, { is_error: true, subtype: 'error_during_execution' });
  assert.strictEqual(users().length, 2);
  assert.match(users()[1].message.content[0].text, /new work/);
  result(c, { result: 'finished' });
  assert.strictEqual(await pending, 'finished');
});

test('Claude: steering is refused once Stop is under way', () => {
  const { c } = claudeWithFakeProc();
  c.send('original').catch(() => {});
  c.interrupt();
  assert.strictEqual(c.steer('too late'), false);
  clearTimeout(c.intTimer);
});

function codexWithFakeRpc() {
  const c = new CodexClient({ exe: 'unused', cwd: __dirname }); const calls = []; let started;
  c.request = (method, args) => { calls.push({ method, args }); return method === 'turn/start' ? new Promise((r) => { started = r; }) : Promise.resolve({}); };
  return { c, calls, start: (id) => started({ turn: { id } }) };
}
const completed = (c, id, status) => c.emit('notification', 'turn/completed', { threadId: 'th', turn: { id, status } });
const started = (c, id) => c.emit('notification', 'turn/started', { threadId: 'th', turn: { id, status: 'inProgress' } });
const interrupts = (calls) => calls.filter((x) => x.method === 'turn/interrupt');

// Live order (codex app-server, 2026-09-24): turn/start answers with an ID, THEN turn/started; an interrupt
// between the two fails with "no active turn to interrupt".
test('Codex: Stop before the turn is live is held and sent once, when turn/started arrives', async () => {
  const { c, calls, start } = codexWithFakeRpc();
  const turn = c.runTurn('th', 'work');
  await c.interrupt();
  start('t1'); await tick();
  assert.strictEqual(interrupts(calls).length, 0); // not yet: the server would reject it
  started(c, 't1'); await tick();
  assert.deepStrictEqual(interrupts(calls).map((x) => x.args), [{ threadId: 'th', turnId: 't1' }]);
  completed(c, 't1', 'interrupted');
  await assert.rejects(turn, (e) => e.stopped === true);
});

test('Codex: held Stop also works when turn/started comes before the turn/start answer', async () => {
  const { c, calls, start } = codexWithFakeRpc();
  const turn = c.runTurn('th', 'work');
  await c.interrupt();
  started(c, 't1'); await tick();
  start('t1'); await tick();
  assert.strictEqual(interrupts(calls).length, 1);
  completed(c, 't1', 'interrupted');
  await assert.rejects(turn, (e) => e.stopped === true);
});

test('Codex: a finished turn is no longer steerable or interruptible', async () => {
  const { c, calls, start } = codexWithFakeRpc();
  const turn = c.runTurn('th', 'work'); start('t1'); started(c, 't1'); await tick();
  assert.strictEqual(await c.steer('th', 'more'), true);
  completed(c, 't1', 'completed'); await turn;
  assert.strictEqual(c.currentTurn, null);
  assert.strictEqual(await c.steer('th', 'late'), false);
  await c.interrupt();
  assert.ok(!calls.some((x) => x.method === 'turn/interrupt'));
});

test('Codex: steer before the turn is live is refused, so the room can fall back', async () => {
  const { c, start } = codexWithFakeRpc();
  const turn = c.runTurn('th', 'work');
  assert.strictEqual(await c.steer('th', 'early'), false);
  start('t1'); await tick();
  assert.strictEqual(await c.steer('th', 'still early'), false);
  started(c, 't1'); completed(c, 't1', 'completed'); await turn;
});
