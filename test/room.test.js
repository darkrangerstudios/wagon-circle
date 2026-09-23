'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Room, mentions } = require('../src/room');

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

test('no mention goes to last targets (initially both)', async () => {
  const claude = fake('hi'), codex = fake('yo');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  assert.deepStrictEqual(room.postFromHuman('hello'), ['claude', 'codex']);
  await settle();
  room.postFromHuman('@claude just you');
  await settle();
  room.postFromHuman('and again');
  await settle();
  assert.strictEqual(claude.inbox.length, 3);
  assert.strictEqual(codex.inbox.length, 1);
});

test('catch-up delta: agent sees Dean + the other agent, labelled, never its own words', async () => {
  const claude = fake('Claude answer'), codex = fake('Codex answer');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
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
  const room = new Room({ humanName: 'Dean', agents: { claude, codex }, hopCap: 3 });
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
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude go');
  await settle();
  assert.strictEqual(claude.inbox.length, 1);
  assert.strictEqual(codex.inbox.length, 0);
});

test('busy agent queues and receives one merged delta', async () => {
  let release; const slow = { inbox: [], send(t) { this.inbox.push(t); return this.inbox.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve('ok2'); } };
  const codex = fake('c');
  const room = new Room({ humanName: 'Dean', agents: { claude: slow, codex } });
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
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'old ask' }, { role: 'codex', text: 'old answer' }], 'codex');
  room.postFromHuman('@both catch up');
  await settle();
  assert.match(claude.inbox[0], /\[Codex — earlier in the forked Codex conversation\]\nold answer/);
  assert.doesNotMatch(codex.inbox[0], /old answer/);
});

test('agent failure becomes a notice, not relayed as content', async () => {
  const claude = { send: () => Promise.reject(new Error('usage limit')) }, codex = fake('c');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
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
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.postFromHuman('@claude go');
  room.stopAll();
  assert.ok(claude.interrupted);
  release('@codex please continue');
  await settle();
  assert.strictEqual(codex.inbox.length, 0);
});

test('history from a forked Claude session reaches Codex only', async () => {
  const claude = fake('c1'), codex = fake('x1');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'claude-era ask' }, { role: 'claude', text: 'claude-era answer' }], 'claude');
  room.postFromHuman('@both go');
  await settle();
  assert.match(codex.inbox[0], /\[User — earlier in the forked Claude conversation\]\nclaude-era ask/);
  assert.match(codex.inbox[0], /\[Claude — earlier in the forked Claude conversation\]\nclaude-era answer/);
  assert.doesNotMatch(claude.inbox[0], /claude-era/);
});

test('both sides seeded: each agent gets only the other side\'s past', async () => {
  const claude = fake('c'), codex = fake('x');
  const room = new Room({ humanName: 'Dean', agents: { claude, codex } });
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
  const room = new Room({ humanName: 'Darby', agents: { claude, codex }, hopCap: 0 });
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
  const room = new Room({ humanName: 'Dean', agents: { claude, codex: fake('x') } });
  const seen = []; room.on('activity', (a) => seen.push(`${a.name}:${a.phase}:${a.label}`));
  const statuses = []; room.on('status', (s) => statuses.push(s));
  room.postFromHuman('@claude go');
  await settle();
  assert.deepStrictEqual(seen, ['claude:thinking:thinking', 'claude:tool:reading room.js', 'claude:writing:writing']);
  const msg = room.state.transcript.find((e) => e.from === 'claude');
  assert.deepStrictEqual(msg.steps, ['reading room.js']);
  assert.ok(typeof statuses[0].since === 'number');
});
