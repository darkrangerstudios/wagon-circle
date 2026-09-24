'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse, blockFor } = require('../src/claudeUsage');
// Real `/usage` output from Claude Code 2.1.280, 2026-09-23.
const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Sep 23 at 7:40pm (America/Chicago)
Current week (all models): 93% used · resets Sep 25 at 10am (America/Chicago)
Current week (Fable): 100% used · resets Sep 25 at 10am (America/Chicago)

What's contributing to your limits usage?`;

test('parses session, weekly and per-model limits from /usage', () => {
  const u = parse(REAL);
  assert.deepStrictEqual(u.session, { pct: 7, resets: 'Sep 23 at 7:40pm (America/Chicago)' });
  assert.strictEqual(u.week.pct, 93);
  assert.deepStrictEqual(u.models.Fable, { pct: 100, resets: 'Sep 25 at 10am (America/Chicago)' });
});

test('a model is blocked only when its own weekly limit is used up', () => {
  const u = parse(REAL);
  assert.strictEqual(blockFor(u, 'Fable 5.1'), 'Weekly Fable limit used · resets Sep 25 at 10am (America/Chicago)');
  assert.strictEqual(blockFor(u, 'Opus 5.5'), null);
  assert.strictEqual(blockFor(null, 'Fable 5.1'), null);
});
