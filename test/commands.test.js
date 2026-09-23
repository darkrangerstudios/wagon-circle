'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { specs, parse } = require('../src/commands');
const ctx = { codexModels: [{ id: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }, { id: 'gpt-5.5', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], codexModel: 'gpt-6-astra' };

test('commands are grouped Room, Claude, Codex with live Codex options', () => {
  const s = specs(ctx);
  assert.deepStrictEqual([...new Set(s.map((x) => x.group))], ['Room', 'Claude', 'Codex']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/codex model').args, ['gpt-6-astra', 'gpt-5.5']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/codex effort').args, ['low', 'ultra']);
});

test('parse picks the longest command and validates arguments', () => {
  const s = specs(ctx);
  assert.deepStrictEqual([parse('/claude effort max', s).spec.cmd, parse('/claude effort max', s).arg], ['/claude effort', 'max']);
  assert.match(parse('/codex effort turbo', s).error, /accepts: low, ultra/);
  assert.match(parse('/claude effort', s).error, /needs a value/);
  assert.strictEqual(parse('/claude model claude-opus-5-5', s).arg, 'claude-opus-5-5'); // any Claude model id allowed
  assert.match(parse('/nope', s).error, /Unknown command/);
  assert.strictEqual(parse('/stop', s).spec.cmd, '/stop');
});
