'use strict';
// Saved rooms for the Wagon Wheel side panel: name, seats and last activity, newest first. Read-only. A room file
// holds its whole transcript, so each file is parsed once and reused until its size or modification time changes.
const fs = require('fs');
const path = require('path');

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // rooms are <crypto.randomUUID()>.json

function readRoom(file, fsx) {
  const r = JSON.parse(fsx.readFileSync(file, 'utf8'));
  const m = r && r.meta;
  if (!m || typeof m.id !== 'string' || !ROOM_ID.test(m.id) || `${m.id}.json` !== path.basename(file)) return null;
  const seats = Array.isArray(m.participants) ? m.participants : Array.isArray(m.seats) ? m.seats : null;
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
  return {
    id: m.id,
    name: text(m.name, 120) || 'Untitled room',
    cwd: text(m.cwd, 400),
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : null,
    seats: seats ? seats.filter((p) => p && typeof p === 'object').map((p) => ({ label: text(p.label || p.id, 60), provider: text(p.provider, 20) }))
      : [{ label: 'Claude', provider: 'claude' }, { label: 'Codex', provider: 'codex' }], // rooms saved before named seats
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
      try { room = readRoom(file, fsx); } catch { room = null; } // a half-written or foreign file is skipped, not fatal
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, room });
    }
    if (room) rooms.push({ ...room, updatedAt: st.mtimeMs });
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

// What the tree row shows: seat names and when the room was last used.
function describe(room, { open = false, now = Date.now() } = {}) {
  const seats = room.seats.map((p) => p.label).filter(Boolean).join(', ');
  return {
    label: room.name,
    description: [open ? 'open' : ago(room.updatedAt, now), seats].filter(Boolean).join(' · '),
    tooltip: [room.name, seats && `Seats: ${seats}`, room.cwd && `Folder: ${room.cwd}`, `Last activity: ${new Date(room.updatedAt).toLocaleString()}`,
      open ? 'Open now: click to show it.' : 'Click to reopen.'].filter(Boolean).join('\n'),
  };
}

module.exports = { listRooms, readRoom, describe, ago, ROOM_ID };
