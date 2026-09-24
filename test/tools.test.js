'use strict';
// Typed room tools at the process boundary, transport faked: Claude's in-process MCP server over stream-json,
// Codex's dynamicTools over app-server JSON-RPC.
const test = require('node:test');
const assert = require('node:assert');
const { ClaudeClient } = require('../src/claudeClient');
const { CodexClient } = require('../src/codexClient');
const { toolSpecs } = require('../src/tasks');
const tick = () => new Promise((r) => setImmediate(r));

function claude(tools = toolSpecs(['codex'])) {
  const writes = [];
  const c = new ClaudeClient({ exe: 'unused', cwd: __dirname, systemPrompt: '', tools });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } }, kill() {} };
  return { c, writes, mcp: (id, method, params) => c._onLine(JSON.stringify({ type: 'control_request', request_id: `q${id}`, request: { subtype: 'mcp_message', server_name: 'wagon', message: { jsonrpc: '2.0', id, method, params } } })) };
}
const reply = (writes, rid) => writes.find((w) => w.type === 'control_response' && w.response.request_id === rid).response.response.mcp_response;

test('Claude: typed tools are allowed and served in-process; no other MCP server is configured', () => {
  const { c } = claude();
  const a = c._args();
  assert.deepStrictEqual(JSON.parse(a[a.indexOf('--mcp-config') + 1]), { mcpServers: { wagon: { type: 'sdk', name: 'wagon' } } });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.strictEqual(a[a.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,mcp__wagon__request_assistance,mcp__wagon__finish_task');
  const plain = new ClaudeClient({ exe: 'x', cwd: __dirname, systemPrompt: '' })._args();
  assert.strictEqual(plain[plain.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
});

test('Claude: tools/list and tools/call are answered over stdin; the call goes to the open reply', async () => {
  const { c, writes, mcp } = claude();
  mcp(1, 'tools/list'); await tick();
  assert.deepStrictEqual(reply(writes, 'q1').result.tools.map((t) => t.name), ['request_assistance', 'finish_task']);
  const seen = [];
  const pending = c.send('go', () => {}, () => {}, [], (name, args) => { seen.push([name, args]); return { ok: true, text: 'accepted r1' }; });
  mcp(2, 'tools/call', { name: 'request_assistance', arguments: { to: 'codex', purpose: 'review', question: 'q' } }); await tick(); await tick();
  assert.deepStrictEqual(seen, [['request_assistance', { to: 'codex', purpose: 'review', question: 'q' }]]);
  assert.deepStrictEqual(reply(writes, 'q2').result, { content: [{ type: 'text', text: 'accepted r1' }] });
  c._onLine(JSON.stringify({ type: 'result', result: 'done' }));
  assert.strictEqual(await pending, 'done');
});

test('Claude: a refused call is an MCP error result; a call with no reply open is refused', async () => {
  const { c, writes, mcp } = claude();
  const pending = c.send('go', () => {}, () => {}, [], () => ({ ok: false, text: 'Not sent: paused' }));
  mcp(3, 'tools/call', { name: 'request_assistance', arguments: {} }); await tick(); await tick();
  assert.strictEqual(reply(writes, 'q3').result.isError, true);
  c._onLine(JSON.stringify({ type: 'result', result: 'x' })); await pending;
  mcp(4, 'tools/call', { name: 'finish_task', arguments: { summary: 's' } }); await tick(); await tick();
  assert.match(reply(writes, 'q4').result.content[0].text, /no reply is open/);
});

function codex() {
  const writes = []; const c = new CodexClient({ exe: 'unused', cwd: __dirname, tools: toolSpecs(['claude']) });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } } };
  const call = (id, threadId) => c._onLine(JSON.stringify({ id, method: 'item/tool/call', params: { threadId, turnId: 't1', callId: 'c', tool: 'request_assistance', arguments: { to: 'claude', purpose: 'test', question: 'q' }, namespace: null } }));
  return { c, writes, call };
}

test('Codex: new threads carry the tools; a tool call reaches the running turn on that thread only', async () => {
  const { c, writes, call } = codex(); const sent = [];
  c.request = (method, params) => { sent.push({ method, params }); return method === 'thread/start' ? Promise.resolve({ thread: { id: 'th' } }) : new Promise(() => {}); };
  await c.startThread('brief');
  assert.deepStrictEqual(sent[0].params.dynamicTools.map((t) => [t.type, t.name]), [['function', 'request_assistance'], ['function', 'finish_task']]);
  c.runTurn('th', 'go', () => {}, () => {}, [], { onTool: (name, args) => ({ ok: true, text: `accepted for ${args.to}` }) });
  call(7, 'th'); await tick(); await tick();
  assert.deepStrictEqual(writes.find((w) => w.id === 7).result, { contentItems: [{ type: 'inputText', text: 'accepted for claude' }], success: true });
  call(8, 'other-thread'); await tick(); await tick();
  assert.strictEqual(writes.find((w) => w.id === 8).result.success, false);
});

test('Codex: other server requests are still declined', () => {
  const { c, writes } = codex();
  c._onLine(JSON.stringify({ id: 9, method: 'item/commandExecution/requestApproval', params: {} }));
  assert.ok(writes.find((w) => w.id === 9).error);
});
