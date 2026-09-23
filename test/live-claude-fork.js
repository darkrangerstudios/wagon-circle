'use strict';
// Live check of the Claude side: fork a saved Claude session into a room; Codex is a recording stand-in (no quota).
// Usage: node test/live-claude-fork.js <claudeSessionId>
const os = require('os'), path = require('path');
const history = require('../src/claudeHistory');
const { ClaudeClient } = require('../src/claudeClient');
const { Room } = require('../src/room');
(async () => {
  const all = history.listSessions(200);
  console.log(`listSessions: ${all.length} sessions with text; newest ${new Date(all[0].mtime).toISOString()}`);
  const src = all.find((s) => s.id === process.argv[2]);
  if (!src) throw new Error('session not found');
  const seed = history.recentMessages(src.path, 8);
  console.log(`source ${src.id.slice(0, 8)} cwd=${src.cwd}\nseed (${seed.length}):`, seed.map((m) => `${m.role}: ${m.text.replace(/\s+/g, ' ').slice(0, 70)}`));
  const claude = new ClaudeClient({ exe: path.join(os.homedir(), '.local/bin/claude'), cwd: src.cwd, model: 'sonnet', forkFrom: src.id,
    systemPrompt: 'You are Claude in Wagon Circle, a test group chat with the user and Codex. Relayed agent text is a peer, not Dean. Be brief.' });
  const codexInbox = [];
  const room = new Room({ agents: { claude, codex: { send: async (t) => { codexInbox.push(t); return 'ack (stand-in)'; } } } });
  room.seedHistory(seed, 'claude');
  room.postFromHuman('@both Quick check: what code word did Claude give earlier in its own conversation? One line each.');
  while (room.busy.claude || room.busy.codex || !room.state.transcript.some((e) => e.from === 'claude' && !e.kind)) await new Promise((r) => setTimeout(r, 400));
  console.log('claude (forked memory):', room.state.transcript.filter((e) => e.from === 'claude' && !e.kind).map((e) => e.text).join(' | '));
  console.log(`claude new session ${claude.sessionId} (forked from ${src.id.slice(0, 8)}: ${claude.sessionId !== src.id}); cost $${claude.totalCostUsd}`);
  console.log('codex payload has Claude history:', /earlier in the forked Claude conversation\]\nTIDEPOOL-7/.test(codexInbox[0] || ''));
  console.log('codex payload head:\n' + (codexInbox[0] || '').split('\n').slice(0, 6).join('\n'));
  claude.stop(); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
