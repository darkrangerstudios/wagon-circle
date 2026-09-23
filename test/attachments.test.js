'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const att = require('../src/attachments');
const { Room } = require('../src/room');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-att-'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('store classifies images, text and binary files and keeps a room copy', () => {
  const img = att.store(dir, { name: 'shot.png', data: PNG });
  const md = att.store(dir, { name: 'notes.md', data: Buffer.from('# Hi\n```js\nx```').toString('base64') });
  const bin = att.store(dir, { name: 'blob.bin', data: Buffer.from([0, 1, 2, 0]).toString('base64') });
  assert.deepStrictEqual([img.kind, md.kind, bin.kind], ['image', 'text', 'file']);
  assert.ok(fs.existsSync(img.path) && img.path.startsWith(dir));
  assert.strictEqual(att.store(dir, { name: '../../etc/passwd', data: 'eA==' }).name, 'passwd'); // no path escape
});

test('Claude gets a base64 image block and inline text; Codex gets a localImage path', () => {
  const img = att.store(dir, { name: 'a.png', data: PNG });
  const md = att.store(dir, { name: 'b.md', data: Buffer.from('launch code KINDLING-9').toString('base64') });
  const c = att.toClaudeContent('[Dean]\nlook', [img, md]);
  assert.strictEqual(c[0].type, 'text');
  assert.match(c[0].text, /\[Attached file: b\.md\][\s\S]*KINDLING-9/);
  assert.deepStrictEqual([c[1].type, c[1].source.media_type, c[1].source.data], ['image', 'image/png', PNG]);
  const x = att.toCodexInput('[Dean]\nlook', [img, md]);
  assert.match(x[0].text, /KINDLING-9/);
  assert.deepStrictEqual(x[1], { type: 'localImage', path: img.path });
});

test('large text is passed by path, not inlined', () => {
  const big = att.store(dir, { name: 'big.log', data: Buffer.alloc(att.LIMITS.inlineTextBytes + 10, 'a').toString('base64') });
  assert.match(att.describeForText(big), /at .*big\.log\. Open it with your read tools/);
});

test('room delivers attachments to addressed agents once, and to others in catch-up', async () => {
  const got = { claude: [], codex: [] };
  const mk = (n) => ({ send: (t, d, a, files) => { got[n].push(files.map((f) => f.name)); return Promise.resolve('ok'); } });
  const room = new Room({ humanName: 'Dean', agents: { claude: mk('claude'), codex: mk('codex') } });
  const f = { id: '1', name: 'shot.png', kind: 'image' };
  room.postFromHuman('@claude see this', [f]);
  await new Promise((r) => setTimeout(r, 30));
  room.postFromHuman('@claude again');
  await new Promise((r) => setTimeout(r, 30));
  room.postFromHuman('@codex your view?');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(got.claude, [['shot.png'], []]);
  assert.deepStrictEqual(got.codex, [['shot.png']]); // missed it earlier, gets it in catch-up
});
