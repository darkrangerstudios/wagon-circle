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

// An agent's explicit hand-off: a line that STARTS with @claude or @codex, naming the OTHER agent.
// A mention anywhere else is conversation ("I agree with @codex"), not a request; so are mentions inside
// code fences, blockquotes or quotes (talking ABOUT a mention caused the 2026-09-23 runaway).
// Agents cannot use @both / @all. Interim protocol until typed assistance requests replace text routing.
function handoffs(text, from) {
  const found = new Set();
  const prose = String(text).replace(/^[ \t]*(```|~~~)[\s\S]*?(^[ \t]*\1|(?![\s\S]))/gm, ' ');
  for (const m of prose.matchAll(/^[ \t]*@(claude|codex)\b/gim)) found.add(m[1].toLowerCase());
  return [...found].filter((n) => n !== from);
}

const knows = (e, name) => (Array.isArray(e.knownBy) ? e.knownBy.includes(name) : e.knownBy === name);
const markKnown = (e, name) => { if (!knows(e, name)) e.knownBy = [].concat(e.knownBy || [], name); };
const unmarkKnown = (e, name) => { e.knownBy = [].concat(e.knownBy || []).filter((n) => n !== name); };

function label(entry, human) {
  if (entry.kind === 'history') return `[${entry.from === 'human' ? 'User' : LABEL[entry.from]} — earlier in the forked ${entry.source || 'Codex'} conversation]`;
  if (entry.from === 'human' && entry.kind === 'steer') return `[${human}, to ${entry.steer.map((n) => LABEL[n]).join(' and ')} mid-turn]`;
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
  // Delivery: an entry counts as seen by an agent only once it was actually handed to that agent
  // (knownBy). The cursor is just the point before which everything is seen, so nothing is skipped when a
  // delivery is capped, rejected or a steer isn't accepted.
  // Runs: each human message starts a run (a number). Stop cancels every run so far; work belonging to a
  // cancelled run (a queued delivery, the rest of an @both sequence, a hand-off) never starts again.
  constructor({ agents, hopCap = 2, state = null, humanName = 'You', defaultTarget = 'claude', bothMode = 'sequential', labelFor = null, maxTurns = 2 }) {
    super();
    this.agents = agents; this.hopCap = hopCap; this.human = humanName;
    this.defaultTarget = defaultTarget; this.bothMode = bothMode; this.labelFor = labelFor;
    this.maxTurns = maxTurns; this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
    this.state = state || { transcript: [], cursors: { claude: 0, codex: 0 }, lastTargets: [...AGENTS], seq: 0 };
    this.busy = { claude: false, codex: false }; this.pending = { claude: 0, codex: 0 };
    this.hopsLeft = hopCap; this.capNoted = false; this.run = 0; this.cancelledThrough = 0;
  }

  _live(run) { return run > this.cancelledThrough; }

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
    const run = ++this.run;
    this.hopsLeft = this.hopCap; this.capNoted = false;
    this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
    this._append('human', text, { ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    if (targets.length > 1 && this.bothMode === 'sequential') this._inTurn(targets, run);
    else for (const t of targets) this.deliver(t, run);
    return targets;
  }

  // Steer: send a message INTO a running turn. Goes to the busy agents it @mentions, or to every busy agent
  // if it mentions none. If it only mentions idle agents (or nobody is busy), it is an ordinary message.
  steerFromHuman(text, attachments = [], ide = null) {
    const busyNow = AGENTS.filter((a) => this.busy[a] && this.agents[a] && this.agents[a].steer);
    const named = mentions(text);
    const targets = named.length ? named.filter((a) => busyNow.includes(a)) : busyNow;
    if (!targets.length) return { steered: [], targets: this.postFromHuman(text, attachments, ide) };
    // Marked seen by a target up front so its current turn's catch-up doesn't repeat it; unmarked if the
    // agent doesn't accept the steer, and then it reaches that agent as a normal message after the turn.
    const entry = this._append('human', text, { kind: 'steer', steer: targets, knownBy: [...targets], ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    const files = attachments.map((a) => a.name);
    const body = `[${this.human}, steering you mid-turn: follow this now]\n${text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${ide ? `\n(IDE context from ${this.human}'s editor)\n${ide.text}` : ''}`;
    const run = this.run;
    for (const t of targets) {
      let sent; try { sent = Promise.resolve(this.agents[t].steer(body, attachments)); } catch (e) { sent = Promise.reject(e); }
      sent.then((ok) => (ok === false ? 'not accepted' : null), (e) => e.message)
        .then((failed) => {
          if (!failed) return;
          unmarkKnown(entry, t);
          const at = this.state.transcript.indexOf(entry);
          if (at >= 0) this.state.cursors[t] = Math.min(this.state.cursors[t], at);
          this.note(`Couldn't steer ${LABEL[t]} mid-turn (${failed}); it gets your message when its turn ends.`);
          if (this._live(run)) this.deliver(t, run);
        });
    }
    return { steered: targets };
  }

  // One after another: each agent's delivery includes the previous agent's answer.
  async _inTurn(targets, run) {
    for (const t of targets) { if (!this._live(run)) return; await this.deliver(t, run); }
  }

  _fresh(name) {
    return this.state.transcript.slice(this.state.cursors[name]).filter((e) => e.from !== name && !knows(e, name) && e.kind !== 'error');
  }

  // Move the cursor past everything this agent has seen, its own words and errors.
  _advance(name) {
    const tr = this.state.transcript; let c = this.state.cursors[name];
    while (c < tr.length && (tr[c].from === name || knows(tr[c], name) || tr[c].kind === 'error')) c++;
    this.state.cursors[name] = c;
  }

  // Everything this agent missed: labelled text plus the files attached to those messages.
  payloadFor(name, fresh = this._fresh(name)) {
    const text = fresh.map((e) => {
      const files = (e.attachments || []).map((a) => a.name);
      return `${label(e, this.human)}\n${e.text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${e.ide ? `\n(IDE context from ${this.human}'s editor)\n${e.ide.text}` : ''}`;
    }).join('\n\n');
    return { text, attachments: fresh.flatMap((e) => e.attachments || []) };
  }

  async deliver(name, run = this.run) {
    if (!this._live(run) || !this.agents[name]) return;
    if (this.busy[name]) { this.pending[name] = Math.max(this.pending[name], run); return; }
    const fresh = this._fresh(name);
    if (!fresh.length) { this._advance(name); return; }
    if (this.turns[name] >= this.maxTurns) {
      // Not delivered, so not marked seen: the next delivery to this agent still carries it.
      if (!this.turnNoted[name]) { this.turnNoted[name] = true; this.note(`${LABEL[name]} has had its ${this.maxTurns} turns for this message; waiting on ${this.human}.`); }
      return;
    }
    const payload = this.payloadFor(name, fresh);
    for (const e of fresh) markKnown(e, name);
    this._advance(name);
    this.turns[name] += 1;
    this.busy[name] = true; this.emit('status', { name, busy: true, since: Date.now() });
    const steps = []; let diff = null; const started = Date.now();
    const onActivity = (a) => { if (a.phase === 'diff') { diff = a.diff; return; } if (a.step) steps.push(a.label); this.emit('activity', { name, ...a }); };
    try {
      const reply = await this.agents[name].send(payload.text, (partial) => this.emit('draft', { name, text: partial }), onActivity, payload.attachments);
      const model = this.labelFor ? this.labelFor(name) : null;
      const entry = this._append(name, reply || '(no reply)', { took: Date.now() - started, ...(model ? { model } : {}), ...(steps.length ? { steps } : {}), ...(diff ? { diff } : {}) });
      if (this._live(run)) this._relay(name, entry.text, run); // a reply that lands after Stop is shown, never acted on
    } catch (e) {
      if (e.stopped) this.note(`${LABEL[name]} stopped.`);
      else {
        // The agent may never have received it: make it deliverable again (a repeat beats a silent loss).
        for (const x of fresh) unmarkKnown(x, name);
        const at = this.state.transcript.indexOf(fresh[0]);
        if (at >= 0) this.state.cursors[name] = Math.min(this.state.cursors[name], at);
        this._append('system', `${LABEL[name]} failed: ${e.message}`, { kind: 'error' });
      }
    } finally {
      this.busy[name] = false; this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      const next = this.pending[name]; this.pending[name] = 0;
      if (next && this._live(next)) this.deliver(name, next);
    }
  }

  _relay(from, text, run) {
    for (const to of handoffs(text, from)) {
      if (!this._live(run)) return;
      if (this.hopsLeft <= 0) {
        if (!this.capNoted) { this.capNoted = true; this.note(`Hop cap (${this.hopCap}) reached. ${LABEL[from]} asked for ${LABEL[to]}; waiting on ${this.human}.`); }
        continue;
      }
      this.hopsLeft -= 1;
      this.deliver(to, run);
    }
  }

  stopAll() {
    this.cancelledThrough = this.run; this.pending = { claude: 0, codex: 0 };
    for (const n of AGENTS) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this.note(`Stopped by ${this.human}.`);
  }
}

module.exports = { Room, mentions, handoffs, label, AGENTS, LABEL };
