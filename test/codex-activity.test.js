'use strict';
// Replays Codex app-server notification shapes (from `codex app-server generate-ts`) through runTurn. No process, no quota.
const test = require('node:test');
const assert = require('node:assert');
const { CodexClient, describeItem } = require('../src/codexClient');

test('describeItem maps Codex items to readable steps', () => {
  assert.deepStrictEqual(describeItem({ type: 'commandExecution', command: 'rg -n "hop" src/room.js' }), { phase: 'tool', label: 'running rg -n "hop" src/room.js', step: true });
  assert.strictEqual(describeItem({ type: 'fileChange', changes: [{ path: '/a/b/room.js' }] }).label, 'editing room.js');
  assert.strictEqual(describeItem({ type: 'reasoning' }).phase, 'thinking');
  assert.strictEqual(describeItem({ type: 'userMessage' }), null);
});

test('runTurn streams activity, reasoning summary and reply from notifications', async () => {
  const c = new CodexClient({ exe: 'none', cwd: '/tmp' });
  c.request = async (method) => (method === 'turn/start' ? { turn: { id: 'T1' } } : {});
  const acts = []; let draft = '';
  const done = c.runTurn('TH', 'hi', (d) => { draft = d; }, (a) => acts.push(a));
  await new Promise((r) => setImmediate(r));
  const n = (method, params) => c.emit('notification', method, { threadId: 'TH', turnId: 'T1', ...params });
  n('item/started', { item: { type: 'reasoning', id: 'r1' } });
  n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Checking the router ', summaryIndex: 0 });
  n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'for the hop cap.', summaryIndex: 0 });
  n('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'rg -n hopCap src' } });
  n('item/started', { item: { type: 'agentMessage', id: 'm1' } });
  n('item/agentMessage/delta', { itemId: 'm1', delta: 'Cap is 4.' });
  n('item/started', { item: { type: 'reasoning', id: 'x' }, threadId: 'OTHER' }); // another thread: ignored
  n('turn/completed', { turn: { id: 'T1', status: 'completed' } });
  assert.strictEqual(await done, 'Cap is 4.');
  assert.deepStrictEqual(acts.map((a) => a.label), ['waiting for the model', 'thinking', 'thinking', 'thinking', 'running rg -n hopCap src', 'writing']);
  assert.strictEqual(acts[3].thinking, 'Checking the router for the hop cap.');
  assert.strictEqual(draft, 'Cap is 4.');
});
