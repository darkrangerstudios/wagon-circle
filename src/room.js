'use strict';
// Room router: who hears what, when. Pure logic over agents that expose send(text, onDelta) -> Promise<string>.
const { EventEmitter } = require('events');

const AGENTS = ['claude', 'codex'];
const LABEL = { dean: 'Dean', claude: 'Claude', codex: 'Codex', system: 'Campfire' };

// @claude, @codex, @both / @all. Ignores e-mail-like text (x@codex.com) by requiring a non-word char before '@'.
function mentions(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/(^|[^\w@.])@(claude|codex|both|all)\b/gi)) {
    const n = m[2].toLowerCase();
    if (n === 'both' || n === 'all') AGENTS.forEach((a) => found.add(a)); else found.add(n);
  }
  return [...found];
}

function label(entry) {
  if (entry.kind === 'history') return `[${entry.from === 'codex' ? 'Codex' : 'User'} — earlier in the forked Codex thread]`;
  if (entry.from === 'dean') return '[Dean]';
  if (entry.from === 'system') return '[Campfire notice]';
  return `[${LABEL[entry.from]} — relayed by Campfire, not Dean]`;
}

class Room extends EventEmitter {
  constructor({ agents, hopCap = 4, state = null }) {
    super();
    this.agents = agents; this.hopCap = hopCap;
    this.state = state || { transcript: [], cursors: { claude: 0, codex: 0 }, lastTargets: [...AGENTS], seq: 0 };
    this.busy = { claude: false, codex: false }; this.pending = { claude: false, codex: false };
    this.hopsLeft = hopCap; this.capNoted = false; this.halted = false;
  }

  _append(from, text, extra = {}) {
    const entry = { id: ++this.state.seq, from, text, ts: Date.now(), ...extra };
    this.state.transcript.push(entry);
    this.emit('message', entry); this.emit('changed', this.state);
    return entry;
  }

  // Seed history an agent already has (e.g. a forked Codex thread) so only the others receive it.
  seedHistory(items, alreadyKnownBy) {
    for (const it of items) this._append(it.role === 'codex' ? 'codex' : 'dean', it.text, { kind: 'history' });
    if (alreadyKnownBy) this.state.cursors[alreadyKnownBy] = this.state.transcript.length;
    this.emit('changed', this.state);
  }

  note(text) { return this._append('system', text); }

  postFromDean(text) {
    const addressed = mentions(text);
    const targets = addressed.length ? addressed : this.state.lastTargets;
    this.state.lastTargets = targets;
    this.hopsLeft = this.hopCap; this.capNoted = false; this.halted = false;
    this._append('dean', text);
    for (const t of targets) this.deliver(t);
    return targets;
  }

  payloadFor(name) {
    const fresh = this.state.transcript.slice(this.state.cursors[name]).filter((e) => e.from !== name && e.kind !== 'error');
    return fresh.map((e) => `${label(e)}\n${e.text}`).join('\n\n');
  }

  async deliver(name) {
    if (this.halted || !this.agents[name]) return;
    if (this.busy[name]) { this.pending[name] = true; return; }
    const payload = this.payloadFor(name);
    this.state.cursors[name] = this.state.transcript.length;
    if (!payload) return;
    this.busy[name] = true; this.emit('status', { name, busy: true });
    try {
      const reply = await this.agents[name].send(payload, (partial) => this.emit('draft', { name, text: partial }));
      const entry = this._append(name, reply || '(no reply)');
      this._relay(name, entry.text);
    } catch (e) {
      this._append('system', `${LABEL[name]} failed: ${e.message}`, { kind: 'error' });
    } finally {
      this.busy[name] = false; this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      if (this.pending[name]) { this.pending[name] = false; this.deliver(name); }
    }
  }

  _relay(from, text) {
    for (const to of mentions(text).filter((n) => n !== from)) {
      if (this.halted) return;
      if (this.hopsLeft <= 0) {
        if (!this.capNoted) { this.capNoted = true; this.note(`Hop cap (${this.hopCap}) reached. ${LABEL[from]} asked for ${LABEL[to]}; waiting on Dean.`); }
        continue;
      }
      this.hopsLeft -= 1;
      this.deliver(to);
    }
  }

  stopAll() {
    this.halted = true; this.pending = { claude: false, codex: false };
    for (const n of AGENTS) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this.note('Stopped by Dean.');
  }
}

module.exports = { Room, mentions, label, AGENTS, LABEL };
