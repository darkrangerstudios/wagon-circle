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
