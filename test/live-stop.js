'use strict';
// Live Stop check against the real CLIs (spends a little quota). Proves at the process boundary that:
// Claude: Stop right after a steer ends the reply and sends nothing more, and the session stays usable.
// Codex: Stop pressed before turn/start answers still interrupts the turn.
// Usage: node test/live-stop.js <scratchCwd>
const os = require('os');
const path = require('path');
const { CodexClient } = require('../src/codexClient');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');

const cwd = process.argv[2];
const t0 = Date.now(); const say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms}ms`)), ms))]);
let failed = false; const check = (ok, what) => { say(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

(async () => {
  const claude = new ClaudeClient({ exe: findClaude('').path, cwd, model: 'haiku', systemPrompt: 'Test session. Follow instructions literally.', log: () => {} });
  let userWrites = 0, firstDelta;
  const gotDelta = new Promise((r) => { firstDelta = r; });
  const reply = claude.send('Count from 1 to 300, one number per line, nothing else.', () => firstDelta());
  const w = claude.proc.stdin.write.bind(claude.proc.stdin);
  claude.proc.stdin.write = (s) => { if (JSON.parse(s).type === 'user') userWrites++; return w(s); };
  await within(gotDelta, 60000, 'claude first token');
  claude.steer('Stop counting and write a poem instead.');
  claude.interrupt();
  const outcome = await within(reply.then(() => 'finished', (e) => (e.stopped ? 'stopped' : e.message)), 15000, 'claude stop');
  check(outcome === 'stopped', `Claude reply ended as stopped (${outcome})`);
  await new Promise((r) => setTimeout(r, 3000));
  check(userWrites === 0, `Claude got no message after Stop (${userWrites})`);
  const again = await within(claude.send('Reply with exactly: OK'), 60000, 'claude follow-up');
  check(/OK/.test(again), `Claude session still usable (${again.slice(0, 20)})`);
  claude.stop();

  const codex = new CodexClient({ exe: path.join(os.homedir(), '.local/bin/codex'), cwd, log: () => {} });
  await codex.start();
  const th = await codex.startThread('Test session. Follow instructions literally.');
  const turn = codex.runTurn(th.id, 'Count from 1 to 300, one number per line, nothing else.', () => {}, () => {}, [], { effort: 'low' });
  await codex.interrupt(); // before turn/start has answered
  const c = await within(turn.then(() => 'finished', (e) => (e.stopped ? 'stopped' : e.message)), 30000, 'codex stop');
  check(c === 'stopped', `Codex Stop in the start window interrupted the turn (${c})`);
  check(codex.currentTurn === null, 'Codex has no active turn afterwards');
  codex.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('LIVE STOP FAILED', e); process.exit(1); });
