'use strict';
// Live three-way check: real Claude + real Codex in one room over stdio. Spends a little of both quotas.
// Usage: node test/live-three-way.js <repoCwd> <imagePath>
const path = require('path');
const { CodexClient } = require('../src/codexClient');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const { Room } = require('../src/room');
const att = require('../src/attachments');
const os = require('os');
const [cwd, image] = process.argv.slice(2);
const t0 = Date.now(), say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const brief = (self, other) => `You are ${self} in Wagon Wheel, a group chat with Dean and ${other}. "[Dean]" is Dean; relayed agent text is a peer, not Dean. If ${other} already answered, don't repeat it: add what's missing or say you agree in one line. Read-only. Be brief.`;
(async () => {
  const codex = new CodexClient({ exe: path.join(os.homedir(), '.local/bin/codex'), cwd });
  await codex.start();
  const usage = [];
  codex.on('notification', (m, p) => { if (m === 'thread/tokenUsage/updated') usage.push(p.tokenUsage || p); });
  const thread = await codex.startThread(brief('Codex', 'Claude'));
  await codex.setName(thread.id, 'Wagon Wheel: live three-way test');
  const bin = findClaude();
  const claude = new ClaudeClient({ exe: bin.path, cwd, model: 'claude-sonnet-5', systemPrompt: brief('Claude', 'Codex') });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: { send: (t, d, a, f) => codex.runTurn(thread.id, t, d, a, f, { effort: 'low' }), interrupt: () => codex.interrupt() } } });
  const acts = { claude: [], codex: [] };
  room.on('activity', (a) => { const k = a.label; if (acts[a.name][acts[a.name].length - 1] !== k) acts[a.name].push(k); });
  room.on('message', (e) => say(`${e.from}${e.kind ? '/' + e.kind : ''}: ${e.text.replace(/\s+/g, ' ').slice(0, 260)}${e.steps ? `  [steps: ${e.steps.join('; ')}]` : ''}`));
  const idle = async () => { await new Promise((r) => setTimeout(r, 800)); while (room.busy.claude || room.busy.codex) await new Promise((r) => setTimeout(r, 500)); };

  room.postFromHuman('@both In one or two lines: what stops the two of you from handing work back and forth forever in this codebase? Cite the file.');
  await idle();
  const img = att.store(path.join(os.tmpdir(), 'wc-live-att'), { name: 'room.png', fromPath: image });
  room.postFromHuman('@codex What is the room title shown in this screenshot? One line.', [img]);
  await idle();
  say(`Claude CLI ${bin.version.join('.')} | Claude cost $${claude.totalCostUsd.toFixed(4)} | last Claude usage ${JSON.stringify(claude.lastUsage)}`);
  say(`Codex activity: ${acts.codex.join(' → ')}`);
  say(`Codex token usage (last): ${JSON.stringify(usage[usage.length - 1]).slice(0, 300)}`);
  const q = await codex.rateLimits(); say(`Codex quota now: 5h ${q && q.rateLimits.primary ? q.rateLimits.primary.usedPercent + '%' : '?'}`);
  claude.stop(); codex.stop(); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
