'use strict';
// One writer per saved room across VS Code windows. Each window runs its own extension host process, so the
// in-process claim (roomClaims in extension.js) cannot see a room open in another window. A lock file next to the
// room, <id>.lock, holds the owner's pid. It is created exclusively, removed when the room closes, and taken over
// when its owner process is gone (a crash or a window reload).
const fs = require('fs');

const FRESH_MS = 5000; // an unreadable lock this new may be mid-write by another window: treat it as held

const lockPath = (roomFile) => roomFile.replace(/\.json$/, '.lock');

function alive(pid, kill = process.kill) {
  try { kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM: exists, owned by someone else
}

// The live owner other than this process, or null when the room is free (no lock, a dead owner, or ours).
function holder(roomFile, { fsx = fs, kill, self = process.pid, now = Date.now } = {}) {
  const p = lockPath(roomFile);
  let raw;
  try { raw = fsx.readFileSync(p, 'utf8'); } catch { return null; }
  let cur = null; try { cur = JSON.parse(raw); } catch { /* checked below */ }
  if (!cur || !Number.isInteger(cur.pid) || cur.pid <= 0) { // kill(0 or negative) would target process groups
    try { return now() - fsx.statSync(p).mtimeMs < FRESH_MS ? { pid: null, since: null } : null; } catch { return null; }
  }
  if (cur.pid === self || !alive(cur.pid, kill)) return null;
  return { pid: cur.pid, since: typeof cur.since === 'string' ? cur.since : null };
}

// { ok: true } when this process now owns the room, else { ok: false, holder }.
function acquire(roomFile, { fsx = fs, kill, self = process.pid, now = Date.now } = {}) {
  const p = lockPath(roomFile), body = JSON.stringify({ pid: self, since: new Date(now()).toISOString() });
  fsx.mkdirSync(require('path').dirname(p), { recursive: true }); // the first room on a new install has no folder yet
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsx.writeFileSync(p, body, { flag: 'wx' });
      // Two windows taking over the same stale lock can both unlink and create; the later create wins the file.
      // Reading it back catches most of that race. A tiny window remains (both read back before the second unlink);
      // it needs two windows opening one crashed room within milliseconds.
      let mine = false; try { mine = JSON.parse(fsx.readFileSync(p, 'utf8')).pid === self; } catch { /* treat as lost */ }
      if (mine) return { ok: true };
      return { ok: false, holder: holder(roomFile, { fsx, kill, self, now }) || { pid: null, since: null } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const h = holder(roomFile, { fsx, kill, self, now });
    if (h) return { ok: false, holder: h };
    try { fsx.unlinkSync(p); } catch { /* another window removed it first; retry the exclusive create */ }
  }
  const h = holder(roomFile, { fsx, kill, self, now });
  return { ok: false, holder: h || { pid: null, since: null } };
}

// Removes the lock only if this process holds it.
function release(roomFile, { fsx = fs, self = process.pid } = {}) {
  const p = lockPath(roomFile);
  try { const cur = JSON.parse(fsx.readFileSync(p, 'utf8')); if (cur && cur.pid === self) fsx.unlinkSync(p); } catch { /* absent or not ours */ }
}

module.exports = { acquire, release, holder, lockPath, alive, FRESH_MS };
