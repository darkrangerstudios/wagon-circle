'use strict';
// Supported CLI cloud operations. No private HTTP endpoints, token extraction, shell, or auto-apply.
const { execFile } = require('child_process');
const { createHash } = require('crypto');

class CloudCapabilityError extends Error {
  constructor(message) { super(message); this.name = 'CloudCapabilityError'; this.code = 'UNSUPPORTED_CLOUD_CAPABILITY'; }
}

function runFile(exe, args, { cwd, signal, timeout = 30000, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(exe, args, { cwd, signal, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        // Do not retain provider stderr or echo prompts/credentials in a task notice.
        const err = new Error(error.name === 'AbortError' ? 'Cloud operation canceled locally; remote state must be reconciled.' : 'Cloud CLI operation failed; check provider sign-in, CLI compatibility and connectivity.');
        err.code = error.code; err.uncertain = input !== undefined;
        reject(err);
      } else resolve(stdout);
    });
    // A prompt on stdin is never interpreted as shell or CLI flags.
    if (proc.stdin) { proc.stdin.on('error', () => {}); proc.stdin.end(input); }
  });
}

function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function identifier(value, name = 'session ID') {
  text(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function promptText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000 || value.includes('\0')) throw new Error('Invalid cloud message');
  return value;
}
function parseJson(raw) {
  try { return JSON.parse(raw); } catch { throw new Error('Cloud CLI returned unsupported output; no state was advanced.'); }
}
const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

class CodexCloud {
  constructor({ exe = 'codex', cwd, run = runFile } = {}) { Object.assign(this, { exe, cwd, run }); }
  capabilities() {
    return { list: true, create: true, status: true, diff: true, followUp: false, cancel: false,
      history: 'unavailable', syncCoverage: 'status-and-diff',
      limitation: 'This Codex CLI exposes cloud task metadata and diffs, not a full transcript, follow-ups or remote cancellation.' };
  }
  async list({ environmentId, cursor, signal } = {}) {
    const args = ['cloud', 'list', '--json', '--limit', '20'];
    if (environmentId) args.push('--env', identifier(environmentId, 'environment ID'));
    if (cursor) args.push('--cursor', text(cursor, 'cursor', 4096));
    const data = parseJson(await this.run(this.exe, args, { cwd: this.cwd, signal }));
    if (!data || !Array.isArray(data.tasks) || data.tasks.length > 20 || (data.cursor != null && typeof data.cursor !== 'string')) throw new Error('Unexpected cloud task list');
    const tasks = data.tasks.map((task) => {
      identifier(task.id);
      if (typeof task.status !== 'string' || typeof task.title !== 'string') throw new Error('Unexpected cloud task metadata');
      return { id: task.id, title: task.title, status: task.status, updatedAt: task.updated_at || null,
        environmentId: task.environment_id || null, summary: task.summary == null ? null : task.summary,
        url: `https://chatgpt.com/codex/tasks/${encodeURIComponent(task.id)}` };
    });
    return { tasks, cursor: data.cursor || null };
  }
  async read({ remoteId, environmentId, cursor: previousRevision, signal } = {}) {
    identifier(remoteId);
    let cursor = null; const visited = new Set();
    // A bounded, complete search. Being outside the bound is an explicit error, never task completion.
    for (let page = 0; page < 10; page++) {
      const result = await this.list({ environmentId, cursor, signal });
      const task = result.tasks.find((entry) => entry.id === remoteId);
      if (task) {
        const currentRevision = revision(task);
        return { cursor: currentRevision, coverage: 'status-only',
          events: currentRevision === previousRevision ? [] : [{ id: `snapshot:${currentRevision}`, kind: 'status', remoteId, task }] };
      }
      if (!result.cursor) throw new Error('Linked cloud task is not available to this account/environment.');
      if (visited.has(result.cursor)) throw new Error('Cloud pagination repeated a cursor.');
      visited.add(result.cursor); cursor = result.cursor;
    }
    throw new Error('Linked cloud task was not found within the bounded listing; refine the environment filter.');
  }
  async diff({ remoteId, signal } = {}) {
    identifier(remoteId);
    return this.run(this.exe, ['cloud', 'diff', remoteId], { cwd: this.cwd, signal });
  }
  async create({ environmentId, branch, prompt, signal } = {}) {
    identifier(environmentId, 'environment ID'); promptText(prompt);
    const args = ['cloud', 'exec', '--env', environmentId, '--attempts', '1'];
    if (branch) args.push('--branch', text(branch, 'branch', 1024));
    // exec takes a positional query; the option terminator prevents prompt-based flag injection.
    args.push('--', prompt);
    let output;
    try { output = await this.run(this.exe, args, { cwd: this.cwd, signal, timeout: 60000 }); }
    catch (error) { error.uncertain = true; throw error; }
    const match = String(output).match(/https:\/\/chatgpt\.com\/codex\/tasks\/([A-Za-z0-9_-]+)/);
    if (!match) { const error = new Error('Submission may have succeeded; no task ID could be recovered. Reconcile in Codex before retrying.'); error.uncertain = true; throw error; }
    return { remoteId: match[1], url: match[0], coverage: 'status-and-diff' };
  }
  followUp() { throw new CloudCapabilityError('The supported Codex cloud CLI has no follow-up command.'); }
  cancel() { throw new CloudCapabilityError('Remote cancellation is unavailable through this Codex cloud CLI. A local Stop cannot confirm it.'); }
}

class ClaudeCloud {
  constructor({ exe = 'claude', cwd, run = runFile } = {}) { Object.assign(this, { exe, cwd, run }); }
  capabilities() {
    return { list: false, create: false, status: false, diff: false, followUp: true, cancel: false,
      history: 'unavailable', syncCoverage: 'unavailable',
      limitation: 'Cloud follow-ups are supported. Automatic discovery/transcript retrieval and unattended creation are not verified by this adapter.' };
  }
  async followUp({ remoteId, prompt, signal } = {}) {
    identifier(remoteId); promptText(prompt);
    if (!/^(session_|cse_)/.test(remoteId)) throw new Error('Expected a Claude cloud session ID');
    let result;
    try {
      result = parseJson(await this.run(this.exe, ['-p', '--cloud', remoteId, '--output-format', 'json'],
        { cwd: this.cwd, signal, timeout: 60000, input: prompt }));
    } catch (error) { error.uncertain = true; throw error; }
    if (!result || result.ok !== true || result.session_id !== remoteId) {
      const error = new Error('Cloud follow-up was not confirmed for the selected session; reconcile before retry.'); error.uncertain = true; throw error;
    }
    return { remoteId, accepted: true, completed: false, url: `https://claude.ai/code/${encodeURIComponent(remoteId)}` };
  }
  read() { throw new CloudCapabilityError('No supported headless Claude cloud transcript reader has been verified. Full chat sync remains unavailable.'); }
  create() { throw new CloudCapabilityError('Start the session through Claude cloud first. Automated creation/upload behavior has not been verified.'); }
  cancel() { throw new CloudCapabilityError('Remote cancellation is unavailable through this adapter.'); }
}

module.exports = { CodexCloud, ClaudeCloud, CloudCapabilityError, runFile };
