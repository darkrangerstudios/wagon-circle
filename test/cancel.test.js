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

// Codex delta review of v0.4.4, D1: the interrupt goes unanswered, so the 3-second fallback kills Claude.
// That is still the user's Stop: the cancelled request must not be resent, and the next turn must be steerable.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const { Room } = require('../src/room');

function withFakeSpawn(fn) {
  const procs = []; const realSpawn = childProcess.spawn; const realTimeout = global.setTimeout; let fire = null;
  childProcess.spawn = () => {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.writes = [];
    p.stdin = { write(s) { p.writes.push(JSON.parse(s)); }, end() {} };
    p.kill = () => p.emit('exit', null, 'SIGTERM');
    procs.push(p); return p;
  };
  global.setTimeout = (f, ms) => (ms === 3000 ? ((fire = f), 1) : realTimeout(f, ms));
  delete require.cache[require.resolve('../src/claudeClient')];
  const { ClaudeClient: Fresh } = require('../src/claudeClient'); // picks up the fake spawn
  return Promise.resolve(fn({ Fresh, procs, fireKill: () => fire() }))
    .finally(() => { childProcess.spawn = realSpawn; global.setTimeout = realTimeout; delete require.cache[require.resolve('../src/claudeClient')]; });
}
const userText = (p) => p.writes.filter((w) => w.type === 'user').map((w) => w.message.content[0].text).join('\n');

test('Claude: a Stop that has to kill the process ends as stopped, without resending the cancelled work', () => withFakeSpawn(async ({ Fresh, procs, fireKill }) => {
  const c = new Fresh({ exe: 'fake', cwd: __dirname, systemPrompt: '' });
  const room = new Room({ agents: { claude: c } });
  room.postFromHuman('@claude CANCELLED_WORK');
  room.stopAll();
  room.postFromHuman('@claude NEW_QUESTION');
  fireKill(); await tick(); await tick();
  assert.strictEqual(procs.length, 2);
  assert.doesNotMatch(userText(procs[1]), /CANCELLED_WORK/);
  assert.match(userText(procs[1]), /NEW_QUESTION/);
  assert.ok(!room.state.transcript.some((e) => e.kind === 'error'), 'a user Stop is not a failure');
  assert.ok(room.state.transcript.some((e) => /Claude stopped/.test(e.text)));
  assert.strictEqual(c.cancelling, false);
  assert.strictEqual(c.steer('REDIRECT'), true); // the new turn is steerable before its first result
  procs[1].stdout.write(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution' }) + '\n'); await tick();
  assert.match(userText(procs[1]), /REDIRECT/);
  procs[1].stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\n'); await tick(); await tick();
  assert.ok(room.state.transcript.some((e) => e.from === 'claude' && e.text === 'done'));
}));

test('Claude: a steer whose interrupt has to kill the process is redelivered with the original, not lost', () => withFakeSpawn(async ({ Fresh, procs, fireKill }) => {
  const c = new Fresh({ exe: 'fake', cwd: __dirname, systemPrompt: '' });
  const room = new Room({ agents: { claude: c } });
  room.postFromHuman('@claude ORIGINAL');
  assert.deepStrictEqual(room.steerFromHuman('STEER_TEXT').steered, ['claude']);
  fireKill(); await tick(); await tick();
  assert.ok(room.state.transcript.some((e) => e.kind === 'error'), 'a crash is a failure, not a Stop');
  assert.strictEqual(c.steerQueue.length, 0);
  // The failure makes the turn's input deliverable again; the next message carries it, steer included.
  room.postFromHuman('@claude AGAIN'); await tick();
  const sent = userText(procs[1]);
  assert.match(sent, /ORIGINAL/); assert.match(sent, /STEER_TEXT/); assert.match(sent, /AGAIN/);
}));
