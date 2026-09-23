'use strict';
// Room router: who hears what, when. Pure logic over agents that expose send(text, onDelta) -> Promise<string>.
const { EventEmitter } = require('events');

const AGENTS = ['claude', 'codex'];
const LABEL = { claude: 'Claude', codex: 'Codex', system: 'Wagon Circle' };

// @claude, @codex, @both / @all. Ignores e-mail-like text (x@codex.com) by requiring a non-word char before '@'.
function mentions(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/(^|[^\w@.])@(claude|codex|both|all)\b/gi)) {
    const n = m[2].toLowerCase();
    if (n === 'both' || n === 'all') AGENTS.forEach((a) => found.add(a)); else found.add(n);
  }
  return [...found];
}

// An agent's explicit hand-off: @claude or @codex in plain prose, naming the OTHER agent.
// Mentions inside code fences, `inline code` or quotes are the agent talking ABOUT a mention, not making one
// (that is what caused the 2026-09-23 runaway). Agents cannot use @both / @all.
function handoffs(text, from) {
  const prose = String(text)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ');
  return mentions(prose.replace(/@(both|all)\b/gi, ' ')).filter((n) => n !== from);
}

function label(entry, human) {
  if (entry.kind === 'history') return `[${entry.from === 'human' ? 'User' : LABEL[entry.from]} — earlier in the forked ${entry.source || 'Codex'} conversation]`;
  if (entry.from === 'human') return `[${human}]`;
  if (entry.from === 'system') return '[Wagon Circle notice]';
  return `[${LABEL[entry.from]} — relayed by Wagon Circle, not ${human}]`;
}

class Room extends EventEmitter {
  // defaultTarget: who hears a message with no @mention ('claude' | 'codex' | 'both').
  // bothMode: 'sequential' = addressed agents answer one after another, each seeing the previous answer;
  //           'parallel' = all at once, independently.
  // labelFor(name): optional, the model an agent is running (shown on its replies).
  // maxTurns: most replies one agent may give per human message (its answer plus replies to hand-offs).
  constructor({ agents, hopCap = 2, state = null, humanName = 'You', defaultTarget = 'claude', bothMode = 'sequential', labelFor = null, maxTurns = 2 }) {
    super();
    this.agents = agents; this.hopCap = hopCap; this.human = humanName;
    this.defaultTarget = defaultTarget; this.bothMode = bothMode; this.labelFor = labelFor;
    this.maxTurns = maxTurns; this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
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

  // Seed history one agent already has (its forked thread or session) so only the other agent receives it.
  // items: [{role: 'user'|'codex'|'claude', text}]; alreadyKnownBy: 'codex' | 'claude'.
  seedHistory(items, alreadyKnownBy) {
    for (const it of items) this._append(AGENTS.includes(it.role) ? it.role : 'human', it.text, { kind: 'history', source: LABEL[alreadyKnownBy], knownBy: alreadyKnownBy });
  }

  note(text) { return this._append('system', text); }

  postFromHuman(text, attachments = [], ide = null) {
    const addressed = mentions(text);
    const targets = addressed.length ? addressed : this.defaultTarget === 'both' ? [...AGENTS] : [this.defaultTarget];
    this.hopsLeft = this.hopCap; this.capNoted = false; this.halted = false;
    this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
    this._append('human', text, { ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    if (targets.length > 1 && this.bothMode === 'sequential') this._inTurn(targets);
    else for (const t of targets) this.deliver(t);
    return targets;
  }

  // One after another: each agent's delivery includes the previous agent's answer.
  async _inTurn(targets) {
    for (const t of targets) { if (this.halted) return; await this.deliver(t); }
  }

  // Everything this agent missed: labelled text plus the files attached to those messages.
  payloadFor(name) {
    const fresh = this.state.transcript.slice(this.state.cursors[name]).filter((e) => e.from !== name && e.knownBy !== name && e.kind !== 'error');
    const text = fresh.map((e) => {
      const files = (e.attachments || []).map((a) => a.name);
      return `${label(e, this.human)}\n${e.text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${e.ide ? `\n(IDE context from ${this.human}'s editor)\n${e.ide.text}` : ''}`;
    }).join('\n\n');
    return { text, attachments: fresh.flatMap((e) => e.attachments || []) };
  }

  async deliver(name) {
    if (this.halted || !this.agents[name]) return;
    if (this.busy[name]) { this.pending[name] = true; return; }
    const payload = this.payloadFor(name);
    this.state.cursors[name] = this.state.transcript.length;
    if (!payload.text) return;
    if (this.turns[name] >= this.maxTurns) {
      if (!this.turnNoted[name]) { this.turnNoted[name] = true; this.note(`${LABEL[name]} has had its ${this.maxTurns} turns for this message; waiting on ${this.human}.`); }
      return;
    }
    this.turns[name] += 1;
    this.busy[name] = true; this.emit('status', { name, busy: true, since: Date.now() });
    const steps = []; let diff = null; const started = Date.now();
    const onActivity = (a) => { if (a.phase === 'diff') { diff = a.diff; return; } if (a.step) steps.push(a.label); this.emit('activity', { name, ...a }); };
    try {
      const reply = await this.agents[name].send(payload.text, (partial) => this.emit('draft', { name, text: partial }), onActivity, payload.attachments);
      const model = this.labelFor ? this.labelFor(name) : null;
      const entry = this._append(name, reply || '(no reply)', { took: Date.now() - started, ...(model ? { model } : {}), ...(steps.length ? { steps } : {}), ...(diff ? { diff } : {}) });
      this._relay(name, entry.text);
    } catch (e) {
      this._append('system', `${LABEL[name]} failed: ${e.message}`, { kind: 'error' });
    } finally {
      this.busy[name] = false; this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      if (this.pending[name]) { this.pending[name] = false; this.deliver(name); }
    }
  }

  _relay(from, text) {
    for (const to of handoffs(text, from)) {
      if (this.halted) return;
      if (this.hopsLeft <= 0) {
        if (!this.capNoted) { this.capNoted = true; this.note(`Hop cap (${this.hopCap}) reached. ${LABEL[from]} asked for ${LABEL[to]}; waiting on ${this.human}.`); }
        continue;
      }
      this.hopsLeft -= 1;
      this.deliver(to);
    }
  }

  stopAll() {
    this.halted = true; this.pending = { claude: false, codex: false };
    for (const n of AGENTS) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this.note(`Stopped by ${this.human}.`);
  }
}

module.exports = { Room, mentions, handoffs, label, AGENTS, LABEL };
