'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ide = require('../src/ideContext');
test('summary and format describe the selection, problems and tabs', () => {
  const snap = { file: 'src/room.js', language: 'javascript', cursor: 41, selection: { start: 40, end: 52, text: 'deliver(name) {' }, tabs: ['src/room.js', 'README.md'], problems: [{ severity: 'Error', line: 44, message: 'x is not defined' }] };
  assert.strictEqual(ide.summary(snap), 'room.js · L40–52 selected');
  const t = ide.format(snap);
  assert.match(t, /Active file: src\/room\.js \(javascript\), cursor on line 41/);
  assert.match(t, /Selected lines 40-52:\n```\ndeliver\(name\) \{/);
  assert.match(t, /- Error line 44: x is not defined/);
  assert.match(t, /Open tabs: src\/room\.js, README\.md/);
  assert.strictEqual(ide.summary({ file: 'a/b.ts', cursor: 7 }), 'b.ts · L7');
  assert.strictEqual(ide.format(null), null);
});
