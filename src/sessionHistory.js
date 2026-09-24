'use strict';
// Opt-in, read-only reference access. Only the host binds sources and changes sharing policy.
// Retrieved text never enters the room router as a human message or task-control event.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

class SessionHistory {
  constructor() { this.bindings = new Map(); this.serial = 0; }

  bind(participant, { provider, sessionId, readPage }) {
    if (typeof participant !== 'string' || !participant || typeof provider !== 'string' || !provider
        || typeof sessionId !== 'string' || !sessionId || typeof readPage !== 'function') throw new Error('Invalid history binding');
    const binding = { participant, provider, sessionId, readPage, generation: ++this.serial,
      policyRevision: 0, enabled: false, readers: [], after: null };
    this.bindings.set(participant, binding);
    // Consent belongs to a working session, not its reusable participant label.
    for (const source of this.bindings.values()) {
      if (source.readers.includes(participant)) {
        source.readers = source.readers.filter((reader) => reader !== participant);
        source.policyRevision++;
      }
    }
    return this.describe(participant);
  }

  describe(participant) {
    const binding = this.bindings.get(participant);
    if (!binding) return null;
    const { readPage, ...publicBinding } = binding;
    return { ...publicBinding, readers: [...binding.readers] };
  }

  // Called by a human settings action, never exported as an agent task tool.
  configure(participant, { enabled, readers = [], after = null }) {
    const binding = this.bindings.get(participant);
    if (!binding || typeof enabled !== 'boolean' || !Array.isArray(readers)
        || readers.some((reader) => typeof reader !== 'string' || !reader || !this.bindings.has(reader))
        || (after !== null && (!Number.isFinite(after) || after < 0))) throw new Error('Invalid history sharing policy');
    Object.assign(binding, { enabled, readers: [...new Set(readers)], after, policyRevision: binding.policyRevision + 1 });
    return this.describe(participant);
  }

  async read({ requester, target, generation, policyRevision, cursor = null, query = '', limit = 20, maxChars = 12000 }) {
    const binding = this.bindings.get(target);
    const readerBinding = this.bindings.get(requester);
    const admitted = () => this.bindings.get(target) === binding && binding.enabled
      && readerBinding && this.bindings.get(requester) === readerBinding
      && binding.readers.includes(requester) && binding.generation === generation && binding.policyRevision === policyRevision;
    if (!binding || !admitted()) throw new Error('Session history access is disabled, out of scope or stale');
    if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
        || !Number.isSafeInteger(maxChars) || maxChars < 100 || maxChars > 50000) throw new Error('Invalid history page limits');
    let pageCursor = null, startItem = 0, startChar = 0, expectedHash = null;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error('Invalid history cursor');
      const saved = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (saved.generation !== generation || saved.policyRevision !== policyRevision || saved.target !== target
          || saved.query !== query || !Number.isSafeInteger(saved.item) || saved.item < 0
          || !Number.isSafeInteger(saved.character) || saved.character < 0) throw new Error('Stale history cursor');
      pageCursor = saved.pageCursor; startItem = saved.item; startChar = saved.character; expectedHash = saved.hash;
    }
    const page = await binding.readPage({ sessionId: binding.sessionId, cursor: pageCursor, limit: 20 });
    // A revoke/rebind while the provider is reading must not leak its late result.
    if (!admitted()) throw new Error('Session history sharing changed during retrieval');
    if (!page || !Array.isArray(page.messages) || page.messages.length > 1000) throw new Error('Invalid history response');
    const hash = digest(JSON.stringify(page.messages));
    if (expectedHash && expectedHash !== hash) throw new Error('History page changed; restart retrieval to avoid skipping content');
    const encode = (nextPage, item, character, pageHash) => Buffer.from(JSON.stringify({
      generation, policyRevision, target, query, pageCursor: nextPage, item, character, hash: pageHash,
    })).toString('base64url');
    const messages = []; let remaining = maxChars, truncated = !!page.truncated, nextCursor = null;
    for (let index = startItem; index < page.messages.length; index++) {
      const item = page.messages[index];
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string'
          || !['user', 'assistant', 'tool'].includes(item.role)) continue;
      if (binding.after !== null && (!Number.isFinite(item.timestamp) || item.timestamp < binding.after)) continue;
      if (query && !item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      const character = index === startItem ? startChar : 0;
      if (messages.length >= limit || remaining <= 0) {
        nextCursor = encode(pageCursor, index, character, hash); break;
      }
      const excerpt = item.text.slice(character, character + remaining);
      const clipped = character + excerpt.length < item.text.length;
      messages.push({ source: { provider: binding.provider, sessionId: binding.sessionId,
        participant: target, generation, messageId: item.id }, role: item.role,
      timestamp: Number.isFinite(item.timestamp) ? item.timestamp : null,
      text: excerpt, offset: character, truncated: clipped, actionable: false });
      remaining -= excerpt.length;
      truncated ||= clipped;
      if (clipped) { nextCursor = encode(pageCursor, index, character + excerpt.length, hash); break; }
    }
    if (!nextCursor && page.cursor != null) nextCursor = encode(page.cursor, 0, 0, null);
    return { messages, cursor: nextCursor,
      coverage: typeof page.coverage === 'string' ? page.coverage : 'unknown', truncated,
      source: { provider: binding.provider, sessionId: binding.sessionId, generation, policyRevision } };
  }
}

// Reader factory takes a host-selected file from session discovery, never a path supplied by an agent.
function claudeHistoryReader(file, historyRoot) {
  const root = fs.realpathSync(historyRoot), selected = fs.realpathSync(file);
  const relative = path.relative(root, selected);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Session file is outside the history root');
  return async ({ sessionId, cursor = null, limit = 20 }) => {
    if (path.basename(selected, '.jsonl') !== sessionId) throw new Error('History session binding mismatch');
    // Re-resolve every time: a symlink replacement cannot redirect a previously selected source.
    if (fs.realpathSync(file) !== selected) throw new Error('History source changed');
    const descriptor = fs.openSync(selected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error('History source is not a file');
      let position = 0;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || cursor.length > 1024) throw new Error('Invalid history cursor');
        const saved = JSON.parse(cursor);
        if (!Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > stat.size
            || saved.inode !== String(stat.ino) || saved.device !== String(stat.dev)) throw new Error('History source changed; reload its first page');
        position = saved.offset;
        const anchor = Buffer.alloc(Math.min(64, position));
        fs.readSync(descriptor, anchor, 0, anchor.length, position - anchor.length);
        if (saved.anchor !== digest(anchor)) throw new Error('History cursor content changed');
      }
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - position));
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      let at = 0; const messages = [];
      while (at < length && messages.length < limit) {
        const end = buffer.indexOf(10, at);
        if (end < 0 || end >= length) break; // a partly written record is retried next time
        const start = at; at = end + 1;
        let record;
        try { record = JSON.parse(buffer.subarray(start, end).toString('utf8')); } catch { continue; }
        if (record.isMeta || record.isSidechain || !['user', 'assistant'].includes(record.type) || !record.message) continue;
        if (record.sessionId && record.sessionId !== sessionId) continue;
        const content = record.message.content;
        // Text history only. Hidden thinking, tool payloads, images and injected metadata are not exported.
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';
        if (!text || /^<(command-|local-command|system-reminder|task-notification|bash-|user-memory)/.test(text.trimStart())) continue;
        messages.push({ id: record.uuid || `offset:${position + start}`, role: record.type,
          timestamp: Date.parse(record.timestamp), text });
      }
      if (!at && length === 4 * 1024 * 1024) throw new Error('History record exceeds the read limit; open it in the native session');
      const offset = position + at;
      const anchor = Buffer.alloc(Math.min(64, offset));
      fs.readSync(descriptor, anchor, 0, anchor.length, offset - anchor.length);
      return { messages, coverage: 'text-only', truncated: false,
        cursor: offset < stat.size ? JSON.stringify({ offset, inode: String(stat.ino), device: String(stat.dev), anchor: digest(anchor) }) : null };
    } finally { fs.closeSync(descriptor); }
  };
}

function codexHistoryReader(client) {
  return async ({ sessionId, cursor, limit }) => {
    const result = await client.request('thread/turns/list', { threadId: sessionId,
      limit, cursor: cursor || null, sortDirection: 'desc', itemsView: 'full' });
    if (!result || !Array.isArray(result.data)) throw new Error('Unsupported Codex history response');
    const messages = [];
    for (const turn of result.data) {
      for (const item of turn.items || []) {
        let text = '', role;
        if (item.type === 'userMessage') {
          role = 'user'; text = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        } else if (item.type === 'agentMessage') { role = 'assistant'; text = item.text || ''; }
        if (text) messages.push({ id: item.id || `${turn.id}:${messages.length}`, role, text,
          timestamp: Number.isFinite(turn.startedAt) ? turn.startedAt * 1000 : null });
      }
    }
    return { messages, cursor: result.nextCursor || null, coverage: 'text-only', truncated: false };
  };
}

module.exports = { SessionHistory, claudeHistoryReader, codexHistoryReader };
