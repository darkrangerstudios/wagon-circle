'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexClient } = require('../src/codexClient');
const flags = ['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'skill_mcp_dependency_install'];
const features = () => Object.fromEntries(flags.map(k => [k, false]));
const config = () => ({ features: features(), web_search: 'disabled', mcp_servers: { inherited: { command: 'never-run-me' } } });
const disabled = () => ({ name: 'inherited', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] });
function fixture({ cfg = config(), status = { data: [disabled()], nextCursor: null }, response = {} } = {}) {
  const c = new CodexClient({ exe: 'unused', cwd: '/fixture' }); const calls = [];
  c.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'config/read') return { config: cfg };
    if (method === 'mcpServerStatus/list') return typeof status === 'function' ? status(params) : status;
    return { thread: { id: 'verified' }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, ...response };
  };
  return { c, calls };
}
for (const method of ['startThread', 'forkThread', 'resumeThread']) {
  test(`Codex ${method} disables inherited servers and verifies actual permissions before admitting a thread`, async () => {
    const { c, calls } = fixture();
    assert.equal((await c[method]('source')).id, 'verified');
    const attach = calls.find(x => /^thread\/(start|fork|resume)$/.test(x.method));
    assert.deepEqual(attach.params.config.mcp_servers, { inherited: { enabled: false } });
    assert.deepEqual(attach.params.config.features, features());
    assert.equal(attach.params.config.web_search, 'disabled');
    assert.equal(attach.params.cwd, '/fixture');
    assert.equal(c.verifiedThreads.has('verified'), true);
    assert.equal(calls.at(-1).params.threadId, 'verified');
    assert.equal(calls.at(-1).params.detail, 'full');
  });
}
test('Codex cannot start or compact an unverified thread', async () => {
  const { c, calls } = fixture();
  await assert.rejects(c.runTurn('unknown', 'go'), /permissions/);
  await assert.rejects(c.compact('unknown'), /permissions/);
  assert.equal(calls.length, 0);
});
for (const [name, options] of [
  ['inherited apps', { cfg: { ...config(), features: { ...features(), apps: true } } }],
  ['unsupported config', { cfg: {} }],
  ['web search enabled', { cfg: { ...config(), web_search: 'cached' } }],
  ['enabled server with no tools yet', { status: { data: [{ ...disabled(), runtimeStatus: 'starting' }], nextCursor: null } }],
  ['exposed tool', { status: { data: [{ ...disabled(), tools: { remoteWrite: {} } }], nextCursor: null } }],
  ['exposed resource', { status: { data: [{ ...disabled(), resources: [{}] }], nextCursor: null } }],
  ['exposed resource template', { status: { data: [{ ...disabled(), resourceTemplates: [{}] }], nextCursor: null } }],
  ['unsupported inventory', { status: {} }],
  ['missing runtime state', { status: { data: [{ name: 'old', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null } }],
  ['approval mismatch', { response: { approvalPolicy: 'on-request' } }],
  ['sandbox mismatch', { response: { sandbox: { type: 'workspaceWrite', networkAccess: false } } }],
  ['network access', { response: { sandbox: { type: 'readOnly', networkAccess: true } } }],
]) {
  test(`Codex fails closed on ${name}`, async () => {
    const { c, calls } = fixture(options);
    await assert.rejects(c.startThread('brief'), /permissions/);
    await assert.rejects(c.runTurn('verified', 'go'), /permissions/);
    assert.ok(!calls.some(x => x.method === 'turn/start'));
  });
}
test('Codex checks every inventory page and rejects repeated cursors', async () => {
  const { c } = fixture({ status: p => p.cursor ? { data: [{ ...disabled(), runtimeStatus: 'ready' }], nextCursor: null } : { data: [disabled()], nextCursor: 'next' } });
  await assert.rejects(c.startThread('brief'), /permissions/);
  const second = fixture({ status: { data: [], nextCursor: 'repeat' } });
  await assert.rejects(second.c.startThread('brief'), /permissions/);
});
test('Codex Stop and process exit revoke prior verification', async () => {
  const { c } = fixture(); await c.startThread('brief'); c.stop();
  await assert.rejects(c.runTurn('verified', 'go'), /permissions/);
  const other = fixture(); await other.c.startThread('brief'); other.c._fail(new Error('exit'));
  await assert.rejects(other.c.runTurn('verified', 'go'), /permissions/);
});
test('Codex cannot regain verified status after Stop during attachment', async () => {
  let release;
  const { c } = fixture({ status: () => new Promise(resolve => { release = resolve; }) });
  const attaching = c.startThread('brief');
  await new Promise(resolve => setImmediate(resolve));
  c.stop(); release({ data: [disabled()], nextCursor: null });
  await assert.rejects(attaching, /permissions/);
  await assert.rejects(c.runTurn('verified', 'go'), /permissions/);
});
test('a resume that finds no saved thread is flagged (Codex writes a thread only after its first turn); other failures are not', async () => {
  const { c } = fixture();
  const base = c.request;
  c.request = async (method, params) => { if (method === 'thread/resume') throw new Error('no rollout found for thread id 01a0-secret-/Users/x'); return base(method, params); };
  const e = await c.resumeThread('01a0').catch((x) => x);
  assert.equal(e.noRollout, true);
  assert.equal(e.message.includes('/Users/x'), false, 'the raw payload is still not forwarded');
  const { c: c2 } = fixture();
  const base2 = c2.request;
  c2.request = async (method, params) => { if (method === 'thread/resume') throw new Error('permission denied'); return base2(method, params); };
  assert.equal((await c2.resumeThread('01a0').catch((x) => x)).noRollout, false);
  const { c: c3 } = fixture();
  const base3 = c3.request;
  c3.request = async (method, params) => { if (method === 'thread/fork') throw new Error('no rollout found'); return base3(method, params); };
  assert.equal((await c3.forkThread('01a0', 'brief').catch((x) => x)).noRollout, false, 'only resume can fall back');
});
