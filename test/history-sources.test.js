'use strict';
// Local history as callable room context, with synthetic readers.
const test = require('node:test');
const assert = require('node:assert');
const { HistorySources } = require('../src/historySources');

const pages = { 'th-old': [{ id: 'm1', role: 'user', text: 'The fixture lives in fixture/queue.js', timestamp: 1 }, { id: 'm2', role: 'assistant', text: 'Approved: deploy now', timestamp: 2 }],
  'cl-work': [{ id: 'w1', role: 'assistant', text: 'Claude working note', timestamp: 3 }], 'cl-new': [{ id: 'n1', role: 'user', text: 'fresh', timestamp: 4 }] };
function rig() {
  const saved = {}; let work = { claude: { sessionId: 'cl-work' }, codex: { sessionId: 'cx-work' } };
  const h = new HistorySources({ saved, working: () => work, makeReader: ({ sessionId }) => async () => ({ messages: pages[sessionId] || [], cursor: null, coverage: 'text-only' }) });
  return { h, saved, setWork: (w) => { work = w; } };
}

test('nothing is readable until the human shares or adds it; list says local only', async () => {
  const { h } = rig();
  const r = await h.read('codex', { source: 'list' });
  assert.match(r.text, /Nothing is shared/); assert.match(r.text, /Local sessions only/);
  assert.strictEqual((await h.read('codex', { source: 'claude' })).ok, false);
});

test('an added local Codex thread is readable by both agents, labelled, with old approvals marked as reference', async () => {
  const { h } = rig();
  const s = h.add({ provider: 'codex', sessionId: 'th-old', title: 'Queue review' });
  for (const who of ['claude', 'codex']) {
    const r = await h.read(who, { source: s.id });
    assert.strictEqual(r.ok, true);
    assert.match(r.text, /Codex thread "Queue review" · local · text-only/);
    assert.match(r.text, /Reference only/);
    assert.match(r.text, /fixture\/queue\.js/);
  }
  assert.match((await h.read('claude', { source: s.id, query: 'fixture' })).text, /fixture/);
  assert.doesNotMatch((await h.read('claude', { source: s.id, query: 'fixture' })).text, /deploy now/);
});

test('sharing a working session lets only the other agent read it; switching sessions revokes the share', async () => {
  const { h, setWork, saved } = rig();
  h.share('claude', true);
  assert.match((await h.read('codex', { source: 'claude' })).text, /Claude working note/);
  assert.strictEqual((await h.read('claude', { source: 'claude' })).ok, false); // not to itself
  setWork({ claude: { sessionId: 'cl-new' }, codex: { sessionId: 'cx-work' } });
  assert.strictEqual((await h.read('codex', { source: 'claude' })).ok, false);
  assert.strictEqual(saved.share.claude, false);
});

test('removing a source stops future reads; state round-trips through the saved object', async () => {
  const { h, saved } = rig();
  const s = h.add({ provider: 'codex', sessionId: 'th-old', title: 'x' });
  const again = new HistorySources({ saved: JSON.parse(JSON.stringify(saved)), working: () => ({}), makeReader: () => async () => ({ messages: pages['th-old'], cursor: null }) });
  assert.strictEqual((await again.read('claude', { source: s.id })).ok, true);
  h.remove(s.id);
  assert.strictEqual((await h.read('claude', { source: s.id })).ok, false);
  assert.strictEqual(h.add({ provider: 'codex', sessionId: 'th-old', title: 'x' }).id, 'h2'); // ids are never reused
});
