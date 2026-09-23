'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
test('webview script expects the same version the extension stamps on the page', () => {
  const v = require('../package.json').version;
  const m = fs.readFileSync(require.resolve('../media/room.js'), 'utf8').match(/const EXPECT = '([^']+)'/);
  assert.strictEqual(m[1], v);
});
