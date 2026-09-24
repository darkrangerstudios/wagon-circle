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
  assert.match(b.inbox[0], /\[Claude — relayed by Wagon Circle, not Dean\]\nA/);
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
