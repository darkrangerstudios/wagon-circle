'use strict';
// Actual renderer under a minimal DOM, to exercise seat routing rather than duplicate it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walk, setup } = require('./fixtures/webview-dom');
test('same-provider controls route model, session and history to the named seat', () => {
  const h = setup(); assert.equal(h.ids.participants.children.length, 3);
  h.click(h.ids.participants, 'Checker controls'); assert.match(h.ids.pop.textContent, /Codex on this computer/); assert.match(h.ids.pop.textContent, /\/fixture\/review/);
  h.click(h.ids.pop, 'high'); assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/codex-2 effort high' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Switch to one of your conversations…'); assert.deepEqual(h.sent.at(-1), { type: 'session', vendor: 'codex-2', action: 'switch' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Share Checker history with Research'); assert.deepEqual(h.sent.at(-1), { type: 'historyShare', source: 'codex-2', reader: 'claude', on: true });
  h.receive({ type: 'status', name: 'codex-2', busy: true }); h.click(h.ids.participants, 'Checker controls');
  const sw = walk(h.ids.pop).filter(e => ['Start over', 'Switch to one of your conversations…'].includes(e.textContent));
  assert.equal(sw.length, 2); assert.ok(sw.every(e => e.disabled));
});
test('mentions and lead selection use IDs while labels stay inert text', () => {
  const h = setup(); h.ids.input.value = '@codex-'; h.ids.input.selectionStart = 7; h.ids.input.fire('input');
  assert.equal(h.ids.menu.querySelector('.mlabel').textContent, '@codex-2'); h.ids.input.fire('keydown', { key: 'Tab' }); assert.equal(h.ids.input.value, '@codex-2 ');
  h.ids.lead.fire('click'); const b = walk(h.ids.pop).find(e => e.tagName === 'button' && e.textContent.includes('@codex-2 leads')); b.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/default codex-2' });
  h.meta.participants[1].label = '<img src=x onerror=bad()> '; h.controls['codex-2'].label = h.meta.participants[1].label;
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls }); assert.match(h.ids.participants.textContent, /<img src=x/); assert.equal(walk(h.ids.participants).filter(e => e.tagName === 'img').length, 0);
});
test('account quota stays singular and last-turn usage remains seat-specific', () => {
  const h = setup(); h.receive({ type: 'quota', quota: { primary: { usedPercent: 25, windowDurationMins: 300 } } });
  h.receive({ type: 'status', name: 'codex', busy: false, participantUsage: { fresh: 10, cached: 20, cacheWrite: 0, output: 5 } });
  h.receive({ type: 'status', name: 'codex-2', busy: false, participantUsage: { fresh: 30, cached: 40, cacheWrite: 0, output: 6 } });
  const open = () => { h.ids.pop.hidden = true; walk(h.ids.quota).find(e => e.tagName === 'button').fire('click'); return h.ids.pop.textContent; };
  assert.equal(walk(h.ids.quota).filter(e => e.tagName === 'button').length, 1);
  let t = open();
  assert.equal((t.match(/Codex · 5 hours/g) || []).length, 1, 'the account limit appears once, not per seat');
  assert.match(t, /BuilderLast reply read 30 tokens, 67% reused/i); assert.match(t, /CheckerLast reply read 70 tokens, 57% reused/i);
  h.receive({ type: 'init', meta: h.meta, controls: h.controls, participantUsage: { 'codex-2': { fresh: 50, cached: 60, cacheWrite: 0, output: 7 } } });
  t = open();
  assert.match(t, /CheckerLast reply read 110 tokens, 55% reused/i); assert.doesNotMatch(t, /Builder/);
  h.receive({ type: 'message', entry: { from: 'codex-2', text: 'Independent answer', ts: Date.now() } });
  assert.equal(h.ids.log.children.at(-1).dataset.participant, 'codex-2'); assert.match(h.ids.log.children.at(-1).className, /codex/); assert.match(h.ids.log.textContent, /Checker/);
});
