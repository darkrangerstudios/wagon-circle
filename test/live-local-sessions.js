'use strict';
// Opt-in real two-Codex RoomSession check. Uses only generated temporary folders and spends up to
// six short turns (normally three). No Claude/model provider other than the selected Codex is started.
// node test/live-local-sessions.js [codexExecutable] [model]
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wagon-local-live-'));
const [exe = 'codex', model = 'gpt-6-astra'] = process.argv.slice(2);
const values = { userName: 'Tester', cwd: root, codexPath: exe, experimentalAgents: [], taskMode: 'work', taskTurns: 6, taskReserve: 2, taskMinutes: 3, ideContext: false };
const vscode = { workspace: { getConfiguration: () => ({ get: k => values[k], inspect: k => ({ workspaceValue: values[k] }), update: async () => {} }), isTrusted: true }, window: {}, commands: { executeCommand: async () => {} }, env: {}, ConfigurationTarget: { Global: 1 } };
const realLoad = Module._load;
Module._load = function (req, parent, ...args) {
  if (req === 'vscode') return vscode;
  if (req === './claudeBinary' && parent.filename.endsWith('/src/extension.js')) return { findClaude: () => ({ path: 'not-used', version: [2, 1, 281] }), atLeast: () => true };
  return realLoad.call(this, req, parent, ...args);
};
const { RoomSession } = require('../src/extension'); Module._load = realLoad;
const { CodexClient } = require('../src/codexClient');
const receipts = [], originalRequest = CodexClient.prototype.request;
CodexClient.prototype.request = async function (method, params, ...rest) {
  const result = await originalRequest.call(this, method, params, ...rest);
  if (['thread/start','thread/resume'].includes(method)) receipts.push({ method, cwd: this.cwd, thread: result.thread.id, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox });
  return result;
};
const check = (ok, label) => { assert.ok(ok, label); console.log('PASS', label); };
let session;
const timer = setTimeout(() => { if (session) session.dispose(); console.error('FAIL deadline'); process.exitCode = 1; }, 210000);
(async () => {
  const seats = [['codex', 'Builder', 'BIRCH-31'], ['codex-2', 'Checker', 'CEDAR-72']].map(([id,label,marker]) => {
    const cwd = path.join(root, id); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd,'marker.txt'),marker+'\n');
    return { id,label,provider:'codex',cwd,model,effort:'low',fast:false,sessionId:null,typed:false };
  });
  const context = { globalStorageUri: { fsPath: path.join(root,'storage') } };
  session = new RoomSession(context, { id:'live-local',name:'Local participant proof',cwd:root,humanName:'Tester',seats,defaultTarget:'codex',ideContext:false,handoffRule:4 }, null);
  await session.boot();
  const slots = session.slots, bindings = Object.fromEntries(session.meta.seats.map(p=>[p.id,p.sessionId]));
  check(bindings.codex !== bindings['codex-2'], 'distinct native thread IDs');
  check(slots.codex.client.proc.pid !== slots['codex-2'].client.proc.pid, 'distinct private child processes');
  check(session.meta.seats.every(p=>session.slots[p.id].client.verifiedThreads.has(p.sessionId)), 'both native threads passed effective permission and MCP checks');
  check(session.history.list('codex').length === 0 && session.history.list('codex-2').length === 0, 'working histories start private');
  const turns = []; session.room.on('message', e => { if(e.from !== 'system') console.log(JSON.stringify({from:e.from,to:e.to,kind:e.kind,text:String(e.text).slice(0,800)})); });
  session.room.on('status', e => { if(e.busy) turns.push(e.name); });
  session.room.postFromHuman('@codex Read marker.txt in your own working folder. Then use request_assistance to ask codex-2 to read marker.txt in its own working folder and return its value. Make exactly one request. When the answer is returned, call finish_task with a short summary containing both markers. Do not read another participant\'s folder yourself. Do not use any other model tools or explore unrelated files.');
  const deadline = Date.now()+190000;
  while (Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,250));
    const task=session.room.tasks.get('t1');
    if(task?.status==='completed' && !Object.values(session.room.busy).some(Boolean)) break;
    if(task && ['exhausted','stopped'].includes(task.status)) throw new Error('Task stopped before completion: '+task.status);
  }
  const room=session.room, t=room.tasks.get('t1'), requests=room.state.transcript.filter(e=>e.kind==='request');
  check(t?.status==='completed', 'typed handoff finishes the task');
  check(requests.length===1 && requests[0].from==='codex' && requests[0].to==='codex-2', 'one request delivered to the named same-provider peer');
  check(t.requests.length===1 && t.requests[0].status==='answered', 'peer answer resolves exactly once');
  check(turns.filter(n=>n==='codex').length===2 && turns.filter(n=>n==='codex-2').length===1, 'three turns, no acknowledgment-only turns');
  check(t.summary.includes('BIRCH-31') && t.summary.includes('CEDAR-72'), 'result contains evidence from both local working folders');
  const usage=room.tasks.summary(t).usage;
  check(['codex','codex-2'].every(id=>usage[id]?.output>0 && !usage[id].unreported), 'task usage attributed separately to each seat');
  session.shareHistory('codex','codex-2',true);
  check(session.history.list('codex-2').some(s=>s.source==='codex') && session.history.list('codex').length===0, 'one-way recipient-specific history grant');
  session.save(); const saved=JSON.parse(fs.readFileSync(session.file,'utf8')), spent=t.used.turns;
  session.dispose();
  session=new RoomSession(context,saved.meta,saved.state); await session.boot();
  check(session.meta.seats.every(p=>bindings[p.id]===p.sessionId), 'reopen restores each native thread without swapping');
  check(session.room.tasks.get('t1').used.turns===spent, 'reopen retains consumed allowance');
  check(session.history.list('codex-2').some(s=>s.source==='codex') && session.history.list('codex').length===0, 'reopen retains only the consented recipient');
  check(session.meta.seats.every(p=>fs.readFileSync(path.join(p.cwd,'marker.txt'),'utf8')===(p.id==='codex'?'BIRCH-31\n':'CEDAR-72\n')), 'fixtures unchanged');
  console.log(JSON.stringify({model,effort:'low',turns,bindings,usage,receipts,fixture:root}));
})().catch(e=>{ console.error('FAIL',e.stack);process.exitCode=1; }).finally(()=>{ clearTimeout(timer);if(session)session.dispose(); });
