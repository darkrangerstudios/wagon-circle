'use strict';
// Live typed-assistance check: real Claude + real Codex, each with the room's typed tools, on a small fixture.
// Proves at the process boundary: a request reaches the peer once, its answer returns to the requester without
// an @mention, the task counts turns, and no acknowledgment-only turns follow. Spends a little of both quotas.
// Usage: node test/live-tasks.js <scratchCwd> [claudeModel] [codexModel]
const fs = require('fs');
const path = require('path');
const { CodexClient } = require('../src/codexClient');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const { Room } = require('../src/room');
const { toolSpecs } = require('../src/tasks');
const { roomPrompt } = require('../src/prompts');
const [cwd, claudeModel = 'haiku', codexModel = 'gpt-5.6-luna'] = process.argv.slice(2);
const t0 = Date.now(), say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
let failed = false; const check = (ok, what) => { say(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

fs.mkdirSync(path.join(cwd, 'fixture'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'fixture', 'queue.js'), `'use strict';
// Bounded work queue.
class Queue {
  constructor(limit) { this.items = []; this.limit = limit; }
  push(x) { if (this.items.length > this.limit) return false; this.items.push(x); return true; }
  pop() { return this.items.shift(); }
}
module.exports = { Queue };
`);

(async () => {
  const codex = new CodexClient({ exe: 'codex', cwd, tools: toolSpecs(['claude']) });
  await codex.start();
  const usage = []; codex.on('notification', (m, p) => { if (m === 'thread/tokenUsage/updated') usage.push(p.tokenUsage || p); });
  const thread = await codex.startThread(roomPrompt('codex', 'claude', 'Dean', true));
  await codex.setName(thread.id, 'Wagon Wheel: live typed-assistance test');
  const bin = findClaude('');
  const claude = new ClaudeClient({ exe: bin.path, cwd, model: claudeModel, systemPrompt: roomPrompt('claude', 'codex', 'Dean', true), tools: toolSpecs(['codex']) });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: { get lastTurnUsage() { return codex.lastTurnUsage; }, typed: true, send: (t, d, a, f, onTool) => codex.runTurn(thread.id, t, d, a, f, { model: codexModel, effort: 'low', onTool }), interrupt: () => codex.interrupt() } } });
  room.on('message', (e) => say(`${e.from}${e.kind ? '/' + e.kind : ''}${e.answers ? ' (answers ' + e.answers.map((a) => a.request).join(',') + ')' : ''}: ${e.text.replace(/\s+/g, ' ').slice(0, 220)}`));
  const idle = async () => { await new Promise((r) => setTimeout(r, 1500)); while (room.busy.claude || room.busy.codex) await new Promise((r) => setTimeout(r, 500)); await new Promise((r) => setTimeout(r, 1500)); };

  room.postFromHuman('Review fixture/queue.js for an off-by-one bug. Before concluding, use request_assistance to ask Codex to independently check the exact line you suspect, and wait for its answer. When the answer is back and you agree, call finish_task with a one-line summary.');
  await idle();
  const tr = room.state.transcript, t = room.tasks.get('t1');
  const reqs = tr.filter((e) => e.kind === 'request');
  const answers = tr.filter((e) => e.answers);
  check(!!t, 'a task started from the typed request');
  check(reqs.length >= 1 && reqs[0].from === 'claude' && reqs[0].to === 'codex', `Claude asked Codex through the tool (${reqs.length} request(s))`);
  check(answers.length >= 1 && answers[0].from === 'codex', 'Codex answer resolved the request');
  check(t && t.requests.every((r) => r.status === 'answered'), 'every request answered');
  const claudeTurns = tr.filter((e) => e.from === 'claude' && !e.kind).length, codexTurns = tr.filter((e) => e.from === 'codex' && !e.kind).length;
  check(claudeTurns <= 2 && codexTurns <= reqs.length, `no acknowledgment turns (Claude ${claudeTurns}, Codex ${codexTurns})`);
  check(!tr.some((e) => e.kind === 'error'), 'no errors');
  const u = t ? room.tasks.summary(t).usage : {};
  check(u.claude && u.claude.turns >= 1 && !u.claude.unreported && u.claude.output > 0, `Claude reported its task tokens (${JSON.stringify(u.claude)})`);
  check(u.codex && u.codex.turns >= 1 && !u.codex.unreported && u.codex.output > 0, `Codex reported its task tokens (${JSON.stringify(u.codex)})`);
  say(`task: ${t && t.status} · ${t && t.used.turns} task turns · summary: ${t && t.summary}`);
  say(`Claude CLI ${bin.version.join('.')} ${claudeModel} · cost $${claude.totalCostUsd.toFixed(4)} · last ${JSON.stringify(claude.lastUsage)}`);
  say(`Codex ${codexModel} usage (last): ${JSON.stringify(usage[usage.length - 1]).slice(0, 260)}`);
  claude.stop(); codex.stop(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 300000).unref();
