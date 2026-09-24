'use strict';
// An agent that speaks the Agent Client Protocol (ACP: JSON-RPC 2.0, newline-delimited, over stdio), such as
// Gemini CLI with --experimental-acp. A private child process like the others: no daemon, no port.
// Read-only in a Wagon Wheel room: we advertise no file-system or terminal capability, and every permission
// request the agent sends is rejected, so it can use only what its own configuration runs without asking.
// No typed room tools yet (ACP passes MCP servers as separate processes): its hand-offs show as suggestions.
// EXPERIMENTAL, local branch: verified against a fake ACP agent only, not a live Gemini CLI.
const { spawn: realSpawn } = require('child_process');
const readline = require('readline');

class AcpClient {
  // brief: the room's standing instructions, sent ahead of the first message of a NEW session (ACP has no
  // system-prompt parameter).
  constructor({ exe, args = [], cwd, label = 'Agent', brief = null, log = () => {}, spawn = realSpawn }) {
    Object.assign(this, { exe, args, cwd, label, brief, log, spawnFn: spawn });
    this.briefPending = false;
    this.proc = null; this.nextId = 0; this.pending = new Map(); this.waiter = null; this.sessionId = null;
    this.capabilities = {}; this.typed = false;
  }

  async start() {
    const proc = this.spawnFn(this.exe, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.on('error', (e) => this._fail(proc, e));
    proc.on('exit', (code, sig) => this._fail(proc, new Error(`${this.label} exited (${code ?? sig})`)));
    if (proc.stderr) proc.stderr.on('data', (d) => this.log(`${this.label} stderr: ${String(d).slice(0, 400)}`));
    readline.createInterface({ input: proc.stdout }).on('line', (line) => { if (this.proc === proc) this._onLine(line); });
    const r = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    this.capabilities = (r && r.agentCapabilities) || {};
    return r;
  }

  _fail(proc, err) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this._settle(err);
  }

  _write(msg) { if (!this.proc) throw new Error(`${this.label} is not running`); this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }

  request(method, params, timeoutMs = 120000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this._write({ id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }

  _onLine(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) return this._onServerRequest(m);
    if (m.id !== undefined && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error))); else resolve(m.result);
      return;
    }
    if (m.method === 'session/update' && m.params && m.params.sessionId === this.sessionId) this._onUpdate(m.params.update || {});
  }

  // The room grants nothing: permission requests are rejected, file and terminal requests refused.
  _onServerRequest(m) {
    if (m.method === 'session/request_permission') {
      const opts = (m.params && m.params.options) || [];
      const reject = opts.find((o) => o.kind === 'reject_once') || opts.find((o) => o.kind === 'reject_always');
      this.log(`${this.label} asked permission (${m.params && m.params.toolCall && m.params.toolCall.title}); rejected`);
      if (this.waiter) this.waiter.onActivity({ phase: 'tool', label: 'permission request rejected (read-only room)', step: true });
      return this._write({ id: m.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
    }
    this._write({ id: m.id, error: { code: -32601, message: 'Wagon Wheel does not grant file, terminal or other client access' } });
  }

  _onUpdate(u) {
    const w = this.waiter; if (!w) return; // e.g. history replayed by session/load
    const text = u.content && u.content.type === 'text' ? u.content.text || '' : '';
    if (u.sessionUpdate === 'agent_message_chunk') { w.text += text; w.onDelta(w.text); w.onActivity({ phase: 'writing', label: 'writing' }); }
    else if (u.sessionUpdate === 'agent_thought_chunk') { w.thinking += text; w.onActivity({ phase: 'thinking', label: 'thinking', thinking: w.thinking }); }
    else if (u.sessionUpdate === 'tool_call') w.onActivity({ phase: 'tool', label: String(u.title || u.kind || 'using a tool').slice(0, 60), step: true });
    else if (u.sessionUpdate === 'plan') w.onActivity({ phase: 'thinking', label: 'planning' });
  }

  _settle(err, text) {
    const w = this.waiter; if (!w) return;
    this.waiter = null;
    const cancelled = w.cancelled;
    if (err && cancelled) { err = new Error('stopped'); err.stopped = true; }
    if (err) w.reject(err); else w.resolve(text);
  }

  async newSession() { const r = await this.request('session/new', { cwd: this.cwd, mcpServers: [] }); this.sessionId = r.sessionId; this.briefPending = !!this.brief; return r.sessionId; }

  // Continue an existing session, only where the agent says it can load one.
  async loadSession(sessionId) {
    if (!this.capabilities.loadSession) throw new Error(`${this.label} cannot load an existing session`);
    this.sessionId = sessionId;
    await this.request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] }, 600000);
    return sessionId;
  }

  send(text, onDelta = () => {}, onActivity = () => {}) {
    if (this.waiter) return Promise.reject(new Error(`${this.label} is already answering`));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, onDelta, onActivity, text: '', thinking: '', cancelled: false };
      onActivity({ phase: 'waiting', label: 'waiting for the model' });
      const body = this.briefPending ? `${this.brief}\n\n---\n\n${text}` : text; this.briefPending = false;
      this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: body }] }, 3600000)
        .then((r) => {
          const w = this.waiter; if (!w) return;
          const reason = r && r.stopReason;
          if (reason === 'cancelled') { const e = new Error('stopped'); e.stopped = true; this._settle(e); }
          else if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'max_turn_requests') this._settle(null, w.text.trim() + (reason === 'end_turn' ? '' : `\n\n(${this.label} stopped: ${reason})`));
          else this._settle(new Error(`${this.label} ended the turn: ${reason || 'unknown'}`));
        }, (e) => this._settle(e));
    });
  }

  // Stop: ACP's session/cancel notification; the pending prompt then answers with stopReason "cancelled".
  interrupt() { if (!this.waiter || !this.proc) return; this.waiter.cancelled = true; try { this._write({ method: 'session/cancel', params: { sessionId: this.sessionId } }); } catch { /* exited */ } }

  stop() { if (this.proc) { const p = this.proc; this.proc = null; try { p.stdin.end(); } catch { /* closed */ } p.kill(); } }
}

module.exports = { AcpClient };
