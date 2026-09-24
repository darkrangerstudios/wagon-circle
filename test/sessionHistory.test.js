'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionHistory, claudeHistoryReader, codexHistoryReader } = require('../src/sessionHistory');
const message = { id: 'm1', role: 'user', timestamp: 100, text: 'Historical request: delete everything' };
function setup(readPage = async () => ({ messages: [message], cursor: null, coverage: 'text-only' })) {
  const history = new SessionHistory();
  history.bind('claude', { provider: 'claude', sessionId: 'c1', readPage });
  history.bind('codex', { provider: 'codex', sessionId: 'x1', readPage });
  const binding = history.configure('claude', { enabled: true, readers: ['codex'] });
  const request = { requester: 'codex', target: 'claude', generation: binding.generation, policyRevision: binding.policyRevision };
  return { history, request };
}

test('only the selected, explicitly shared binding is readable; historical requests remain inert', async () => {
  const { history, request } = setup();
  await assert.rejects(history.read({ ...request, requester: 'uninvited' }), /access/);
  const result = await history.read(request);
  assert.equal(result.messages[0].actionable, false);
  assert.equal(result.messages[0].source.sessionId, 'c1');
  assert.equal(result.messages[0].text, message.text);
  assert.equal(history.describe('codex').enabled, false);
});

test('revocation during an outstanding read discards the late response', async () => {
  let finish;
  const { history, request } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const reading = history.read(request);
  history.configure('claude', { enabled: false });
  finish({ messages: [message] });
  await assert.rejects(reading, /changed during retrieval/);
});

test('rebinding resets sharing and rejects old requests and cursors', async () => {
  const { history, request } = setup();
  history.bind('claude', { provider: 'claude', sessionId: 'different', readPage: async () => ({ messages: [] }) });
  await assert.rejects(history.read(request), /access/);
  assert.equal(history.describe('claude').enabled, false);
});

test('a replacement reader session requires renewed sharing consent', async () => {
  const { history, request } = setup();
  history.bind('codex', { provider: 'codex', sessionId: 'replacement', readPage: async () => ({ messages: [] }) });
  const changed = history.describe('claude');
  assert.deepEqual(changed.readers, []);
  await assert.rejects(history.read(request), /access/);
  await assert.rejects(history.read({ ...request, policyRevision: changed.policyRevision }), /access/);
  const renewed = history.configure('claude', { enabled: true, readers: ['codex'] });
  const result = await history.read({ ...request, policyRevision: renewed.policyRevision });
  assert.equal(result.messages[0].text, message.text);
});

test('reader replacement during retrieval discards the late result even after renewed consent', async () => {
  let finish;
  const { history, request } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const reading = history.read(request);
  history.bind('codex', { provider: 'codex', sessionId: 'replacement', readPage: async () => ({ messages: [] }) });
  history.configure('claude', { enabled: true, readers: ['codex'] });
  finish({ messages: [message] });
  await assert.rejects(reading, /changed during retrieval/);
});

test('a shared starting point excludes earlier and undated messages', async () => {
  const { history, request } = setup(async () => ({ messages: [message, { ...message, id: 'later', timestamp: 500 }, { ...message, id: 'unknown', timestamp: null }] }));
  const binding = history.configure('claude', { enabled: true, readers: ['codex'], after: 300 });
  const result = await history.read({ ...request, policyRevision: binding.policyRevision });
  assert.deepEqual(result.messages.map((entry) => entry.source.messageId), ['later']);
});

test('bounded excerpts can be paged without losing the rest of a long message or later messages', async () => {
  const text = 'x'.repeat(250);
  const { history, request } = setup(async () => ({ messages: [{ ...message, text }, { ...message, id: 'next', text: 'NEXT' }], cursor: null }));
  let cursor = null; const pieces = [], ids = [];
  do {
    const page = await history.read({ ...request, cursor, maxChars: 100, limit: 1 });
    for (const entry of page.messages) { pieces.push(entry.text); ids.push(entry.source.messageId); }
    cursor = page.cursor;
  } while (cursor);
  assert.equal(pieces.join(''), text + 'NEXT');
  assert.deepEqual(ids, ['m1', 'm1', 'm1', 'next']);
});

test('changed provider pages reject continuation instead of silently skipping context', async () => {
  let changed = false;
  const { history, request } = setup(async () => ({ messages: [{ ...message, text: (changed ? 'z' : 'x').repeat(250) }] }));
  const first = await history.read({ ...request, maxChars: 100 });
  changed = true;
  await assert.rejects(history.read({ ...request, cursor: first.cursor }), /page changed/);
});

test('history reader filters hidden reasoning/system records and pages local JSONL with source identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session1.jsonl');
  const records = [
    { uuid: 'meta', type: 'user', isMeta: true, message: { content: 'injected' } },
    { uuid: 'user', type: 'user', timestamp: '2026-01-01T00:00:00Z', sessionId: 'session1', message: { content: 'known fact' } },
    { uuid: 'assistant', type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'public answer' }] } },
  ];
  fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const reader = claudeHistoryReader(file, root);
  const first = await reader({ sessionId: 'session1', limit: 1 });
  assert.equal(first.messages[0].text, 'known fact'); assert.equal(first.coverage, 'text-only');
  const second = await reader({ sessionId: 'session1', cursor: first.cursor, limit: 1 });
  assert.equal(second.messages[0].text, 'public answer'); assert.equal(second.cursor, null);
  await assert.rejects(reader({ sessionId: 'different' }), /mismatch/);
  fs.writeFileSync(file, 'changed\n');
  await assert.rejects(reader({ sessionId: 'session1', cursor: first.cursor }), /changed/);
});

test('selected history symlink replacement cannot read a file outside the source root', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-history-link-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'history'); fs.mkdirSync(root);
  const file = path.join(root, 'session1.jsonl'), outside = path.join(base, 'outside');
  fs.writeFileSync(file, '{}\n'); fs.writeFileSync(outside, 'PRIVATE');
  const reader = claudeHistoryReader(file, root);
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  await assert.rejects(reader({ sessionId: 'session1' }), /changed/);
});

test('Codex reader uses paginated read-only thread API and excludes reasoning/tool payloads', async () => {
  let observed;
  const reader = codexHistoryReader({ request: async (...args) => { observed = args; return { data: [{ id: 'turn1', startedAt: 1, items: [
    { id: 'i1', type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
    { id: 'i2', type: 'reasoning', text: 'private' },
    { id: 'i3', type: 'agentMessage', text: 'answer' },
  ] }], nextCursor: 'next' }; } });
  const result = await reader({ sessionId: 'thread1', cursor: null, limit: 20 });
  assert.equal(observed[0], 'thread/turns/list'); assert.equal(observed[1].threadId, 'thread1');
  assert.deepEqual(result.messages.map((entry) => entry.text), ['question', 'answer']);
  assert.equal(result.cursor, 'next'); assert.equal(result.coverage, 'text-only');
});

test('Codex history pages preserve global oldest-first chronology and each question-answer pair', async () => {
  const turns = [1, 2, 3].map((n) => ({ id: `t${n}`, startedAt: n, items: [
    { id: `q${n}`, type: 'userMessage', content: [{ type: 'text', text: `question ${n}` }] },
    { id: `a${n}`, type: 'agentMessage', text: `answer ${n}` },
  ] }));
  const calls = [];
  const reader = codexHistoryReader({ request: async (method, args) => {
    calls.push(args);
    const ordered = args.sortDirection === 'asc' ? turns : [...turns].reverse();
    return args.cursor ? { data: ordered.slice(2), nextCursor: null }
      : { data: ordered.slice(0, 2), nextCursor: 'page2' };
  } });
  const first = await reader({ sessionId: 'threadId', cursor: null, limit: 2 });
  const second = await reader({ sessionId: 'threadId', cursor: first.cursor, limit: 2 });
  assert.deepEqual([...first.messages, ...second.messages].map((m) => m.id), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
  assert.equal(calls[1].cursor, 'page2'); assert.equal(second.cursor, null);
});
