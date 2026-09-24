'use strict';
// ACP adapter against a fake ACP agent over real stdio pipes (a node child process). No model, no network.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { AcpClient } = require('../src/acpClient');
const { Room } = require('../src/room');
const agent = () => new AcpClient({ exe: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-acp-agent.js')], cwd: __dirname, label: 'Gemini' });

test('ACP: initialize, new session, streamed reply, thinking and tool activity', async () => {
  const a = agent(); await a.start(); await a.newSession();
  const acts = [], drafts = [];
  const reply = await a.send('ping', (d) => drafts.push(d), (x) => acts.push(x.label));
  assert.strictEqual(reply, 'Hello you said: ping');
  assert.ok(acts.includes('thinking') && acts.includes('Reading queue.js'));
  assert.strictEqual(drafts[drafts.length - 1], 'Hello you said: ping');
  a.stop();
});

test('ACP: every permission request is rejected, and file access is refused', async () => {
  const a = agent(); await a.start(); await a.newSession();
  assert.match(await a.send('please write the file'), /"outcome":"selected","optionId":"no"/);
  assert.match(await a.send('fsread'), /fs refused/);
  a.stop();
});

test('ACP: Stop sends session/cancel and the reply ends as stopped', async () => {
  const a = agent(); await a.start(); await a.newSession();
  const p = a.send('slow work'); setTimeout(() => a.interrupt(), 30);
  await assert.rejects(p, (e) => e.stopped === true);
  assert.strictEqual(await a.send('again'), 'Hello you said: again'); // same session still usable
  a.stop();
});

test('ACP: continuing a session loads it without replaying its history into a reply', async () => {
  const a = agent(); await a.start();
  await a.loadSession('sess-1');
  assert.strictEqual(await a.send('hi'), 'Hello you said: hi');
  a.stop();
});

test('ACP: the agent exiting mid-reply is a failure, and a Stop that ends in exit is a Stop', async () => {
  const a = agent(); await a.start(); await a.newSession();
  const p = a.send('slow'); a.proc.kill();
  await assert.rejects(p, (e) => !e.stopped && /exited/.test(e.message));
  const b = agent(); await b.start(); await b.newSession();
  const q = b.send('slow'); b.waiter.cancelled = true; b.proc.kill();
  await assert.rejects(q, (e) => e.stopped === true);
  a.stop(); b.stop();
});

test('ACP agent in a room: untyped, so its @claude line is a suggestion, not a dispatch', async () => {
  const g = agent(); await g.start(); await g.newSession();
  try {
    const claude = { typed: true, inbox: [], send: async (t) => { claude.inbox.push(t); return 'ok'; } };
    const room = new Room({ humanName: 'Dean', agents: { claude, codex: { typed: true, send: async () => 'x' }, gemini: g } });
    room.postFromHuman('@gemini say this back:\n@claude please look'); await new Promise((r) => setTimeout(r, 300));
    assert.ok(room.state.transcript.some((e) => e.from === 'gemini' && /you said:/.test(e.text)));
    assert.ok(room.state.transcript.some((e) => e.kind === 'suggestion' && e.suggest.from === 'gemini' && e.suggest.to === 'claude'));
    assert.strictEqual(claude.inbox.length, 1); // the human's own @claude line, never Gemini's
  } finally { g.stop(); }
});
