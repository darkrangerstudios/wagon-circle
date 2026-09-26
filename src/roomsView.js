'use strict';
// Saved rooms for the Wagon Wheel side panel: name, seats and last activity, newest first. Read-only. A room file
// holds its whole transcript, so each file is parsed once and reused until its size or modification time changes.
const fs = require('fs');
const path = require('path');

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // rooms are <crypto.randomUUID()>.json
const LARGE = 25 * 1024 * 1024; // bigger room files are listed without being parsed on the extension host
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g; // controls, separators, bidi overrides

function readRoom(file, fsx) {
  const r = JSON.parse(fsx.readFileSync(file, 'utf8'));
  const m = r && r.meta;
  if (!m || typeof m.id !== 'string' || !ROOM_ID.test(m.id) || `${m.id}.json` !== path.basename(file)) return null;
  // meta.seats is the saved roster with each seat's conversation id; meta.participants is a display copy without it
  // that also lists experimental agents. Ids come from seats; participants not in seats are added for display only.
  const base = Array.isArray(m.seats) ? m.seats : Array.isArray(m.participants) ? m.participants : null;
  const extra = Array.isArray(m.seats) && Array.isArray(m.participants) ? m.participants.filter((p) => p && !m.seats.some((x) => x && x.id === p.id)).map((p) => ({ ...p, sessionId: null })) : [];
  const seats = base ? [...base, ...extra] : null;
  const text = (v, max) => (typeof v === 'string' ? v.replace(UNSAFE, ' ').slice(0, max) : '');
  // Last activity is the newest message, not the file time: opening and closing a room saves it without activity.
  const t = r.state && Array.isArray(r.state.transcript) ? r.state.transcript : [];
  let last = null;
  // Room notes and seeded history are not activity: a boot can add a note without anyone talking.
  for (let i = t.length - 1; i >= 0 && i >= t.length - 50; i--) if (t[i] && t[i].from !== 'system' && t[i].kind !== 'history' && Number.isFinite(t[i].ts)) { last = t[i].ts; break; }
  const created = typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : null;
  return {
    id: m.id,
    name: text(m.name, 120) || 'Untitled room',
    cwd: text(m.cwd, 400),
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : null,
    lastActivity: last != null ? last : created,
    seats: seats ? seats.filter((p) => p && typeof p === 'object').map((p) => ({ label: text(p.label || p.id, 60), provider: text(p.provider, 20), sessionId: typeof p.sessionId === 'string' ? p.sessionId : null }))
      : [{ label: 'Claude', provider: 'claude', sessionId: typeof m.claudeSessionId === 'string' ? m.claudeSessionId : null }, { label: 'Codex', provider: 'codex', sessionId: typeof m.codexThreadId === 'string' ? m.codexThreadId : null }], // rooms saved before named seats
  };
}

function listRooms(dir, cache = new Map(), fsx = fs) {
  let names;
  try { names = fsx.readdirSync(dir); } catch { return []; }
  const rooms = [], seen = new Set();
  for (const n of names) {
    if (!n.endsWith('.json') || !ROOM_ID.test(n.slice(0, -5))) continue;
    const file = path.join(dir, n);
    let st; try { st = fsx.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    seen.add(file);
    const hit = cache.get(file);
    let room = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit.room : undefined;
    if (room === undefined) {
      if (st.size > LARGE) room = { id: n.slice(0, -5), name: 'Large room (details not loaded)', cwd: '', createdAt: null, lastActivity: null, seats: [] };
      else { try { room = readRoom(file, fsx); } catch { room = null; } } // a half-written or foreign file is skipped, not fatal
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, room });
    }
    if (room) rooms.push({ ...room, file, updatedAt: room.lastActivity != null ? room.lastActivity : st.mtimeMs });
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return rooms.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// What the tree row shows: seat names and when the room was last used. open: false, 'here' or 'elsewhere'.
function describe(room, { open = false, now = Date.now() } = {}) {
  const seats = room.seats.map((p) => p.label).filter(Boolean).join(', ');
  const state = open === 'elsewhere' ? 'open in another window' : open ? 'open' : ago(room.updatedAt, now);
  const hint = open === 'elsewhere' ? 'Open in another VS Code window: switch to that window to use it.' : open ? 'Open now: click to show it.' : 'Click to reopen.';
  return {
    label: room.name,
    description: [state, seats].filter(Boolean).join(' · '),
    tooltip: [room.name, seats && `Seats: ${seats}`, room.cwd && `Folder: ${room.cwd}`, `Last activity: ${new Date(room.updatedAt).toLocaleString()}`, hint].filter(Boolean).join('\n'),
  };
}

module.exports = { listRooms, readRoom, describe, ago, ROOM_ID, LARGE };
