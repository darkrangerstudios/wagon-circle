'use strict';
// Private Codex app-server over stdio (newline-delimited JSON-RPC). One process per room; no daemon, no ports.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const { toCodexInput } = require('./attachments');

// Methods the room must never call, whatever a future caller asks for.
const FORBIDDEN = new Set(['account/rateLimitResetCredit/consume', 'account/logout', 'account/login/start', 'thread/delete']);

const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;

// A human-readable activity for a Codex thread item, or null for items that aren't steps.
function describeItem(item) {
  switch (item && item.type) {
    case 'reasoning': return { phase: 'thinking', label: 'thinking' };
    case 'agentMessage': return { phase: 'writing', label: 'writing' };
    case 'commandExecution': return { phase: 'tool', label: `running ${clip(item.command, 50)}`, step: true };
    case 'fileChange': return { phase: 'tool', label: `editing ${(item.changes || []).map((c) => base(c.path)).slice(0, 3).join(', ') || 'files'}`, step: true };
    case 'mcpToolCall': return { phase: 'tool', label: `using ${item.server}.${item.tool}`, step: true };
    case 'dynamicToolCall': return { phase: 'tool', label: `using ${item.tool}`, step: true };
    case 'webSearch': return { phase: 'tool', label: `searching ${clip(item.query || 'the web', 40)}`, step: true };
    case 'imageView': return { phase: 'tool', label: `viewing ${base(item.path)}`, step: true };
    case 'plan': return { phase: 'thinking', label: 'planning' };
    case 'contextCompaction': return { phase: 'thinking', label: 'compacting context' };
    case 'collabAgentToolCall': case 'subAgentActivity': return { phase: 'tool', label: 'working with a sub-agent', step: true };
    default: return null;
  }
}

class CodexClient extends EventEmitter {
  // tools: typed room tools, attached to threads this client STARTS (app-server takes dynamicTools only on
  // thread/start; they persist across thread/resume). Calls go to the running turn's onTool.
  constructor({ exe, cwd, tools = [], log = () => {} }) {
    super();
    this.exe = exe; this.cwd = cwd; this.log = log; this.tools = tools;
    this.nextId = 0; this.pending = new Map(); this.proc = null;
  }

  async start() {
    this.proc = spawn(this.exe, ['app-server'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this._fail(e));
    this.proc.on('exit', (code, sig) => this._fail(new Error(`codex app-server exited (${code ?? sig})`)));
    this.proc.stderr.on('data', (d) => this.log(`codex stderr: ${String(d).slice(0, 400)}`));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));
    await this.request('initialize', { clientInfo: { name: 'wagon-circle', title: 'Wagon Circle', version: '0.5.0' }, ...(this.tools.length ? { capabilities: { experimentalApi: true } } : {}) });
    this._write({ method: 'initialized' });
  }

  _fail(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    if (this.proc) { this.proc = null; this.emit('exit', err); }
  }

  _write(msg) {
    if (!this.proc) throw new Error('codex app-server is not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === 'item/tool/call') { this._onToolCall(m); return; }
    if (m.id !== undefined && m.method) {
      // Server-to-client request (approval, user input). The room never grants anything.
      this.log(`codex asked ${m.method}; declined`);
      this._write({ id: m.id, error: { code: -32601, message: 'Wagon Circle does not grant approvals or input' } });
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error))); else resolve(m.result);
      return;
    }
    if (m.method) this.emit('notification', m.method, m.params || {});
  }

  // A typed room tool, called from inside a turn. Only the running turn on that thread may answer it.
  async _onToolCall(m) {
    const p = m.params || {}; const t = this.currentTurn;
    let r;
    if (!t || !t.onTool || t.threadId !== p.threadId) r = { ok: false, text: 'Not available: no turn is open on this thread.' };
    else {
      try { r = await t.onTool(p.tool, p.arguments || {}); } catch (e) { r = { ok: false, text: `Failed: ${e.message}` }; }
      if (this.currentTurn !== t || t.cancelled) r = { ok: false, text: 'Not delivered: that turn already ended.' }; // Stopped or finished while the tool ran
    }
    try { this._write({ id: m.id, result: { contentItems: [{ type: 'inputText', text: String(r.text || '') }], success: !!r.ok } }); } catch (e) { this.log(`tool reply: ${e.message}`); }
  }

  request(method, params, timeoutMs = 120000) {
    if (FORBIDDEN.has(method)) return Promise.reject(new Error(`${method} is forbidden in Wagon Circle`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this._write({ id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }

  safety(developerInstructions) {
    return { approvalPolicy: 'never', sandbox: 'read-only', cwd: this.cwd, developerInstructions };
  }

  async listThreads(searchTerm, limit = 20) {
    const r = await this.request('thread/list', { limit, searchTerm: searchTerm || null });
    return r.data || [];
  }

  async startThread(developerInstructions) {
    const r = await this.request('thread/start', { ...this.safety(developerInstructions), ephemeral: false, ...(this.tools.length ? { dynamicTools: this.tools.map((t) => ({ type: 'function', ...t })) } : {}) });
    return r.thread;
  }

  async forkThread(threadId, developerInstructions) {
    const r = await this.request('thread/fork', { threadId, excludeTurns: true, ephemeral: false, ...this.safety(developerInstructions) }, 600000);
    return r.thread;
  }

  async resumeThread(threadId) {
    const r = await this.request('thread/resume', { threadId, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' }, 600000);
    return r.thread;
  }

  async setName(threadId, name) {
    try { await this.request('thread/name/set', { threadId, name }); } catch (e) { this.log(`name/set: ${e.message}`); }
  }

  // Recent user/agent messages from a thread, oldest first. Reads local history; no model call.
  async recentMessages(threadId, turns = 8) {
    const r = await this.request('thread/turns/list', { threadId, limit: turns, sortDirection: 'desc', itemsView: 'full' }, 180000);
    const out = [];
    for (const turn of (r.data || []).slice().reverse()) {
      for (const item of turn.items || []) {
        if (item.type === 'userMessage') {
          const text = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          if (text) out.push({ role: 'user', text });
        } else if (item.type === 'agentMessage' && item.text) out.push({ role: 'codex', text: item.text });
      }
    }
    return out;
  }

  async listModels() {
    try { const r = await this.request('model/list', { limit: 50 }, 20000); return (r.data || []).filter((m) => !m.hidden); } catch (e) { this.log(`model/list: ${e.message}`); return []; }
  }

  compact(threadId) { return this.request('thread/compact/start', { threadId }, 600000); }

  async rateLimits() {
    try { return await this.request('account/rateLimits/read', {}, 20000); } catch (e) { this.log(`rateLimits: ${e.message}`); return null; }
  }

  // Run one turn; resolves with the agent's text. onDelta streams partial text.
  runTurn(threadId, text, onDelta = () => {}, onActivity = () => {}, attachments = [], opts = {}) {
    return new Promise((resolve, reject) => {
      let turnId = null; const messages = new Map(); let lastError = null; const thinking = new Map();
      onActivity({ phase: 'waiting', label: 'waiting for the model' });
      const onNote = (method, p) => {
        if (p.threadId && p.threadId !== threadId) return;
        if (turnId && p.turnId && p.turnId !== turnId) return;
        if (method === 'turn/started' && p.turn && (!turnId || p.turn.id === turnId)) {
          turnId = active.turnId = p.turn.id; active.started = true;
          if (active.cancelled) this._interruptTurn(active);
        } else if (method === 'turn/diff/updated' && p.diff) {
          onActivity({ phase: 'diff', diff: p.diff });
        } else if (method === 'item/started') {
          const a = describeItem(p.item); if (a) onActivity(a);
        } else if (method === 'item/reasoning/summaryTextDelta') {
          thinking.set(p.itemId, (thinking.get(p.itemId) || '') + p.delta);
          onActivity({ phase: 'thinking', label: 'thinking', thinking: [...thinking.values()].join('\n\n') });
        } else if (method === 'item/agentMessage/delta') {
          messages.set(p.itemId, (messages.get(p.itemId) || '') + p.delta);
          onDelta([...messages.values()].join('\n\n'));
        } else if (method === 'item/completed' && p.item && p.item.type === 'agentMessage') {
          messages.set(p.item.id, p.item.text || messages.get(p.item.id) || '');
        } else if (method === 'error') {
          lastError = (p.error && p.error.message) || 'Codex error';
        } else if (method === 'turn/completed' && p.turn && (!turnId || p.turn.id === turnId)) {
          cleanup();
          const status = p.turn.status; const reply = [...messages.values()].join('\n\n').trim();
          if (status === 'completed') resolve(reply);
          else if (status === 'interrupted') { const e = new Error('stopped'); e.stopped = true; reject(e); }
          else reject(new Error((p.turn.error && p.turn.error.message) || lastError || `turn ${status}`));
        }
      };
      // The active turn exists from now, so a Stop before the turn is running is remembered. The server answers
      // turn/start with an ID before the turn is live (interrupt then fails: "no active turn"), so a held Stop
      // is sent once turn/started arrives.
      const active = { threadId, turnId: null, started: false, cancelled: false, onTool: opts.onTool || null }; this.currentTurn = active;
      const onExit = (err) => { cleanup(); reject(err); };
      const cleanup = () => { this.off('notification', onNote); this.off('exit', onExit); if (this.currentTurn === active) this.currentTurn = null; };
      this.on('notification', onNote); this.once('exit', onExit);
      this.request('turn/start', { threadId, input: toCodexInput(text, attachments), ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.fast ? { serviceTierForTurn: 'priority' } : {}) })
        .then((r) => { if (!turnId) turnId = active.turnId = r && r.turn && r.turn.id; if (active.cancelled && active.started) this._interruptTurn(active); })
        .catch((e) => { cleanup(); reject(e); });
    });
  }

  // Steer: add input to the running turn (Codex's native turn/steer). The same turn keeps going.
  async steer(threadId, text, attachments = []) {
    const t = this.currentTurn;
    if (!t || !t.started || t.cancelled || t.threadId !== threadId) return false;
    await this.request('turn/steer', { threadId, expectedTurnId: t.turnId, input: toCodexInput(text, attachments) }, 20000);
    return true;
  }

  // Stop. Before the turn is live the cancel is held, and sent once (see runTurn).
  async interrupt() {
    const t = this.currentTurn; if (!t) return;
    t.cancelled = true;
    if (t.started) await this._interruptTurn(t);
  }

  async _interruptTurn(t) {
    if (t.interruptSent) return; t.interruptSent = true;
    try { await this.request('turn/interrupt', { threadId: t.threadId, turnId: t.turnId }, 10000); } catch (e) { this.log(`interrupt: ${e.message}`); }
  }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); } }
}

module.exports = { CodexClient, FORBIDDEN, describeItem };
