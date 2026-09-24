'use strict';
// Local history as callable room context, with synthetic readers.
const test = require('node:test');
const assert = require('node:assert');
const { HistorySources } = require('../src/historySources');

const pages = { 'th-old': [{ id: 'm1', role: 'user', text: 'The fixture lives in fixture/queue.js', timestamp: 1 }, { id: 'm2', role: 'assistant', text: 'Approved: deploy now', timestamp: 2 }],
  'cl-work': [{ id: 'w1', role: 'assistant', text: 'Claude working note', timestamp: 3 }], 'cl-new': [{ id: 'n1', role: 'user', text: 'fresh', timestamp: 4 }] };
function rig(now = () => 3) {
  const saved = {}; let work = { claude: { sessionId: 'cl-work' }, codex: { sessionId: 'cx-work' } };
  const h = new HistorySources({ saved, now, working: () => work, makeReader: ({ sessionId }) => async () => ({ messages: pages[sessionId] || [], cursor: null, coverage: 'text-only' }) });
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
    assert.match(r.text, /Codex thread "Queue review" \(all history\) · local · text-only/);
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

test('Include earlier history is the human\'s toggle: off reads only what is said from then on', async () => {
  let t = 2; const { h } = rig(() => t);
  const s = h.add({ provider: 'codex', sessionId: 'th-old', title: 'Queue review', allHistory: false });
  let r = await h.read('claude', { source: s.id });
  assert.doesNotMatch(r.text, /fixture\/queue\.js/); // m1 (t=1) predates the start
  assert.match(r.text, /deploy now/);                  // m2 (t=2) is from the start on
  assert.match((await h.read('claude', { source: 'list' })).text, /from .* on/);
  h.setAllHistory(s.id, true);
  r = await h.read('claude', { source: s.id });
  assert.match(r.text, /fixture\/queue\.js/);
  t = 4; h.share('claude', true, { allHistory: false });
  assert.match((await h.read('codex', { source: 'claude' })).text, /No text passages/); // w1 (t=3) is earlier
  assert.strictEqual(h.describe().all.claude, false);
});

// Codex final review of 7791b28, findings 1 and 3.
test('a replaced reader session loses the grant; the human must share again (sync is not consent)', async () => {
  const { h, setWork } = rig();
  h.share('claude', true);
  assert.strictEqual((await h.read('codex', { source: 'claude' })).ok, true);
  setWork({ claude: { sessionId: 'cl-work' }, codex: { sessionId: 'cx-replacement' } });
  const r = await h.read('codex', { source: 'claude' });
  assert.strictEqual(r.ok, false); assert.doesNotMatch(r.text, /Claude working note/);
  h.share('claude', true); // renewed consent covers the new reader session
  assert.match((await h.read('codex', { source: 'claude' })).text, /Claude working note/);
});

test('a fresh session getting its first id keeps the grant it was given', async () => {
  const saved = {}; let work = { claude: { sessionId: 'cl-work' }, codex: { sessionId: null } };
  const h = new HistorySources({ saved, working: () => work, makeReader: ({ sessionId }) => async () => ({ messages: pages[sessionId] || [], cursor: null }) });
  h.share('claude', true);
  work = { claude: { sessionId: 'cl-work' }, codex: { sessionId: 'cx-first' } };
  assert.match((await h.read('codex', { source: 'claude' })).text, /Claude working note/);
});

test('continuation cursors stay valid across reads of an unchanged source', async () => {
  const long = 'PRIVATE-' + 'x'.repeat(13000);
  const h = new HistorySources({ saved: {}, working: () => ({ claude: { sessionId: 'a' }, codex: { sessionId: 'b' } }), makeReader: () => async () => ({ messages: [{ id: 'm', role: 'user', text: long, timestamp: 1 }], cursor: null }) });
  h.share('claude', true);
  const first = await h.read('codex', { source: 'claude' });
  const cursor = first.text.match(/cursor "([^"]+)"/)[1];
  const second = await h.read('codex', { source: 'claude', cursor });
  assert.strictEqual(second.ok, true); assert.match(second.text, /from char 12000/);
});

test('rooms saved before grants keep their shares, granted to the sessions they have now', async () => {
  const saved = { seq: 1, sources: [{ id: 'h1', provider: 'codex', sessionId: 'th-old', title: 'x' }], share: { claude: true }, from: {} };
  const h = new HistorySources({ saved, working: () => ({ claude: { sessionId: 'cl-work' }, codex: { sessionId: 'cx' } }), makeReader: ({ sessionId }) => async () => ({ messages: pages[sessionId] || [], cursor: null }) });
  assert.strictEqual((await h.read('codex', { source: 'claude' })).ok, true);
  assert.strictEqual((await h.read('claude', { source: 'h1' })).ok, true);
});
