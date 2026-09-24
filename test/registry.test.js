'use strict';
// Participant registry: routing, tasks and history keyed by stable participant id, not by provider name.
const test = require('node:test');
const assert = require('node:assert');
const { Room, mentions } = require('../src/room');
const { HistorySources } = require('../src/historySources');

function typed(script) {
  const a = { typed: true, inbox: [] };
  a.send = (text, d, act, att, onTool) => { a.inbox.push(text); return new Promise((res) => setTimeout(async () => res(await (typeof script === 'function' ? script(text, a.inbox.length, onTool) : script)), 5)); };
  return a;
}
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test('a third participant is addressable, gets @all, and can be asked through a typed request', async () => {
  const claude = typed(async (t, n, tool) => { if (n === 1) await tool('request_assistance', { to: 'gemini', purpose: 'review', question: 'second opinion?' }); return 'asked Gemini'; });
  const gemini = typed('Looks right to me.'), codex = typed('x');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex, gemini } });
  assert.deepStrictEqual(mentions('@gemini and @all', room.names).sort(), ['claude', 'codex', 'gemini']);
  room.postFromHuman('review this'); await settle();
  assert.match(gemini.inbox[0], /Request r1 from Claude to you/);
  assert.match(claude.inbox[1], /Gemini — answer to your request r1/);
  assert.strictEqual(codex.inbox.length, 0);
});

test('two sessions of the same provider are separate participants with their own cursors', async () => {
  const a = typed('A'), b = typed('B');
  const room = new Room({ humanName: 'Dean', agents: { claude: a, 'claude-2': b }, labels: { 'claude-2': 'Claude (reviewer)' } });
  room.postFromHuman('@claude first'); await settle();
  room.postFromHuman('@claude-2 second'); await settle();
  assert.match(b.inbox[0], /\[Claude — relayed by Wagon Wheel, not Dean\]\nA/);
  assert.doesNotMatch(a.inbox.join('\n'), /second/);
  assert.notStrictEqual(room.state.cursors.claude, room.state.cursors['claude-2']);
});

test('an old two-agent room restores unchanged, and a participant added later starts at the present', async () => {
  const state = { transcript: [{ id: 1, from: 'human', text: 'old secret plan', ts: 1 }, { id: 2, from: 'claude', text: 'old reply', ts: 2 }], cursors: { claude: 2, codex: 0 }, lastTargets: ['claude'], seq: 2 };
  const gemini = typed('hi');
  const room = new Room({ humanName: 'Dean', state, agents: { claude: typed('c'), codex: typed('x'), gemini } });
  assert.deepStrictEqual([room.state.cursors.claude, room.state.cursors.codex, room.state.cursors.gemini], [2, 0, 2]);
  room.postFromHuman('@gemini hello'); await settle();
  assert.doesNotMatch(gemini.inbox[0], /old secret plan/);
});

test('participant ids are validated', () => {
  for (const bad of ['Both', 'all', 'human', 'x y', '9lives']) assert.throws(() => new Room({ agents: { [bad]: typed('x') } }), /Invalid participant id/);
});

test('history sharing works per participant, including a third provider', async () => {
  const saved = {};
  const h = new HistorySources({ saved, participants: [{ id: 'claude', label: 'Claude', provider: 'claude' }, { id: 'codex', label: 'Codex', provider: 'codex' }, { id: 'gemini', label: 'Gemini', provider: 'acp' }],
    working: () => ({ claude: { sessionId: 'c1' }, codex: { sessionId: 'x1' }, gemini: { sessionId: 'g1' } }),
    makeReader: ({ sessionId }) => async () => ({ messages: [{ id: 'm', role: 'assistant', text: `from ${sessionId}` }], cursor: null, coverage: 'text-only' }) });
  h.share('gemini', true);
  assert.match((await h.read('claude', { source: 'gemini' })).text, /Gemini's working session[\s\S]*from g1/);
  assert.match((await h.read('codex', { source: 'gemini' })).text, /from g1/);
  assert.strictEqual((await h.read('gemini', { source: 'gemini' })).ok, false);
});

// Rebase acceptance: the core's saved in-flight and Stop guarantees apply to every registered participant.
test('a third participant cut off mid-turn resumes from the saved snapshot without losing task consumption', async () => {
  const room = new Room({ agents: { claude: typed('x'), codex: typed('y'), gemini: { send: () => new Promise(() => {}) } } });
  room.tasks.mode = 'work';
  let saved; room.on('changed', (s) => { saved = JSON.parse(JSON.stringify(s)); });
  room.postFromHuman('@gemini inspect the fixture');
  const gemini = typed('reviewed');
  const again = new Room({ state: saved, agents: { claude: typed('x'), codex: typed('y'), gemini } });
  assert.strictEqual(again.tasks.active().status, 'paused');
  assert.strictEqual(again.tasks.active().used.turns, saved.tasks.tasks[0].used.turns);
  assert.ok(again.held.has('gemini'));
  assert.match(again.state.transcript.at(-1).text, /Gemini's last turn was cut off/);
  assert.strictEqual(gemini.inbox.length, 0);
  again.resumeTask(); await settle();
  assert.strictEqual(gemini.inbox.length, 1);
  assert.match(gemini.inbox[0], /inspect the fixture/);
  assert.strictEqual(again.tasks.active().usage.gemini.unreported, 1);
});

test('Stop of a third participant is persisted and a reopen never revives it', async () => {
  let interrupted = 0, saved;
  const room = new Room({ agents: { claude: typed('x'), codex: typed('y'), gemini: { send: () => new Promise(() => {}), interrupt() { interrupted++; } } } });
  room.tasks.mode = 'work'; room.on('changed', (s) => { saved = JSON.parse(JSON.stringify(s)); });
  room.postFromHuman('@gemini inspect slowly'); room.stopAll();
  assert.strictEqual(interrupted, 1);
  const gemini = typed('must not run');
  const again = new Room({ state: saved, agents: { claude: typed('x'), codex: typed('y'), gemini } });
  assert.strictEqual(again.held.size, 0);
  assert.strictEqual(again.tasks.get('t1').status, 'stopped');
  again.resumeTask(); await settle();
  assert.strictEqual(gemini.inbox.length, 0);
});

test('adding a third history reader does not inherit prior grants; rebinding revokes its explicit grant', async () => {
  const saved = {}, working = { claude: { sessionId: 'c1' }, codex: { sessionId: 'x1' }, gemini: { sessionId: 'g1' } };
  const opts = { saved, working: () => working, makeReader: () => async () => ({ messages: [{ id: 'm', role: 'assistant', text: 'shared evidence' }], cursor: null, coverage: 'text-only' }) };
  const first = new HistorySources(opts); first.share('claude', true);
  const second = new HistorySources({ ...opts, participants: [{ id: 'claude', label: 'Claude', provider: 'claude' }, { id: 'codex', label: 'Codex', provider: 'codex' }, { id: 'gemini', label: 'Gemini', provider: 'acp' }] });
  assert.strictEqual((await second.read('gemini', { source: 'claude' })).ok, false);
  second.share('claude', true);
  assert.strictEqual((await second.read('gemini', { source: 'claude' })).ok, true);
  working.gemini.sessionId = 'g2';
  assert.strictEqual((await second.read('gemini', { source: 'claude' })).ok, false);
  assert.strictEqual((await second.read('codex', { source: 'claude' })).ok, true);
});
