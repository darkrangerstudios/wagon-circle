'use strict';
// The .vsix people install: every contributed command is registered, and only runtime files ship.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');

test('every command in the manifest is registered by the extension, and the reverse', () => {
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  const registered = [...src.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]).sort();
  const contributed = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(registered, contributed);
  assert.ok(contributed.includes('wagonWheel.reportProblem'));
});

test('.vscodeignore keeps tests, the site, agent notes and local settings out of the package', () => {
  const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const r of ['test/**', 'docs/**', '.github/**', '.claude/**', 'AGENTS.md', '**/*.vsix']) assert.ok(rules.includes(r), `missing ${r}`);
  assert.ok(!rules.some((r) => /^(src|media|walkthrough)\b/.test(r) || r === 'README.md' || r === 'LICENSE'), 'a runtime file is excluded');
});

test('the manifest carries what an installable package needs', () => {
  for (const k of ['name', 'displayName', 'publisher', 'version', 'icon', 'license', 'repository', 'engines', 'main']) assert.ok(pkg[k], `missing ${k}`);
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
  assert.match(pkg.scripts.package, /@vscode\/vsce@\d+\.\d+\.\d+ package$/, 'vsce is pinned to an exact version');
  assert.strictEqual(pkg.dependencies, undefined, 'no runtime dependencies');
});
