'use strict';
// Unified diffs: parse into files and hunks, and apply hunks to a file's text in memory (never on disk).

function parse(text) {
  const files = []; let file = null; let hunk = null;
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    // Inside an unfinished hunk every line belongs to it, even one that looks like a header ("--- sql comment").
    if (hunk && (hunk.leftOld > 0 || hunk.leftNew > 0)) {
      const l = line === '' ? ' ' : line; // a blank context line whose leading space was stripped
      if (l[0] === ' ') { hunk.leftOld--; hunk.leftNew--; } else if (l[0] === '-') hunk.leftOld--; else if (l[0] === '+') hunk.leftNew--; else { hunk = null; continue; }
      hunk.lines.push(l); continue;
    }
    if (line.startsWith('diff --git ')) { file = null; hunk = null; continue; }
    if (line.startsWith('--- ')) { file = { oldPath: clean(line.slice(4)), newPath: null, hunks: [] }; files.push(file); hunk = null; continue; }
    if (line.startsWith('+++ ') && file && file.newPath === null) { file.newPath = clean(line.slice(4)); continue; }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      hunk = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      hunk.leftOld = hunk.oldLines; hunk.leftNew = hunk.newLines; file.hunks.push(hunk); continue;
    }
  }
  for (const f of files) for (const x of f.hunks) { delete x.leftOld; delete x.leftNew; }
  return files.filter((f) => f.hunks.length);
}

function clean(p) {
  const s = p.split('\t')[0].trim();
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

// Apply hunks to text. Each hunk is located by its context near the stated line, tolerating drift.
// Returns the patched text, or null when a hunk's context isn't found.
function apply(original, hunks) {
  const lines = original === '' ? [] : original.replace(/\r\n/g, '\n').split('\n');
  let offset = 0;
  for (const h of hunks) {
    const before = h.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1));
    const after = h.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1));
    const want = Math.max(0, h.oldStart - 1 + offset);
    let at = -1;
    for (let d = 0; d <= lines.length && at < 0; d++) {
      for (const cand of d === 0 ? [want] : [want - d, want + d]) {
        if (cand >= 0 && cand + before.length <= lines.length && before.every((l, i) => lines[cand + i] === l)) { at = cand; break; }
      }
    }
    if (at < 0) return null;
    lines.splice(at, before.length, ...after);
    offset += after.length - before.length;
  }
  return lines.join('\n');
}

function stats(file) {
  let add = 0, del = 0;
  for (const h of file.hunks) for (const l of h.lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
  return { add, del };
}

module.exports = { parse, apply, stats };
