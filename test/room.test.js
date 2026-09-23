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
  const room = new Room({ agents: { claude, codex } });
  assert.deepStrictEqual(room.postFromDean('hello'), ['claude', 'codex']);
  await settle();
  room.postFromDean('@claude just you');
  await settle();
  room.postFromDean('and again');
  await settle();
  assert.strictEqual(claude.inbox.length, 3);
  assert.strictEqual(codex.inbox.length, 1);
});

test('catch-up delta: agent sees Dean + the other agent, labelled, never its own words', async () => {
  const claude = fake('Claude answer'), codex = fake('Codex answer');
  const room = new Room({ agents: { claude, codex } });
  room.postFromDean('@both first');
  await settle();
  room.postFromDean('@codex second');
  await settle();
  const last = codex.inbox[1];
  assert.match(last, /\[Claude — relayed by Campfire, not Dean\]\nClaude answer/);
  assert.match(last, /\[Dean\]\n@codex second/);
  assert.doesNotMatch(last, /Codex answer/);
  assert.doesNotMatch(last, /first/);
});

test('relay on mention, capped per Dean message', async () => {
  const claude = fake('@codex your turn'), codex = fake('@claude back to you');
  const room = new Room({ agents: { claude, codex }, hopCap: 3 });
  room.postFromDean('@claude start');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(claude.inbox.length + codex.inbox.length, 4); // 1 from Dean + 3 hops
  const notes = room.state.transcript.filter((e) => e.from === 'system');
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].text, /Hop cap \(3\)/);
  room.postFromDean('@codex fresh budget');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(claude.inbox.length + codex.inbox.length, 8);
});

test('self-mention does not loop', async () => {
  const claude = fake('as @claude I say hi'), codex = fake('x');
  const room = new Room({ agents: { claude, codex } });
  room.postFromDean('@claude go');
  await settle();
  assert.strictEqual(claude.inbox.length, 1);
  assert.strictEqual(codex.inbox.length, 0);
});

test('busy agent queues and receives one merged delta', async () => {
  let release; const slow = { inbox: [], send(t) { this.inbox.push(t); return this.inbox.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve('ok2'); } };
  const codex = fake('c');
  const room = new Room({ agents: { claude: slow, codex } });
  room.postFromDean('@claude one');
  room.postFromDean('@claude two');
  room.postFromDean('@claude three');
  release('ok1');
  await settle();
  assert.strictEqual(slow.inbox.length, 2);
  assert.match(slow.inbox[1], /two[\s\S]*three/);
});

test('history seeded for Codex fork reaches Claude only', async () => {
  const claude = fake('seen'), codex = fake('c');
  const room = new Room({ agents: { claude, codex } });
  room.seedHistory([{ role: 'user', text: 'old ask' }, { role: 'codex', text: 'old answer' }], 'codex');
  room.postFromDean('@both catch up');
  await settle();
  assert.match(claude.inbox[0], /earlier in the forked Codex thread\]\nold answer/);
  assert.doesNotMatch(codex.inbox[0], /old answer/);
});

test('agent failure becomes a notice, not relayed as content', async () => {
  const claude = { send: () => Promise.reject(new Error('usage limit')) }, codex = fake('c');
  const room = new Room({ agents: { claude, codex } });
  room.postFromDean('@claude hi');
  await settle();
  room.postFromDean('@codex next');
  await settle();
  assert.ok(room.state.transcript.some((e) => e.kind === 'error' && /usage limit/.test(e.text)));
  assert.doesNotMatch(codex.inbox[0], /usage limit/);
});

test('stop halts relays and interrupts busy agents', async () => {
  let release; const claude = { send: () => new Promise((r) => { release = r; }), interrupt() { this.interrupted = true; } };
  const codex = fake('c');
  const room = new Room({ agents: { claude, codex } });
  room.postFromDean('@claude go');
  room.stopAll();
  assert.ok(claude.interrupted);
  release('@codex please continue');
  await settle();
  assert.strictEqual(codex.inbox.length, 0);
});
