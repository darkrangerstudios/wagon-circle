'use strict';
// Persistent Claude Code session over stdio (stream-json in, stream-json out). No ports.
const { spawn } = require('child_process');
const readline = require('readline');

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

class ClaudeClient {
  constructor({ exe, cwd, model, systemPrompt, sessionId = null, forkFrom = null, log = () => {} }) {
    Object.assign(this, { exe, cwd, model, systemPrompt, sessionId, forkFrom, log });
    this.proc = null; this.waiter = null; this.totalCostUsd = 0;
  }

  _args() {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS.join(','),
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', this.systemPrompt];
    if (this.model) a.push('--model', this.model);
    if (this.sessionId) a.push('--resume', this.sessionId);
    else if (this.forkFrom) a.push('--resume', this.forkFrom, '--fork-session');
    return a;
  }

  _spawn() {
    const proc = spawn(this.exe, this._args(), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (d) => this.log(`claude stderr: ${String(d).slice(0, 400)}`));
    proc.on('error', (e) => this._settle(e));
    proc.on('exit', (code, sig) => { if (this.proc === proc) this.proc = null; this._settle(new Error(`claude exited (${code ?? sig})`)); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
  }

  _settle(err, text) {
    const w = this.waiter; if (!w) return;
    this.waiter = null;
    if (err) w.reject(err); else w.resolve(text);
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.forkFrom = null; }
    const w = this.waiter; if (!w) return;
    if (m.type === 'stream_event' && m.event && m.event.type === 'content_block_delta' && m.event.delta && m.event.delta.type === 'text_delta') {
      w.partial += m.event.delta.text; w.onDelta(w.partial);
    } else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      const text = m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text) { w.blocks.push(text); w.partial = ''; w.onDelta(w.blocks.join('\n\n')); }
    } else if (m.type === 'result') {
      if (typeof m.total_cost_usd === 'number') this.totalCostUsd = m.total_cost_usd;
      if (m.session_id) this.sessionId = m.session_id;
      if (m.is_error) this._settle(new Error(m.result || m.subtype || 'Claude error'));
      else this._settle(null, (m.result || w.blocks.join('\n\n')).trim());
    }
  }

  send(text, onDelta = () => {}) {
    if (this.waiter) return Promise.reject(new Error('Claude is already answering'));
    if (!this.proc) this._spawn();
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, onDelta, partial: '', blocks: [] };
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    });
  }

  // Claude has no mid-turn cancel over stdio; stopping kills the process and the next send resumes the session.
  interrupt() { if (this.proc) { this.proc.kill(); } }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { ClaudeClient, READ_ONLY_TOOLS };
