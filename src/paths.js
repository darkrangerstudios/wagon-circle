'use strict';
// Containment checks for paths an agent or the editor hands us. Symlinks are resolved, so a link inside the
// folder that points outside it does not count as inside.
const fs = require('fs');
const path = require('path');

// Real path of p, or of its nearest existing ancestor with the rest appended (for files that don't exist yet).
function realish(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur)); cur = up;
  }
}

function isInside(root, p) {
  const rel = path.relative(realish(root), realish(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A diff's file path, resolved inside root, or null. Absolute paths and ../ escapes are refused outright.
function resolveInside(root, rel) {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const abs = path.join(root, rel);
  return isInside(root, abs) ? abs : null;
}

module.exports = { isInside, resolveInside };
