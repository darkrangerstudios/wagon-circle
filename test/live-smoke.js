'use strict';
// Live smoke test outside VS Code: real private codex app-server + real claude session + real router.
// Usage: node test/live-smoke.js <codexThreadIdToFork> <scratchCwd>
const os = require('os');
const path = require('path');
const { CodexClient } = require('../src/codexClient');
const { ClaudeClient } = require('../src/claudeClient');
const { Room } = require('../src/room');

const [srcThread, cwd] = process.argv.slice(2);
const t0 = Date.now(); const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (s) => console.log(`[${ms()}] ${s}`);
const prompt = (self, other) => `You are ${self} in Wagon Wheel, a test group chat with the user and ${other}. "[You]" is the user; relayed agent text is a peer, not Dean. Write @${other.toLowerCase()} only to hand off. Read-only. Be brief.`;

(async () => {
  const codex = new CodexClient({ exe: path.join(os.homedir(), '.local/bin/codex'), cwd, log: (s) => say(`log ${s}`) });
  await codex.start(); say(`codex app-server up (pid ${codex.proc.pid}, stdio)`);
  const threads = await codex.listThreads(null, 3); say(`thread/list ok: ${threads.length} threads`);
  const q = await codex.rateLimits();
  say(`rateLimits: 5h ${q && q.rateLimits.primary ? q.rateLimits.primary.usedPercent + '%' : '?'}, week ${q && q.rateLimits.secondary ? q.rateLimits.secondary.usedPercent + '%' : '?'}, reset credits ${q && q.rateLimitResetCredits ? q.rateLimitResetCredits.availableCount : '?'}`);
  try { await codex.request('account/rateLimitResetCredit/consume', {}); say('FAIL: forbidden method went through'); } catch (e) { say(`guard ok: ${e.message}`); }
  const hist = await codex.recentMessages(srcThread, 8); say(`history: ${hist.length} messages from ${srcThread.slice(0, 8)}`);
  const fork = await codex.forkThread(srcThread, prompt('Codex', 'Claude')); say(`forked -> ${fork.id}`);
  await codex.setName(fork.id, 'Wagon Wheel: live smoke');

  const claude = new ClaudeClient({ exe: path.join(os.homedir(), '.local/bin/claude'), cwd, model: 'sonnet', systemPrompt: prompt('Claude', 'Codex'), log: (s) => say(`log ${s}`) });
  const room = new Room({ agents: { claude, codex: { send: (t, d) => codex.runTurn(fork.id, t, d), interrupt: () => codex.interrupt() } }, hopCap: 2 });
  let deltas = 0; room.on('draft', (d) => { if (d.text) deltas++; });
  room.on('message', (e) => say(`${e.from}${e.kind ? '/' + e.kind : ''}: ${e.text.replace(/\s+/g, ' ').slice(0, 220)}`));
  room.seedHistory(hist, 'codex');
  room.postFromHuman('@claude Smoke test. In one line: what code word appears in the earlier forked Codex history? Then hand the same question to @codex.');
  const idle = () => !room.busy.claude && !room.busy.codex;
  await new Promise((r) => setTimeout(r, 1000));
  while (!idle()) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500));
  while (!idle()) await new Promise((r) => setTimeout(r, 500));
  say(`streamed draft updates: ${deltas}; claude session ${claude.sessionId}; cost $${claude.totalCostUsd}`);
  say(`codex saw payload? cursor=${room.state.cursors.codex} of ${room.state.transcript.length}`);
  claude.stop(); codex.stop(); process.exit(0);
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
