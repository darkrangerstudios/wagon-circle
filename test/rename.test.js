'use strict';
// The Wagon Circle -> Wagon Wheel rename moved the extension's storage folder. Rooms saved under the old id are
// copied (never moved) once. The extension loads with a minimal vscode stub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');
const realLoad = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? {} : realLoad.call(this, req, ...a); };
const { migrateRooms } = require('../src/extension');
Module._load = realLoad;

test('rooms saved under the old extension id are copied to the new one, once, and the originals stay', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'wwgs-'));
  const oldRooms = path.join(g, 'darkrangerstudios.wagon-circle', 'rooms');
  fs.mkdirSync(path.join(oldRooms, 'r1', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(oldRooms, 'r1.json'), '{"meta":{"id":"r1"}}');
  fs.writeFileSync(path.join(oldRooms, 'r1', 'attachments', 'a.png'), 'x');
  const ctx = { globalStorageUri: { fsPath: path.join(g, 'darkrangerstudios.wagon-wheel') } };
  migrateRooms(ctx);
  const newRooms = path.join(g, 'darkrangerstudios.wagon-wheel', 'rooms');
  assert.strictEqual(fs.readFileSync(path.join(newRooms, 'r1.json'), 'utf8'), '{"meta":{"id":"r1"}}');
  assert.ok(fs.existsSync(path.join(newRooms, 'r1', 'attachments', 'a.png')));
  assert.ok(fs.existsSync(path.join(oldRooms, 'r1.json')), 'originals kept');
  fs.writeFileSync(path.join(newRooms, 'r2.json'), '{}'); fs.writeFileSync(path.join(oldRooms, 'r1.json'), 'changed later');
  migrateRooms(ctx); // already migrated: nothing is copied over newer data
  assert.strictEqual(fs.readFileSync(path.join(newRooms, 'r1.json'), 'utf8'), '{"meta":{"id":"r1"}}');
  fs.rmSync(g, { recursive: true, force: true });
});

test('nothing to migrate is a no-op', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'wwgs-'));
  migrateRooms({ globalStorageUri: { fsPath: path.join(g, 'darkrangerstudios.wagon-wheel') } });
  assert.ok(!fs.existsSync(path.join(g, 'darkrangerstudios.wagon-wheel', 'rooms')));
  fs.rmSync(g, { recursive: true, force: true });
});

// Codex combined review of 272670f: a partial copy used to block every later attempt.
test('an interrupted migration leaves nothing half-copied and succeeds on the next launch', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'wwgs-'));
  const oldRooms = path.join(g, 'darkrangerstudios.wagon-circle', 'rooms');
  fs.mkdirSync(oldRooms, { recursive: true });
  fs.writeFileSync(path.join(oldRooms, 'room1.json'), '{"a":1}'); fs.writeFileSync(path.join(oldRooms, 'room2.json'), '{"b":2}');
  const ctx = { globalStorageUri: { fsPath: path.join(g, 'darkrangerstudios.wagon-wheel') } };
  const newRooms = path.join(g, 'darkrangerstudios.wagon-wheel', 'rooms');
  // Fault injection: copy only room1, then fail.
  const faulty = { cpSync: (from, to) => { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(path.join(from, 'room1.json'), path.join(to, 'room1.json')); throw new Error('disk full'); } };
  assert.strictEqual(migrateRooms(ctx, faulty), false);
  assert.ok(!fs.existsSync(newRooms), 'no partial rooms folder is left in place');
  assert.strictEqual(migrateRooms(ctx), true);
  assert.deepStrictEqual(fs.readdirSync(newRooms).sort(), ['room1.json', 'room2.json']);
  assert.ok(fs.existsSync(path.join(oldRooms, 'room2.json')), 'originals kept');
  fs.rmSync(g, { recursive: true, force: true });
});

test('a copy that does not match the originals is not promoted', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'wwgs-'));
  const oldRooms = path.join(g, 'darkrangerstudios.wagon-circle', 'rooms');
  fs.mkdirSync(oldRooms, { recursive: true }); fs.writeFileSync(path.join(oldRooms, 'r.json'), 'full content');
  const ctx = { globalStorageUri: { fsPath: path.join(g, 'darkrangerstudios.wagon-wheel') } };
  const truncating = { cpSync: (from, to) => { fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, 'r.json'), 'fu'); } };
  assert.strictEqual(migrateRooms(ctx, truncating), false);
  assert.ok(!fs.existsSync(path.join(g, 'darkrangerstudios.wagon-wheel', 'rooms')));
  fs.rmSync(g, { recursive: true, force: true });
});
