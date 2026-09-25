'use strict';
// RoomSession.boot, the path New Room and Reopen take, with the CLIs and VS Code stubbed. Room unit tests do not
// cover it: a new room (no saved state) crashed here in the native run of 572138e.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');

let experimentalAgents, acpBehavior;
const acpStarts = [];
class FakeAcp {
  constructor(o) { this.o = o; this.capabilities = { loadSession: true }; this.calls = []; this.stops = 0; }
  async start() { acpStarts.push(this.o); this.calls.push('start'); if (!acpBehavior) throw new Error('synthetic missing agent'); acpBehavior.client = this; if (acpBehavior.start) await acpBehavior.start(); }
  async newSession() { this.calls.push('new'); if (acpBehavior.new) await acpBehavior.new(); this.sessionId = 'gemini-new'; }
  async loadSession(id) { this.calls.push('load'); if (acpBehavior.load) await acpBehavior.load(); this.sessionId = id; }
  stop() { this.stops++; }
}
const stubs = {
  vscode: { workspace: { getConfiguration: () => ({ get: (key) => key === 'experimentalAgents' ? experimentalAgents : undefined, inspect: (key) => key === 'experimentalAgents' && experimentalAgents !== undefined ? { workspaceValue: experimentalAgents } : undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: true },
    ConfigurationTarget: { Global: 1 }, window: {}, commands: { executeCommand: async () => {} }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } },
};
let fakeThreadSeq = 0;
let resumeFailure = null; // set by a test: what FakeCodex.resumeThread throws
class FakeCodex { constructor(o) { this.o = o; this.lastTurnUsage = null; } async start() {} on() {} async startThread() { return { id: `th-new-${++fakeThreadSeq}` }; } async resumeThread(id) { if (resumeFailure) throw resumeFailure; return { id }; } async forkThread() { return { id: `th-fork-${++fakeThreadSeq}` }; }
  async recentMessages() { return [{ role: 'human', text: 'CODEX_SEED_PRIVATE' }]; } async setName() {} async listModels() { return []; } async rateLimits() { return null; } async listThreads() { return []; } stop() {} }
class FakeClaude { constructor(o) { Object.assign(this, o); this.totalCostUsd = 0; this.lastUsage = null; this.typed = true; } stop() {} setOptions() {} }
const fakes = {
  [path.join(__dirname, '../src/claudeHistory.js')]: { ROOT: os.tmpdir(), recentMessages: () => [{ role: 'human', text: 'CLAUDE_SEED_PRIVATE' }] },
  [path.join(__dirname, '../src/acpClient.js')]: { AcpClient: FakeAcp },
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

test('experimental profiles: off by default, only known Gemini accepted once, malformed settings ignored', async () => {
  const run = async (value) => {
    experimentalAgents = value; acpStarts.length = 0;
    let s;
    try { s = new RoomSession(context(), newMeta('profile check'), null); await s.boot(); return acpStarts.slice(); }
    finally { if (s) s.dispose(); experimentalAgents = undefined; }
  };
  assert.deepStrictEqual(await run(undefined), []);
  for (const value of ['gemini', {}, ['constructor', 'toString', '__proto__'], [{ id: 'gemini', command: '/unexpected' }]]) {
    assert.deepStrictEqual(await run(value), [], 'invalid profile input cannot start an agent');
  }
  const got = await run(['gemini', 'gemini', 'unknown']);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].exe, 'gemini');
  assert.deepStrictEqual(got[0].args, ['--experimental-acp']);
});


const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

for (const phase of ['start', 'new', 'load']) test(`closing during ACP ${phase} owns and stops the pending client; late completion cannot revive boot`, async () => {
  const entered = deferred(), release = deferred();
  experimentalAgents = ['gemini'];
  acpBehavior = { [phase]: async () => { entered.resolve(); await release.promise; } };
  const meta = newMeta(`close during ${phase}`);
  if (phase === 'load') meta.extra = { gemini: { sessionId: 'gemini-saved' } };
  const s = new RoomSession(context(), meta, null);
  const boot = s.boot();
  try {
    await entered.promise;
    const client = acpBehavior.client;
    s.dispose(); const stoppedAtClose = client.stops;
    // A late boot/save must not overwrite newer data after the room has been disposed.
    fs.writeFileSync(s.file, 'SYNTHETIC_AFTER_CLOSE');
    release.resolve(); await boot;
    await s.boot(); // disposal is permanent, even if a caller tries to boot this object again
    assert.ok(stoppedAtClose > 0, 'the pending client is stopped at close, before its await resolves');
    assert.strictEqual(s.room, undefined);
    assert.strictEqual(s.scheduler, undefined);
    assert.strictEqual(s.extras.length, 0);
    assert.deepStrictEqual(client.calls, phase === 'start' ? ['start'] : ['start', phase]);
    s.save();
    assert.strictEqual(fs.readFileSync(s.file, 'utf8'), 'SYNTHETIC_AFTER_CLOSE');
  } finally {
    release.resolve(); await boot.catch(() => {}); s.dispose();
    experimentalAgents = undefined; acpBehavior = undefined;
  }
});

for (const side of ['codex', 'claude']) test(`Join Existing: ${side} history reaches only the named peer, and Keep private seeds nothing`, async () => {
  experimentalAgents = ['gemini']; acpBehavior = {};
  const opts = side === 'codex' ? { forkFrom: { id: 'source-codex' } } : { claudeFrom: { id: 'source-claude', path: '/synthetic' } };
  const marker = side === 'codex' ? 'CODEX_SEED_PRIVATE' : 'CLAUDE_SEED_PRIVATE';
  const peer = side === 'codex' ? 'claude' : 'codex';
  const opened = [];
  try {
    for (const share of [true, false]) {
      const s = new RoomSession(context(), newMeta('join consent'), null); opened.push(s);
      await s.boot({ ...opts, shareSeed: { [side]: share } });
      assert.strictEqual(s.room.payloadFor(peer).text.includes(marker), share);
      assert.ok(!s.room.payloadFor('gemini').text.includes(marker));
      assert.ok(!s.room.payloadFor(side).text.includes(marker));
      if (!share) assert.ok(!JSON.stringify(s.room.state.transcript).includes(marker));
    }
  } finally { for (const s of opened) s.dispose(); experimentalAgents = undefined; acpBehavior = undefined; }
});

test('a booted room holds its cross-window lock until it closes, and a second window is refused meanwhile', async () => {
  const roomLock = require('../src/roomLock');
  const ctx = context(), s = new RoomSession(ctx, newMeta('locked'), null);
  await s.boot();
  const lock = roomLock.lockPath(s.file);
  assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.strictEqual(roomLock.acquire(s.file, { self: process.pid + 100000, kill: () => {} }).ok, false, 'another window sees it held');
  s.dispose();
  assert.ok(!fs.existsSync(lock), 'closing releases it');
});

test('reopen: a Codex thread that was never written starts fresh when the seat never spoke, and fails when it did', async () => {
  const noRollout = Object.assign(new Error('Codex room permissions could not be verified: thread/resume failed.'), { roomPermission: true, noRollout: true });
  try {
    resumeFailure = noRollout;
    const meta = { ...newMeta('closed early'), codexThreadId: 'th-never-written', claudeSessionId: null };
    const quiet = new RoomSession(context(), meta, { transcript: [{ id: 1, from: 'human', text: 'hi', ts: 1 }, { id: 2, from: 'codex', kind: 'history', text: 'seeded', ts: 2 }], cursors: { claude: 0, codex: 0 }, lastTargets: ['claude'], seq: 2 });
    await quiet.boot();
    assert.notStrictEqual(quiet.slots.codex.seat.sessionId, 'th-never-written', 'a fresh thread replaced the unwritten one');
    assert.match(quiet.slots.codex.seat.sessionId, /^th-new-/);
    quiet.dispose();

    const meta2 = { ...newMeta('talked'), codexThreadId: 'th-lost', claudeSessionId: null };
    const spoke = new RoomSession(context(), meta2, { transcript: [{ id: 1, from: 'codex', text: 'an answer', ts: 1 }], cursors: { claude: 0, codex: 1 }, lastTargets: ['codex'], seq: 1 });
    const r1 = await spoke.boot().then(() => { spoke.dispose(); return new Error('booted'); }, (e) => e); // never leave a live room behind
    assert.match(r1.message, /thread\/resume failed/, 'history was expected: refuse instead of starting over');

    resumeFailure = Object.assign(new Error('Codex room permissions could not be verified: thread/resume failed.'), { roomPermission: true, noRollout: false });
    const other = new RoomSession(context(), { ...newMeta('other'), codexThreadId: 'th-x', claudeSessionId: null }, { transcript: [], cursors: { claude: 0, codex: 0 }, lastTargets: ['claude'], seq: 0 });
    const r2 = await other.boot().then(() => { other.dispose(); return new Error('booted'); }, (e) => e);
    assert.match(r2.message, /thread\/resume failed/, 'other resume failures still fail');
  } finally { resumeFailure = null; }
});
