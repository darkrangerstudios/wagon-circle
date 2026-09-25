'use strict';
// Launchers: the Activity Bar side panel (Start buttons, saved Rooms), the editor title button and the status bar item.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');
const roomsView = require('../src/roomsView');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwrooms-'));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function writeRoom(dir, n, meta, mtime) {
  const file = path.join(dir, `${meta.id || id(n)}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta: { id: id(n), createdAt: '2026-09-25T10:00:00Z', ...meta }, state: { transcript: [{ from: 'human', text: 'PRIVATE_TRANSCRIPT' }] } }));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

test('listRooms: newest activity first, skips files that are not rooms, and old rooms get the Claude and Codex seats', () => {
  const dir = tmp(), t = Date.parse('2026-09-25T12:00:00Z');
  writeRoom(dir, 1, { name: 'older', participants: [{ id: 'claude', label: 'Reader', provider: 'claude' }] }, t - 3600e3);
  writeRoom(dir, 2, { name: 'newer\u0007 room' }, t);
  fs.writeFileSync(path.join(dir, `${id(3)}.json`), '{ half written');
  fs.writeFileSync(path.join(dir, `${id(4)}.json`), JSON.stringify({ meta: { id: id(5), name: 'wrong file' } }));
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ meta: { id: 'notes', name: 'x' } }));
  fs.mkdirSync(path.join(dir, id(1)));  // a room's attachments folder
  const rooms = roomsView.listRooms(dir);
  assert.deepStrictEqual(rooms.map((r) => r.name), ['newer  room', 'older']);
  assert.deepStrictEqual(rooms[0].seats.map((s) => s.label), ['Claude', 'Codex']);
  assert.deepStrictEqual(rooms[1].seats, [{ label: 'Reader', provider: 'claude' }]);
  assert.ok(!JSON.stringify(rooms).includes('PRIVATE_TRANSCRIPT'), 'the list carries no transcript');
  assert.deepStrictEqual(roomsView.listRooms(path.join(dir, 'missing')), []);
});

test('listRooms parses each room file once until it changes, and forgets deleted rooms', () => {
  const dir = tmp(), cache = new Map(), t = Date.parse('2026-09-25T12:00:00Z');
  const file = writeRoom(dir, 1, { name: 'a' }, t);
  let reads = 0;
  const fsx = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } };
  roomsView.listRooms(dir, cache, fsx); roomsView.listRooms(dir, cache, fsx);
  assert.strictEqual(reads, 1);
  writeRoom(dir, 1, { name: 'renamed' }, t + 5000);
  assert.strictEqual(roomsView.listRooms(dir, cache, fsx)[0].name, 'renamed');
  assert.strictEqual(reads, 2);
  fs.unlinkSync(file);
  assert.deepStrictEqual(roomsView.listRooms(dir, cache, fsx), []);
  assert.strictEqual(cache.size, 0);
});

test('describe: open rooms say so, others say when they were last used', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const room = { name: 'r', seats: [{ label: 'Claude' }, { label: 'Codex' }], cwd: '/w', updatedAt: now - 2 * 3600e3 };
  assert.strictEqual(roomsView.describe(room, { now }).description, '2 h ago · Claude, Codex');
  assert.strictEqual(roomsView.describe(room, { now, open: true }).description, 'open · Claude, Codex');
  assert.match(roomsView.describe(room, { now }).tooltip, /Click to reopen/);
  assert.deepStrictEqual([30e3, 5 * 60e3, 30 * 3600e3, 3 * 86400e3].map((d) => roomsView.ago(now - d, now)), ['just now', '5 min ago', 'yesterday', '3 days ago']);
});

// Extension glue with a VS Code stub that records what activate() registers.
function loadExtension(state = {}) {
  const disposable = { dispose() {} };
  const rec = { trees: {}, commands: {}, bars: [], warnings: [], panels: [], configListeners: [], executed: [] };
  const settings = { ...state.settings };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (k) => settings[k], inspect: (k) => (k in settings ? { globalValue: settings[k] } : undefined), update: async () => {} }), workspaceFolders: undefined, isTrusted: true,
      registerTextDocumentContentProvider: () => disposable, onDidChangeConfiguration: (fn) => { rec.configListeners.push(fn); return disposable; } },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable, onDidChangeTextEditorVisibleRanges: () => disposable,
      registerTreeDataProvider: (id, p) => { rec.trees[id] = p; return disposable; },
      createStatusBarItem: (id, align, prio) => { const b = { id, align, prio, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; rec.bars.push(b); return b; },
      showWarningMessage: async (m) => { rec.warnings.push(m); },
      createWebviewPanel: (type, title) => { const p = { type, title, webview: { html: '', cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: () => {}, postMessage: () => {} }, onDidDispose: () => {}, reveal() { this.revealed = (this.revealed || 0) + 1; } }; rec.panels.push(p); return p; },
      withProgress: async () => {},
    },
    commands: { registerCommand: (cid, fn) => { rec.commands[cid] = fn; return disposable; }, executeCommand: async (...a) => { rec.executed.push(a); } },
    EventEmitter: class { constructor() { this.fired = 0; this.event = () => disposable; } fire() { this.fired++; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.state = state; } },
    TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 }, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 }, ConfigurationTarget: { Global: 1 },
    Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }), file: (p) => ({ fsPath: p }), parse: (u) => u },
    env: {}, version: '1.104.0',
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...a) { return req === 'vscode' ? vscode : realLoad.call(this, req, parent, ...a); };
  let ext;
  try { delete require.cache[require.resolve('../src/extension')]; ext = require('../src/extension'); } finally { Module._load = realLoad; }
  const storage = tmp();
  const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, globalStorageUri: { fsPath: storage }, extensionUri: { fsPath: root } };
  ext.activate(context);
  return { ext, rec, context, settings, rooms: path.join(storage, 'rooms') };
}

test('activate registers the side panel views, the room commands and a status bar button that opens New Room', () => {
  const { rec } = loadExtension();
  assert.deepStrictEqual(Object.keys(rec.trees).sort(), ['wagonWheel.rooms', 'wagonWheel.start']);
  assert.deepStrictEqual(rec.trees['wagonWheel.start'].getChildren(), [], 'Start stays empty so VS Code shows its buttons');
  assert.ok(rec.commands['wagonWheel.openRoomById'] && rec.commands['wagonWheel.refreshRooms']);
  assert.strictEqual(rec.bars.length, 1);
  assert.strictEqual(rec.bars[0].command, 'wagonWheel.newRoom');
  assert.strictEqual(rec.bars[0].visible, true);
});

test('the status bar button follows wagonWheel.showStatusBar, including live changes', () => {
  const { rec, settings } = loadExtension({ settings: { showStatusBar: false } });
  assert.strictEqual(rec.bars[0].visible, false);
  settings.showStatusBar = true;
  rec.configListeners.forEach((fn) => fn({ affectsConfiguration: (k) => k === 'wagonWheel.showStatusBar' }));
  assert.strictEqual(rec.bars[0].visible, true);
});

test('Rooms view: each saved room is a row that reopens it by id', () => {
  const { rec, rooms } = loadExtension();
  fs.mkdirSync(rooms, { recursive: true });
  writeRoom(rooms, 7, { name: 'date-parser release check', cwd: '/w', participants: [{ id: 'claude', label: 'Claude', provider: 'claude' }] });
  const tree = rec.trees['wagonWheel.rooms'];
  const [room] = tree.getChildren();
  const item = tree.getTreeItem(room);
  assert.strictEqual(item.label, 'date-parser release check');
  assert.deepStrictEqual(item.command, { command: 'wagonWheel.openRoomById', title: 'Open room', arguments: [id(7)] });
  assert.strictEqual(item.iconPath.id, 'comment-discussion');
  assert.match(item.description, /Claude$/);
});

test('openRoomById: rejects ids that are not room ids, reveals an open room instead of starting a second, and reopens a saved one', async () => {
  const { ext, rec, rooms, context } = loadExtension();
  fs.mkdirSync(rooms, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(rooms), 'outside.json'), JSON.stringify({ meta: { id: 'outside', name: 'x' } }));
  await rec.commands['wagonWheel.openRoomById']('../outside');
  await rec.commands['wagonWheel.openRoomById']({ id: 'x' });
  assert.strictEqual(rec.panels.length, 0);
  assert.strictEqual(rec.warnings.length, 0, 'invalid ids are ignored quietly');

  await ext.openRoomById(context, id(9));
  assert.match(rec.warnings[0], /could not be read/);

  writeRoom(rooms, 8, { name: 'saved room' });
  await ext.openRoomById(context, id(8));
  assert.strictEqual(rec.panels.length, 1);
  assert.strictEqual(rec.panels[0].title, 'Wagon Wheel: saved room');
  assert.match(rec.panels[0].iconPath.dark.fsPath, /media\/wheel-dark\.svg$/, 'the room tab shows the wheel');
  const tree = rec.trees['wagonWheel.rooms'];
  assert.strictEqual(tree.getTreeItem(tree.getChildren().find((r) => r.id === id(8))).iconPath.id, 'circle-filled', 'an open room is marked');

  await ext.openRoomById(context, id(8));
  assert.strictEqual(rec.panels.length, 1, 'no second panel for an open room');
  assert.strictEqual(rec.panels[0].revealed, 1);
});

test('manifest: Activity Bar container, both views, welcome buttons, editor title button and settings are wired', () => {
  const c = pkg.contributes;
  const container = c.viewsContainers.activitybar.find((v) => v.id === 'wagonWheel');
  assert.ok(container && fs.existsSync(path.join(root, container.icon)));
  assert.deepStrictEqual(c.views.wagonWheel.map((v) => v.id), ['wagonWheel.start', 'wagonWheel.rooms']);
  const commands = new Set(c.commands.map((x) => x.command));
  for (const w of c.viewsWelcome) for (const m of w.contents.matchAll(/\(command:([\w.]+)\)/g)) assert.ok(commands.has(m[1]), `${m[1]} is a contributed command`);
  assert.match(c.viewsWelcome.find((w) => w.view === 'wagonWheel.start').contents, /command:wagonWheel\.newRoom/);
  const button = c.menus['editor/title'].find((m) => m.command === 'wagonWheel.newRoom');
  assert.strictEqual(button.group, 'navigation');
  assert.strictEqual(button.when, 'config.wagonWheel.showEditorButton');
  const icon = c.commands.find((x) => x.command === 'wagonWheel.newRoom').icon;
  for (const f of [icon.light, icon.dark]) assert.ok(fs.existsSync(path.join(root, f)), f);
  const general = c.configuration.find((g) => g.title === 'General').properties;
  assert.strictEqual(general['wagonWheel.showEditorButton'].default, true);
  assert.strictEqual(general['wagonWheel.showStatusBar'].default, true);
  const hidden = c.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command).sort();
  assert.deepStrictEqual(hidden, ['wagonWheel.openRoomById', 'wagonWheel.refreshRooms']);
  assert.ok(pkg.activationEvents.includes('onStartupFinished'), 'the status bar button is there before any command runs');
});
