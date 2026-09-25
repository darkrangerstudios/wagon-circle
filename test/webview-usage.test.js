'use strict';
// The "This computer" pill opens the usage breakdown: per model, lane, thinking, cache tier and tool, for today or
// the window. Everything renders as text; nothing is posted to the host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walk, setup } = require('./fixtures/webview-dom');

const u = (fresh, cached, cacheWrite, output) => ({ fresh, cached, cacheWrite, output });
const detail = (opts) => ({ models: {}, lanes: { main: u(0, 0, 0, 0), subagent: u(0, 0, 0, 0) }, thinking: 0, tiers: null, tools: {}, toolCalls: 0, ...opts });
const local = {
  scannedAt: Date.parse('2026-09-25T10:00:00'), windowDays: 7,
  claude: {
    today: u(10, 100, 5, 20), window: u(1000, 5000, 300, 900), sessions: 3,
    detail: {
      today: detail({ models: { 'claude-opus-5-5': { ...u(10, 100, 5, 20), thinking: 7 } }, lanes: { main: u(10, 100, 5, 20), subagent: u(0, 0, 0, 0) }, thinking: 7, tiers: { h1: 5, m5: 0 }, tools: { Read: { calls: 2, chars: 1500, unsized: 1 } }, toolCalls: 2 }),
      window: detail({ models: { 'claude-opus-5-5': { ...u(900, 4000, 300, 800), thinking: 70 }, 'claude-haiku-4-5': { ...u(100, 1000, 0, 100), thinking: 0 } }, lanes: { main: u(900, 4000, 300, 800), subagent: u(100, 1000, 0, 100) }, thinking: 70, tiers: { h1: 250, m5: 50 }, tools: { Read: { calls: 40, chars: 120000, unsized: 0 }, Grep: { calls: 12, chars: 3000, unsized: 0 } }, toolCalls: 52 }),
    },
  },
  codex: { unknown: true },
};

test('the pill opens the breakdown for the window and switches to today', () => {
  const h = setup();
  h.receive({ type: 'localUsage', usage: local });
  const pill = walk(h.ids.quota).find((e) => e.tagName === 'button');
  assert.match(pill.textContent, /This computer · 7 days: Claude 7\.2k · Codex unknown/);
  pill.fire('click');
  assert.equal(h.ids.pop.hidden, false); assert.equal(h.ids.pop.dataset.for, 'usage');
  const text = h.ids.pop.textContent;
  assert.match(text, /Claude · 7\.2k tokens · 3 sessions/);
  assert.match(text, /claude-opus-5-5.*1\.2k new · 4\.0k cached · 800 out · 70 thinking/);
  assert.match(text, /claude-haiku-4-5/);
  assert.match(text, /Main conversation.*Subagents/);
  assert.match(text, /Thinking70 of 900 output tokens/);
  assert.match(text, /Cache writes250 1-hour · 50 5-minute/);
  assert.match(text, /Tool calls · 52/); assert.match(text, /Read40× · ≈120\.0k chars back/); assert.match(text, /Grep12× · ≈3\.0k chars back/);
  assert.match(text, /Codex: log format not recognised/);
  assert.match(text, /estimates in characters, not tokens/);
  h.click(h.ids.pop, 'Today');
  const today = h.ids.pop.textContent;
  assert.match(today, /Claude · 135 tokens/); assert.doesNotMatch(today, /sessions/);
  assert.doesNotMatch(today, /claude-haiku-4-5/); assert.doesNotMatch(today, /Subagents/); // no subagent tokens today
  assert.match(today, /Read2× · ≈1\.5k chars back \(1 unsized\)/);
  assert.equal(h.sent.filter((m) => m.type !== 'ready').length, 0); // nothing posted to the host
  pill.fire('click'); assert.equal(h.ids.pop.hidden, true); // the pill toggles
});

test('an older host without breakdowns still opens with totals and says to reload', () => {
  const h = setup();
  h.receive({ type: 'localUsage', usage: { scannedAt: local.scannedAt, windowDays: 7, claude: { today: u(1, 2, 3, 4), window: u(1, 2, 3, 4), sessions: 1 }, codex: null } });
  walk(h.ids.quota).find((e) => e.tagName === 'button').fire('click');
  assert.match(h.ids.pop.textContent, /All4 new · 2 cached · 4 out/);
  assert.match(h.ids.pop.textContent, /needs a newer Wagon Wheel host/);
  assert.match(h.ids.pop.textContent, /Codex: no local logs found/);
});

test('a refresh while open re-renders in place, and a click on the pill itself does not close it', () => {
  const h = setup();
  h.receive({ type: 'localUsage', usage: local });
  const pill = () => walk(h.ids.quota).find((e) => e.tagName === 'button');
  pill().fire('click');
  assert.match(h.ids.pop.textContent, /Tool calls · 52/);
  h.docFire('click', pill()); assert.equal(h.ids.pop.hidden, false); // the outside-click handler exempts the pill
  h.receive({ type: 'localUsage', usage: { ...local, scannedAt: local.scannedAt + 5 * 60e3, claude: { ...local.claude, detail: { ...local.claude.detail, window: { ...local.claude.detail.window, toolCalls: 53 } } } } });
  assert.equal(h.ids.pop.hidden, false); assert.match(h.ids.pop.textContent, /Tool calls · 53/);
  assert.match(h.ids.pop.textContent, /updated 10:05/);
  h.docFire('click', h.ids.log); assert.equal(h.ids.pop.hidden, true); // a click elsewhere closes it
});

test('a zero-token placeholder model (Claude Code logs "<synthetic>") is not shown as a model row', () => {
  const h = setup();
  const window = local.claude.detail.window;
  h.receive({ type: 'localUsage', usage: { ...local, claude: { ...local.claude, detail: { ...local.claude.detail, window: { ...window, models: { ...window.models, '<synthetic>': { ...u(0, 0, 0, 0), thinking: 0 } } } } } } });
  walk(h.ids.quota).find((e) => e.tagName === 'button').fire('click');
  assert.match(h.ids.pop.textContent, /claude-opus-5-5/); assert.match(h.ids.pop.textContent, /claude-haiku-4-5/);
  assert.doesNotMatch(h.ids.pop.textContent, /<synthetic>/);
});
