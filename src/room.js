'use strict';
// Room router: who hears what, when. Pure logic over agents that expose send(text, onDelta) -> Promise<string>.
const { EventEmitter } = require('events');
const { TaskLedger } = require('./tasks');

const AGENTS = ['claude', 'codex'];
const LABEL = { claude: 'Claude', codex: 'Codex', system: 'Wagon Wheel' };

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

// Agent-facing label. `to` is the agent receiving the payload (requests and answers read differently to their parties).
function label(entry, human, to) {
  if (entry.kind === 'request') {
    const who = entry.to === to ? 'you' : LABEL[entry.to];
    return `[Request ${entry.request} from ${LABEL[entry.from]} to ${who} (${entry.purpose})${entry.task ? `, task ${entry.task}` : ''}: relayed by Wagon Wheel, not ${human}.${entry.to === to ? ` Your reply goes back to ${LABEL[entry.from]} automatically.` : ''}]`;
  }
  const mine = (entry.answers || []).filter((a) => a.to === to).map((a) => a.request);
  if (mine.length) return `[${LABEL[entry.from]} — answer to your request ${mine.join(', ')}, relayed by Wagon Wheel, not ${human}]`;
  if (entry.kind === 'history') return `[${entry.from === 'human' ? 'User' : LABEL[entry.from]} — earlier in the forked ${entry.source || 'Codex'} conversation]`;
  if (entry.from === 'human' && entry.kind === 'steer') return `[${human}, to ${entry.steer.map((n) => LABEL[n]).join(' and ')} mid-turn]`;
  if (entry.from === 'human') return `[${human}]`;
  if (entry.from === 'system') return '[Wagon Wheel notice]';
  return `[${LABEL[entry.from]} — relayed by Wagon Wheel, not ${human}]`;
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
  // Typed agents (agent.typed) ask each other through the request_assistance tool, under a host-owned task
  // (tasks.js). Prose is never a control channel: an untyped agent's line-start @name becomes a displayed
  // suggestion the human can send (DESIGN.md "Structured assistance"). proseHandoffs: true restores the
  // pre-v0.5 automatic routing; the extension never sets it (kept for the legacy router tests).
  // readHistory(requester, args): shared session history (extension glue over sessionHistory.js); optional.
  constructor({ agents, hopCap = 2, state = null, humanName = 'You', defaultTarget = 'claude', bothMode = 'sequential', labelFor = null, maxTurns = 2, now = Date.now, proseHandoffs = false, readHistory = null }) {
    super();
    this.agents = agents; this.hopCap = hopCap; this.human = humanName;
    this.defaultTarget = defaultTarget; this.bothMode = bothMode; this.labelFor = labelFor;
    this.maxTurns = maxTurns; this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
    this.state = state || { transcript: [], cursors: { claude: 0, codex: 0 }, lastTargets: [...AGENTS], seq: 0 };
    this.busy = { claude: false, codex: false }; this.pending = { claude: 0, codex: 0 };
    this.hopsLeft = hopCap; this.capNoted = false; this.proseHandoffs = proseHandoffs; this.readHistory = readHistory;
    // Saved with the room so a reload can tell cut-off work from work the human stopped.
    this.run = this.state.run || 0; this.cancelledThrough = this.state.cancelledThrough || 0;
    this.tasks = new TaskLedger({ now, agents: AGENTS, state: this.state.tasks });
    this.state.tasks = this.tasks.state; // saved with the room; rooms from before tasks start empty
    this.held = new Set(); this.heldNoted = null; this.lastHuman = null;
    this._reconcile();
  }

  // After a reload no turn is running, so a request marked delivered was cut off with its turn: reopen it, make its
  // entry deliverable again and hold the recipient until the human continues. Nothing starts on its own.
  // After a reload no turn is running. Every delivery that was in flight (a request to answer, an answer to take
  // back, the human's own message) was cut off with its turn: make its input deliverable again and hold the agent.
  // Work the human had stopped stays stopped. The task shows as paused, so Resume is the visible way on; nothing
  // starts on its own and consumed allowances stay consumed.
  _reconcile() {
    const inflight = this.state.inflight || {}; this.state.inflight = {};
    for (const [name, f] of Object.entries(inflight)) {
      if (!this.agents[name] || !f || !(f.run > this.cancelledThrough)) continue;
      const entries = this.state.transcript.filter((e) => f.ids.includes(e.id));
      if (entries.length) this._undeliver(name, entries, f.turnStart); else this.tasks.reopen(name);
      this.held.add(name);
    }
    // Rooms saved before in-flight records: a request still marked delivered was cut off the same way.
    for (const r of this.tasks._requests().filter((x) => x.status === 'delivered')) {
      const e = this.state.transcript.find((x) => x.kind === 'request' && x.request === r.id);
      if (e) this._undeliver(r.to, [e], this.state.transcript.length); else r.status = 'open';
      this.held.add(r.to);
    }
    if (!this.held.size) return;
    this.run = this.state.run = Math.max(this.run, this.cancelledThrough + 1); // recovered work gets a live run of its own
    const t = this.tasks.active(); if (t && t.status === 'active') this.tasks.pause('reload');
    const who = [...this.held].map((n) => LABEL[n]).join(' and ');
    this.note(`Reopened: ${who}'s last turn was cut off before it finished. ${t ? 'The task is paused; Resume to continue' : 'Message the agent to continue'}. Nothing restarts on its own.`);
  }

  _taskChanged() { this.emit('task', this.tasks.summary()); this.emit('changed', this.state); }

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
    const run = this.state.run = ++this.run;
    this.hopsLeft = this.hopCap; this.capNoted = false;
    this.turns = { claude: 0, codex: 0 }; this.turnNoted = {};
    const entry = this._append('human', text, { to: targets, ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    this.lastHuman = { id: entry.id, text };
    if (this.tasks.noteHuman(text)) this._taskChanged();
    if (this.tasks.mode === 'work' && !this.tasks.active()) { this.tasks.start({ objective: text, originId: entry.id, lead: targets[0], run }); this._taskChanged(); }
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
      return `${label(e, this.human, name)}\n${e.text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${e.ide ? `\n(IDE context from ${this.human}'s editor)\n${e.ide.text}` : ''}`;
    }).join('\n\n');
    return { text, attachments: fresh.flatMap((e) => e.attachments || []) };
  }

  async deliver(name, run = this.run) {
    if (!this._live(run) || !this.agents[name]) return;
    if (this.busy[name]) { this.pending[name] = Math.max(this.pending[name], run); return; }
    const fresh = this._fresh(name);
    if (!fresh.length) { this._advance(name); return; }
    // Task work (a request to answer, or an answer to take back) is bounded by the task's allowance, not the
    // per-message reply cap. The human's own messages always get through and never spend task turns.
    const requests = fresh.filter((e) => e.kind === 'request' && e.to === name && this.tasks.openFor(name).some((r) => r.id === e.request));
    const answers = fresh.filter((e) => (e.answers || []).some((a) => a.to === name));
    const taskTurn = requests.length > 0 || answers.length > 0;
    // Addressed by the human (entries from before v0.5 carry no recipients: treat them as addressed).
    const humanTurn = fresh.some((e) => e.from === 'human' && e.kind !== 'history' && (e.kind === 'steer' ? e.steer : e.to || [name]).includes(name));
    if (taskTurn && !humanTurn) {
      const adm = this.tasks.admitTurn(name);
      if (!adm.ok) { this._hold(name, adm.reason); return; }
    } else if (!taskTurn && this.turns[name] >= this.maxTurns) {
      // Not delivered, so not marked seen: the next delivery to this agent still carries it.
      if (!this.turnNoted[name]) { this.turnNoted[name] = true; this.note(`${LABEL[name]} has had its ${this.maxTurns} turns for this message; waiting on ${this.human}.`); }
      return;
    }
    this.held.delete(name);
    const payload = this.payloadFor(name, fresh);
    for (const e of fresh) markKnown(e, name);
    this._advance(name);
    if (taskTurn && !humanTurn) this.tasks.recordTurn(name); else this.turns[name] += 1;
    if (requests.length) this.tasks.markDelivered(requests.map((e) => e.request), name);
    // Saved with the room until the turn ends, so a reload mid-turn can recover exactly this delivery.
    (this.state.inflight || (this.state.inflight = {}))[name] = { ids: fresh.map((e) => e.id), run, turnStart: this.state.transcript.length };
    // The room is saved on 'changed': emit it now, for every turn, so the in-flight record is on disk before the
    // provider call starts (a crash mid-turn must find it).
    if (taskTurn) this._taskChanged(); else this.emit('changed', this.state);
    const t = this.tasks.active(); const ctx = { run, taskId: t ? t.id : null, generation: t ? t.generation : 0 };
    this.busy[name] = true; this.emit('status', { name, busy: true, since: Date.now() });
    const steps = []; let diff = null; const started = Date.now(); const turnStart = this.state.transcript.length;
    const onActivity = (a) => { if (a.phase === 'diff') { diff = a.diff; return; } if (a.step) steps.push(a.label); this.emit('activity', { name, ...a }); };
    const onTool = (tool, args) => this._onTool(name, tool, args, ctx);
    try {
      const reply = await this.agents[name].send(payload.text, (partial) => this.emit('draft', { name, text: partial }), onActivity, payload.attachments, onTool);
      const model = this.labelFor ? this.labelFor(name) : null;
      // This reply answers the requests it was handed; the entry id is the next seq.
      const back = this._live(run) ? this.tasks.resolveDelivered(name, this.state.seq + 1) : [];
      const entry = this._append(name, reply || '(no reply)', { took: Date.now() - started, ...(model ? { model } : {}), ...(steps.length ? { steps } : {}), ...(diff ? { diff } : {}), ...(back.length ? { answers: back } : {}) });
      if (back.length) this._taskChanged();
      if (this._live(run)) { // a reply that lands after Stop is shown, never acted on
        if (!this.agents[name].typed) this._relay(name, entry.text, run);
        for (const to of new Set(back.map((b) => b.to))) this.deliver(to, run);
      }
    } catch (e) {
      if (e.stopped) {
        this.note(`${LABEL[name]} stopped.`);
        // Interrupted by a task limit, not by the human's Stop: the turn's input is undelivered again and waits
        // (held) until the human adds allowance and resumes. A human Stop cancels it for good.
        if (this._live(run)) { this._undeliver(name, fresh, turnStart); this.held.add(name); this._taskChanged(); }
      } else {
        // The agent may never have received it: make it deliverable again (a repeat beats a silent loss).
        this._undeliver(name, fresh, turnStart);
        this._append('system', `${LABEL[name]} failed: ${e.message}`, { kind: 'error' });
      }
    } finally {
      // Tokens this turn spent go to the task it belonged to (or the task it started), whatever its outcome.
      const tt = ctx.taskId ? this.tasks.get(ctx.taskId) : (() => { const a = this.tasks.active(); return a && a.run === run ? a : null; })();
      if (tt) this.tasks.addUsage(tt.id, name, this.agents[name].lastTurnUsage || null);
      // Clear the in-flight record BEFORE the save that ends the turn, so a finished turn is never saved as cut off.
      if (this.state.inflight) delete this.state.inflight[name];
      if (tt) this._taskChanged(); else this.emit('changed', this.state);
      this.busy[name] = false; this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      const next = this.pending[name]; this.pending[name] = 0;
      if (next && this._live(next)) this.deliver(name, next);
    }
  }

  // A turn that did not complete: its input (and steers accepted during it) becomes deliverable again, and the
  // requests it carried go back to open under their original ids.
  _undeliver(name, fresh, turnStart) {
    const steered = this.state.transcript.slice(turnStart).filter((x) => x.kind === 'steer' && x.steer.includes(name));
    for (const x of fresh.concat(steered)) unmarkKnown(x, name);
    const at = this.state.transcript.indexOf(fresh[0]);
    if (at >= 0) this.state.cursors[name] = Math.min(this.state.cursors[name], at);
    this.tasks.reopen(name);
  }

  // Task work that may not start now waits, undelivered, until the human resumes or adds allowance.
  _hold(name, reason) {
    this.held.add(name);
    const t = this.tasks.active(); const key = `${t && t.id}:${reason}`;
    if (this.heldNoted !== key) { this.heldNoted = key; this.note(`Task ${t ? t.id : ''}: ${reason}. ${LABEL[name]}'s pending work waits for ${this.human} (resume, add allowance, or stop).`); }
    this._taskChanged();
  }

  // Typed tool calls from an agent's turn. ctx pins the run, task and generation the turn started under.
  _onTool(name, tool, args, ctx) {
    if (!this._live(ctx.run)) return { ok: false, text: `Not sent: ${this.human} pressed Stop.` };
    if (tool === 'request_assistance') {
      const h = this.lastHuman || { id: null, text: '' };
      const r = this.tasks.requestAssistance(name, args, { originId: h.id, objective: h.text, run: ctx.run, taskId: ctx.taskId, generation: ctx.generation });
      if (r.ok) {
        const q = r.request; const t = q.task && this.tasks.get(q.task);
        const text = [q.question, q.scope && `Scope: ${q.scope}`, q.expected && `Expected answer: ${q.expected}`, t && `Task objective (from ${this.human}): ${t.objective}`].filter(Boolean).join('\n');
        this._append(name, text, { kind: 'request', to: q.to, request: q.id, purpose: q.purpose, ...(q.task ? { task: q.task } : {}) });
        this._taskChanged();
        this.deliver(q.to, ctx.run);
      } else if (r.budget) {
        const t = this.tasks.active(), key = `${t && t.id}:budget`;
        if (this.heldNoted !== key) { this.heldNoted = key; this.note(`Task ${t ? t.id : ''}: ${LABEL[name]} asked ${LABEL[args && args.to] || 'a peer'} for more, but ${r.text.replace(/^Not sent: /, '').replace(/\.$/, '')}. Add turns or time in Task controls to let them continue.`); }
      }
      return r;
    }
    if (tool === 'finish_task') {
      const t = this.tasks.active(); const r = this.tasks.finish(name, args && args.summary, ctx);
      if (r.ok) { this.note(`Task ${t.id} finished by ${LABEL[name]}: ${t.summary || ''}`); this._taskChanged(); }
      return r;
    }
    if (tool === 'read_session_history') {
      if (!this.readHistory) return { ok: false, text: 'Session history sharing is not available in this room.' };
      // Re-checked after the read: a result that lands after Stop (or after the turn's task moved on) is dropped.
      const stale = () => !this._live(ctx.run) || (ctx.taskId && (!this.tasks.get(ctx.taskId) || this.tasks.get(ctx.taskId).generation !== ctx.generation));
      return Promise.resolve(this.readHistory(name, args || {})).catch((e) => ({ ok: false, text: `Not available: ${e.message}` }))
        .then((r) => (stale() ? { ok: false, text: `Not delivered: ${this.human} pressed Stop.` } : r));
    }
    return { ok: false, text: `Unknown tool ${tool}.` };
  }

  pauseTask() { if (this.tasks.pause('human')) { this.note(`Task paused by ${this.human}. Running turns finish; nothing new starts.`); this._taskChanged(); } }

  resumeTask() {
    const resumed = this.tasks.resume('human');
    if (!resumed && !this.held.size) return;
    this.heldNoted = null; if (resumed) this.note(`Task resumed by ${this.human}.`); this._taskChanged();
    const held = [...this.held]; this.held.clear();
    for (const n of held) this.deliver(n, this.run);
  }

  // Adjusting limits never resumes by itself; a raised limit is used when the human resumes.
  setTaskLimits(limits) { if (this.tasks.setLimits(limits)) this._taskChanged(); }

  // The host clock (scheduler.js): a used-up time allowance cancels running task work.
  tick() {
    if (!this.tasks.checkTime()) return;
    this.note(`Task ${this.tasks.active().id} used its time allowance. Running work is stopped; add time to continue, or finish with what we have.`);
    for (const n of AGENTS) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this._taskChanged();
  }

  _relay(from, text, run) {
    if (!this.proseHandoffs) {
      for (const to of handoffs(text, from)) this._append('system', `${LABEL[from]} asked for ${LABEL[to]} in its reply. Only you can pass it on.`, { kind: 'suggestion', suggest: { from, to } });
      return;
    }
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
    this.cancelledThrough = this.state.cancelledThrough = this.run; this.pending = { claude: 0, codex: 0 }; this.held.clear();
    if (this.tasks.stop()) this._taskChanged();
    for (const n of AGENTS) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this.note(`Stopped by ${this.human}.`);
  }
}

module.exports = { Room, mentions, handoffs, label, AGENTS, LABEL };
