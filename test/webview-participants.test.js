'use strict';
// Actual renderer under a minimal DOM, to exercise seat routing rather than duplicate it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; this.attrs = {}; this.className = ''; this.hidden = false; this.value = ''; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this.selectionStart = 0; this._text = ''; this.classList = { add: x => { this.className += ' ' + x; }, toggle: (x, on) => { this.className = this.className.split(' ').filter(c => c !== x).concat(on ? [x] : []).join(' '); } }; }
  set textContent(x) { this._text = String(x); this.children = []; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  get lastChild() { return this.children.at(-1); }
  appendChild(e) { e.parent = this; this.children.push(e); return e; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, e = {}) { for (const fn of this.events[k] || []) fn({ preventDefault() {}, ...e }); }
  matches(s) { if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.className.split(' ').includes(c)); if (s.startsWith('#')) return this.id === s.slice(1); return this.tagName === s; }
  querySelector(s) { return walk(this).find(e => e.matches(s)) || null; }
  focus() {} scrollIntoView() {}
  setSelectionRange(a) { this.selectionStart = a; }
  remove() { this.parent.children = this.parent.children.filter(e => e !== this); }
}
function walk(e) { return e.children.flatMap(c => [c, ...walk(c)]); }
function setup() {
  const ids = Object.fromEntries(['log','input','participants','ide','deftarget','lead','quota','who','stop','send','task','tc','pop','tray','menu','title','ids','attach'].map(id => { const e = new Element(); e.id = id; return [id, e]; }));
  ids.pop.hidden = true;
  const body = new Element('body'); body.dataset.wc = require('../package.json').version; Object.values(ids).forEach(e => body.appendChild(e));
  const listeners = {}, sent = [];
  const document = { body, createElement: t => new Element(t), getElementById: id => walk(body).find(e => e.id === id), addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/room.js'), 'utf8'), { document, window: { innerHeight: 800, addEventListener: (k, fn) => { listeners[k] = fn; } }, navigator: { platform: 'Mac' }, acquireVsCodeApi: () => ({ postMessage: m => sent.push(JSON.parse(JSON.stringify(m))) }), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1 });
  const participants = [{ id: 'codex', label: 'Builder', provider: 'codex', cwd: '/fixture/app' }, { id: 'codex-2', label: 'Checker', provider: 'codex', cwd: '/fixture/review' }, { id: 'claude', label: 'Research', provider: 'claude', cwd: '/fixture/research' }];
  const controls = Object.fromEntries(participants.map(p => [p.id, { ...p, model: 'fixture-model', models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['low', 'high'] }], effort: 'low', efforts: ['low', 'max'], session: p.id + '-thread', typed: true, readers: participants.filter(r => r.id !== p.id).map(r => ({ id: r.id, label: r.label, shared: false })) }]));
  const meta = { name: 'Fixture', participants, defaultTarget: 'codex-2' };
  const receive = m => listeners.message({ data: m }); receive({ type: 'init', meta, controls, transcript: [] });
  const click = (root, label) => { const b = walk(root).find(e => e.tagName === 'button' && (e.textContent === label || e.attrs['aria-label'] === label)); assert.ok(b, `button ${label}`); b.fire('click'); };
  return { ids, body, sent, receive, meta, controls, click };
}
test('same-provider controls route model, session and history to the named seat', () => {
  const h = setup(); assert.equal(h.ids.participants.children.length, 3);
  h.click(h.ids.participants, 'Checker controls'); assert.match(h.ids.pop.textContent, /Codex app-server/); assert.match(h.ids.pop.textContent, /\/fixture\/review/);
  h.click(h.ids.pop, 'high'); assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/codex-2 effort high' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Fork…'); assert.deepEqual(h.sent.at(-1), { type: 'session', vendor: 'codex-2', action: 'fork' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Share Checker history with Research'); assert.deepEqual(h.sent.at(-1), { type: 'historyShare', source: 'codex-2', reader: 'claude', on: true });
  h.receive({ type: 'status', name: 'codex-2', busy: true }); h.click(h.ids.participants, 'Checker controls');
  assert.ok(walk(h.ids.pop).filter(e => ['New','Continue…','Fork…'].includes(e.textContent)).every(e => e.disabled));
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
  assert.equal(h.ids.quota.children.filter(e => e.textContent.startsWith('Codex 5h')).length, 1);
  assert.match(h.ids.quota.textContent, /Builder · last turn 10 new, 20 cached/); assert.match(h.ids.quota.textContent, /Checker · last turn 30 new, 40 cached/);
  h.receive({ type: 'init', meta: h.meta, controls: h.controls, participantUsage: { 'codex-2': { fresh: 50, cached: 60, cacheWrite: 0, output: 7 } } });
  assert.match(h.ids.quota.textContent, /Checker · last turn 50 new, 60 cached/); assert.doesNotMatch(h.ids.quota.textContent, /Builder · last turn/);
  h.receive({ type: 'message', entry: { from: 'codex-2', text: 'Independent answer', ts: Date.now() } });
  assert.equal(h.ids.log.children.at(-1).dataset.participant, 'codex-2'); assert.match(h.ids.log.children.at(-1).className, /codex/); assert.match(h.ids.log.textContent, /Checker/);
});
