'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProvider, checkSetup, runProbe } = require('../src/setup');
const output = (stdout, code = 0, stderr = '') => ({ stdout, code, stderr });
function fake(...outputs) { const calls = []; return { calls, run: async (...args) => { calls.push(args); return outputs.shift(); } }; }
test('setup probes only version and read-only auth commands, without leaking identity', async () => {
  const probe = fake(output('2.1.280 (Claude Code)'), output(JSON.stringify({ loggedIn: true, email: 'private@example.test', authToken: 'SECRET' })));
  const result = await checkProvider('claude', '/configured/claude', probe);
  assert.equal(result.authentication, 'present'); assert.equal(result.version, '2.1.280');
  assert.deepEqual(probe.calls, [['/configured/claude', ['--version']], ['/configured/claude', ['auth', 'status', '--json']]]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private@example/);
});
test('Codex reports credential presence while stripping raw key-bearing output', async () => {
  const probe = fake(output('codex-cli 0.153.1'), output('', 0, 'Logged in using an API key - SECRET'));
  const result = await checkProvider('codex', 'codex', probe);
  assert.equal(result.authentication, 'present'); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.deepEqual(probe.calls[1][1], ['login', 'status']);
});
test('missing executables do not trigger auth or any installation', async () => {
  const probe = fake({ code: 'ENOENT' });
  const result = await checkProvider('codex', 'missing', probe);
  assert.equal(result.installation, 'missing'); assert.equal(probe.calls.length, 1);
});
test('unknown or failed auth output is not mislabeled signed out or ready', async () => {
  for (const auth of [output('unknown format'), output('Not logged in', 2), { code: 1, timedOut: true }]) {
    const result = await checkProvider('codex', 'codex', fake(output('codex-cli 0.153.1'), auth));
    assert.equal(result.authentication, 'unknown'); assert.match(result.issue, /^auth-check-/);
  }
});
test('recognized signed-out responses remain actionable setup results', async () => {
  assert.equal((await checkProvider('claude', 'claude', fake(output('2.1.280 (Claude Code)'), output('{"loggedIn":false}', 1)))).authentication, 'signed-out');
  assert.equal((await checkProvider('codex', 'codex', fake(output('codex-cli 0.153.1'), output('', 1, 'Not logged in')))).authentication, 'signed-out');
});
test('untrusted workspace cannot launch probes; execution-host label stays explicit', async () => {
  let calls = 0;
  const options = { run: async () => { calls++; throw new Error('should not run'); } };
  const result = await checkSetup({ trusted: false, executionHost: 'SSH: dev', executables: { codex: 'codex' } }, options);
  assert.equal(result.state, 'workspace-untrusted'); assert.equal(result.executionHost, 'SSH: dev'); assert.equal(calls, 0);
});
test('empty setup is not ready and failed single provider does not hide the other', async () => {
  assert.equal((await checkSetup({ trusted: true, executionHost: 'local', executables: {} })).state, 'needs-attention');
  const result = await checkSetup({ trusted: true, executionHost: 'container', executables: { codex: 'codex', claude: 'missing' } }, {
    run: async (exe, args) => exe === 'missing' ? { code: 'ENOENT' } : output(args[0] === '--version' ? 'codex-cli 0.153.1' : 'Logged in using ChatGPT'),
  });
  assert.equal(result.state, 'needs-attention'); assert.equal(result.providers[0].authentication, 'present');
});
test('safe runner uses argv and closes stdin without invoking a shell', async () => {
  const result = await runProbe(process.execPath, ['-e', 'process.stdin.on("end",()=>console.log(process.argv[1]));process.stdin.resume()', 'literal;$(not-a-command)']);
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), 'literal;$(not-a-command)');
});
