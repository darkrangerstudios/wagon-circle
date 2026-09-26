'use strict';
// Host integration with real room/history logic and synthetic CLI responses. No provider process is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wagon-local-sessions-'));
const historyRoot = path.join(root, 'history'); fs.mkdirSync(historyRoot);
let serial = 0, fixtureSerial = 0;
let codexClients = [], claudeClients = [], claudeUsageReads = [], threadChoices = [], claudeChoices = [], picks = [], warnings = [], inputs = [], folders = [];
let codexBarrier = null;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const phase = async (name, client) => { if (codexBarrier) await codexBarrier(name, client); };
function holdCodexPhase(name) {
  const entered = deferred(), released = deferred(); let used = false;
  codexBarrier = async (current, client) => { if (used || current !== name) return; used = true; entered.resolve(client); await released.promise; };
  return { entered: entered.promise, release: released.resolve };
}
const modelCatalogue = [
  { id: 'model-one', displayName: 'Model One', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] },
  { id: 'model-two', displayName: 'Model Two', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }
];

class FakeCodex {
  constructor(options) { this.options = options; this.calls = []; this.turns = []; this.quotaReads = 0; this.stops = 0; codexClients.push(this); }
  async start() { this.calls.push(['start']); await phase('start', this); }
  on() {}
  async startThread(brief) { const id = `codex-${++serial}`; this.calls.push(['new', id, brief]); await phase('thread', this); return { id }; }
  async resumeThread(id) { this.calls.push(['continue', id]); await phase('thread', this); return { id }; }
  async forkThread(id, brief) { const fork = `codex-${++serial}`; this.calls.push(['fork', id, fork, brief]); await phase('thread', this); return { id: fork }; }
  async setName(id, name) { this.calls.push(['name', id, name]); }
  async listModels() { await phase('models', this); return modelCatalogue; }
  async listThreads() { return threadChoices; }
  async rateLimits() { this.quotaReads++; return { rateLimits: { primary: { usedPercent: 20 } } }; }
  async compact(id) { this.calls.push(['compact', id]); }
  async request(method, args) {
    assert.equal(method, 'thread/turns/list');
    this.calls.push(['history', args.threadId]);
    return { data: [{ id: 'history-turn', startedAt: 1, items: [{ type: 'agentMessage', id: 'evidence', text: `HISTORY:${args.threadId}` }] }], nextCursor: null };
  }
  async runTurn(id, text, delta, activity, files, options) {
    this.turns.push({ id, text, ...options });
    this.lastTurnUsage = { fresh: 7, cached: 0, output: 3 };
    await tick();
    return this.script ? this.script(text, this.turns.length, options.onTool) : 'Synthetic Codex reply';
  }
  interrupt() { this.calls.push(['interrupt']); }
  steer() { return Promise.resolve(true); }
  stop() { this.stops++; }
}

class FakeClaude {
  constructor(options) {
    this.options = options; Object.assign(this, options);
    this.typed = true; this.turns = []; this.updates = []; this.stops = 0; this.totalCostUsd = 0;
    this.nextId = `claude-${++serial}`; claudeClients.push(this);
  }
  setOptions(options) { this.updates.push(options); Object.assign(this, options); }
  async send(text, delta, activity, files, onTool) {
    if (!this.sessionId) { this.sessionId = this.nextId; if (this.onSession) this.onSession(this.sessionId); } // as the CLI's first line does
    fs.writeFileSync(path.join(historyRoot, `${this.sessionId}.jsonl`), JSON.stringify({ type: 'assistant', uuid: 'evidence', sessionId: this.sessionId,
      message: { content: [{ type: 'text', text: `HISTORY:${this.sessionId}` }] } }) + '\n');
    this.turns.push({ text, model: this.model, effort: this.effort, onTool });
    this.lastTurnUsage = { fresh: 5, cached: 0, output: 2 };
    await tick();
    return this.script ? this.script(text, this.turns.length, onTool) : 'Synthetic Claude reply';
  }
  async compact() { this.updates.push({ compact: true }); }
  interrupt() {}
  steer() { return Promise.resolve(true); }
  stop() { this.stops++; }
}

const vscode = {
  workspace: { isTrusted: true, workspaceFolders: undefined,
    getConfiguration: () => ({ get: (key) => ({ userName: 'Human', cwd: root, ideContext: false }[key]), inspect: () => undefined, update: async () => {} }) },
  ConfigurationTarget: { Global: 1 }, commands: { executeCommand: async () => {} }, env: {}, Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    showQuickPick: async (items) => { assert.ok(picks.length, 'a picker response was planned'); return picks.shift()(items); },
    showWarningMessage: async (...args) => { warnings.push(args); return 'Continue'; },
    showInputBox: async (options) => {
      assert.ok(inputs.length, 'an input response was planned');
      const next = inputs.shift(), value = typeof next === 'function' ? next(options) : next;
      if (value !== undefined && options.validateInput) assert.equal(options.validateInput(value), null);
      return value;
    },
    showOpenDialog: async () => { assert.ok(folders.length, 'a folder response was planned'); return folders.shift(); }
  }
};
const fakes = {
  [path.join(__dirname, '../src/codexClient.js')]: { CodexClient: FakeCodex },
  [path.join(__dirname, '../src/claudeClient.js')]: { ClaudeClient: FakeClaude },
  [path.join(__dirname, '../src/claudeBinary.js')]: { findClaude: () => ({ path: 'synthetic-claude', version: [2, 1, 281] }), atLeast: () => true },
  [path.join(__dirname, '../src/claudeUsage.js')]: { fetch: async (exe, cwd) => { claudeUsageReads.push({ exe, cwd }); return null; }, blockFor: () => null },
  [path.join(__dirname, '../src/claudeHistory.js')]: { ROOT: historyRoot, listSessions: () => claudeChoices,
    fileFor: (id) => path.join(historyRoot, `${id}.jsonl`), recentMessages: () => [] }
};
const realLoad = Module._load;
let RoomSession, newMeta;
try {
  Module._load = function (request, parent, ...args) {
    if (request === 'vscode') return vscode;
    let resolved; try { resolved = Module._resolveFilename(request, parent); } catch { /* optional module */ }
    return fakes[resolved] || realLoad.call(this, request, parent, ...args);
  };
  delete require.cache[require.resolve('../src/extension')];
  ({ RoomSession, newMeta } = require('../src/extension'));
} finally { Module._load = realLoad; }

test.beforeEach(() => { codexClients = []; claudeClients = []; claudeUsageReads = []; threadChoices = []; claudeChoices = []; picks = []; warnings = []; inputs = []; folders = []; codexBarrier = null; });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(t, providers = ['codex', 'codex']) {
  const directory = path.join(root, `fixture-${++fixtureSerial}`); fs.mkdirSync(directory);
  const context = { globalStorageUri: { fsPath: path.join(directory, 'storage') } };
  const ids = ['app', 'db', 'writer', 'reviewer'];
  const seats = providers.map((provider, i) => {
    const cwd = path.join(directory, ids[i]); fs.mkdirSync(cwd);
    return { id: ids[i], label: ids[i].toUpperCase(), provider, cwd, model: provider === 'codex' ? 'model-one' : 'sonnet', effort: i % 2 ? 'high' : 'low' };
  });
  const opened = [];
  const create = (meta = { ...newMeta('Synthetic local seats'), cwd: directory, seats }, state = null) => {
    const session = new RoomSession(context, meta, state); opened.push(session); return session;
  };
  t.after(() => { for (const session of opened.reverse()) session.dispose(); });
  return { seats, context, create };
}

async function settle(session) {
  for (let n = 0; n < 100; n++) {
    await tick();
    if (Object.values(session.room.busy).every((v) => !v) && Object.values(session.room.pending).every((v) => !v)) return;
  }
  assert.fail('synthetic room did not become idle');
}
function fakePanel() {
  const posted = []; let onDispose = null, onMessage = null;
  return { posted, close: () => onDispose && onDispose(), receive: (m) => onMessage && onMessage(m),
    webview: { postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => { onMessage = fn; } }, onDidDispose: (fn) => { onDispose = fn; } };
}
const peerEnum = (client) => client.options.tools.find((tool) => tool.name === 'request_assistance').inputSchema.properties.to.enum;

for (const provider of ['codex', 'claude']) test(`two ${provider} seats use independent clients, settings, folders and peer tools`, async (t) => {
  const f = fixture(t, [provider, provider]), s = f.create(); await s.boot();
  const clients = provider === 'codex' ? codexClients : claudeClients;
  assert.equal(clients.length, 2);
  assert.notEqual(clients[0], clients[1]);
  assert.deepEqual(clients.map((c) => c.options.cwd), f.seats.map((p) => p.cwd));
  assert.deepEqual(peerEnum(clients[0]), ['db']); assert.deepEqual(peerEnum(clients[1]), ['app']);
  assert.deepEqual(Object.keys(s.controls()), ['app', 'db']);
  assert.equal(s.room.defaultTarget, 'app');
  if (provider === 'claude') {
    assert.deepEqual(clients.map((c) => c.options.model), ['sonnet', 'sonnet']);
    assert.deepEqual(clients.map((c) => c.options.effort), ['low', 'high']);
  }
  s.room.postFromHuman('@app first'); await settle(s);
  s.room.postFromHuman('@db second'); await settle(s);
  assert.equal(clients[0].turns.length, 1); assert.equal(clients[1].turns.length, 1);
  assert.equal(clients[0].turns[0].model, provider === 'codex' ? 'model-one' : 'sonnet');
  assert.equal(clients[1].turns[0].effort, 'high');
  assert.notEqual(s.controls().app.session, s.controls().db.session);
  assert.equal(s.controls().app.cwd, f.seats[0].cwd);
  assert.equal(s.controls().db.provider, provider);
});

test('host commands change only the named Codex seat and publish its supported effort choices', async (t) => {
  const s = fixture(t).create(); await s.boot();
  const beforeDb = structuredClone(s.meta.seats[1]);
  assert.deepEqual(s.cmdSpecs().find((spec) => spec.cmd === '/app effort').args, ['low', 'high']);
  await s.runCommand('/app model model-two');
  assert.equal(s.meta.seats[0].model, 'model-two'); assert.equal(s.meta.seats[0].effort, null);
  assert.deepEqual(s.cmdSpecs().find((spec) => spec.cmd === '/app effort').args, ['medium']);
  await s.runCommand('/app effort medium');
  s.room.postFromHuman('@app check with the selected settings'); await settle(s);
  assert.equal(codexClients[0].turns[0].model, 'model-two');
  assert.equal(codexClients[0].turns[0].effort, 'medium');
  assert.deepEqual(s.meta.seats[1], beforeDb);
});

test('host commands restart options for only the named Claude seat', async (t) => {
  const s = fixture(t, ['claude', 'claude']).create(); await s.boot();
  await s.runCommand('/app model custom-claude-alias'); await s.runCommand('/app effort max');
  assert.deepEqual(claudeClients[0].updates, [{ model: 'custom-claude-alias' }, { effort: 'max' }]);
  assert.deepEqual(claudeClients[1].updates, []);
  assert.equal(s.controls().app.model, 'custom-claude-alias');
  assert.equal(s.controls().db.model, 'sonnet');
});

test('typed assistance between two Codex seats returns evidence and completes one tracked task', async (t) => {
  const s = fixture(t).create(); await s.boot();
  codexClients[0].script = async (text, n, tool) => {
    if (n === 1) { assert.equal((await tool('request_assistance', { to: 'db', purpose: 'review', question: 'Check the synthetic database contract' })).ok, true); return 'Requested review'; }
    assert.match(text, /DB — answer to your request r1/); assert.match(text, /SYNTHETIC_REVIEW_EVIDENCE/);
    assert.equal((await tool('finish_task', { summary: 'Contract reviewed' })).ok, true); return 'Finished';
  };
  codexClients[1].script = () => 'SYNTHETIC_REVIEW_EVIDENCE';
  s.room.postFromHuman('@app review together'); await settle(s);
  assert.equal(codexClients[0].turns.length, 2); assert.equal(codexClients[1].turns.length, 1);
  const task = s.room.tasks.get('t1');
  assert.equal(task.status, 'completed'); assert.equal(task.summary, 'Contract reviewed');
  assert.deepEqual(task.requests.map(({ from, to, status }) => ({ from, to, status })), [{ from: 'app', to: 'db', status: 'answered' }]);
  assert.deepEqual(Object.keys(task.usage).sort(), ['app', 'db']);
  assert.equal(task.usage.db.fresh, 7);
});

test('saving and reopening four seats preserves bindings while polling account quota once per provider', async (t) => {
  const f = fixture(t, ['codex', 'codex', 'claude', 'claude']), s = f.create(); await s.boot(); await tick();
  assert.equal(codexClients.reduce((n, c) => n + c.quotaReads, 0), 1);
  assert.equal(claudeUsageReads.length, 1);
  for (const id of ['writer', 'reviewer']) { s.room.postFromHuman(`@${id} establish synthetic session`); await settle(s); }
  const sessions = Object.fromEntries(Object.entries(s.controls()).map(([id, control]) => [id, control.session]));
  assert.equal(new Set(Object.values(sessions)).size, 4);
  s.save(); const saved = JSON.parse(fs.readFileSync(s.file, 'utf8')); s.dispose();
  const quotaBefore = codexClients.reduce((n, c) => n + c.quotaReads, 0), claudeBefore = claudeUsageReads.length;
  const reopened = f.create(saved.meta, saved.state); await reopened.boot(); await tick();
  assert.deepEqual(Object.fromEntries(Object.entries(reopened.controls()).map(([id, control]) => [id, control.session])), sessions);
  assert.deepEqual(reopened.meta.seats.map((p) => [p.id, p.cwd, p.model, p.effort]), saved.meta.seats.map((p) => [p.id, p.cwd, p.model, p.effort]));
  assert.equal(codexClients.reduce((n, c) => n + c.quotaReads, 0) - quotaBefore, 1);
  assert.equal(claudeUsageReads.length - claudeBefore, 1);
  assert.ok(codexClients.slice(-2).every((c) => c.calls.some(([action]) => action === 'continue')));
});

for (const provider of ['codex', 'claude']) test(`duplicate saved ${provider} session ids fail before starting a provider`, async (t) => {
  const f = fixture(t, [provider, provider]); f.seats.forEach((seat) => { seat.sessionId = 'same-session'; });
  const s = f.create(); await assert.rejects(s.boot(), /already in use/);
  assert.equal(codexClients.length, 0); assert.equal(claudeClients.length, 0);
  const only = f.create({ ...newMeta('Recover released claim'), seats: [{ ...f.seats[0] }] });
  await only.boot(); assert.equal(only.controls().app.session, 'same-session');
});

for (const provider of ['codex', 'claude']) test(`Continue cannot take a ${provider} sibling's owned session`, async (t) => {
  const f = fixture(t, [provider, provider]);
  f.seats[1].cwd = f.seats[0].cwd; f.seats[0].sessionId = `${provider}-app`; f.seats[1].sessionId = `${provider}-db`;
  const s = f.create(); await s.boot();
  threadChoices = claudeChoices = [{ id: `${provider}-db`, cwd: f.seats[0].cwd, title: 'Sibling', name: 'Sibling' }];
  picks.push((items) => items.find((item) => item.id === `${provider}-db`));
  const before = structuredClone(s.meta.seats), clients = provider === 'codex' ? codexClients : claudeClients;
  const count = clients.length;
  await assert.rejects(s.switchSession('app', 'continue'), /already in use/);
  assert.equal(warnings.length, 1); assert.equal(clients.length, count);
  assert.deepEqual(s.meta.seats, before); assert.equal(clients[0].stops, 0); assert.equal(clients[1].stops, 0);
  assert.equal(s.room.busy.app, false);
});

test('history grants apply only to the named reader and source, then reset on a reader switch', async (t) => {
  const s = fixture(t, ['codex', 'codex', 'codex']).create(); await s.boot();
  await s.runCommand('/history share app db on');
  const read = await s.history.read('db', { source: 'app' });
  assert.equal(read.ok, true); assert.match(read.text, new RegExp(`HISTORY:${s.controls().app.session}`));
  assert.equal((await s.history.read('writer', { source: 'app' })).ok, false);
  assert.equal((await s.history.read('db', { source: 'writer' })).ok, false);
  const source = s.history.add({ provider: 'codex', sessionId: 'external-evidence', title: 'Synthetic evidence', readers: ['db'] });
  assert.equal((await s.history.read('db', { source: source.id })).ok, true);
  assert.equal((await s.history.read('writer', { source: source.id })).ok, false);
  await s.switchSession('db', 'new');
  assert.equal((await s.history.read('db', { source: 'app' })).ok, false);
  assert.equal((await s.history.read('db', { source: source.id })).ok, false);
});

test('a Claude history grant stays with its named reader when new sessions receive their first ids', async (t) => {
  const s = fixture(t, ['claude', 'claude', 'codex']).create(); await s.boot();
  await s.runCommand('/history share app db on');
  assert.equal(s.controls().app.session, undefined);
  for (const id of ['app', 'db']) { s.room.postFromHuman(`@${id} create synthetic session`); await settle(s); }
  const read = await s.history.read('db', { source: 'app' });
  assert.equal(read.ok, true); assert.match(read.text, new RegExp(`HISTORY:${s.controls().app.session}`));
  assert.equal((await s.history.read('writer', { source: 'app' })).ok, false);
  assert.equal((await s.history.read('app', { source: 'db' })).ok, false);
});

test('fork switches only the selected seat, preserves the source and does not replay earlier room context', async (t) => {
  const s = fixture(t).create(); await s.boot();
  s.room.postFromHuman('@app SYNTHETIC_OLD_ROOM_CONTEXT'); await settle(s);
  await s.runCommand('/history share app db on');
  const sibling = structuredClone(s.meta.seats[1]), old = codexClients[0], source = s.controls().db.session;
  threadChoices = [{ id: source, cwd: sibling.cwd, name: 'Sibling source' }];
  picks.push((items) => items.find((item) => item.id === source));
  await s.switchSession('app', 'fork');
  const replacement = codexClients.at(-1);
  assert.ok(replacement.calls.some(([action, id]) => action === 'fork' && id === source));
  assert.ok(!replacement.calls.some(([action]) => action === 'continue'));
  assert.equal(warnings.length, 0); assert.equal(old.stops, 1);
  assert.deepEqual(s.meta.seats[1], sibling);
  assert.equal(replacement.options.cwd, old.options.cwd, 'the chosen source does not silently change the seat folder');
  assert.deepEqual(peerEnum(replacement), ['db']);
  assert.notEqual(s.controls().app.session, source);
  assert.equal((await s.history.read('db', { source: 'app' })).ok, false);
  s.room.postFromHuman('@app SYNTHETIC_NEW_MESSAGE'); await settle(s);
  assert.equal(replacement.turns.length, 1);
  assert.match(replacement.turns[0].text, /SYNTHETIC_NEW_MESSAGE/);
  assert.doesNotMatch(replacement.turns[0].text, /SYNTHETIC_OLD_ROOM_CONTEXT/);
  assert.equal(s.controls().app.typed, false, 'a foreign fork does not inherit the new-thread tool contract');
});

for (const stage of ['start', 'thread', 'models']) test(`closing during Codex boot ${stage} stops its client and cannot revive a room, save or claim`, async (t) => {
  const f = fixture(t); f.seats[0].sessionId = `boot-held-${stage}`;
  const s = f.create(), barrier = holdCodexPhase(stage), boot = s.boot();
  try {
    const client = await barrier.entered;
    s.dispose(); assert.ok(client.stops > 0, 'close stops the pending client immediately');
    fs.writeFileSync(s.file, 'AFTER_CLOSE_CHECKPOINT');
    barrier.release(); await boot;
    assert.equal(s.room, undefined); assert.equal(s.scheduler, undefined);
    assert.equal(codexClients.length, 1, 'no later seat starts after close');
    s.save(); await s.boot();
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'AFTER_CLOSE_CHECKPOINT');
    const next = f.create({ ...newMeta('Claim after close'), seats: [{ ...f.seats[0] }] });
    await next.boot(); assert.equal(next.controls().app.session, f.seats[0].sessionId);
  } finally { barrier.release(); await boot; }
});

test('Stop during a pending Continue keeps the original seat and releases the candidate claim', async (t) => {
  const f = fixture(t), s = f.create(); await s.boot();
  const before = structuredClone(s.meta.seats), old = codexClients[0];
  threadChoices = [{ id: 'continue-candidate', cwd: f.seats[0].cwd, name: 'Synthetic candidate' }];
  picks.push((items) => items[0]);
  const barrier = holdCodexPhase('models'), switching = s.switchSession('app', 'continue');
  try {
    const candidate = await barrier.entered;
    s.room.stopAll(); assert.ok(candidate.stops > 0, 'Stop reaches the candidate before its pending call resolves');
    barrier.release(); await switching;
    assert.deepEqual(s.meta.seats, before); assert.equal(old.stops, 0); assert.equal(s.room.busy.app, false);
    const other = f.create({ ...newMeta('Released candidate'), seats: [{ ...f.seats[0], sessionId: 'continue-candidate' }] });
    await other.boot(); assert.equal(other.controls().app.session, 'continue-candidate');
  } finally { barrier.release(); await switching; }
});

test('closing during a pending new-session switch prevents adoption and later saves', async (t) => {
  const f = fixture(t), s = f.create(); await s.boot();
  const oldId = s.controls().app.session, barrier = holdCodexPhase('thread'), switching = s.switchSession('app', 'new');
  try {
    const candidate = await barrier.entered;
    const candidateId = candidate.calls.find(([action]) => action === 'new')[1];
    s.dispose(); assert.ok(candidate.stops > 0);
    fs.writeFileSync(s.file, 'AFTER_SWITCH_CLOSE');
    barrier.release(); await switching;
    assert.equal(s.meta.seats[0].sessionId, oldId);
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'AFTER_SWITCH_CLOSE');
    const other = f.create({ ...newMeta('No revived claim'), seats: [{ ...f.seats[0], sessionId: candidateId }] });
    await other.boot(); assert.equal(other.controls().app.session, candidateId);
  } finally { barrier.release(); await switching; }
});

test('a late Claude first-session reply cannot save or reclaim ownership after disposal', async (t) => {
  const f = fixture(t, ['claude']), s = f.create(); await s.boot();
  const entered = deferred(), released = deferred();
  claudeClients[0].send = async () => { entered.resolve(); await released.promise; claudeClients[0].sessionId = 'late-claude-id'; return 'Late reply'; };
  s.room.postFromHuman('@app start');
  try {
    await entered.promise; s.dispose(); fs.writeFileSync(s.file, 'AFTER_CLAUDE_CLOSE');
    released.resolve(); await settle(s);
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'AFTER_CLAUDE_CLOSE');
    const other = f.create({ ...newMeta('No late Claude claim'), seats: [{ ...f.seats[0], sessionId: 'late-claude-id' }] });
    await other.boot(); assert.equal(other.controls().app.session, 'late-claude-id');
  } finally { released.resolve(); }
});

test('the same all-Claude saved room cannot open twice before any session ids exist', async (t) => {
  const f = fixture(t, ['claude', 'claude']), first = f.create(); await first.boot();
  const saved = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  const second = f.create(structuredClone(saved.meta), saved.state);
  await assert.rejects(second.boot(), /room is already open/);
  assert.equal(claudeClients.length, 2);
  first.dispose(); await second.boot();
  assert.equal(claudeClients.length, 4);
});

test('closing a rejected duplicate room cannot overwrite the active owner checkpoint', async (t) => {
  const f = fixture(t, ['claude', 'claude']), owner = f.create(); await owner.boot();
  const saved = JSON.parse(fs.readFileSync(owner.file, 'utf8'));
  const duplicate = f.create(saved.meta, saved.state), panel = fakePanel(); duplicate.attach(panel);
  await assert.rejects(duplicate.boot(), /room is already open/);
  assert.ok(panel.posted.some((m) => m.type === 'notice' && /Could not start: This room is already open/.test(m.text))); // the panel says why
  assert.equal(duplicate.disposed, false); // it may still boot here once the owner closes
  // The page clears its log on init, so the refusal must arrive again after init once the page is ready.
  panel.receive({ type: 'ready' });
  const types = panel.posted.map((m) => m.type);
  assert.ok(types.lastIndexOf('notice') > types.lastIndexOf('init'), 'the refusal is posted after init');
  assert.match(panel.posted.at(-1).text, /already open/);
  // A refused panel is inert: nothing but ready is handled, so no attachment lands in the shared room folder.
  const before = panel.posted.length;
  panel.receive({ type: 'attachData', name: 'x.txt', mime: 'text/plain', data: Buffer.from('x').toString('base64') });
  panel.receive({ type: 'send', text: 'hello' });
  assert.equal(panel.posted.length, before); assert.equal(duplicate.pendingAtts.size, 0);
  assert.equal(fs.existsSync(duplicate.attDir), false);
  owner.room.note('LATEST_OWNER_CHECKPOINT');
  const checkpoint = fs.readFileSync(owner.file, 'utf8');
  duplicate.dispose();
  assert.equal(fs.readFileSync(owner.file, 'utf8'), checkpoint);
});

test('a rejected room never gains save ownership merely because the original owner closed', async (t) => {
  const f = fixture(t, ['claude']), owner = f.create(); await owner.boot();
  const saved = JSON.parse(fs.readFileSync(owner.file, 'utf8')), duplicate = f.create(saved.meta, saved.state);
  await assert.rejects(duplicate.boot(), /room is already open/);
  owner.room.note('FINAL_OWNER_CHECKPOINT'); owner.dispose();
  const checkpoint = fs.readFileSync(owner.file, 'utf8');
  duplicate.dispose();
  assert.equal(fs.readFileSync(owner.file, 'utf8'), checkpoint);
});

test('re-adding a history source stops before new consent and accurately retains its existing policy', async (t) => {
  const s = fixture(t).create(); await s.boot();
  const existing = s.history.add({ provider:'codex', sessionId:'external-reference', title:'Synthetic reference', readers:['app'], allHistory:true });
  threadChoices = [{ id:'external-reference',name:'Synthetic reference' }];
  picks = [items=>items[0], items=>[items.find(x=>x.id==='db')], items=>items.find(x=>x.all===false)];
  await s.addHistorySource();
  assert.equal(picks.length,2,'no misleading new consent questions');
  assert.equal(s.history.saved.sources.length,1);
  assert.equal((await s.history.read('app',{source:existing.id})).ok,true);
  assert.equal((await s.history.read('db',{source:existing.id})).ok,false);
  assert.equal(s.history.allHistory(existing.id),true);
  const notice=s.room.state.transcript.at(-1).text;
  assert.match(notice,/Already added as h1/); assert.match(notice,/Readers and history range are unchanged/);
  assert.match(notice,/\/history remove h1/); assert.doesNotMatch(notice,/Added .*reference for DB/);
});

test('history source added during consent picker cannot produce a false success for different readers', async (t) => {
  const s = fixture(t).create(); await s.boot();
  threadChoices = [{ id:'external-reference',name:'Synthetic reference' }];
  picks = [items=>items[0], items=>[items.find(x=>x.id==='db')], items=>{
    s.history.add({provider:'codex',sessionId:'external-reference',title:'Synthetic reference',readers:['app'],allHistory:true});
    return items.find(x=>x.all===false);
  }];
  await s.addHistorySource();
  assert.equal(s.history.saved.sources.length,1); assert.equal(s.history.allHistory('h1'),true);
  assert.equal((await s.history.read('app',{source:'h1'})).ok,true);
  assert.equal((await s.history.read('db',{source:'h1'})).ok,false);
  assert.match(s.room.state.transcript.at(-1).text,/Already added as h1/);
});

// ---------- session claims at the moment the CLI reports an id (Kestrel peer review of 3905948, P2) ----------

test('a Claude seat claims its session the moment the CLI reports it, so a sibling cannot Continue it mid-turn', async (t) => {
  const f = fixture(t, ['claude', 'claude']); f.seats[1].cwd = f.seats[0].cwd;
  const s = f.create(); await s.boot();
  const [app, db] = claudeClients;
  const entered = deferred(), released = deferred();
  app.send = async function (text) { this.sessionId = this.nextId; this.onSession(this.sessionId); entered.resolve(); await released.promise; return 'First reply'; };
  s.room.postFromHuman('@app start'); await entered.promise;
  assert.equal(s.meta.seats[0].sessionId, app.nextId); // claimed before any save or turn end
  claudeChoices = [{ id: app.nextId, cwd: f.seats[0].cwd, title: 'Fresh sibling', mtime: Date.now() }];
  picks.push((items) => items.find((item) => item.id === app.nextId));
  await assert.rejects(s.switchSession('db', 'continue'), /already in use/); // the claim already belongs to app
  assert.equal(warnings.length, 1); assert.equal(db.stops, 0); assert.equal(s.meta.seats[1].sessionId, null);
  released.resolve(); await settle(s);
  assert.equal(s.room.busy.app, false); assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).meta.seats[0].sessionId, app.nextId);
});

test('a conflicting id learned late is noted once and never breaks saving or strands the seat', async (t) => {
  const f = fixture(t, ['claude', 'claude']); f.seats[1].cwd = f.seats[0].cwd;
  const s = f.create(); await s.boot();
  const [app, db] = claudeClients;
  const entered = deferred(), released = deferred();
  // The old race: app's CLI id becomes visible to db's Continue picker before app has claimed it.
  app.send = async function () { entered.resolve(); await released.promise; this.sessionId = 'shared-claude'; return 'Late first reply'; };
  s.room.postFromHuman('@app start'); await entered.promise;
  claudeChoices = [{ id: 'shared-claude', cwd: f.seats[0].cwd, title: 'Unclaimed yet', mtime: 0 }];
  picks.push((items) => items[0]);
  await s.switchSession('db', 'continue');
  assert.equal(s.meta.seats[1].sessionId, 'shared-claude'); assert.equal(db.stops, 1);
  released.resolve(); await settle(s);
  assert.equal(s.room.busy.app, false); // the turn ended cleanly despite the claim conflict
  const notes = s.room.state.transcript.filter((e) => e.from === 'system' && /already continues/.test(e.text));
  assert.equal(notes.length, 1);
  assert.equal(s.room.state.transcript.filter((e) => e.kind === 'error').length, 0);
  s.room.postFromHuman('@app again'); await settle(s); // a second turn: still no throw, still one note
  assert.equal(s.room.state.transcript.filter((e) => e.from === 'system' && /already continues/.test(e.text)).length, 1);
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(saved.state.transcript.at(-1).text, 'Late first reply'); // saving kept working after the conflict
  assert.equal(saved.meta.seats[1].sessionId, 'shared-claude'); assert.equal(saved.meta.seats[0].sessionId, null); // app never took the claim
});

test('a failed boot tells the panel why, and closing that panel forgets the session', async (t) => {
  const f = fixture(t), s = f.create();
  codexBarrier = async () => { throw new Error('synthetic start failure'); };
  const panel = fakePanel(); s.attach(panel);
  await assert.rejects(s.boot(), /synthetic start failure/);
  assert.ok(panel.posted.some((m) => m.type === 'notice' && /Could not start: synthetic start failure/.test(m.text)));
  assert.equal(s.disposed, true);
  panel.close(); assert.equal(s.panel, null);
});

test('the Continue warning says when the session changed in the last two minutes', async (t) => {
  const f = fixture(t, ['claude']), s = f.create(); await s.boot();
  claudeChoices = [{ id: 'recent-claude', cwd: f.seats[0].cwd, title: 'Recent', mtime: Date.now() - 1000 }];
  picks.push((items) => items[0]); await s.switchSession('app', 'continue');
  assert.match(warnings[0][1].detail, /last two minutes/);
  claudeChoices = [{ id: 'old-claude', cwd: f.seats[0].cwd, title: 'Old', mtime: Date.now() - 3600e3 }];
  picks.push((items) => items[0]); await s.switchSession('app', 'continue');
  assert.doesNotMatch(warnings[1][1].detail, /last two minutes/);
});

test('Switch to one of your conversations: a copy behaves as Fork, the original as Continue (with its warning), cancel changes nothing', async (t) => {
  const s = fixture(t).create(); await s.boot();
  const source = s.controls().db.session, cwd = s.meta.seats[1].cwd;
  threadChoices = [{ id: source, cwd, name: 'Sibling source' }];
  // Copy.
  picks.push((items) => items.find((item) => item.id === source), (items) => { assert.deepEqual(items.map((i) => i.label), ['Work on a copy (recommended)', 'Keep going in the original']); return items[0]; });
  await s.switchSession('app', 'switch');
  let replacement = codexClients.at(-1);
  assert.ok(replacement.calls.some(([action, id]) => action === 'fork' && id === source));
  assert.equal(warnings.length, 0);
  assert.match(s.room.state.transcript.at(-1).text, /now uses a copy of "Sibling source"/);
  // Cancel at the copy-or-original question.
  const before = codexClients.length;
  picks.push((items) => items.find((item) => item.id === source), () => undefined);
  await s.switchSession('app', 'switch');
  assert.equal(codexClients.length, before, 'nothing started');
  // Original: goes through Continue, which warns first and refuses a conversation another agent owns.
  picks.push((items) => items.find((item) => item.id === source), (items) => items[1]);
  await assert.rejects(s.switchSession('app', 'switch'), /already in use/);
  assert.equal(warnings.length, 1);
  void replacement;
});
