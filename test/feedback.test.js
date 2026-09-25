'use strict';
// Report a Problem: the issue URL carries versions and the roster, and log lines only on opt-in, scrubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');
const feedback = require('../src/feedback');
const setup = require('../src/setup');

const facts = (extra = {}) => ({ extension: '0.5.3', vscode: '1.104.0', platform: 'darwin arm64', remote: null,
  clis: [{ name: 'Claude Code CLI', version: '2.1.282' }, { name: 'Codex CLI', version: null, state: 'not found' }],
  seats: [{ id: 'claude', label: 'Claude', provider: 'claude', model: 'claude-sonnet-5', effort: 'high' }], log: [], ...extra });
const bodyOf = (url) => new URL(url).searchParams.get('body');

test('scrub removes the home folder, the login name, emails and secret-shaped strings', () => {
  const who = { home: '/Users/alex', user: 'alex' };
  const out = feedback.scrub('spawn /Users/alex/.local/bin/claude for alex@example.com key sk-ant-api03-abcdefgh token ghp_abcdefghijklmnop Bearer xyz.abc 0123456789abcdef0123456789abcdef session eyJhbGciOi.eyJzdWIi.c2ln user alex done', who);
  for (const leak of ['/Users/alex', 'alex@example.com', 'sk-ant', 'ghp_', 'xyz.abc', '0123456789abcdef', 'eyJ', ' alex ']) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  assert.match(out, /~\/\.local\/bin\/claude/);
  assert.match(out, /user <user> done/);
});

test('scrub keeps ordinary paths readable (seen natively: the Claude CLI path was cut short)', () => {
  const line = '[t] setup: Claude Code: v2.1.282, signed in [/Users/alex/.vscode/extensions/anthropic.claude-code-2.1.282-darwin-arm64/resources/native-binary/claude]';
  assert.strictEqual(feedback.scrub(line, { home: '/Users/alex', user: 'alex' }),
    '[t] setup: Claude Code: v2.1.282, signed in [~/.vscode/extensions/anthropic.claude-code-2.1.282-darwin-arm64/resources/native-binary/claude]');
  assert.strictEqual(feedback.scrub('thread 019a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b ok'), 'thread <redacted> ok');
});

test('scrub leaves words that merely contain the login name, strips control characters and caps length', () => {
  assert.strictEqual(feedback.scrub('alexander ok', { user: 'alex' }), 'alexander ok');
  assert.ok(!feedback.scrub('a\x1b[31mred\x07').includes('\x1b'));
  assert.ok(feedback.scrub('x'.repeat(10) + ' ' + 'word '.repeat(100)).length <= 200);
});

test('without opt-in the issue has versions and roster but no log lines', () => {
  const { url, logLines } = feedback.issueUrl(facts({ log: ['[t] codex stderr: SECRET_LOG_LINE'] }));
  assert.ok(url.startsWith(feedback.ISSUES_URL + '?'));
  const body = bodyOf(url);
  assert.deepStrictEqual(logLines, []);
  assert.ok(!body.includes('SECRET_LOG_LINE'));
  assert.match(body, /Wagon Wheel: 0\.5\.3/);
  assert.match(body, /Claude Code CLI: 2\.1\.282/);
  assert.match(body, /Codex CLI: not found/);
  assert.match(body, /Claude \(claude, claude-sonnet-5, high\)/);
  assert.match(body, /no conversation, prompts, files or session contents/);
});

test('with opt-in only the last ten lines go in, scrubbed', () => {
  const log = Array.from({ length: 14 }, (_, i) => `[t] line ${i} /Users/alex/x`);
  const { url, logLines } = feedback.issueUrl(facts({ log }), { includeLog: true, home: '/Users/alex', user: 'alex' });
  assert.strictEqual(logLines.length, feedback.LOG_LINES);
  assert.strictEqual(logLines[0], '[t] line 4 ~/x');
  const body = bodyOf(url);
  assert.ok(!body.includes('line 3 '));
  assert.ok(!body.includes('/Users/alex'));
  assert.match(body, /Last 10 log lines \(scrubbed\)/);
});

test('an over-long report drops the oldest log lines first and stays under the URL limit', () => {
  const log = Array.from({ length: 10 }, (_, i) => `[t] ${i} ` + '€'.repeat(190)); // 9 URL characters each
  const { url, logLines } = feedback.issueUrl(facts({ log }), { includeLog: true });
  assert.ok(url.length <= feedback.MAX_URL);
  assert.ok(logLines.length < 10 && logLines.length > 0);
  assert.ok(logLines[logLines.length - 1].startsWith('[t] 9 '));
});

test('cliVersion reports a version, not found, or unknown and never raw output', async () => {
  const run = (out) => async () => out;
  assert.strictEqual(await setup.cliVersion('claude', 'claude', { run: run({ code: 0, stdout: '2.1.282 (Claude Code)\n' }) }), '2.1.282');
  assert.strictEqual(await setup.cliVersion('codex', 'codex', { run: run({ code: 0, stdout: 'codex-cli 0.99.0\n' }) }), '0.99.0');
  assert.strictEqual(await setup.cliVersion('codex', 'codex', { run: run({ code: 'ENOENT', stdout: '' }) }), 'not found');
  assert.strictEqual(await setup.cliVersion('claude', 'claude', { run: run({ code: 0, stdout: 'hello alex@example.com' }) }), 'unknown');
  assert.strictEqual(await setup.cliVersion('gemini', 'gemini', { run: run({ code: 0, stdout: '1.0.0' }) }), 'unknown');
});

test('first run checks only the room\'s providers that have not passed before', () => {
  const seats = [{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }, { provider: 'acp' }];
  assert.deepStrictEqual(setup.firstRunProviders(seats, {}), ['claude', 'codex']);
  assert.deepStrictEqual(setup.firstRunProviders(seats, { claude: true }), ['codex']);
  assert.deepStrictEqual(setup.firstRunProviders(seats, { claude: true, codex: true }), []);
  assert.deepStrictEqual(setup.firstRunProviders(seats, 'garbage'), ['claude', 'codex']);
  assert.ok(setup.blocking({ installation: 'missing' }));
  assert.ok(setup.blocking({ installation: 'available', authentication: 'signed-out' }));
  assert.ok(!setup.blocking({ installation: 'available', authentication: 'unknown' }));
  assert.ok(!setup.passes({ installation: 'available', authentication: 'unknown' }));
});

// Extension glue with VS Code and the CLI probe stubbed.
function loadExtension(ui) {
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: ui.trusted !== false },
    window: {
      withProgress: async (_o, fn) => fn(),
      showWarningMessage: async (msg, opts, ...buttons) => { ui.warnings.push({ msg, opts, buttons }); return ui.answer; },
      showInformationMessage: async (msg, opts, ...buttons) => { ui.infos.push({ msg, opts, buttons }); return ui.answer; },
    },
    ProgressLocation: { Notification: 15 }, version: '1.104.0',
    env: { remoteName: undefined, openExternal: (u) => { ui.opened.push(String(u)); } },
    Uri: { parse: (u) => u, file: (p) => ({ fsPath: p }) },
    commands: { executeCommand: async () => {} },
  };
  const fakeSetup = { ...setup, checkSetup: async ({ executables }) => { ui.checked.push(Object.keys(executables)); return { executionHost: 'this computer', state: 'x', providers: Object.keys(executables).map((p) => ({ provider: p, executable: executables[p], guide: setup.GUIDES[p], ...ui.results[p] })) }; },
    cliVersion: async (p) => (p === 'claude' ? '2.1.282' : 'not found') };
  const fakes = { [require.resolve('../src/setup')]: fakeSetup, [require.resolve('../src/claudeBinary')]: { findClaude: () => ({ path: 'claude', version: [2, 1, 282] }), atLeast: () => true } };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...a) {
    if (req === 'vscode') return vscode;
    const file = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
    return file && fakes[file] ? fakes[file] : realLoad.call(this, req, parent, ...a);
  };
  try { delete require.cache[require.resolve('../src/extension')]; return require('../src/extension'); } finally { Module._load = realLoad; }
}
const memo = () => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); }, m }; };
const ui = (o = {}) => ({ warnings: [], infos: [], opened: [], checked: [], results: {}, ...o });

test('first New Room: a passing provider is recorded and not probed again', async () => {
  const u = ui({ results: { claude: { installation: 'available', version: '2.1.282', authentication: 'present' } } });
  const ext = loadExtension(u), context = { globalState: memo() };
  assert.strictEqual(await ext.firstRunCheck(context, [{ provider: 'claude' }]), true);
  assert.deepStrictEqual(context.globalState.get(setup.PASSED_KEY), { claude: true });
  assert.strictEqual(await ext.firstRunCheck(context, [{ provider: 'claude' }]), true);
  assert.deepStrictEqual(u.checked, [['claude']]);
  assert.strictEqual(u.warnings.length, 0);
});

test('first New Room: a signed-out CLI warns before any turn; dismissing cancels, and nothing is recorded', async () => {
  const u = ui({ answer: undefined, results: { codex: { installation: 'available', version: '0.99.0', authentication: 'signed-out' } } });
  const ext = loadExtension(u), context = { globalState: memo() };
  assert.strictEqual(await ext.firstRunCheck(context, [{ provider: 'codex' }]), false);
  assert.strictEqual(u.warnings.length, 1);
  assert.ok(u.warnings[0].opts.modal);
  assert.match(u.warnings[0].msg, /Codex CLI: v0\.99\.0, signed out/);
  assert.deepStrictEqual(u.warnings[0].buttons, ['Create room anyway', 'Open Codex CLI guide']);
  assert.strictEqual(context.globalState.get(setup.PASSED_KEY), undefined);
});

test('first New Room: the person can continue anyway, or open the guide (which cancels)', async () => {
  const results = { claude: { installation: 'missing' } };
  let u = ui({ answer: 'Create room anyway', results });
  assert.strictEqual(await loadExtension(u).firstRunCheck({ globalState: memo() }, [{ provider: 'claude' }]), true);
  u = ui({ answer: 'Open Claude Code guide', results });
  assert.strictEqual(await loadExtension(u).firstRunCheck({ globalState: memo() }, [{ provider: 'claude' }]), false);
  assert.deepStrictEqual(u.opened, [setup.GUIDES.claude]);
});

test('first New Room: an untrusted workspace is not probed', async () => {
  const u = ui({ trusted: false });
  assert.strictEqual(await loadExtension(u).firstRunCheck({ globalState: memo() }, [{ provider: 'claude' }]), true);
  assert.deepStrictEqual(u.checked, []);
});

test('Report a Problem never puts room transcript text in the issue, and cancelling opens nothing', async () => {
  let u = ui({ answer: undefined });
  const ext = loadExtension(u);
  await ext.reportProblem();
  assert.deepStrictEqual(u.opened, []);
  assert.match(u.infos[0].opts.detail, /Never included: your conversation, prompts, files or session contents/);

  u = ui({ answer: 'Open issue' });
  const ext2 = loadExtension(u);
  const s = new ext2.RoomSession({ globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'wwfb-')) } }, ext2.newMeta('r'), null);
  s.meta.participants = [{ id: 'claude', label: 'Claude', provider: 'claude', model: 'claude-sonnet-5' }];
  s.room = { state: { transcript: [{ from: 'human', text: 'TRANSCRIPT_SECRET' }] } };
  s.controls = () => ({ claude: { model: 'claude-opus-5-5', effort: 'max' } });
  s.attach({ active: true, webview: { onDidReceiveMessage: () => {}, postMessage: () => {} }, onDidDispose: () => {} }); // registers it as an open room
  await ext2.reportProblem();
  assert.match(u.infos[0].opts.detail, /Claude Code CLI 2\.1\.282, Codex CLI not found/);
  assert.strictEqual(u.opened.length, 1);
  const body = bodyOf(u.opened[0]);
  assert.ok(!body.includes('TRANSCRIPT_SECRET'));
  assert.match(body, /Claude Code CLI: 2\.1\.282/);
  assert.match(body, /Codex CLI: not found/);
  assert.match(body, /Room: Claude \(claude, claude-opus-5-5, max\)/, 'the live model from the room controls, not the saved default');
});
