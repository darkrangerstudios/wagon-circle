'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Room, mentions } = require('../src/room');
// These tests cover the pre-v0.5 prose router (proseHandoffs: true). The product default is typed requests
// plus displayed suggestions; see room-tasks.test.js.

// Fake agent: records what it was sent, replies from a script (string or fn), resolves after a tick.
function fake(script) {
  const a = { inbox: [], interrupted: false };
  a.send = (text) => { a.inbox.push(text); const r = typeof script === 'function' ? script(text, a.inbox.length) : script; return new Promise((res) => setTimeout(() => res(r), 5)); };
  a.interrupt = () => { a.interrupted = true; };
  return a;
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test('mentions: names, both/all, ignores emails', () => {
  assert.deepStrictEqual(mentions('hey @Claude and @codex'), ['claude', 'codex']);
  assert.deepStrictEqual(mentions('@both go'), ['claude', 'codex']);
  assert.deepStrictEqual(mentions('mail bob@codex.com'), []);
  assert.deepStrictEqual(mentions('no mention'), []);
});

test('no mention goes to the default agent, not both', async () => {
  const claude = fake('hi'), codex = fake('yo');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  assert.deepStrictEqual(room.postFromHuman('hello'), ['claude']);
  await settle();
  room.postFromHuman('@codex just you');
  await settle();
  room.postFromHuman('and again'); // back to the default, not sticky
  await settle();
  assert.strictEqual(claude.inbox.length, 2);
  assert.strictEqual(codex.inbox.length, 1);
  const both = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude: fake('a'), codex: fake('b') }, defaultTarget: 'both' });
  assert.deepStrictEqual(both.postFromHuman('hi'), ['claude', 'codex']);
});

test('@both takes turns: the second agent sees the first answer, in mention order', async () => {
  const claude = fake('Claude says use a lock'), codex = fake('Agreed');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@codex then @claude: how do we stop duplicate work?');
  await settle();
  assert.strictEqual(codex.inbox.length, 1);
  assert.doesNotMatch(codex.inbox[0], /use a lock/);
  assert.match(claude.inbox[0], /\[Codex — relayed by Wagon Circle, not Dean\]\nAgreed/); // Codex went first
});

test('parallel mode answers independently', async () => {
  const claude = fake('A'), codex = fake('B');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, bothMode: 'parallel' });
  room.postFromHuman('@both go');
  await settle();
  assert.doesNotMatch(claude.inbox[0], /relayed/);
  assert.doesNotMatch(codex.inbox[0], /relayed/);
});

test('catch-up delta: agent sees Dean + the other agent, labelled, never its own words', async () => {
  const claude = fake('Claude answer'), codex = fake('Codex answer');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, bothMode: 'parallel' });
  room.postFromHuman('@both first');
  await settle();
  room.postFromHuman('@codex second');
  await settle();
  const last = codex.inbox[1];
  assert.match(last, /\[Claude — relayed by Wagon Circle, not Dean\]\nClaude answer/);
  assert.match(last, /\[Dean\]\n@codex second/);
  assert.doesNotMatch(last, /Codex answer/);
  assert.doesNotMatch(last, /first/);
});

test('relay on mention, capped per Dean message', async () => {
  const claude = fake('@codex your turn'), codex = fake('@claude back to you');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, hopCap: 3 });
  room.postFromHuman('@claude start');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(claude.inbox.length + codex.inbox.length, 4); // 1 from Dean + 3 hops
  const notes = room.state.transcript.filter((e) => e.from === 'system');
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].text, /Hop cap \(3\)/);
  room.postFromHuman('@codex fresh budget');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(claude.inbox.length + codex.inbox.length, 8);
});

test('self-mention does not loop', async () => {
  const claude = fake('as @claude I say hi'), codex = fake('x');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude go');
  await settle();
  assert.strictEqual(claude.inbox.length, 1);
  assert.strictEqual(codex.inbox.length, 0);
});

test('busy agent queues and receives one merged delta', async () => {
  let release; const slow = { inbox: [], send(t) { this.inbox.push(t); return this.inbox.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve('ok2'); } };
  const codex = fake('c');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude: slow, codex } });
  room.postFromHuman('@claude one');
  room.postFromHuman('@claude two');
  room.postFromHuman('@claude three');
  release('ok1');
  await settle();
  assert.strictEqual(slow.inbox.length, 2);
  assert.match(slow.inbox[1], /two[\s\S]*three/);
});

test('history seeded for Codex fork reaches Claude only', async () => {
  const claude = fake('seen'), codex = fake('c');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'old ask' }, { role: 'codex', text: 'old answer' }], 'codex');
  room.postFromHuman('@both catch up');
  await settle();
  assert.match(claude.inbox[0], /\[Codex — earlier in the forked Codex conversation\]\nold answer/);
  assert.doesNotMatch(codex.inbox[0], /old answer/);
});

test('agent failure becomes a notice, not relayed as content', async () => {
  const claude = { send: () => Promise.reject(new Error('usage limit')) }, codex = fake('c');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude hi');
  await settle();
  room.postFromHuman('@codex next');
  await settle();
  assert.ok(room.state.transcript.some((e) => e.kind === 'error' && /usage limit/.test(e.text)));
  assert.doesNotMatch(codex.inbox[0], /usage limit/);
});

test('stop halts relays and interrupts busy agents', async () => {
  let release; const claude = { send: () => new Promise((r) => { release = r; }), interrupt() { this.interrupted = true; } };
  const codex = fake('c');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude go');
  room.stopAll();
  assert.ok(claude.interrupted);
  release('@codex please continue');
  await settle();
  assert.strictEqual(codex.inbox.length, 0);
});

test('history from a forked Claude session reaches Codex only', async () => {
  const claude = fake('c1'), codex = fake('x1');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'claude-era ask' }, { role: 'claude', text: 'claude-era answer' }], 'claude');
  room.postFromHuman('@both go');
  await settle();
  assert.match(codex.inbox[0], /\[User — earlier in the forked Claude conversation\]\nclaude-era ask/);
  assert.match(codex.inbox[0], /\[Claude — earlier in the forked Claude conversation\]\nclaude-era answer/);
  assert.doesNotMatch(claude.inbox[0], /claude-era/);
});

test('both sides seeded: each agent gets only the other side\'s past', async () => {
  const claude = fake('c'), codex = fake('x');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'CODEX-PAST-Q' }, { role: 'codex', text: 'CODEX-PAST-A' }], 'codex');
  room.seedHistory([{ role: 'user', text: 'CLAUDE-PAST-Q' }, { role: 'claude', text: 'CLAUDE-PAST-A' }], 'claude');
  room.postFromHuman('@both sync up');
  await settle();
  assert.match(claude.inbox[0], /CODEX-PAST-Q[\s\S]*CODEX-PAST-A[\s\S]*sync up/);
  assert.doesNotMatch(claude.inbox[0], /CLAUDE-PAST/);
  assert.match(codex.inbox[0], /CLAUDE-PAST-Q[\s\S]*CLAUDE-PAST-A[\s\S]*sync up/);
  assert.doesNotMatch(codex.inbox[0], /CODEX-PAST/);
});

test('the human name is configurable everywhere it is written', async () => {
  const claude = fake('@codex over to you'), codex = fake('done');
  const room = new Room({ proseHandoffs: true, humanName: 'Darby', agents: { claude, codex }, hopCap: 0 });
  room.postFromHuman('@claude hi');
  await settle();
  assert.match(claude.inbox[0], /^\[Darby\]\n@claude hi/);
  const note = room.state.transcript.find((e) => e.from === 'system');
  assert.match(note.text, /waiting on Darby/);
  room.postFromHuman('@codex go');
  await settle();
  assert.match(codex.inbox[0], /\[Claude — relayed by Wagon Circle, not Darby\]/);
  assert.doesNotMatch(codex.inbox[0], /Dean/);
});

test('activity passes through and tool steps are kept on the finished message', async () => {
  const claude = { send: (t, onDelta, onActivity) => { onActivity({ phase: 'thinking', label: 'thinking', thinking: 'hmm' }); onActivity({ phase: 'tool', label: 'reading room.js', step: true }); onActivity({ phase: 'writing', label: 'writing' }); return Promise.resolve('done'); } };
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex: fake('x') } });
  const seen = []; room.on('activity', (a) => seen.push(`${a.name}:${a.phase}:${a.label}`));
  const statuses = []; room.on('status', (s) => statuses.push(s));
  room.postFromHuman('@claude go');
  await settle();
  assert.deepStrictEqual(seen, ['claude:thinking:thinking', 'claude:tool:reading room.js', 'claude:writing:writing']);
  const msg = room.state.transcript.find((e) => e.from === 'claude');
  assert.deepStrictEqual(msg.steps, ['reading room.js']);
  assert.ok(typeof statuses[0].since === 'number');
});

test('IDE context rides with the message to every agent that reads it', async () => {
  const claude = fake('ok'), codex = fake('ok');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude why is this slow?', [], { summary: 'room.js · L40–52 selected', text: 'Active file: src/room.js\nSelected lines 40-52' });
  await settle();
  assert.match(claude.inbox[0], /\(IDE context from Dean's editor\)\nActive file: src\/room\.js/);
  room.postFromHuman('@codex thoughts?');
  await settle();
  assert.match(codex.inbox[0], /Selected lines 40-52/); // catch-up carries it too
});

test('runaway from the 2026-09-23 transcript: talking ABOUT mentions must not hand off', async () => {
  // Both agents discuss the tags in backticks and quotes, as they did in Dean's live test.
  const claude = fake('So the `@both` tag seems to persist. Codex said "@claude should confirm" earlier.');
  const codex = fake('That supports `@both` carrying forward.\n```\n@claude\n```');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@both interesting, does it fire to both again?');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(claude.inbox.length, 1);
  assert.strictEqual(codex.inbox.length, 1);
});

test('agents cannot use @both, and each agent gets at most 2 turns per human message', async () => {
  const claude = fake('@codex your turn @both'), codex = fake('@claude back to you');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, hopCap: 10 });
  room.postFromHuman('@claude start');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(claude.inbox.length, 2); // its answer + one reply to a hand-off
  assert.strictEqual(codex.inbox.length, 2);  // never more than 2, however high the hop cap
  assert.ok(room.state.transcript.some((e) => e.from === 'system' && /2 turns/.test(e.text)));
});

test('default hop cap of 2 keeps a normal exchange short', async () => {
  const claude = fake('@codex your turn'), codex = fake('@claude back to you');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, hopCap: 2 });
  room.postFromHuman('@claude start');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(claude.inbox.length + codex.inbox.length, 3); // answer, hand-off, hand-back; then waits on Dean
});

test('handoffs: only a line that starts with the other agent\'s name; never code, quotes or @both', () => {
  const { handoffs } = require('../src/room');
  assert.deepStrictEqual(handoffs('Found the race.\n@codex can you confirm it on Windows?', 'claude'), ['codex']);
  assert.deepStrictEqual(handoffs('  @Codex: what\'s your diagnosis?', 'claude'), ['codex']);
  assert.deepStrictEqual(handoffs('the `@codex` tag and "@codex" and @both', 'claude'), []);
  assert.deepStrictEqual(handoffs('```\n@codex\n```', 'claude'), []);
  // Codex review F4 (2026-09-23): agreement, blockquotes and tilde fences are conversation, not requests.
  assert.deepStrictEqual(handoffs('I agree with @codex.', 'claude'), []);
  assert.deepStrictEqual(handoffs('> @codex please check this', 'claude'), []);
  assert.deepStrictEqual(handoffs('~~~\n@codex\n~~~\nok', 'claude'), []);
  assert.deepStrictEqual(handoffs('```js\nx()\n```\n@codex over to you', 'claude'), ['codex']);
  assert.deepStrictEqual(handoffs('@claude note to self', 'claude'), []);
});

test('steer goes into the busy agent\'s turn, once, and the other agent sees it later', async () => {
  let release; const steered = [];
  const claude = { send: () => new Promise((r) => { release = r; }), steer: (t) => { steered.push(t); return true; } };
  const codex = fake('ok');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude refactor the parser');
  const r = room.steerFromHuman('actually skip the tests for now');
  assert.deepStrictEqual(r.steered, ['claude']);
  assert.match(steered[0], /^\[Dean, steering you mid-turn: follow this now\]\nactually skip the tests/);
  release('done');
  await settle();
  room.postFromHuman('@claude anything else?');
  await settle();
  room.postFromHuman('@codex review please');
  await settle();
  assert.match(codex.inbox[0], /\[Dean, to Claude mid-turn\]\nactually skip the tests/);
});

test('a steer that only names an idle agent is an ordinary message', async () => {
  let release; const claude = { send: () => new Promise((r) => { release = r; }), steer: () => true };
  const codex = fake('on it');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude long job');
  const r = room.steerFromHuman('@codex meanwhile, check the README');
  assert.deepStrictEqual(r.steered, []);
  await settle();
  assert.strictEqual(codex.inbox.length, 1);
  release('x');
});

test('stopping shows a calm note, not a failure', async () => {
  const claude = { send: () => { const e = new Error('stopped'); e.stopped = true; return Promise.reject(e); } };
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex: fake('x') } });
  room.postFromHuman('@claude go');
  await settle();
  assert.ok(room.state.transcript.some((e) => e.from === 'system' && e.text === 'Claude stopped.' && !e.kind));
});

// Codex review of v0.4.3 (2026-09-23), F1-F3: cancellation and delivery.
test('Stop cancels the whole run: a new message cannot revive the stopped @both sequence', async () => {
  let release; const claude = { inbox: [], send(t) { this.inbox.push(t); return new Promise((r) => { release = r; }); }, interrupt() {} };
  const codex = fake('ok');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@both OLD_TASK');
  room.stopAll();
  room.postFromHuman('@claude NEW_TASK');
  release('old result'); await settle();
  assert.strictEqual(codex.inbox.length, 0);  // the old sequence stays stopped
  assert.strictEqual(claude.inbox.length, 2); // Claude still gets the new message after its turn
  assert.match(claude.inbox[1], /NEW_TASK/);
  release('new result'); await settle();
});

test('a delivery held back by the turn limit is kept for the next one', async () => {
  const claude = fake('ok'), codex = fake('ok');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex }, maxTurns: 1 });
  room.postFromHuman('@claude start'); await settle();
  room._append('codex', 'UNSEEN_FINDING');
  await room.deliver('claude'); // capped: not sent
  room.postFromHuman('@claude continue'); await settle();
  assert.strictEqual(claude.inbox.length, 2);
  assert.match(claude.inbox[1], /UNSEEN_FINDING/);
});

test('a failed send leaves its messages deliverable', async () => {
  let fail = true; const claude = fake(() => 'ok');
  const send = claude.send; claude.send = (t) => (fail ? Promise.reject(new Error('transport down')) : send(t));
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex: fake('x') } });
  room.postFromHuman('@claude FIRST'); await settle();
  fail = false;
  room.postFromHuman('@claude SECOND'); await settle();
  assert.match(claude.inbox[0], /FIRST[\s\S]*SECOND/);
});

for (const [how, steer] of [['returns false', () => false], ['throws', () => { throw new Error('no turn'); }], ['rejects', () => Promise.reject(new Error('gone'))]]) {
  test(`a steer the agent ${how} on reaches it after its turn, and is not marked seen`, async () => {
    let release; const claude = { inbox: [], send(t) { this.inbox.push(t); return new Promise((r) => { release = r; }); }, steer };
    const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex: fake('x') } });
    room.postFromHuman('@claude long job');
    room.steerFromHuman('LOST_STEER'); await settle();
    assert.ok(room.state.transcript.some((e) => e.from === 'system' && /Couldn't steer Claude/.test(e.text)));
    release('done'); await settle();
    assert.strictEqual(claude.inbox.length, 2);
    assert.match(claude.inbox[1], /LOST_STEER/);
    release('ok'); await settle();
  });
}

test('a reply that lands after Stop is shown but its hand-off is not followed', async () => {
  let release; const claude = { send: () => new Promise((r) => { release = r; }), interrupt() {} };
  const codex = fake('c');
  const room = new Room({ proseHandoffs: true, humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude go'); room.stopAll();
  room.postFromHuman('@codex unrelated'); await settle();
  release('@codex please continue the old work'); await settle();
  assert.strictEqual(codex.inbox.length, 1); // only the new message, no relay from the stopped run
  assert.ok(room.state.transcript.some((e) => e.from === 'claude' && /old work/.test(e.text)));
});
