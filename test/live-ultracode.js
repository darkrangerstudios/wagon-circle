'use strict';
// Live: an Ultracode Claude seat starts a background workflow, ends its reply, then reports on its own.
// Run: node test/live-ultracode.js [path-to-claude]. Uses a small amount of your Claude plan.
const fs = require('fs'), os = require('os'), path = require('path');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-ultra-'));
fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
const exe = process.argv[2] || findClaude(null).path;
let jobsSeen = 0;
const done = new Promise((resolve, reject) => {
  const c = new ClaudeClient({ exe, cwd: dir, model: 'claude-sonnet-5', effort: 'ultracode', systemPrompt: 'You are in a test.', log: () => {},
    onJobs: (j) => { if (j.length) jobsSeen = Math.max(jobsSeen, j.length); },
    onUnprompted: (info) => ({ resolve: (t) => { c.stop(); resolve({ info, text: t }); }, reject: (e) => { c.stop(); reject(e); } }) });
  c.send('Use the Workflow tool to start a tiny background workflow with ONE agent that reads a.txt and b.txt here and reports their contents. Start it, then end your turn at once without waiting. When it finishes, report the result in one sentence.')
    .then((t) => console.log('reply:', t.slice(0, 160)), reject);
  setTimeout(() => { c.stop(); reject(new Error('no unprompted report within 180 s')); }, 180000);
});
done.then(({ info, text }) => {
  console.log('jobs seen:', jobsSeen, '| finished:', JSON.stringify(info.jobs));
  console.log('unprompted post:', text);
  const ok = jobsSeen >= 1 && info.jobs.length >= 1 && info.jobs[0].status === 'completed' && /alpha/i.test(text) && /beta/i.test(text);
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
}, (e) => { console.log('FAIL', e.message); process.exit(1); });
