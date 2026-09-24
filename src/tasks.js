'use strict';
// Task ledger: host-owned records for sustained work. Pure logic, clock injected, no I/O.
// Agents act only through typed tools (request_assistance, finish_task); the host stamps who, which task and
// which generation, and decides admission. A model's words never change these records.

const PURPOSES = ['review', 'investigate', 'test', 'challenge'];
const PRESETS = {
  economy: { turns: 8, reserve: 1, minutes: 10 },
  balanced: { turns: 20, reserve: 2, minutes: 30 },
  thorough: { turns: 40, reserve: 3, minutes: 90 }
};
const DEFAULT_LIMITS = PRESETS.balanced;
const TERMINAL = new Set(['stopped', 'completed']);
const OPEN = new Set(['open', 'delivered']);
const NAME = (a) => a[0].toUpperCase() + a.slice(1);
const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

class TaskLedger {
  // agents: participant ids that may send and receive requests. mode: 'auto' | 'chat' | 'work'.
  constructor({ now = Date.now, agents, mode = 'auto', state = null, defaults = null }) {
    this.now = now; this.agents = agents;
    this.state = state || { mode, seq: { task: 0, req: 0 }, tasks: [], chat: { requests: [], runs: [] } };
    if (defaults) this.state.defaults = { ...defaults };
  }

  get tasks() { return this.state.tasks; }
  get mode() { return this.state.mode; }
  set mode(m) { this.state.mode = m; }
  get defaults() { return this.state.defaults || DEFAULT_LIMITS; }
  get(id) { return this.tasks.find((t) => t.id === id) || null; }
  active() { for (let i = this.tasks.length - 1; i >= 0; i--) if (!TERMINAL.has(this.tasks[i].status)) return this.tasks[i]; return null; }
  _requests() { return this.tasks.flatMap((t) => t.requests).concat(this.state.chat.requests); }
  _log(t, actor, text) { t.log.push({ at: this.now(), actor, text }); if (t.log.length > 200) t.log.splice(0, t.log.length - 200); }

  usedMs(t) { return t.used.activeMs + (t.used.since != null ? this.now() - t.used.since : 0); }
  _halt(t, status) { t.used.activeMs = this.usedMs(t); t.used.since = null; t.status = status; }

  start({ objective, originId, lead }) {
    const t = { id: `t${++this.state.seq.task}`, objective: clip(objective, 200), originId, lead, status: 'active', generation: 1,
      created: this.now(), limits: { ...this.defaults }, used: { turns: 0, activeMs: 0, since: this.now() }, requests: [], summary: null, log: [] };
    this.tasks.push(t); this._log(t, lead, `started: ${t.objective}`);
    return t;
  }

  // The time allowance: true when it just ran out.
  checkTime() {
    const t = this.active();
    if (!t || t.status !== 'active' || !t.limits.minutes || this.usedMs(t) < t.limits.minutes * 60e3) return false;
    this._halt(t, 'exhausted'); this._log(t, 'host', 'time allowance used');
    return true;
  }

  // May an agent start a turn for the active task? Accepted requests already hold their answer turn (see
  // requestAssistance), and taking answers back may use the reserve, so only a used-up allowance refuses.
  admitTurn(agent) {
    const t = this.active(); if (!t) return { ok: true };
    this.checkTime();
    if (t.status === 'paused') return { ok: false, reason: 'the task is paused' };
    if (t.status === 'exhausted') return { ok: false, reason: 'the task allowance is used up' };
    const left = t.limits.turns - t.used.turns;
    if (left <= 0) { this._halt(t, 'exhausted'); this._log(t, 'host', 'turn allowance used'); return { ok: false, reason: 'the turn allowance is used up' }; }
    return { ok: true, task: t };
  }

  recordTurn(agent) { const t = this.active(); if (t) t.used.turns += 1; return t; }

  // The request_assistance tool. ctx: { originId, objective, run } from the host; { taskId, generation } pin a
  // tool call to the task and generation its turn belonged to, so a call landing after Stop is refused.
  requestAssistance(from, args, ctx) {
    const a = args || {}, deny = (text) => ({ ok: false, text });
    const to = String(a.to || '').toLowerCase().trim(), question = String(a.question || '').trim();
    if (to === from) return deny('Not sent: you cannot ask yourself.');
    if (!this.agents.includes(to)) return deny(`Not sent: "${clip(a.to, 30)}" is not in this room. Ask one of: ${this.agents.filter((x) => x !== from).join(', ')}.`);
    if (!PURPOSES.includes(a.purpose)) return deny(`Not sent: purpose must be one of ${PURPOSES.join(', ')}.`);
    if (!question) return deny('Not sent: the question is empty.');
    if (ctx.taskId) { const pinned = this.get(ctx.taskId); if (!pinned || TERMINAL.has(pinned.status) || pinned.generation !== ctx.generation) return deny(`Not sent: task ${ctx.taskId} was ${pinned ? pinned.status : 'removed'}.`); }
    // No bouncing: while answering a request from X, a new request to X is refused. The reply already goes back
    // to X, so a clarifying question belongs in it. (Live run 2026-09-24: Codex forwarded r1 straight back.)
    const owed = this._requests().filter((r) => r.status === 'delivered' && r.to === from && r.from === to);
    if (owed.length) return deny(`Not sent: you are answering ${owed.map((r) => r.id).join(', ')} from ${NAME(to)}. Do the work yourself and put your answer, and any question for ${NAME(to)}, in your reply; it goes back automatically.`);
    const fields = { from, to, purpose: a.purpose, question: clip(question, 4000), scope: a.scope ? clip(a.scope, 1000) : null, expected: a.expected ? clip(a.expected, 1000) : null };

    if (this.mode === 'chat') {
      if (this.state.chat.runs.includes(ctx.run)) return deny('Not sent: Chat mode allows one consultation per message. Switch to Auto or Work for a longer task.');
      this.state.chat.runs = this.state.chat.runs.slice(-20).concat(ctx.run);
      const r = { id: `r${++this.state.seq.req}`, task: null, generation: 0, ...fields, status: 'open', created: this.now() };
      this.state.chat.requests.push(r); if (this.state.chat.requests.length > 50) this.state.chat.requests.shift();
      return { ok: true, request: r, text: this._accepted(r) };
    }

    const t = this.active() || this.start({ objective: ctx.objective, originId: ctx.originId, lead: from });
    this.checkTime();
    if (t.status === 'paused') return deny(`Not sent: task ${t.id} is paused by the human.`);
    if (t.status === 'exhausted') return { ...deny(`Not sent: task ${t.id} has used its allowance. Wrap up with what you have.`), budget: true };
    const dup = t.requests.find((r) => OPEN.has(r.status) && r.from === from && r.to === to && r.question === fields.question);
    if (dup) return deny(`Not sent: the same request is already open as ${dup.id}.`);
    const committed = t.requests.filter((r) => OPEN.has(r.status)).length; // each open request still needs its answer turn
    if (t.limits.turns - t.used.turns - committed <= t.limits.reserve) return { ...deny(`Not sent: the remaining turns of task ${t.id} are reserved for wrapping up.`), budget: true };
    const r = { id: `r${++this.state.seq.req}`, task: t.id, generation: t.generation, ...fields, status: 'open', created: this.now() };
    t.requests.push(r); this._log(t, from, `${r.id} to ${to} (${r.purpose}): ${clip(question, 80)}`);
    return { ok: true, request: r, text: this._accepted(r) };
  }

  _accepted(r) {
    return `accepted ${r.id}${r.task ? ` (task ${r.task})` : ''}: ${NAME(r.to)} will get it. Its answer comes back to you automatically; no need to mention it. Continue with anything that does not depend on the answer, then end your turn.`;
  }

  // Requests handed to their recipient in one delivery.
  markDelivered(ids, to) { for (const r of this._requests()) if (ids.includes(r.id) && r.to === to && r.status === 'open') { r.status = 'delivered'; r.deliveredAt = this.now(); } }
  openFor(to) { return this._requests().filter((r) => r.to === to && r.status === 'open'); }

  // The recipient's reply answers every request it was handed. Returns where each answer goes back.
  resolveDelivered(agent, answerId) {
    const back = [];
    for (const r of this._requests()) {
      if (r.to !== agent || r.status !== 'delivered') continue;
      r.status = 'answered'; r.answerId = answerId; r.answeredAt = this.now();
      const t = r.task && this.get(r.task); if (t) this._log(t, agent, `answered ${r.id}`);
      back.push({ request: r.id, to: r.from });
    }
    return back;
  }

  // A delivery failed: requests go back to open so the next delivery carries them.
  reopen(agent) { for (const r of this._requests()) if (r.to === agent && r.status === 'delivered') r.status = 'open'; }

  // finish_task: a completion proposal from the lead, accepted only once every request is reconciled.
  finish(from, summary) {
    const t = this.active();
    if (!t) return { ok: false, text: 'No task is active.' };
    if (from !== t.lead) return { ok: false, text: `Only the lead (${NAME(t.lead)}) can finish task ${t.id}.` };
    const open = t.requests.filter((r) => OPEN.has(r.status));
    if (open.length) return { ok: false, text: `Not finished: ${open.map((r) => r.id).join(', ')} ${open.length > 1 ? 'are' : 'is'} still open.` };
    this._halt(t, 'completed'); t.summary = clip(summary, 2000); this._log(t, from, 'finished');
    return { ok: true, text: `Task ${t.id} marked complete.` };
  }

  // A human message during a task: logged as a visible revision; the objective itself never changes.
  noteHuman(text) { const t = this.active(); if (!t) return null; t.revision = (t.revision || 0) + 1; this._log(t, 'human', `rev ${t.revision}: ${clip(text, 100)}`); return t; }

  pause(by) { const t = this.active(); if (!t || t.status !== 'active') return false; this._halt(t, 'paused'); t.pausedBy = by; this._log(t, by, 'paused'); return true; }

  // Only the human resumes; an agent cannot restart paused or exhausted work.
  resume(by) {
    const t = this.active();
    if (by !== 'human' || !t || !['paused', 'exhausted'].includes(t.status)) return false;
    t.status = 'active'; t.used.since = this.now(); t.pausedBy = null; this._log(t, by, 'resumed');
    return true;
  }

  // Stop: the task and everything open under it end. A new generation makes every in-flight call stale.
  stop() {
    for (const r of this.state.chat.requests) if (OPEN.has(r.status)) r.status = 'cancelled';
    const t = this.active(); if (!t) return null;
    this._halt(t, 'stopped'); t.generation += 1;
    for (const r of t.requests) if (OPEN.has(r.status)) r.status = 'cancelled';
    this._log(t, 'human', 'stopped');
    return t;
  }

  // Raising adds capacity (used stays); lowering to what is used stops new dispatch at the next check.
  setLimits(limits) {
    const t = this.active(); if (!t) return null;
    for (const k of ['turns', 'reserve', 'minutes']) if (Number.isFinite(limits[k]) && limits[k] >= 0) t.limits[k] = Math.round(limits[k]);
    this._log(t, 'human', `limits: ${t.limits.turns} turns (${t.limits.reserve} reserved), ${t.limits.minutes} min`);
    return t;
  }

  setDefaults(limits) { this.state.defaults = { ...this.defaults, ...limits }; }

  // What the task card shows.
  summary(t = this.active()) {
    if (!t) return null;
    return { id: t.id, objective: t.objective, lead: t.lead, status: t.status, limits: t.limits, turns: t.used.turns, usedMs: this.usedMs(t),
      open: t.requests.filter((r) => OPEN.has(r.status)).map((r) => ({ id: r.id, from: r.from, to: r.to, purpose: r.purpose, question: clip(r.question, 120), status: r.status })),
      answered: t.requests.filter((r) => r.status === 'answered').length, summary: t.summary, log: t.log.slice(-8) };
  }
}

// The typed tools each agent gets. `peers`: the other participants it may ask.
function toolSpecs(peers) {
  return [
    { name: 'request_assistance',
      description: 'Ask another agent in this Wagon Circle room for help with the current work: a review, an investigation, a test or a challenge to a conclusion. The host records it under a task, delivers it once and returns the answer to you automatically in a later turn. Use it only when you genuinely need the other agent; never to acknowledge or thank.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['to', 'purpose', 'question'], properties: {
        to: { type: 'string', enum: peers, description: 'Which agent to ask.' },
        purpose: { type: 'string', enum: PURPOSES },
        question: { type: 'string', description: 'The specific question, with the context the other agent needs.' },
        scope: { type: 'string', description: 'Optional: files, revisions or artifacts to look at.' },
        expected: { type: 'string', description: 'Optional: what a useful answer looks like (e.g. a reproduction, or a reason it cannot happen).' } } } },
    { name: 'finish_task',
      description: 'Propose that the current task is complete (lead only). Accepted only when no request is still open. Give a short summary of the outcome.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } } }
  ];
}

module.exports = { TaskLedger, PRESETS, PURPOSES, DEFAULT_LIMITS, toolSpecs };
