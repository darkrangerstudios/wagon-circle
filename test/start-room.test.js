'use strict';
// Start a Room: the plan builder's rules, the screen's host messages, and the screen itself (media/start.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const Module = require('module');
const startRoom = require('../src/startRoom');
const { Element, walk } = require('./fixtures/webview-dom');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwstart-'));
const A = (provider, extra = {}) => ({ provider, label: provider === 'claude' ? 'Claude' : 'Codex', model: null, effort: null, start: 'fresh', conversation: null, folder: null, share: false, ...extra });

test('plan: the default pair gets the familiar ids; names become unique ids; nothing starts yet', () => {
  const cwd = dir();
  const p = startRoom.buildPlan({ name: ' Review ', agents: [A('claude'), A('codex')] }, { defaultCwd: cwd });
  assert.strictEqual(p.name, 'Review');
  assert.deepStrictEqual(p.seats.map(({ id, label, provider, cwd: c }) => ({ id, label, provider, c })), [
    { id: 'claude', label: 'Claude', provider: 'claude', c: cwd }, { id: 'codex', label: 'Codex', provider: 'codex', c: cwd }]);
  const two = startRoom.buildPlan({ name: 'x', agents: [A('codex', { label: 'Application' }), A('codex', { label: 'Application' }), A('claude', { label: 'Both' }), A('claude', { label: '9 lives' })] }, { defaultCwd: cwd });
  assert.deepStrictEqual(two.seats.map((s) => s.id), ['application', 'application-2', 'claude', 'claude-2'], 'duplicates numbered; reserved or non-letter names fall back to the app');
  assert.deepStrictEqual(two.shareSeed, {}); assert.deepStrictEqual(two.originals, []);
});

test('plan: a copy or the original must be one of the listed conversations; Claude uses the conversation\'s folder', () => {
  const home = dir(), convFolder = dir(), codexFolder = dir();
  const lists = { claude: [{ id: 'cl-1', cwd: convFolder, when: 1 }], codex: [{ id: 'th-1', cwd: codexFolder, when: 2 }, { id: 'th-gone', cwd: '/no/such/folder', when: 3 }] };
  const p = startRoom.buildPlan({ name: 'r', agents: [
    A('claude', { start: 'copy', conversation: 'cl-1', folder: home, share: true }),
    A('codex', { start: 'original', conversation: 'th-1', folder: home }),
    A('codex', { label: 'Old', start: 'copy', conversation: 'th-gone', folder: home, share: true })] }, { lists, defaultCwd: home });
  const [cl, cx, old] = p.seats;
  assert.strictEqual(cl.cwd, convFolder, 'Claude reopens a conversation only from the folder it started in');
  assert.strictEqual(cl.forkFrom, 'cl-1'); assert.strictEqual(cl.sessionId, null);
  assert.strictEqual(cx.sessionId, 'th-1'); assert.strictEqual(cx.cwd, codexFolder); assert.strictEqual(cx.typed, false);
  assert.strictEqual(old.cwd, home, 'a Codex conversation whose folder is gone keeps the chosen folder'); assert.strictEqual(old.forkFrom, 'th-gone');
  assert.deepStrictEqual(p.shareSeed, { claude: true, 'old': true });
  assert.deepStrictEqual(p.originals, [{ label: 'Codex', provider: 'codex', id: 'th-1', when: 2 }]);
});

test('plan: refuses what the screen should never send, with a sentence a person can act on', () => {
  const cwd = dir(), lists = { claude: [{ id: 'cl-1', cwd, when: 1 }], codex: [] };
  const bad = (form, re, ctx = {}) => assert.throws(() => startRoom.buildPlan(form, { lists, defaultCwd: cwd, codexModels: [{ id: 'gpt-x', efforts: ['low', 'high'] }], ...ctx }), re);
  bad({ name: '', agents: [A('claude')] }, /Give the room a name/);
  bad({ name: 'r', agents: [] }, /at least one agent/);
  bad({ name: 'r', agents: Array.from({ length: 7 }, () => A('claude')) }, /up to 6 agents/);
  bad({ name: 'r', agents: [A('gemini')] }, /choose Claude or Codex/);
  bad({ name: 'r', agents: [A('claude', { label: ' ' })] }, /name of 1 to 60/);
  bad({ name: 'r', agents: [A('claude', { start: 'copy', conversation: 'not-listed' })] }, /pick one of your Claude conversations/);
  bad({ name: 'r', agents: [A('claude', { start: 'original', conversation: 'cl-1' }), A('claude', { label: 'Two', start: 'original', conversation: 'cl-1' })] }, /can't both keep going in the same original/);
  bad({ name: 'r', agents: [A('claude', { folder: '/no/such/folder' })] }, /folder no longer exists/);
  bad({ name: 'r', agents: [A('claude', { model: 'gpt-4' })] }, /model isn't available/);
  bad({ name: 'r', agents: [A('codex', { model: 'gpt-x', effort: 'max' })] }, /thinking effort isn't available/);
  bad({ name: 'r', agents: [A('claude', { start: 'sideways' })] }, /choose how it starts/);
  bad(null, /Something went wrong/);
  // Two copies of one conversation are fine; only a second writer on the original is refused.
  assert.strictEqual(startRoom.buildPlan({ name: 'r', agents: [A('claude', { start: 'copy', conversation: 'cl-1' }), A('claude', { label: 'Two', start: 'copy', conversation: 'cl-1' })] }, { lists, defaultCwd: cwd }).seats.length, 2);
});

test('setup lines and conversation rows read as plain English and carry no control characters', () => {
  assert.deepStrictEqual(startRoom.setupLine({ provider: 'claude', installation: 'available', version: '2.1.282', authentication: 'present' }), { ready: true, text: 'Ready: Claude Code 2.1.282, signed in.', fix: null });
  assert.deepStrictEqual(startRoom.setupLine({ provider: 'codex', installation: 'missing', issue: 'missing' }), { ready: false, text: 'Codex isn\'t installed on this computer.', fix: 'install' });
  assert.strictEqual(startRoom.setupLine({ provider: 'claude', installation: 'available', version: '2.1.0', authentication: 'signed-out' }).fix, 'signin');
  assert.strictEqual(startRoom.setupLine({ provider: 'codex', installation: 'available', version: '0.1.0', authentication: 'unknown' }).ready, true);
  const row = startRoom.conversationRow({ id: 'x', cwd: '/home/alex/code/app', when: 5, title: 'Fix‮ the\nbug' }, '/home/alex');
  assert.deepStrictEqual(row, { id: 'x', title: 'Fix  the bug', folder: '~/code/app', when: 5 });
  assert.strictEqual(startRoom.conversationRow({ id: 'y', cwd: null }, '/h').title, 'Untitled conversation');
});

// The host side of the screen, with VS Code, the CLIs and their histories stubbed.
function loadHost({ lists = {}, recentMs = null, answer } = {}) {
  const disposable = { dispose() {} };
  const rec = { panels: [], warnings: [], opened: [] };
  const convDir = dir();
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: true,
      registerTextDocumentContentProvider: () => disposable, onDidChangeConfiguration: () => disposable },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable, onDidChangeTextEditorVisibleRanges: () => disposable,
      registerTreeDataProvider: () => disposable, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage: async (m, o, ...b) => { rec.warnings.push({ m, o, b }); return answer; },
      showOpenDialog: async () => [{ fsPath: convDir }],
      createWebviewPanel: (type, title) => {
        const p = { type, title, sent: [], disposed: false, revealed: 0, webview: { html: '', cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: (fn) => { p.recv = fn; }, postMessage: (m) => { p.sent.push(m); } },
          onDidDispose: (fn) => { p.onClose = fn; }, reveal() { p.revealed++; }, dispose() { p.disposed = true; if (p.onClose) p.onClose(); } };
        rec.panels.push(p); return p;
      },
      withProgress: async () => {},
    },
    commands: { registerCommand: (id, fn) => { (rec.cmd ||= {})[id] = fn; return disposable; }, executeCommand: async () => {} },
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} },
    TreeItem: class {}, ThemeIcon: class {}, TreeItemCollapsibleState: { None: 0 }, StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }), file: (p) => ({ fsPath: p }), parse: (u) => u },
    env: { openExternal: (u) => rec.opened.push(u) }, version: '1.104.0',
  };
  class FakeCodex { async start() {} async listModels() { return [{ id: 'gpt-x', displayName: 'GPT X', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }]; }
    async listThreads() { return [{ id: 'th-1', name: 'Codex chat', cwd: convDir, updatedAt: 100 }]; } stop() {} on() {} }
  const now = Date.now();
  const fakes = {
    [require.resolve('../src/codexClient')]: { CodexClient: FakeCodex, FORBIDDEN: new Set() },
    [require.resolve('../src/claudeHistory')]: { ROOT: os.tmpdir(), listSessions: () => lists.claude || [{ id: 'cl-1', path: '/x', cwd: convDir, mtime: recentMs ? now - recentMs : now - 3600e3, title: 'Old chat', preview: 'hi' }], recentMessages: () => [], fileFor: () => null },
    [require.resolve('../src/claudeBinary')]: { findClaude: () => ({ path: 'claude', version: [2, 1, 282] }), atLeast: () => true },
    [require.resolve('../src/setup')]: { ...require('../src/setup'), checkSetup: async ({ executables }) => ({ executionHost: 'this computer', providers: Object.keys(executables).map((p) => ({ provider: p, installation: 'available', version: '1.0.0', authentication: p === 'codex' ? 'signed-out' : 'present' })) }) },
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...a) {
    if (req === 'vscode') return vscode;
    const file = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
    return file && fakes[file] ? fakes[file] : realLoad.call(this, req, parent, ...a);
  };
  let ext;
  try { delete require.cache[require.resolve('../src/extension')]; ext = require('../src/extension'); } finally { Module._load = realLoad; }
  const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, globalStorageUri: { fsPath: dir() }, extensionUri: { fsPath: path.join(__dirname, '..') } };
  ext.activate(context);
  return { ext, rec, convDir };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('host: every launcher opens one Start a Room screen with status, models and conversations; Join Existing preselects conversations', async () => {
  const { rec } = loadHost();
  await rec.cmd['wagonWheel.newRoom']();
  assert.strictEqual(rec.panels.length, 1); const p = rec.panels[0];
  assert.strictEqual(p.title, 'Wagon Wheel: Start a Room');
  assert.match(p.webview.html, /script-src 'nonce-[^']+'/); assert.doesNotMatch(p.webview.html, /unsafe-inline/);
  await p.recv({ type: 'ready' }); await settle();
  const init = p.sent.find((m) => m.type === 'init'), st = p.sent.find((m) => m.type === 'setup'), lists = p.sent.find((m) => m.type === 'lists');
  assert.strictEqual(init.existing, false);
  assert.strictEqual(st.claude.ready, true); assert.strictEqual(st.codex.fix, 'signin');
  assert.deepStrictEqual(lists.conversations.claude.map((c) => c.title), ['Old chat']);
  assert.deepStrictEqual(lists.conversations.codex.map((c) => c.title), ['Codex chat']);
  assert.deepStrictEqual(lists.models.codex, [{ id: 'gpt-x', name: 'GPT X', efforts: ['low', 'high'] }]);
  assert.ok(!JSON.stringify(lists).includes('"path"'), 'no file paths of conversation logs go to the page');
  await rec.cmd['wagonWheel.joinExisting']();
  assert.strictEqual(rec.panels.length, 1, 'one screen at a time'); assert.strictEqual(p.revealed, 1);
  assert.deepStrictEqual(p.sent.at(-1), { type: 'mode', existing: true });
  await p.recv({ type: 'guide', provider: 'codex' }); await p.recv({ type: 'guide', provider: 'https://evil.example' });
  assert.deepStrictEqual(rec.opened, [require('../src/setup').GUIDES.codex], 'only the known guide links open');
});

test('host: Start builds the room from the form, closes the screen and opens the room; a bad form gets a sentence back', async () => {
  const { rec, convDir } = loadHost();
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'Bad', agents: [{ provider: 'claude', label: 'Claude', start: 'copy', conversation: 'forged-id' }] } });
  assert.deepStrictEqual(p.sent.slice(-2), [{ type: 'error', text: 'Claude: pick one of your Claude conversations, or start fresh.' }, { type: 'busy', on: false }]);
  assert.strictEqual(rec.panels.length, 1);
  await p.recv({ type: 'start', form: { name: 'My room', agents: [{ provider: 'claude', label: 'Claude', start: 'copy', conversation: 'cl-1', share: true }, { provider: 'codex', label: 'Codex', start: 'fresh', model: 'gpt-x', effort: 'high' }] } });
  assert.strictEqual(p.disposed, true, 'the screen closes');
  assert.strictEqual(rec.panels.length, 2); assert.strictEqual(rec.panels[1].title, 'Wagon Wheel: My room');
  void convDir;
});

test('host: keeping going in an original that changed in the last two minutes asks first; declining starts nothing', async () => {
  const { rec } = loadHost({ recentMs: 30e3, answer: undefined });
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'r', agents: [{ provider: 'claude', label: 'Claude', start: 'original', conversation: 'cl-1' }] } });
  assert.strictEqual(rec.warnings.length, 1); assert.ok(rec.warnings[0].o.modal);
  assert.match(rec.warnings[0].m, /changed in the last two minutes/);
  assert.deepStrictEqual(p.sent.at(-1), { type: 'busy', on: false });
  assert.strictEqual(rec.panels.length, 1, 'no room opened');
});

// The page itself, run against a minimal DOM.
function loadPage() {
  const app = new Element('main'); app.id = 'app';
  const body = new Element('body'); body.appendChild(app);
  const sent = []; let listener;
  const document = { body, activeElement: null, createElement: (t) => new Element(t), getElementById: (id) => (id === 'app' ? app : null) };
  function Option(text, value) { const o = new Element('option'); o.textContent = text; o.value = value; return o; }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/start.js'), 'utf8'), { document, Option, CSS: { escape: (s) => s }, Date,
    window: { addEventListener: (k, fn) => { if (k === 'message') listener = fn; } }, acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) }) }); // plain objects: the page runs in another realm
  const receive = (m) => listener({ data: m });
  const buttons = () => walk(app).filter((e) => e.tagName === 'button');
  const click = (text) => { const b = buttons().find((e) => e.textContent === text || walk(e).some((c) => c.textContent === text && ['o', 't'].includes(c.className))); if (!b) throw new Error(`no button ${text}`); b.fire('click'); };
  return { app, sent, receive, click, buttons, text: () => app.textContent };
}
const pageLists = { type: 'lists', conversations: { claude: [{ id: 'cl-1', title: 'Fix the parser', folder: '~/code/p', when: Date.now() - 3600e3 }], codex: [] }, models: { claude: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Most capable', efforts: ['low', 'high'] }], codex: [] } };

test('page: plain-English choices, a copy recommended by default, and the form it sends', () => {
  const pg = loadPage();
  assert.deepStrictEqual(pg.sent, [{ type: 'ready' }]);
  pg.receive({ type: 'init', existing: false, defaults: { name: 'Room 9/25/2026', folder: '/w', folderLabel: '~/w' }, trusted: true });
  pg.receive({ type: 'setup', claude: { ready: true, text: 'Ready: Claude Code 2.1.282, signed in.', fix: null }, codex: { ready: false, text: 'Codex 0.1.0 is installed, but you\'re signed out.', fix: 'signin' } });
  pg.receive(pageLists);
  const t = pg.text();
  for (const phrase of ['Start a room', 'Who\'s in the room', 'A fresh conversation', 'One of your Claude conversations', 'How to sign in', 'Works in', '~/w', 'Name the room', 'Start room',
    'Codex isn\'t ready yet and won\'t be able to answer until it is.']) assert.ok(t.includes(phrase), phrase);
  for (const jargon of ['seat', 'fork', 'Fork', 'working session', 'roster', 'participant']) assert.ok(!t.includes(jargon), `no "${jargon}" on the screen`);
  pg.click('One of your Claude conversations');
  assert.ok(pg.text().includes('Fix the parser'));
  pg.click('Fix the parser');
  const t2 = pg.text();
  assert.ok(t2.includes('Work on a copy (recommended)') && t2.includes('Keep going in the original') && t2.includes('Uses the folder where this conversation started'));
  assert.ok(t2.includes('Starting Claude (a copy of "Fix the parser") and Codex (fresh).'));
  pg.click('How to sign in'); assert.deepStrictEqual(pg.sent.at(-1), { type: 'guide', provider: 'codex' });
  pg.click('Start room');
  assert.deepStrictEqual(pg.sent.at(-1), { type: 'start', form: { name: 'Room 9/25/2026', agents: [
    { provider: 'claude', label: 'Claude', model: null, effort: null, start: 'copy', conversation: 'cl-1', folder: '/w', share: false },
    { provider: 'codex', label: 'Codex', model: null, effort: null, start: 'fresh', conversation: null, folder: '/w', share: false }] } });
});

test('page: add and remove agents up to six, change a folder, and show the host\'s error', () => {
  const pg = loadPage();
  pg.receive({ type: 'init', existing: true, defaults: { name: 'R', folder: '/w', folderLabel: '~/w' }, trusted: true });
  pg.receive(pageLists);
  assert.ok(pg.text().includes('Pick a conversation above.'), 'Join Existing opens with conversations chosen');
  pg.click('+ Add Claude'); pg.click('+ Add Claude'); pg.click('+ Add Codex'); pg.click('+ Add Codex');
  assert.ok(pg.text().includes('A room holds up to 6 agents.'));
  assert.ok(pg.buttons().filter((b) => b.textContent.startsWith('+ Add')).every((b) => b.disabled));
  pg.click('Remove');
  assert.ok(!pg.text().includes('A room holds up to 6 agents.'));
  pg.receive({ type: 'folder', index: 1, folder: '/other', folderLabel: '~/other' });
  assert.ok(pg.text().includes('~/other'));
  pg.receive({ type: 'error', text: 'Claude: pick one of your Claude conversations, or start fresh.' });
  assert.ok(pg.text().includes('Claude: pick one of your Claude conversations, or start fresh.'));
  pg.receive({ type: 'busy', on: true });
  assert.ok(pg.buttons().find((b) => b.textContent === 'Starting…').disabled);
});
