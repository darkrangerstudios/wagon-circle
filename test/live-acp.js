'use strict';
// Live check for an ACP agent (e.g. Gemini CLI) joining a room as a read-only third participant.
// Usage: node test/live-acp.js <scratchCwd> <command> [args...]   e.g. node test/live-acp.js /tmp/wc gemini --experimental-acp
// Spends that provider's quota. Checks: a reply streams back, a write request is rejected, Stop cancels.
const { AcpClient } = require('../src/acpClient');
const { Room } = require('../src/room');
const { acpPrompt } = require('../src/prompts');
const [cwd, exe, ...args] = process.argv.slice(2);
const t0 = Date.now(), say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
let failed = false; const check = (ok, what) => { say(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
(async () => {
  const a = new AcpClient({ exe, args, cwd, label: 'Gemini', brief: acpPrompt('Gemini', 'Dean', ['Claude', 'Codex']), log: (s) => say(`log: ${s}`) });
  const init = await a.start(); say(`initialize: ${JSON.stringify(init).slice(0, 300)}`);
  await a.newSession(); say(`session ${a.sessionId}; loadSession=${!!a.capabilities.loadSession}`);
  const room = new Room({ humanName: 'Dean', agents: { claude: { typed: true, send: async () => '(stand-in)' }, codex: { typed: true, send: async () => '(stand-in)' }, gemini: a } });
  room.on('message', (e) => say(`${e.from}: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`));
  const idle = async () => { await new Promise((r) => setTimeout(r, 800)); while (room.busy.gemini) await new Promise((r) => setTimeout(r, 400)); };
  room.postFromHuman('@gemini In one sentence: what file types are in this folder? Read-only.'); await idle();
  check(room.state.transcript.some((e) => e.from === 'gemini' && e.text.length > 3), 'Gemini replied in the room');
  room.postFromHuman('@gemini Create a file named wc-should-not-exist.txt containing hi.'); await idle();
  check(!require('fs').existsSync(require('path').join(cwd, 'wc-should-not-exist.txt')), 'no file was written (permission rejected)');
  room.postFromHuman('@gemini Count slowly from 1 to 200, one number per line.'); setTimeout(() => room.stopAll(), 4000); await idle();
  check(room.state.transcript.some((e) => /Gemini stopped/.test(e.text)), 'Stop cancelled the turn');
  a.stop(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 300000).unref();
