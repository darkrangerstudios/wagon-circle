'use strict';
// The one host timer. Sources register a check; the scheduler runs whichever are due, never overlapping a
// source with itself, and sleeps until the next due time. Checks are local work (reading status, comparing
// cursors); a quiet check never starts a model. Adaptive polls back off per the policy below.
//
// Adaptive policy (DESIGN.md "Built-in polling"): 10 minutes; after two consecutive successful quiet scheduled
// checks, hourly; fresh substantive evidence restores 10 minutes. Errors, manual checks, deferred (busy) checks
// and duplicates do not count as quiet. Agent adjustments go through update(), inside the user's bounds.

const MIN = 60e3;
const DEFAULT_POLICY = { mode: 'adaptive', fastMs: 10 * MIN, slowMs: 60 * MIN, quietToSlow: 2, minMs: 5 * MIN, maxMs: 120 * MIN, agentAdjust: true };

class Scheduler {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, log });
    this.sources = new Map(); this.timer = null;
  }

  // check(): Promise<'quiet' | 'substantive' | 'error' | 'deferred' | 'duplicate'>. Fixed sources give everyMs;
  // polls give a policy (and may be restored from a saved record).
  add(id, { check, everyMs = null, policy = null, record = null }) {
    const p = policy ? { ...DEFAULT_POLICY, ...policy } : null;
    const r = record || { id, revision: 1, intervalMs: p ? p.fastMs : everyMs, quiet: 0, errors: 0, lastOk: null, dueAt: this.now() + (p ? p.fastMs : everyMs), paused: false, changedBy: 'default', reason: null };
    // After sleep or reload, at most one overdue catch-up: never replay every missed tick.
    if (r.dueAt < this.now()) r.dueAt = this.now();
    this.sources.set(id, { id, check, policy: p, everyMs, record: r, running: false });
    this._arm();
    return r;
  }

  remove(id) { this.sources.delete(id); this._arm(); }
  get(id) { const s = this.sources.get(id); return s ? s.record : null; }

  _arm() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    let next = Infinity;
    for (const s of this.sources.values()) if (!s.record.paused && !s.running) next = Math.min(next, s.record.dueAt);
    if (next === Infinity) return;
    this.timer = this.setTimer(() => { this.timer = null; this.runDue(); }, Math.max(0, next - this.now()));
  }

  async runDue() {
    const due = [...this.sources.values()].filter((s) => !s.record.paused && !s.running && s.record.dueAt <= this.now());
    await Promise.all(due.map((s) => this._run(s, false)));
    this._arm();
  }

  // manual: a user-triggered check. It never advances the quiet counter.
  async runNow(id) { const s = this.sources.get(id); if (s && !s.running) await this._run(s, true); this._arm(); }

  async _run(s, manual) {
    s.running = true;
    let outcome; try { outcome = await s.check(); } catch (e) { this.log(`check ${s.id}: ${e.message}`); outcome = 'error'; }
    s.running = false;
    if (!this.sources.has(s.id)) return outcome; // removed while running (Stop): a late result changes nothing
    const r = s.record, p = s.policy;
    if (outcome !== 'error') { r.lastOk = this.now(); r.errors = 0; }
    if (!p) { r.dueAt = this.now() + r.intervalMs; return outcome; }
    if (outcome === 'substantive') { r.quiet = 0; if (r.changedBy === 'default') r.intervalMs = p.fastMs; }
    else if (outcome === 'quiet' && !manual) { r.quiet += 1; if (r.changedBy === 'default' && p.mode === 'adaptive' && r.quiet >= p.quietToSlow) r.intervalMs = p.slowMs; }
    else if (outcome === 'error') r.errors += 1; // shown as stale; not quiet, and the provider's own backoff is separate
    const wait = outcome === 'error' ? Math.min(p.maxMs, r.intervalMs * 2 ** Math.min(r.errors, 4)) : r.intervalMs;
    r.dueAt = this.now() + wait;
    return outcome;
  }

  // update_polling: a change within the user's bounds, against the revision the caller saw.
  update(id, { expectedRevision, intervalMinutes = null, pause = null, actor, reason = '' }) {
    const s = this.sources.get(id);
    if (!s || !s.policy) return { ok: false, text: 'No such poll.' };
    const r = s.record, p = s.policy;
    if (expectedRevision !== r.revision) return { ok: false, text: `Stale: the poll is at revision ${r.revision}.`, record: { ...r } };
    if (actor !== 'human' && !p.agentAdjust) return { ok: false, text: 'Agent adjustments are turned off for this poll.' };
    if (actor !== 'human' && pause === false && r.paused && r.changedBy === 'human') return { ok: false, text: 'Only the human can resume a poll they paused.' };
    if (intervalMinutes != null) {
      const ms = intervalMinutes * MIN;
      if (!(ms >= p.minMs && ms <= p.maxMs)) return { ok: false, text: `Out of bounds: ${p.minMs / MIN}-${p.maxMs / MIN} minutes.` };
      r.intervalMs = ms; r.dueAt = (r.lastOk || this.now()) + ms;
      if (r.dueAt < this.now()) r.dueAt = this.now();
    }
    if (pause != null) r.paused = !!pause;
    r.revision += 1; r.changedBy = actor; r.reason = String(reason).slice(0, 200);
    this._arm();
    return { ok: true, text: `Poll ${id} revision ${r.revision}: every ${r.intervalMs / MIN} min${r.paused ? ', paused' : ''}; next ${new Date(r.dueAt).toISOString()}.`, record: { ...r } };
  }

  dispose() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.sources.clear(); }
}

module.exports = { Scheduler, DEFAULT_POLICY };
