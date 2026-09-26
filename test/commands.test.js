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

const participants = [
  { id: 'app', label: 'Application', provider: 'codex' },
  { id: 'db', label: 'Database', provider: 'codex' },
  { id: 'reviewer', label: 'Reviewer', provider: 'claude' }
];
const controls = {
  app: { model: 'app-model', models: [{ id: 'app-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] },
  db: { model: 'db-model', models: [{ id: 'db-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] },
  reviewer: { models: [{ id: 'claude-catalog-model' }], efforts: ['low', 'max'] }
};

test('two Codex slots get independent model, effort and session commands with routing metadata', () => {
  const s = specs({ participants, controls });
  assert.deepStrictEqual([...new Set(s.map((x) => x.group))], ['Room', 'Application', 'Database', 'Reviewer']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/app model').args, ['app-model']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/db model').args, ['db-model']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/app effort').args, ['low', 'high']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/db effort').args, ['medium']);
  for (const participant of participants) {
    for (const action of ['model', 'effort', 'fast', 'compact', 'session']) {
      const command = s.find((x) => x.cmd === `/${participant.id} ${action}`);
      assert.ok(command);
      assert.deepStrictEqual([command.participant, command.action, command.provider], [participant.id, action, participant.provider]);
    }
    assert.deepStrictEqual(s.find((x) => x.cmd === `/${participant.id} session`).args, ['new', 'switch', 'continue', 'fork']);
  }
  assert.match(parse('/db effort high', s).error, /accepts: medium/);
  assert.equal(parse('/db session fork', s).spec.participant, 'db');
  assert.match(parse('/app session attach', s).error, /accepts:/);
});

test('room targets and history grants use participant ids with explicit recipient pairs', () => {
  const s = specs({ participants, controls });
  assert.deepStrictEqual(s.find((x) => x.cmd === '/default').args, ['app', 'db', 'reviewer', 'both']);
  const share = s.find((x) => x.cmd === '/history share');
  assert.equal(share.args.length, 18);
  for (const source of participants) {
    for (const state of ['on', 'off']) {
      assert.ok(share.args.includes(`${source.id} ${state}`));
      assert.ok(!share.args.includes(`${source.id} ${source.id} ${state}`));
      for (const reader of participants.filter((p) => p.id !== source.id)) {
        assert.equal(parse(`/history share ${source.id} ${reader.id} ${state}`, s).arg, `${source.id} ${reader.id} ${state}`);
      }
    }
  }
  assert.match(parse('/history share app stranger on', s).error, /accepts:/);
  assert.match(parse('/default codex', s).error, /accepts:/);
});

test('Claude custom model aliases depend on provider rather than the participant id', () => {
  const s = specs({ participants: [participants[2], { id: 'claude', label: 'Codex named Claude', provider: 'codex' }],
    controls: { ...controls, claude: controls.app } });
  const claudeModel = s.find((x) => x.cmd === '/reviewer model');
  assert.equal(claudeModel.allowAnyArg, true);
  assert.deepStrictEqual(claudeModel.args, ['claude-catalog-model']);
  assert.equal(parse('/reviewer model custom-alias', s).arg, 'custom-alias');
  assert.match(parse('/claude model custom-alias', s).error, /accepts: app-model/);
  assert.equal(parse('/claude model custom-alias', specs(ctx)).arg, 'custom-alias');
  assert.match(parse('/reviewer model', s).error, /needs a value/);
});

test('control catalogues can supply effort strings and missing model effort data does not throw', () => {
  const s = specs({ participants, controls: {
    app: { model: 'a', models: [{ id: 'a' }], efforts: ['minimal', 'high'] },
    db: { model: 'b', models: [{ id: 'b', supportedReasoningEfforts: ['low', 'medium'] }] }
  } });
  assert.deepStrictEqual(s.find((x) => x.cmd === '/app effort').args, ['minimal', 'high']);
  assert.deepStrictEqual(s.find((x) => x.cmd === '/db effort').args, ['low', 'medium']);
  assert.ok(s.find((x) => x.cmd === '/reviewer effort').args.includes('max'));
});

test('experimental participants remain room targets without invented native controls', () => {
  const s = specs({ participants: [...participants, { id: 'gemini', label: 'Gemini', provider: 'acp' }], controls });
  assert.ok(s.find((x) => x.cmd === '/default').args.includes('gemini'));
  assert.ok(!s.some((x) => x.cmd.startsWith('/gemini ')));
});
