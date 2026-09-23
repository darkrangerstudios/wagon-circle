'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse, apply, stats } = require('../src/diffs');

const DIFF = `diff --git a/src/parse.ts b/src/parse.ts
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -2,3 +2,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
--- /dev/null
+++ b/test/new.test.ts
@@ -0,0 +1,2 @@
+test('x', () => {});
+
`;

test('parse splits files and hunks, and handles new files', () => {
  const files = parse(DIFF);
  assert.deepStrictEqual(files.map((f) => [f.oldPath, f.newPath]), [['src/parse.ts', 'src/parse.ts'], [null, 'test/new.test.ts']]);
  assert.deepStrictEqual(stats(files[0]), { add: 2, del: 1 });
});

test('apply patches in memory and tolerates line drift', () => {
  const [f] = parse(DIFF);
  const original = ['// header', 'const a = 1;', 'const b = 2;', 'export { a };'].join('\n');
  assert.strictEqual(apply(original, f.hunks), ['// header', 'const a = 1;', 'const b = 3;', 'const c = 4;', 'export { a };'].join('\n'));
  const drifted = ['// one', '// two', '// three', 'const a = 1;', 'const b = 2;', 'export { a };'].join('\n');
  assert.match(apply(drifted, f.hunks), /const c = 4;/);
});

test('apply refuses when context does not match', () => {
  const [f] = parse(DIFF);
  assert.strictEqual(apply('totally different\nfile', f.hunks), null);
});

test('new file applies against empty text', () => {
  const nf = parse(DIFF)[1];
  assert.strictEqual(apply('', nf.hunks), "test('x', () => {});\n");
});

test('a deleted line that looks like a header stays in its hunk', () => {
  const d = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- old comment\n select 1;\n";
  const [f] = parse(d);
  assert.deepStrictEqual(f.hunks[0].lines, ['--- old comment', ' select 1;']);
  assert.strictEqual(apply('-- old comment\nselect 1;', f.hunks), 'select 1;');
});
