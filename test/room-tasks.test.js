'use strict';
// Typed assistance through the router: tool calls instead of @mentions, host-owned tasks and turn limits.
const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../src/room');

// Typed fake: script(text, n, tool) may call tool(name, args) mid-turn; resolves with its reply after a tick.
function typed(script) {
  const a = { typed: true, inbox: [], toolResults: [], interrupted: 0 };
  a.send = (text, onDelta, onActivity, atts, onTool) => {
    a.inbox.push(text);
    const tool = async (name, args) => { const r = await onTool(name, args); a.toolResults.push(r); return r; };
    return new Promise((res, rej) => setTimeout(async () => {
      try { res(await (typeof script === 'function' ? script(text, a.inbox.length, tool) : script)); } catch (e) { rej(e); }
    }, 5));
  };
  a.interrupt = () => { a.interrupted += 1; };
  return a;
}
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const ask = (to, question, purpose = 'review') => ['request_assistance', { to, purpose, question }];

test('a typed request reaches the peer once and its answer returns to the requester without any @mention', async () => {
  const claude = typed(async (text, n, tool) => {
    if (n === 1) { const r = await tool(...ask('codex', 'Does Stop drop queued steers?')); assert.strictEqual(r.ok, true); return 'Asked Codex; reviewing the rest meanwhile.'; }
    return 'Final: Codex confirmed it; merged view below.';
  });
  const codex = typed('Yes: steerQueue is cleared in interrupt(); line 118.');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('Review the Stop path together');
  await settle();
  assert.strictEqual(codex.inbox.length, 1);
  assert.match(codex.inbox[0], /Request r1 from Claude to you \(review\), task t1/);
  assert.match(codex.inbox[0], /Does Stop drop queued steers\?/);
  assert.match(codex.inbox[0], /Review the Stop path together/); // the human's objective travels with it
  assert.strictEqual(claude.inbox.length, 2);
  assert.match(claude.inbox[1], /Codex — answer to your request r1/);
  assert.match(claude.inbox[1], /line 118/);
  const t = room.tasks.get('t1');
  assert.deepStrictEqual([t.status, t.used.turns, t.requests[0].status], ['active', 2, 'answered']);
  await settle(); // nothing else happens: no ACK turns
  assert.deepStrictEqual([claude.inbox.length, codex.inbox.length], [2, 1]);
});

test('typed agents are not routed by prose: a line-start @mention in a reply is just text', async () => {
  const claude = typed('@codex can you check this?');
  const codex = typed('should not run');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('hi'); await settle();
  assert.strictEqual(codex.inbox.length, 0);
});

test('an untyped agent\'s line-start hand-off is a suggestion for the human, never an automatic dispatch', async () => {
  const claude = typed('ok'); const codex = { inbox: [], send: (t) => { codex.inbox.push(t); return Promise.resolve('@claude please look'); } };
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@codex go'); await settle();
  assert.strictEqual(claude.inbox.length, 0);
  const sug = room.state.transcript.find((e) => e.kind === 'suggestion');
  assert.deepStrictEqual(sug.suggest, { from: 'codex', to: 'claude' });
  assert.strictEqual(sug.from, 'system');
});

test('a review needing six exchanges finishes without the human typing continue', async () => {
  let round = 0;
  const claude = typed(async (text, n, tool) => {
    if (round < 3) { round += 1; await tool(...ask('codex', `Check finding ${round}`)); return `Sent finding ${round}.`; }
    await tool('finish_task', { summary: 'Three findings checked' }); return 'Done: three findings checked.';
  });
  const codex = typed((text) => `Checked: ${(text.match(/Check finding (\d)/) || [])[1]}`);
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('Review with Codex until all findings are checked'); await settle(400);
  assert.strictEqual(codex.inbox.length, 3);
  assert.strictEqual(room.tasks.get('t1').status, 'completed');
  assert.strictEqual(room.tasks.get('t1').summary, 'Three findings checked');
  assert.ok(room.state.transcript.some((e) => /Task t1 finished by Claude/.test(e.text)));
});

test('the turn allowance bounds a ping-pong, tells the human, and raised limits let the next message continue', async () => {
  const claude = typed(async (text, n, tool) => { await tool(...ask('codex', `q${n}`)); return `c${n}`; });
  const codex = typed(async (text, n, tool) => { await tool(...ask('claude', `q${n}`, 'challenge')); return `x${n}`; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.tasks.setDefaults({ turns: 6, reserve: 1 });
  room.postFromHuman('argue'); await settle(500);
  const t = room.tasks.get('t1');
  assert.ok(t.used.turns <= 6, `used ${t.used.turns}`);
  assert.ok(t.requests.every((r) => r.status === 'answered'), 'every accepted request got its answer turn');
  assert.ok(claude.inbox.length + codex.inbox.length <= 7); // 6 task turns plus the human's own delivery
  assert.strictEqual(room.state.transcript.filter((e) => /Add turns or time/.test(e.text)).length, 1, 'told once');
  room.setTaskLimits({ turns: 12 });
  const before = t.requests.length;
  room.postFromHuman('continue'); await settle(500);
  assert.ok(t.requests.length > before, 'new requests admitted after raising the limit');
  assert.ok(t.used.turns <= 12);
});

test('Pause holds task dispatch; a status question still reaches the lead and does not count as a task turn', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const claude = typed(async (text, n, tool) => { if (n === 1) { await tool(...ask('codex', 'check A')); return 'asked'; } return `claude ${n}`; });
  const codex = typed(async () => { await gate; return 'A is fine'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  room.pauseTask();
  release(); await settle();
  assert.strictEqual(claude.inbox.length, 1, 'the answer waits while paused');
  const turns = room.tasks.get('t1').used.turns;
  room.postFromHuman('how is it going?'); await settle();
  assert.strictEqual(claude.inbox.length, 2);
  assert.strictEqual(room.tasks.get('t1').used.turns, turns);
  room.resumeTask(); await settle();
  assert.ok(claude.inbox.some((t) => /answer to your request r1/.test(t)));
});

test('Stop cancels the task; a tool call and an answer landing afterwards are inert', async () => {
  let callLate, releaseCodex;
  const claude = typed(async (text, n, tool) => { if (n === 1) { await tool(...ask('codex', 'check')); await new Promise((r) => { callLate = r; }); return (await tool(...ask('codex', 'late one'))).text; } return 'no'; });
  const codex = typed(() => new Promise((r) => { releaseCodex = () => r('late answer'); }));
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  room.stopAll();
  callLate(); releaseCodex(); await settle();
  assert.strictEqual(room.tasks.get('t1').status, 'stopped');
  assert.match(claude.toolResults[1].text, /Stop/);
  assert.strictEqual(claude.inbox.length, 1, 'the late answer does not wake Claude');
  assert.strictEqual(codex.inbox.length, 1);
});

test('the time allowance interrupts running task work and keeps the request open for later', async () => {
  let t = 0; const now = () => t;
  const claude = typed(async (text, n, tool) => { await tool(...ask('codex', 'long check')); return 'asked'; });
  const codex = typed(() => new Promise(() => {}));
  const room = new Room({ humanName: 'Dean', agents: { claude, codex }, now });
  room.tasks.setDefaults({ minutes: 1 });
  room.postFromHuman('review'); await settle();
  t = 61e3; room.tick();
  assert.strictEqual(codex.interrupted, 1);
  assert.strictEqual(room.tasks.get('t1').status, 'exhausted');
});

test('a failed delivery reopens its request so the next delivery carries it', async () => {
  let fail = true;
  const claude = typed(async (text, n, tool) => { if (n === 1) await tool(...ask('codex', 'check B')); return 'ok'; });
  const codex = typed(() => { if (fail) { fail = false; throw new Error('pipe closed'); } return 'B ok'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'open');
  room.postFromHuman('@codex try again'); await settle();
  assert.match(codex.inbox[1], /check B/);
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'answered');
});

test('Work mode starts a visible task from the human message itself', async () => {
  const room = new Room({ humanName: 'Dean', agents: { claude: typed('on it'), codex: typed('x') } });
  room.tasks.mode = 'work';
  room.postFromHuman('Audit the diff parser'); await settle();
  assert.strictEqual(room.tasks.get('t1').objective, 'Audit the diff parser');
  assert.strictEqual(room.tasks.get('t1').lead, 'claude');
});

test('old saved rooms get an empty ledger and keep their transcript', () => {
  const state = { transcript: [{ id: 1, from: 'human', text: 'hi', ts: 1 }], cursors: { claude: 1, codex: 0 }, lastTargets: ['claude'], seq: 1 };
  const room = new Room({ humanName: 'Dean', agents: { claude: typed('x'), codex: typed('y') }, state });
  assert.strictEqual(room.state.transcript.length, 1);
  assert.deepStrictEqual(room.state.tasks.tasks, []);
});

test('an answer for a busy requester waits under its original request id, then arrives once', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const claude = typed(async (text, n, tool) => { if (n === 1) { await tool(...ask('codex', 'check C')); await gate; return 'still working'; } return 'merged'; });
  const codex = typed('C is fine');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'answered');
  assert.strictEqual(claude.inbox.length, 1, 'Claude is busy: the answer is queued, not steered in');
  release(); await settle();
  assert.strictEqual(claude.inbox.length, 2);
  assert.match(claude.inbox[1], /answer to your request r1/);
  await settle(); assert.strictEqual(claude.inbox.length, 2);
});

test('a side question keeps the objective and shows as a task revision', async () => {
  const claude = typed(async (text, n, tool) => { if (n === 1) await tool(...ask('codex', 'check D')); return 'ok'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: typed('D ok') } });
  room.postFromHuman('Review the parser'); await settle();
  room.postFromHuman('also, what time is it?'); await settle();
  const t = room.tasks.get('t1');
  assert.strictEqual(t.objective, 'Review the parser');
  assert.strictEqual(t.revision, 1);
  assert.ok(t.log.some((x) => /rev 1: also, what time/.test(x.text)));
});

test('reload keeps unresolved requests, consumption and ownership; the open request is delivered after reopen', async () => {
  const claude = typed(async (text, n, tool) => { await tool(...ask('codex', 'check E')); return 'asked'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: { typed: true, send: () => Promise.reject(new Error('window closed')) } } }); // Codex never answers before the "reload"
  room.postFromHuman('review'); await settle();
  const saved = JSON.parse(JSON.stringify(room.state));
  const again = new Room({ humanName: 'Dean', state: saved, agents: { claude: typed('merged'), codex: typed('E ok') } });
  const t = again.tasks.get('t1');
  assert.deepStrictEqual([t.status, t.lead, t.requests[0].status], ['active', 'claude', 'open']);
  const used = t.used.turns;
  again.postFromHuman('@codex continue'); await settle();
  assert.strictEqual(again.tasks.get('t1').requests[0].status, 'answered');
  assert.ok(again.tasks.get('t1').used.turns >= used);
});

test('read_session_history goes to the host reader with the real requester and never counts as a turn or starts a task', async () => {
  const calls = [];
  const claude = typed(async (text, n, tool) => (await tool('read_session_history', { source: 'codex', query: 'fixture' })).text);
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: typed('x') }, readHistory: (who, args) => { calls.push([who, args]); return { ok: true, text: 'passage' }; } });
  room.postFromHuman('what did codex find earlier?'); await settle();
  assert.deepStrictEqual(calls, [['claude', { source: 'codex', query: 'fixture' }]]);
  assert.strictEqual(room.tasks.active(), null);
  assert.ok(room.state.transcript.some((e) => e.from === 'claude' && e.text === 'passage'));
  const denied = new Room({ humanName: 'Dean', agents: { claude: typed(async (t, n, tool) => (await tool('read_session_history', { source: 'codex' })).text), codex: typed('x') } });
  denied.postFromHuman('go'); await settle();
  assert.ok(denied.state.transcript.some((e) => /not available/.test(e.text)));
});

// Codex final review of 7791b28, findings 4, 5 and 6.
test('finish_task from an old task\'s turn cannot complete a newer task', () => {
  const q = new Room({ agents: { claude: typed('x'), codex: typed('y') } }); q.run = 1;
  const t1 = q.tasks.start({ objective: 'old', originId: 1, lead: 'claude', run: 1 });
  const oldctx = { run: 1, taskId: t1.id, generation: t1.generation };
  q.tasks.finish('claude', 'old complete', oldctx);
  q.run = 2; const t2 = q.tasks.start({ objective: 'new', originId: 2, lead: 'claude', run: 2 });
  const r = q._onTool('claude', 'finish_task', { summary: 'late' }, oldctx);
  assert.strictEqual(r.ok, false); assert.strictEqual(t2.status, 'active');
  assert.strictEqual(q._onTool('claude', 'finish_task', { summary: 'no task at start' }, { run: 1, taskId: null, generation: 0 }).ok, false);
  assert.strictEqual(q._onTool('claude', 'finish_task', { summary: 'mine' }, { run: 2, taskId: null, generation: 0 }).ok, true);
});

test('a history read that resolves after Stop is not delivered', async () => {
  let release;
  const r = new Room({ agents: { claude: typed('x'), codex: typed('y') }, readHistory: () => new Promise((res) => { release = res; }) }); r.run = 1;
  const pending = r._onTool('claude', 'read_session_history', { source: 'h1' }, { run: 1, taskId: null, generation: 0 });
  r.stopAll(); release({ ok: true, text: 'PRIVATE-LATE' });
  const out = await pending;
  assert.strictEqual(out.ok, false); assert.doesNotMatch(out.text, /PRIVATE/);
});

test('work stopped by the time limit is redelivered once after more time and Resume; the request is answered once', async () => {
  let t = 0; const now = () => t; let codexCalls = 0, hang = true;
  const claude = typed(async (text, n, tool) => { if (n === 1) { await tool(...ask('codex', 'long check')); return 'asked'; } return 'merged'; });
  const codex = { typed: true, send: (text) => { codexCalls += 1; if (hang) return new Promise((res, rej) => { codex.stopIt = () => { const e = new Error('stopped'); e.stopped = true; rej(e); }; }); return Promise.resolve(`checked: ${/long check/.test(text)}`); }, interrupt() { codex.stopIt(); } };
  const room = new Room({ humanName: 'Dean', agents: { claude, codex }, now });
  room.tasks.setDefaults({ minutes: 1 });
  room.postFromHuman('review'); await settle();
  t = 61e3; room.tick(); await settle();
  const task = room.tasks.get('t1');
  assert.deepStrictEqual([task.status, task.requests[0].status, room.held.has('codex')], ['exhausted', 'open', true]);
  hang = false;
  room.setTaskLimits({ minutes: 5 }); room.resumeTask(); await settle();
  assert.strictEqual(codexCalls, 2);
  assert.strictEqual(task.requests[0].status, 'answered');
  assert.ok(claude.inbox.some((x) => /answer to your request r1/.test(x) && /checked: true/.test(x)));
});

test('a human Stop still cancels for good: nothing is held or redelivered', async () => {
  const codex = { typed: true, send: () => new Promise((res, rej) => { codex.stopIt = () => { const e = new Error('stopped'); e.stopped = true; rej(e); }; }), interrupt() { codex.stopIt(); } };
  const claude = typed(async (text, n, tool) => { await tool(...ask('codex', 'x')); return 'asked'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  room.stopAll(); await settle();
  assert.strictEqual(room.held.size, 0);
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'cancelled');
});

test('reload reopens a request that was cut off mid-delivery: the task shows paused, and Resume delivers it once', async () => {
  const claude = typed(async (text, n, tool) => { if (n === 1) await tool(...ask('codex', 'check F')); return 'asked'; });
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: { typed: true, send: () => new Promise(() => {}) } } });
  room.postFromHuman('review'); await settle();
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'delivered');
  const used = room.tasks.get('t1').used.turns;
  const saved = JSON.parse(JSON.stringify(room.state));
  const codex = typed('F ok');
  const again = new Room({ humanName: 'Dean', state: saved, agents: { claude: typed('merged'), codex } });
  const t = again.tasks.get('t1');
  assert.deepStrictEqual([t.requests[0].status, t.status, again.tasks.summary().status], ['open', 'paused', 'paused']); // the card offers Resume
  assert.ok(again.held.has('codex'));
  assert.ok(again.state.transcript.some((e) => /Reopened: Codex's last turn was cut off/.test(e.text)));
  assert.strictEqual(t.used.turns, used, 'consumed allowance is kept');
  await settle(); assert.strictEqual(codex.inbox.length, 0, 'nothing starts on its own');
  again.resumeTask(); await settle();
  assert.strictEqual(codex.inbox.length, 1); assert.match(codex.inbox[0], /check F/);
  assert.strictEqual(t.requests[0].status, 'answered');
});

// Codex combined review of 272670f: a reload while the lead takes an answer back lost that delivery.
test('reload while the lead consolidates an answer: Resume gives the lead the answer again', async () => {
  const claude = { typed: true, inbox: [], send: (text, d, a, att, onTool) => { claude.inbox.push(text); if (claude.inbox.length === 1) return onTool(...ask('codex', 'check G')).then(() => 'asked'); return new Promise(() => {}); } };
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: typed('G is fine') } });
  room.postFromHuman('review'); await settle();
  assert.match(claude.inbox[1], /answer to your request r1/); // consolidation turn in flight, never finishes
  assert.strictEqual(room.tasks.get('t1').requests[0].status, 'answered');
  const saved = JSON.parse(JSON.stringify(room.state));
  const lead = typed('merged the answer');
  const again = new Room({ humanName: 'Dean', state: saved, agents: { claude: lead, codex: typed('x') } });
  assert.ok(again.held.has('claude'));
  assert.strictEqual(again.tasks.get('t1').status, 'paused');
  again.resumeTask(); await settle();
  assert.strictEqual(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /answer to your request r1/); assert.match(lead.inbox[0], /G is fine/);
  assert.ok(again.state.transcript.some((e) => e.from === 'claude' && e.text === 'merged the answer'));
});

test('a human Stop survives a reload: stopped work is not held or revived', async () => {
  const room = new Room({ humanName: 'Dean', agents: { claude: { typed: true, send: () => new Promise(() => {}), interrupt() {} }, codex: typed('x') } });
  room.postFromHuman('@claude long job'); await settle();
  room.stopAll(); // the process dies before the stopped turn settles, so the in-flight record is still saved
  const saved = JSON.parse(JSON.stringify(room.state));
  const claude = typed('should not run');
  const again = new Room({ humanName: 'Dean', state: saved, agents: { claude, codex: typed('x') } });
  assert.strictEqual(again.held.size, 0);
  again.resumeTask(); await settle();
  assert.strictEqual(claude.inbox.length, 0);
  assert.ok(!again.state.transcript.some((e) => /Reopened:/.test(e.text)));
});

test('task usage: each turn\'s reported tokens go to its task; turns without a report are counted, not zero', async () => {
  const claude = typed(async (text, n, tool) => { if (n === 1) await tool(...ask('codex', 'check U')); return 'ok'; });
  claude.lastTurnUsage = { fresh: 10, cached: 90, cacheWrite: 0, output: 5 };
  const codex = typed('U fine'); // reports nothing
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('review'); await settle();
  const u = room.tasks.summary(room.tasks.get('t1')).usage;
  assert.deepStrictEqual(u.claude, { fresh: 20, cached: 180, cacheWrite: 0, output: 10, turns: 2, unreported: 0 });
  assert.deepStrictEqual(u.codex, { fresh: 0, cached: 0, cacheWrite: 0, output: 0, turns: 1, unreported: 1 });
});
