'use strict';
// Live cross-provider history: each agent reads a local session of the OTHER provider through
// read_session_history. Plants a codename in a fresh Codex thread and a fresh Claude session (one tiny turn each),
// shares them, then asks each agent to find the other's codename. Spends a little of both quotas.
// Usage: node test/live-history.js <scratchCwd> [claudeModel] [codexModel]
const { CodexClient } = require('../src/codexClient');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const claudeHistory = require('../src/claudeHistory');
const { claudeHistoryReader, codexHistoryReader } = require('../src/sessionHistory');
const { HistorySources } = require('../src/historySources');
const { Room } = require('../src/room');
const { toolSpecs } = require('../src/tasks');
const { roomPrompt } = require('../src/prompts');
const [cwd, claudeModel = 'haiku', codexModel = 'gpt-5.6-luna'] = process.argv.slice(2);
const t0 = Date.now(), say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
let failed = false; const check = (ok, what) => { say(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

(async () => {
  const exe = findClaude('').path;
  // Two source sessions, one per provider, each holding a codename only it knows.
  const codex = new CodexClient({ exe: 'codex', cwd, tools: toolSpecs(['claude']) }); await codex.start();
  const src = await codex.startThread('Test thread.');
  await codex.runTurn(src.id, 'Remember this codename for later: BLUE-HERON-42. Reply with just OK.', () => {}, () => {}, [], { model: codexModel, effort: 'low' });
  const plant = new ClaudeClient({ exe, cwd, model: claudeModel, systemPrompt: 'Test session.' });
  await plant.send('Remember this codename for later: COPPER-FOX-17. Reply with just OK.'); plant.stop();
  const claudeFile = claudeHistory.fileFor(plant.sessionId);
  check(!!claudeFile, 'planted Claude session saved locally');

  // The room: fresh working sessions that know neither codename.
  const thread = await codex.startThread(roomPrompt('codex', 'claude', 'Dean', true));
  const claude = new ClaudeClient({ exe, cwd, model: claudeModel, systemPrompt: roomPrompt('claude', 'codex', 'Dean', true), tools: toolSpecs(['codex']) });
  const history = new HistorySources({ saved: {}, working: () => ({ claude: { sessionId: claude.sessionId }, codex: { sessionId: thread.id } }),
    makeReader: ({ provider, sessionId, file }) => provider === 'codex' ? codexHistoryReader(codex) : claudeHistoryReader(file || claudeHistory.fileFor(sessionId), claudeHistory.ROOT) });
  const hc = history.add({ provider: 'codex', sessionId: src.id, title: 'Codename thread' });
  const hl = history.add({ provider: 'claude', sessionId: plant.sessionId, title: 'Codename session', file: claudeFile });
  const reads = [];
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: { typed: true, send: (t, d, a, f, onTool) => codex.runTurn(thread.id, t, d, a, f, { model: codexModel, effort: 'low', onTool }) } },
    readHistory: async (who, args) => { const r = await history.read(who, args); reads.push([who, args.source, r.ok]); return r; } });
  room.on('message', (e) => say(`${e.from}: ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`));
  const idle = async () => { await new Promise((r) => setTimeout(r, 1500)); while (room.busy.claude || room.busy.codex) await new Promise((r) => setTimeout(r, 500)); };

  room.postFromHuman(`@claude Use read_session_history on source ${hc.id} to find the codename in that Codex thread. Reply with just the codename.`);
  await idle();
  room.postFromHuman(`@codex Use read_session_history on source ${hl.id} to find the codename in that Claude session. Reply with just the codename.`);
  await idle();
  const said = (who) => room.state.transcript.filter((e) => e.from === who).map((e) => e.text).join(' ');
  check(reads.some(([w, s, ok]) => w === 'claude' && s === hc.id && ok), 'Claude read the Codex thread through the tool');
  check(/BLUE-HERON-42/.test(said('claude')), 'Claude found the Codex codename');
  check(reads.some(([w, s, ok]) => w === 'codex' && s === hl.id && ok), 'Codex read the Claude session through the tool');
  check(/COPPER-FOX-17/.test(said('codex')), 'Codex found the Claude codename');
  history.remove(hc.id);
  check(!(await history.read('claude', { source: hc.id })).ok, 'a removed source is refused');
  say(`Claude cost $${claude.totalCostUsd.toFixed(4)}`);
  claude.stop(); codex.stop(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 300000).unref();
