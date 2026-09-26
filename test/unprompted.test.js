'use strict';
// v0.7.0: agents posting on their own (Claude reporting a finished background job) and Ultracode.
const test = require('node:test');
const assert = require('node:assert');
const { ClaudeClient } = require('../src/claudeClient');
const { Room } = require('../src/room');

function fakeClaude(opts = {}) {
  const writes = [], jobsSeen = [];
  const c = new ClaudeClient({ exe: 'unused', cwd: __dirname, systemPrompt: '', onJobs: (j) => jobsSeen.push(j), ...opts });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); }, end() {} }, kill() { c.killed = (c.killed || 0) + 1; } };
  const line = (m) => c._onLine(JSON.stringify(m));
  return { c, writes, jobsSeen, line };
}
const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const jobs = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, description: `job ${id}` })) });
const notice = (id, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: id, status, summary: `job ${id} ${status}` });
const flag = (a, name) => a[a.indexOf(name) + 1];

test('Ultracode runs at Extra high with only the Workflow tool added, write tools denied and worktrees refused', () => {
  const a = new ClaudeClient({ exe: 'x', cwd: '/', systemPrompt: '', effort: 'ultracode', fast: true })._args();
  assert.strictEqual(flag(a, '--tools'), 'Read,Glob,Grep,Workflow');
  assert.match(flag(a, '--allowedTools'), /^Read,Glob,Grep,Workflow(,|$)/);
  assert.ok(a.includes('--restricted') && flag(a, '--permission-mode') === 'dontAsk' && a.includes('--strict-mcp-config'));
  assert.strictEqual(flag(a, '--effort'), 'xhigh');
  assert.deepStrictEqual(flag(a, '--disallowedTools').split(','), ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
  const st = JSON.parse(flag(a, '--settings'));
  assert.strictEqual(st.fastMode, true); assert.strictEqual(st.ultracode, true);
  assert.match(st.hooks.WorktreeCreate[0].hooks[0].command, /exit 1$/); // a failing hook: the CLI can't create a worktree
  assert.strictEqual(a.filter((x) => x === '--settings').length, 1);
  const plain = new ClaudeClient({ exe: 'x', cwd: '/', systemPrompt: '', effort: 'high' })._args();
  assert.strictEqual(flag(plain, '--tools'), 'Read,Glob,Grep');
  assert.ok(!plain.includes('--settings') && !plain.includes('--disallowedTools'));
});

test('a background job report after the reply ended becomes an unprompted turn, tagged with the job', async () => {
  const seen = [];
  const { c, line, jobsSeen } = fakeClaude({ onUnprompted: (info) => { seen.push(info); return { resolve: (t) => seen.push(t), reject: (e) => seen.push(e) }; } });
  const reply = c.send('start a workflow');
  line(jobs('w1')); line(text('Started it.')); line({ type: 'result', result: 'Started it.' });
  assert.strictEqual(await reply, 'Started it.');
  assert.deepStrictEqual(jobsSeen.at(-1), [{ id: 'w1', description: 'job w1' }]);
  line(jobs()); line(notice('w1')); line({ type: 'system', subtype: 'init' });
  line(text('The workflow found two files.')); line({ type: 'result', result: 'The workflow found two files.' });
  assert.deepStrictEqual(seen[0], { jobs: [{ id: 'w1', status: 'completed', summary: 'job w1 completed' }] });
  assert.strictEqual(seen[1], 'The workflow found two files.');
  assert.strictEqual(c.waiter, null);
});

test('a refused unprompted turn is interrupted and its text dropped; the next send still works', async () => {
  const { c, line, writes } = fakeClaude({ onUnprompted: () => null });
  line(notice('w1')); line(text('report nobody wanted'));
  assert.strictEqual(writes.at(-1).request.subtype, 'interrupt');
  line({ type: 'result', is_error: true, subtype: 'error_during_execution' });
  assert.strictEqual(c.waiter, null); clearTimeout(c.intTimer);
  const next = c.send('hello'); line(text('hi')); line({ type: 'result', result: 'hi' });
  assert.strictEqual(await next, 'hi');
});

test('stopJobs sends Claude Code\'s stop_task for each running job', () => {
  const { c, line, writes } = fakeClaude();
  line(jobs('a', 'b'));
  assert.strictEqual(c.stopJobs(), 2);
  assert.deepStrictEqual(writes.filter((w) => w.request && w.request.subtype === 'stop_task').map((w) => w.request.task_id), ['a', 'b']);
});

test('a model switch waits for running jobs and for the report a finished job is owed', () => {
  const { c, line } = fakeClaude();
  c.onUnprompted = () => ({ resolve() {}, reject() {} });
  line(jobs('a'));
  c.setOptions({ model: 'claude-opus-5-5' });
  assert.ok(c.proc, 'kept while a job runs');
  line(jobs()); line(notice('a'));
  assert.ok(c.proc, 'kept until the report turn, however long it takes to start');
  line(text('done'));
  assert.ok(c.proc, 'kept during the report');
  line({ type: 'result', result: 'done' });
  assert.strictEqual(c.proc, null, 'restarted once the report ended');
  assert.strictEqual(c.model, 'claude-opus-5-5');
});

test('a stopped job owes no report: a held restart happens at its notification', () => {
  const { c, line } = fakeClaude();
  line(jobs('a'));
  c.setOptions({ effort: 'high' });
  line(jobs()); assert.ok(c.proc);
  line(notice('a', 'stopped'));
  assert.strictEqual(c.proc, null);
  assert.deepStrictEqual(c.finished, []);
});

// ---------- room policy ----------
function agent(reply = 'ok') {
  const a = { typed: true, inbox: [] };
  a.send = (t) => { a.inbox.push(t); return new Promise((r) => setTimeout(() => r(typeof reply === 'function' ? reply(t) : reply), 5)); };
  a.interrupt = () => {};
  return a;
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const job = [{ id: 'w1', status: 'completed', summary: 'read two files' }];

test('a post is visible to everyone, addressed to the human, and wakes nobody', async () => {
  const claude = agent(), codex = agent();
  const room = new Room({ agents: { claude, codex }, humanName: 'Dean' });
  room.postFromHuman('@claude start a workflow'); await settle();
  const h = room.unprompted('claude', { jobs: job });
  assert.ok(h); assert.strictEqual(room.busy.claude, true);
  h.resolve('The workflow found two files.'); await settle();
  const post = room.state.transcript.at(-1);
  assert.deepStrictEqual([post.from, post.kind, post.to, post.jobs[0].status], ['claude', 'post', ['human'], 'completed']);
  assert.strictEqual(codex.inbox.length, 0, 'nobody is woken');
  assert.strictEqual(room.busy.claude, false);
  room.postFromHuman('@codex thoughts?'); await settle();
  assert.match(codex.inbox[0], /Claude — posted on its own to Dean after a background job finished/);
  assert.match(codex.inbox[0], /The workflow found two files\./);
});

test('posts are capped per agent; the refusal is noted once', async () => {
  const room = new Room({ agents: { claude: agent(), codex: agent() }, postCap: 1 });
  room.postFromHuman('go'); await settle();
  room.unprompted('claude', { jobs: job }).resolve('one'); await settle();
  assert.strictEqual(room.unprompted('claude', { jobs: job }), null);
  assert.strictEqual(room.unprompted('claude', { jobs: job }), null);
  assert.strictEqual(room.state.transcript.filter((e) => /wasn't posted/.test(e.text)).length, 1);
  assert.strictEqual(new Room({ agents: { claude: agent() }, postCap: 0 }).unprompted('claude', {}), null);
});

test('a post uses a task turn and is refused once the allowance is used', async () => {
  const room = new Room({ agents: { claude: agent(), codex: agent() } });
  room.tasks.mode = 'work'; room.postFromHuman('@claude big job'); await settle();
  const t = room.tasks.active(), before = t.used.turns;
  room.unprompted('claude', { jobs: job }).resolve('report'); await settle();
  assert.strictEqual(t.used.turns, before + 1);
  t.used.turns = t.limits.turns;
  assert.strictEqual(room.unprompted('claude', { jobs: job }), null);
});

test('Pause holds a post until Resume; Stop discards held posts and refuses later reports', async () => {
  const room = new Room({ agents: { claude: agent(), codex: agent() } });
  room.tasks.mode = 'work'; room.postFromHuman('@claude big job'); await settle();
  room.pauseTask();
  room.unprompted('claude', { jobs: job }).resolve('held report'); await settle();
  assert.ok(!room.state.transcript.some((e) => e.kind === 'post'));
  room.resumeTask(); await settle();
  assert.strictEqual(room.state.transcript.filter((e) => e.kind === 'post').length, 1);
  room.pauseTask();
  room.unprompted('claude', { jobs: job }).resolve('second'); await settle();
  room.stopAll();
  assert.ok(room.state.transcript.some((e) => /1 held report from background jobs discarded/.test(e.text)));
  assert.strictEqual(room.unprompted('claude', { jobs: job }), null, 'the job belonged to stopped work');
});

test('a message sent while an agent is posting waits and is delivered after the post', async () => {
  const claude = agent();
  const room = new Room({ agents: { claude, codex: agent() } });
  room.postFromHuman('@claude go'); await settle();
  const h = room.unprompted('claude', { jobs: job });
  room.postFromHuman('@claude and then?');
  assert.strictEqual(claude.inbox.length, 1);
  h.resolve('report'); await settle();
  assert.strictEqual(claude.inbox.length, 2);
  assert.match(claude.inbox[1], /and then\?/);
});

test('a message sent while a refused report is being stopped waits for it instead of failing', async () => {
  const { c, line } = fakeClaude({ onUnprompted: () => null });
  line(notice('w1')); line(text('unwanted'));
  const next = c.send('hello');
  line({ type: 'result', is_error: true, subtype: 'error_during_execution' }); clearTimeout(c.intTimer);
  await new Promise((r) => setImmediate(r));
  line(text('hi')); line({ type: 'result', result: 'hi' });
  assert.strictEqual(await next, 'hi');
});

test('a message sent during a post waits instead of steering it', async () => {
  const claude = agent(); claude.steer = () => { throw new Error('must not steer a post'); };
  const room = new Room({ agents: { claude, codex: agent() } });
  room.postFromHuman('@claude go'); await settle();
  const h = room.unprompted('claude', { jobs: job });
  const r = room.steerFromHuman('@claude actually, stop and summarise');
  assert.deepStrictEqual(r.steered, []);
  h.resolve('report'); await settle();
  const post = room.state.transcript.find((e) => e.kind === 'post');
  assert.strictEqual(post.text, 'report');
  assert.match(claude.inbox.at(-1), /actually, stop and summarise/);
});

test('a post cannot hand off or finish work; it can read shared history', async () => {
  const codex = agent();
  const room = new Room({ agents: { claude: agent(), codex }, readHistory: async () => ({ ok: true, text: 'passage' }) });
  room.tasks.mode = 'work'; room.postFromHuman('@claude big job'); await settle();
  const h = room.unprompted('claude', { jobs: job });
  const ask = await h.onTool('request_assistance', { to: 'codex', purpose: 'review', question: 'look' });
  const fin = await h.onTool('finish_task', { summary: 'done' });
  const read = await h.onTool('read_session_history', { source: 'list' });
  assert.deepStrictEqual([ask.ok, fin.ok, read.ok], [false, false, true]);
  h.resolve('report'); await settle();
  assert.strictEqual(codex.inbox.length, 0);
  assert.strictEqual(room.tasks.active().status, 'active');
});

test('Stop during a post ends it with nothing posted and the agent free', async () => {
  const room = new Room({ agents: { claude: agent(), codex: agent() } });
  room.postFromHuman('@claude go'); await settle();
  const h = room.unprompted('claude', { jobs: job });
  room.stopAll();
  h.reject(Object.assign(new Error('stopped'), { stopped: true })); await settle();
  assert.ok(!room.state.transcript.some((e) => e.kind === 'post' || e.kind === 'error'));
  assert.deepStrictEqual([room.busy.claude, room.posting.has('claude')], [false, false]);
});

test('held posts survive a reload and appear when the task is resumed or finished', async () => {
  const room = new Room({ agents: { claude: agent(), codex: agent() } });
  room.tasks.mode = 'work'; room.postFromHuman('@claude big job'); await settle();
  room.pauseTask();
  room.unprompted('claude', { jobs: job }).resolve('held report'); await settle();
  const saved = JSON.parse(JSON.stringify(room.state));
  const again = new Room({ agents: { claude: agent('ok'), codex: agent() }, state: saved });
  assert.strictEqual(again.state.heldPosts.length, 1);
  again.resumeTask(); await settle();
  assert.strictEqual(again.state.transcript.filter((e) => e.kind === 'post').length, 1);
  // Finished while paused: held posts are shown before the finish note, not carried into the next task.
  const lead = agent(async (t) => 'x');
  const r2 = new Room({ agents: { claude: lead, codex: agent() } });
  r2.tasks.mode = 'work'; r2.postFromHuman('@claude job'); await settle();
  r2.pauseTask(); r2.unprompted('claude', { jobs: job }).resolve('held'); await settle();
  r2.tasks.state.tasks[0].status = 'active'; // the lead's own turn finishes it
  r2._onTool('claude', 'finish_task', { summary: 'ok' }, { run: r2.run, taskId: 't1', generation: 1 });
  assert.strictEqual(r2.state.heldPosts.length, 0);
  assert.ok(r2.state.transcript.some((e) => e.kind === 'post' && e.text === 'held'));
});
