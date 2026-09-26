'use strict';
// Persistent Claude Code session over stdio (stream-json in, stream-json out). No ports.
const { spawn } = require('child_process');
const readline = require('readline');
const { toClaudeContent } = require('./attachments');
const { fromClaude, sum } = require('./localUsage');

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const SERVER = 'wagon'; // in-process MCP server answered over this process's own stdio (no extra process, no port)

const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;

// A human-readable line for a tool call, e.g. "reading room.js".
function describeTool(name, input = {}) {
  if (name === `mcp__${SERVER}__request_assistance`) return `asking ${input.to || 'a peer'} (${input.purpose || 'help'})`;
  if (name === `mcp__${SERVER}__finish_task`) return 'proposing the task is done';
  if (name === `mcp__${SERVER}__read_session_history`) return `reading ${input.from || 'shared'} history`;
  if (name === 'Read') return `reading ${base(input.file_path)}`;
  if (name === 'Grep') return `searching for "${clip(input.pattern, 40)}"`;
  if (name === 'Glob') return `listing ${clip(input.pattern, 40)}`;
  return `using ${name}`;
}

class ClaudeClient {
  // tools: typed room tools ([{name, description, inputSchema}]), answered by the current send()'s onTool.
  constructor({ exe, cwd, model, effort = null, fast = false, systemPrompt, sessionId = null, forkFrom = null, addDirs = [], tools = [], log = () => {}, onNotice = () => {}, onSession = () => {} }) {
    Object.assign(this, { exe, cwd, model, effort, fast, systemPrompt, sessionId, forkFrom, addDirs, tools, log, onNotice, onSession });
    this.typed = tools.length > 0;
    this.proc = null; this.waiter = null; this.totalCostUsd = 0; this.steerQueue = []; this.reqId = 0;
  }

  _args() {
    // The boundary is enforced by the CLI, not by permission rules alone: --restricted ignores the user's own
    // settings files (their allow rules once let the room's Claude run shell commands) and confines file tools to
    // the working directories; --tools limits the built-in set to reading. --allowedTools then lets the read
    // tools and our own room tools run without prompting, and dontAsk refuses everything else.
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--restricted', '--tools', READ_ONLY_TOOLS.join(','),
      '--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS.concat(this.tools.map((t) => `mcp__${SERVER}__${t.name}`)).join(','),
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: this.typed ? { [SERVER]: { type: 'sdk', name: SERVER } } : {} }), '--append-system-prompt', this.systemPrompt];
    if (this.model && this.model !== 'default') a.push('--model', this.model); // Default (recommended): the CLI's own choice
    if (this.effort) a.push('--effort', this.effort);
    if (this.fast) a.push('--settings', JSON.stringify({ fastMode: true })); // Opus fast mode; billed to usage credits
    for (const d of this.addDirs) a.push('--add-dir', d); // lets Read open attachments stored outside cwd
    if (this.sessionId) a.push('--resume', this.sessionId);
    else if (this.forkFrom) a.push('--resume', this.forkFrom, '--fork-session');
    return a;
  }

  _spawn() {
    // The room's Claude is its own entrypoint, not whichever app launched VS Code (Claude Desktop sets one in the
    // environment); that keeps its sessions from looking like the person's own desktop sessions.
    const env = { ...process.env }; delete env.CLAUDE_CODE_ENTRYPOINT;
    const proc = spawn(this.exe, this._args(), { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (d) => this.log(`claude stderr: ${String(d).slice(0, 400)}`));
    // Events from a process we already replaced (model/effort switch) must not touch the new one's reply.
    proc.on('error', (e) => { if (this.proc === proc) this._settle(e); });
    proc.on('exit', (code, sig) => { if (this.proc !== proc) return; this.proc = null; this._settle(new Error(`claude exited (${code ?? sig})`)); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => { if (this.proc === proc) this._onLine(line); });
    if (this.typed) this._write({ type: 'control_request', request_id: `wc-init-${++this.reqId}`, request: { subtype: 'initialize', sdkMcpServers: [SERVER] } });
  }

  _write(o) { if (this.proc) this.proc.stdin.write(JSON.stringify(o) + '\n'); }

  // The CLI's MCP traffic for our in-process server. tools/call goes to the reply in progress; with none open
  // (a late call after Stop or a restart), it is refused.
  async _onMcp(m) {
    const msg = m.request.message || {}; const proc = this.proc;
    let result = {};
    if (msg.method === 'initialize') result = { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1' } };
    else if (msg.method === 'tools/list') result = { tools: this.tools };
    else if (msg.method === 'tools/call') {
      const w = this.waiter, p = msg.params || {};
      let r; try { r = w && w.onTool ? await w.onTool(p.name, p.arguments || {}) : { ok: false, text: 'Not available: no reply is open.' }; } catch (e) { r = { ok: false, text: `Failed: ${e.message}` }; }
      if (w && this.waiter !== w) r = { ok: false, text: 'Not delivered: that reply already ended.' }; // Stopped or finished while the tool ran
      result = { content: [{ type: 'text', text: String(r.text || '') }], ...(r.ok ? {} : { isError: true }) };
    }
    if (this.proc !== proc) return; // answered by a process we already replaced
    const resp = msg.id === undefined ? { jsonrpc: '2.0', result: {}, id: 0 } : { jsonrpc: '2.0', id: msg.id, result };
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { mcp_response: resp } } });
  }

  // Every way a turn ends (result, exit, kill fallback, spawn error) clears its Stop and steer state, so none
  // of it leaks into the next reply. A Stop that ends in an error, even a forced kill, is still a Stop.
  _settle(err, text) {
    const w = this.waiter; if (!w) return;
    this.waiter = null;
    const cancelled = this.cancelling; this.lastTurnUsage = w.usage || null;
    this.cancelling = false; this.steerQueue = []; clearTimeout(this.intTimer); this.intTimer = null;
    if (this.restartPending) { this.restartPending = false; this.stop(); }
    if (err && cancelled && !err.stopped) { err = new Error('stopped'); err.stopped = true; }
    if (err) w.reject(err); else w.resolve(text);
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.forkFrom = null; this.onSession(this.sessionId); } // the host claims it at once
    if (m.type === 'system' && m.subtype === 'notification' && m.text) this.onNotice(m.text); // e.g. fast mode out of credits
    if (m.type === 'control_request' && m.request && m.request.subtype === 'mcp_message' && m.request.server_name === SERVER) { this._onMcp(m); return; }
    const w = this.waiter; if (!w) return;
    const ev = m.type === 'stream_event' ? m.event : null;
    if (ev && ev.type === 'content_block_start' && ev.content_block) {
      const t = ev.content_block.type;
      if (t === 'thinking') w.onActivity({ phase: 'thinking', label: 'thinking' });
      else if (t === 'tool_use') w.onActivity({ phase: 'tool', label: `using ${ev.content_block.name}` });
      else if (t === 'text') w.onActivity({ phase: 'writing', label: 'writing' });
    } else if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
      w.thinking += ev.delta.thinking || ''; w.onActivity({ phase: 'thinking', label: 'thinking', thinking: w.thinking });
    } else if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      w.partial += ev.delta.text; w.onDelta(w.blocks.concat(w.partial ? [w.partial] : []).join('\n\n'));
    } else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) if (c.type === 'tool_use') w.onActivity({ phase: 'tool', label: describeTool(c.name, c.input), step: true });
      const text = m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text) { w.blocks.push(text); w.partial = ''; w.onDelta(w.blocks.join('\n\n')); }
    } else if (m.type === 'result') {
      clearTimeout(this.intTimer); this.intTimer = null; // the interrupt (if any) was honoured: disarm the kill fallback
      w.usage = sum(w.usage, fromClaude(m.usage)); // a steered reply has one result per leg: the turn is their sum
      if (typeof m.total_cost_usd === 'number') this.totalCostUsd = m.total_cost_usd;
      if (this.steerQueue.length && !this.cancelling) {
        // A steer interrupted this turn: send the new instruction and keep the same reply open.
        const next = this.steerQueue.splice(0);
        w.onActivity({ phase: 'waiting', label: 'redirected by you' });
        this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: toClaudeContent(next.map((x) => x.text).join('\n\n'), next.flatMap((x) => x.attachments)) } }) + '\n');
        return;
      }
      if (m.usage) this.lastUsage = { input: m.usage.input_tokens || 0, cacheWrite: m.usage.cache_creation_input_tokens || 0, cacheRead: m.usage.cache_read_input_tokens || 0, output: m.usage.output_tokens || 0 };
      if (m.session_id) this.sessionId = m.session_id;
      if (m.is_error) this._settle(new Error(m.result || m.subtype || 'Claude error'));
      else this._settle(null, (m.result || w.blocks.join('\n\n')).trim());
    }
  }

  send(text, onDelta = () => {}, onActivity = () => {}, attachments = [], onTool = null) {
    if (this.waiter) return Promise.reject(new Error('Claude is already answering'));
    this.lastTurnUsage = null;
    if (!this.proc) this._spawn();
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, onDelta, onActivity, onTool, partial: '', blocks: [], thinking: '' };
      onActivity({ phase: 'waiting', label: 'waiting for the model' });
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: toClaudeContent(text, attachments) } }) + '\n');
    });
  }

  // Model and effort are launch flags: restart on the same session (now, or after the current reply).
  setOptions({ model, effort, fast }) {
    if (model !== undefined) this.model = model;
    if (effort !== undefined) this.effort = effort;
    if (fast !== undefined) this.fast = fast;
    if (this.waiter) this.restartPending = true; else this.stop();
  }

  compact() { return this.send('/compact'); }

  // Stop (the user's cancel): the turn ends and queued steers are dropped; the session and process stay alive.
  interrupt() {
    if (!this.proc || !this.waiter) return;
    this.cancelling = true; this.steerQueue = [];
    this._interrupt();
  }

  // Clean interrupt over stream-json. Falls back to killing the process if the CLI doesn't answer within 3 seconds.
  _interrupt() {
    const proc = this.proc;
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `wc-int-${++this.reqId}`, request: { subtype: 'interrupt' } }) + '\n');
    clearTimeout(this.intTimer);
    this.intTimer = setTimeout(() => { this.intTimer = null; if (this.waiter && this.proc === proc) proc.kill(); }, 3000);
  }

  // Steer: stop the current turn at once and continue it with the new instruction (same reply, same session).
  // Mid-turn injection exists too, but in testing Sonnet 5 ignored it; interrupt-and-redirect was reliable.
  steer(text, attachments = []) {
    if (!this.waiter || !this.proc || this.cancelling) return false;
    this.steerQueue.push({ text, attachments });
    if (this.steerQueue.length === 1) this._interrupt();
    return true;
  }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { ClaudeClient, READ_ONLY_TOOLS, describeTool };
