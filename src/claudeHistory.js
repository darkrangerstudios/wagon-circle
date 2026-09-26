'use strict';
// Read Claude Code's saved sessions (~/.claude/projects/<project>/<session>.jsonl) locally. No model call, no writes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_CHARS = 2000;

function readSlice(file, fromEnd, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    const lines = buf.toString('utf8').split('\n');
    if (fromEnd && len < size) lines.shift(); // first line is cut mid-record
    return lines;
  } finally { fs.closeSync(fd); }
}

function parse(lines) {
  const out = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* partial line */ } }
  return out;
}

// Text a human actually typed, or text Claude actually said. Drops tool traffic, thinking, sub-agents and injected context.
function textOf(rec) {
  if (rec.isMeta || rec.isSidechain || !rec.message) return null;
  const c = rec.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder|task-notification|bash-|user-memory)/.test(t)) return null;
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + ' …[trimmed]' : t;
}

function listSessions(limit = 25) {
  if (!fs.existsSync(ROOT)) return [];
  const files = [];
  for (const dir of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, dir);
    let entries; try { entries = fs.readdirSync(p); } catch { continue; }
    for (const f of entries) if (f.endsWith('.jsonl')) { const fp = path.join(p, f); try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* raced */ } }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { fp, mtime } of files) {
    if (sessions.length >= limit) break;
    const head = parse(readSlice(fp, false, 65536)), tail = parse(readSlice(fp, true, 524288));
    const first = head.find((r) => r.type === 'user' && textOf(r));
    const cwd = (head.find((r) => r.cwd) || tail.find((r) => r.cwd) || {}).cwd;
    if (!first || !cwd) continue; // empty or tool-only session
    const titled = [...head, ...tail].filter((r) => r.customTitle || r.aiTitle);
    const t = titled.reverse().find((r) => r.customTitle) || titled.find((r) => r.aiTitle);
    // mode: the permission mode of the first message. Wagon Wheel runs Claude as dontAsk, so its own rooms' sessions
    // (fresh or copies) carry it; a person's session keeps its own mode even if a room later keeps going in it.
    sessions.push({ id: path.basename(fp, '.jsonl'), path: fp, cwd, mtime, title: t ? (t.customTitle || t.aiTitle) : null, preview: textOf(first).slice(0, 100), mode: typeof first.permissionMode === 'string' ? first.permissionMode : null });
  }
  return sessions;
}

// Last `turns` exchanges, oldest first, as {role: 'user'|'claude', text}.
function recentMessages(file, turns = 8) {
  const msgs = [];
  for (const r of parse(readSlice(file, true, 4 * 1024 * 1024))) {
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const text = textOf(r); if (!text) continue;
    const role = r.type === 'user' ? 'user' : 'claude';
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'claude' && role === 'claude') last.text += '\n\n' + text; // one reply spans several records
    else msgs.push({ role, text });
  }
  let start = msgs.length, seen = 0;
  while (start > 0 && seen < turns) { start -= 1; if (msgs[start].role === 'user') seen += 1; }
  return msgs.slice(start);
}

// The saved file for a session id, or null. Session ids are UUIDs; anything else is refused.
function fileFor(id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(id)) || !fs.existsSync(ROOT)) return null;
  for (const dir of fs.readdirSync(ROOT)) { const fp = path.join(ROOT, dir, `${id}.jsonl`); if (fs.existsSync(fp)) return fp; }
  return null;
}

module.exports = { listSessions, recentMessages, textOf, fileFor, ROOT };
