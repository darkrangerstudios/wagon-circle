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

test('the agent menu says which conversation it is on and offers safe ways to take it with you', () => {
  const h = setup();
  h.controls['codex-2'] = { ...h.controls['codex-2'], source: { kind: 'copy', id: 'th-users-own-1234', title: 'Plan the trip' }, own: 'th-copy-9999', session: 'th-copy-9999', typed: false };
  h.controls.claude = { ...h.controls.claude, source: { kind: 'copy', id: 'cl-src-1111', title: 'My chat' }, own: null, session: 'cl-src-1111' }; // a Claude copy before its first reply
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Checker controls');
  let t = h.ids.pop.textContent;
  assert.match(t, /Working on a copy of your conversation“Plan the trip”Your original stays exactly as it was\./);
  assert.match(t, /id: original th-users · this agent's copy th-copy-/);
  h.click(h.ids.pop, 'Copy command to open your original'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'copyResume', which: 'source' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Continue a copy yourself'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'copyResume', which: 'fork' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Move it out of the room'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'moveOut' });
  h.click(h.ids.participants, 'Research controls');
  t = h.ids.pop.textContent;
  assert.match(t, /Working on a copy of your conversation“My chat”/);
  assert.match(t, /id: original cl-src-1/); assert.doesNotMatch(t, /this agent's copy/, 'the source id is never shown as the agent\'s own');
  assert.ok(walk(h.ids.pop).filter((e) => ['Continue a copy yourself', 'Move it out of the room'].includes(e.textContent)).every((e) => e.disabled), 'no id yet: nothing to take');
  assert.match(t, /gets its id after the first reply/);
  h.controls.codex = { ...h.controls.codex, source: null, own: 'th-fresh-7777' };
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Builder controls');
  t = h.ids.pop.textContent;
  assert.match(t, /A fresh conversation started in this room\./); assert.doesNotMatch(t, /open your original/);
  assert.match(t, /id: conversation th-fresh/);
});
