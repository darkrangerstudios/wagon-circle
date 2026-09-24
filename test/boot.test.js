'use strict';
// RoomSession.boot, the path New Room and Reopen take, with the CLIs and VS Code stubbed. Room unit tests do not
// cover it: a new room (no saved state) crashed here in the native run of 572138e.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');

const stubs = {
  vscode: { workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: true },
    ConfigurationTarget: { Global: 1 }, window: {}, commands: { executeCommand: async () => {} }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } },
};
class FakeCodex { constructor(o) { this.o = o; this.lastTurnUsage = null; } async start() {} on() {} async startThread() { return { id: 'th-new' }; } async resumeThread(id) { return { id }; } async forkThread() { return { id: 'th-fork' }; }
  async setName() {} async listModels() { return []; } async rateLimits() { return null; } async listThreads() { return []; } stop() {} }
class FakeClaude { constructor(o) { Object.assign(this, o); this.totalCostUsd = 0; this.lastUsage = null; this.typed = true; } stop() {} setOptions() {} }
const fakes = {
  [path.join(__dirname, '../src/codexClient.js')]: { CodexClient: FakeCodex, FORBIDDEN: new Set() },
  [path.join(__dirname, '../src/claudeClient.js')]: { ClaudeClient: FakeClaude, READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep'] },
  [path.join(__dirname, '../src/claudeBinary.js')]: { findClaude: () => ({ path: 'claude', version: [2, 1, 281] }), atLeast: () => true },
  [path.join(__dirname, '../src/claudeUsage.js')]: { fetch: async () => null, blockFor: () => null },
};
const realLoad = Module._load;
Module._load = function (req, parent, ...a) {
  if (req === 'vscode') return stubs.vscode;
  const file = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
  if (file && fakes[file]) return fakes[file];
  return realLoad.call(this, req, parent, ...a);
};
delete require.cache[require.resolve('../src/extension')];
const { RoomSession, newMeta } = require('../src/extension');
Module._load = realLoad;

const context = () => ({ globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'wwboot-')) } });

test('New Room: a room with no saved state boots, starts on the current rules and shows no upgrade notice', async () => {
  const s = new RoomSession(context(), newMeta('fresh'), null);
  await s.boot();
  assert.ok(s.room);
  assert.strictEqual(s.meta.codexTyped, true);
  assert.strictEqual(s.meta.handoffRule, 4);
  assert.ok(!s.room.state.transcript.some((e) => /is now Wagon Wheel/.test(e.text)));
  assert.ok(fs.existsSync(s.file), 'saved');
  s.dispose();
});

test('Reopen: an older room with messages gets the upgrade notice once; an empty older room gets none', async () => {
  const meta = { id: 'old1', name: 'old', cwd: os.tmpdir(), codexThreadId: 'th-old', claudeSessionId: null, handoffRule: 2 };
  const state = { transcript: [{ id: 1, from: 'human', text: 'hi', ts: 1, to: ['claude'] }], cursors: { claude: 1, codex: 0 }, lastTargets: ['claude'], seq: 1 };
  const s = new RoomSession(context(), meta, state);
  await s.boot();
  assert.strictEqual(s.room.state.transcript.filter((e) => /is now Wagon Wheel/.test(e.text)).length, 1);
  assert.strictEqual(s.meta.handoffRule, 4);
  s.dispose();
  const empty = new RoomSession(context(), { id: 'old2', name: 'e', cwd: os.tmpdir(), codexThreadId: 'th-old', claudeSessionId: null }, null);
  await empty.boot();
  assert.strictEqual(empty.room.state.transcript.length, 0);
  empty.dispose();
});
