'use strict';
// Creates a fresh test thread; --seed spends one model turn plus an immediately stopped turn so Codex persists its rollout for fork/resume.
// Without --seed, only thread/start is tested. No MCP tool invocations.
// Usage: node test/live-permissions.js <codexExecutable> <scratchCwd> [--seed]
const assert = require('node:assert/strict');
const { CodexClient } = require('../src/codexClient');
const { toolSpecs } = require('../src/tasks');
const [exe, cwd, mode] = process.argv.slice(2);
let modelTurns = 0;
if (!exe || !cwd) throw new Error('Pass the Codex executable and a scratch folder');
const client = new CodexClient({ exe, cwd, tools: toolSpecs(['claude']) });
const timer = setTimeout(() => { client.stop(); process.exitCode = 1; }, 60000);
async function check(thread, label) {
  assert.equal(client.verifiedThreads.has(thread.id), true);
  const result = await client.request('mcpServerStatus/list', { threadId: thread.id, limit: 100, detail: 'full' });
  assert.ok(result.data.every(s => s.runtimeStatus === 'disabled' && !Object.keys(s.tools).length && !s.resources.length && !s.resourceTemplates.length));
  console.log(JSON.stringify({ check: label, passed: true, disabledServers: result.data.length, modelTurns }));
}
(async () => {
  try {
    await client.start();
    const source = await client.startThread('Empty permission-boundary test.'); await check(source, 'start');
    if (mode !== '--seed') { console.log('Fork/resume skipped: an empty thread has no persisted rollout.'); return; }
    modelTurns++;
    let roomToolCalls = 0;
    await client.runTurn(source.id, 'Call finish_task with summary READY once, then reply READY. Do not use any other tools.', () => {}, () => {}, [], { model: 'gpt-6-astra', effort: 'high', onTool: (name) => { assert.equal(name, 'finish_task'); roomToolCalls++; return { ok: true, text: 'Accepted.' }; } });
    assert.equal(roomToolCalls, 1);
    console.log(JSON.stringify({ check: 'room dynamic tool remains callable', passed: true, roomToolCalls, modelTurns }));
    const fork = await client.forkThread(source.id, 'Empty permission-boundary fork.'); await check(fork, 'fork');
    await check(await client.resumeThread(source.id), 'resume');
    modelTurns++;
    const turn = client.runTurn(source.id, 'Count from 1 to 300, one number per line.', () => {}, () => {}, [], { model: 'gpt-6-astra', effort: 'high' });
    const outcome = turn.then(() => false, e => e.stopped === true);
    await client.interrupt();
    assert.equal(await outcome, true);
    assert.equal(client.currentTurn, null);
    console.log(JSON.stringify({ check: 'Stop before turn/start resolves', passed: true, modelTurns }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { clearTimeout(timer); client.stop(); }
})();
