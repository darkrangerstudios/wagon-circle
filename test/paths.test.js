'use strict';
// Agent-supplied diff paths stay inside the room folder. Codex review of v0.4.3, F5.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside, resolveInside } = require('../src/paths');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-paths-')));
const root = path.join(tmp, 'workspace'), outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
fs.symlinkSync(outside, path.join(root, 'link'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ordinary relative paths resolve inside, including files that do not exist yet', () => {
  assert.strictEqual(resolveInside(root, 'src/room.js'), path.join(root, 'src/room.js'));
  assert.strictEqual(resolveInside(root, 'new/dir/file.txt'), path.join(root, 'new/dir/file.txt'));
});

test('absolute paths and ../ escapes are refused', () => {
  assert.strictEqual(resolveInside(root, '../outside/secret.txt'), null);
  assert.strictEqual(resolveInside(root, 'src/../../outside/secret.txt'), null);
  assert.strictEqual(resolveInside(root, path.join(outside, 'secret.txt')), null);
  assert.strictEqual(resolveInside(root, '..\\outside\\secret.txt'), null);
  assert.strictEqual(resolveInside(root, ''), null);
});

test('a symlinked folder pointing outside does not count as inside', () => {
  assert.strictEqual(resolveInside(root, 'link/secret.txt'), null);
  assert.strictEqual(isInside(root, path.join(root, 'link', 'new.txt')), false);
});

test('isInside: the root itself and its children; not siblings with a shared prefix', () => {
  assert.strictEqual(isInside(root, root), true);
  assert.strictEqual(isInside(root, path.join(root, 'src')), true);
  assert.strictEqual(isInside(root, root + '-other/x'), false);
});
