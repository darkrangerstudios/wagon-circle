'use strict';
// A tiny ACP agent for tests: answers initialize / session/new / session/load / session/prompt over stdio,
// streams chunks, asks for permission once when the prompt says "write", and honours session/cancel.
const readline = require('readline');
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let pendingPrompt = null, permId = 900, cancelled = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 'sess-1' } });
  if (m.method === 'session/load') { out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } } } }); return out({ id: m.id, result: null }); }
  if (m.method === 'session/cancel') { cancelled = true; if (pendingPrompt) { out({ id: pendingPrompt, result: { stopReason: 'cancelled' } }); pendingPrompt = null; } return; }
  if (m.id === permId && m.result) { out({ method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission outcome: ${JSON.stringify(m.result.outcome)}` } } } }); out({ id: pendingPrompt, result: { stopReason: 'end_turn' } }); pendingPrompt = null; return; }
  if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text; pendingPrompt = m.id; cancelled = false;
    const up = (u) => out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: u } });
    up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reading queue.js', kind: 'read', status: 'pending' });
    if (/write/.test(text)) return out({ id: permId, method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { toolCallId: 't2', title: 'Edit queue.js' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    if (/slow/.test(text)) return; // waits for cancel
    if (/fsread/.test(text)) return out({ id: 777, method: 'fs/read_text_file', params: { path: '/etc/hosts' } });
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `you said: ${text}` } });
    out({ id: m.id, result: { stopReason: 'end_turn' } }); pendingPrompt = null;
  }
  if (m.id === 777) { out({ method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.error ? 'fs refused' : 'fs allowed' } } } }); out({ id: pendingPrompt, result: { stopReason: 'end_turn' } }); pendingPrompt = null; }
});
