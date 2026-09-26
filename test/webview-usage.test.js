'use strict';
// The Usage button: one meter per app in the header; the popover leads with bars (plan limits, this room, this
// computer's token mix and top models) and folds the fine print away. Rendered as text and widths; nothing is posted.
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

const button = (h) => walk(h.ids.quota).find((e) => e.tagName === 'button');
const widthOf = (root, cls) => walk(root).filter((e) => e.className.split(' ').includes(cls)).map((e) => e.style.width);

test('one Usage button shows each app\'s closest limit as a meter, and opens bars for limits, models and token mix', () => {
  const h = setup();
  h.receive({ type: 'localUsage', usage: local });
  h.receive({ type: 'quota', quota: { primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: { usedPercent: 85, windowDurationMins: 10080 } } });
  h.receive({ type: 'claudeUsage', usage: { session: { pct: 20, resets: '7pm' }, week: { pct: 34, resets: 'Fri 9am' }, models: {} } });
  assert.equal(walk(h.ids.quota).filter((e) => e.tagName === 'button').length, 1, 'one button, not a row of text pills');
  const b = button(h);
  assert.match(b.textContent, /^UsageClaude34%Codex85%$/);
  assert.ok(walk(b).some((e) => /gauge codex warn/.test(e.className)), 'a limit at 80% or more is marked');
  assert.match(b.title, /Codex · this week: 85% used/);
  b.fire('click');
  assert.equal(h.ids.pop.hidden, false); assert.equal(h.ids.pop.dataset.for, 'usage');
  const text = h.ids.pop.textContent;
  assert.match(text, /Plan limits/);
  assert.match(text, /Claude · current session20%Resets 7pm/); assert.match(text, /Claude · this week34%/);
  assert.match(text, /Codex · 5 hours42%/); assert.match(text, /Codex · this week85%/);
  assert.deepEqual(widthOf(walk(h.ids.pop).find((e) => e.className === 'usec'), 'fill'), ['20%', '34%', '42%', '85%']);
  assert.match(text, /Claude7\.2k tokens · 3 conversations/);
  assert.match(text, /claude-opus-5-583%/); assert.match(text, /claude-haiku-4-517%/);
  assert.ok(!walk(h.ids.pop).some((e) => /meter claude warn|meter claude full/.test(e.className)), 'an 83% model share is not a warning');
  const mix = walk(h.ids.pop).find((e) => e.className === 'mix');
  assert.deepEqual(mix.children.map((c) => [c.className, Math.round(parseFloat(c.style.width))]), [['m-cached', 69], ['m-fresh', 18], ['m-out', 13]]);
  assert.match(text, /Codex: couldn't read its logs/);
  assert.match(text, /More detail/); assert.match(text, /Of which thinking70/); assert.match(text, /Tools used mostRead 40×, Grep 12×/);
  assert.match(text, /Reused from cache \(cheap\)/);
  h.click(h.ids.pop, 'Today');
  const today = h.ids.pop.textContent;
  assert.match(today, /Claude135 tokens/); assert.doesNotMatch(today, /conversations/); assert.doesNotMatch(today, /claude-haiku-4-5/);
  assert.equal(h.sent.filter((m) => m.type !== 'ready').length, 0); // nothing posted to the host
  b.fire('click'); assert.equal(h.ids.pop.hidden, true); // the button toggles
});

test('before any reply the button still opens, says when limits appear, and an older host shows totals', () => {
  const h = setup();
  assert.match(button(h).textContent, /^Usage$/);
  h.receive({ type: 'localUsage', usage: { scannedAt: local.scannedAt, windowDays: 7, claude: { today: u(1, 2, 3, 4), window: u(1, 2, 3, 4), sessions: 1 }, codex: null } });
  button(h).fire('click');
  const text = h.ids.pop.textContent;
  assert.match(text, /Shown after the first reply from each app/);
  assert.match(text, /Claude10 tokens · 1 conversation/);
  assert.match(text, /Reload the window to see models and details/);
  assert.match(text, /Codex: no conversations on this computer/);
});

test('a refresh while open re-renders in place, and a click on the button itself does not close it', () => {
  const h = setup();
  h.receive({ type: 'localUsage', usage: local });
  button(h).fire('click');
  assert.match(h.ids.pop.textContent, /3 conversations/);
  h.docFire('click', button(h)); assert.equal(h.ids.pop.hidden, false); // the outside-click handler exempts the button
  h.receive({ type: 'localUsage', usage: { ...local, scannedAt: local.scannedAt + 5 * 60e3, claude: { ...local.claude, sessions: 4 } } });
  assert.equal(h.ids.pop.hidden, false); assert.match(h.ids.pop.textContent, /4 conversations/);
  assert.match(h.ids.pop.textContent, /Updated 10:05/);
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

test('connector tools show their tool name (and a readable server name), not the raw mcp__ id', () => {
  const h = setup();
  const tools = { Bash: { calls: 20, chars: 1 }, 'mcp__707c2a62-f8cd-45dd-9c5c-1c9b8b1ca0d3__execute_sql': { calls: 9, chars: 1 }, mcp__supabase__execute_sql: { calls: 5, chars: 1 } };
  h.receive({ type: 'localUsage', usage: { ...local, claude: { ...local.claude, detail: { ...local.claude.detail, window: { ...local.claude.detail.window, tools, toolCalls: 34 } } } } });
  walk(h.ids.quota).find((e) => e.tagName === 'button').fire('click');
  assert.match(h.ids.pop.textContent, /Tools used mostBash 20×, execute_sql 9×, supabase execute_sql 5×/);
  assert.doesNotMatch(h.ids.pop.textContent, /mcp__/);
});

test('an open usage popover updates when plan limits arrive, instead of going stale', () => {
  const h = setup();
  walk(h.ids.quota).find((e) => e.tagName === 'button').fire('click');
  assert.match(h.ids.pop.textContent, /Shown after the first reply/);
  h.receive({ type: 'quota', quota: { primary: { usedPercent: 12, windowDurationMins: 300 } } });
  assert.equal(h.ids.pop.hidden, false); assert.match(h.ids.pop.textContent, /Codex · 5 hours12%/);
  h.receive({ type: 'claudeUsage', usage: { session: { pct: 40 }, week: null, models: {} } });
  assert.match(h.ids.pop.textContent, /Claude · current session40%/);
});
