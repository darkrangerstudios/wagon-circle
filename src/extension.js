'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { CodexClient } = require('./codexClient');
const { ClaudeClient } = require('./claudeClient');
const { Room, AGENTS } = require('./room');
const { toolSpecs, PRESETS } = require('./tasks');
const { Scheduler } = require('./scheduler');
const { roomPrompt } = require('./prompts');
const claudeHistory = require('./claudeHistory');
const attachments = require('./attachments');
const commands = require('./commands');
const diffs = require('./diffs');
const paths = require('./paths');
const ideContext = require('./ideContext');
const claudeUsage = require('./claudeUsage');
const { findClaude, atLeast } = require('./claudeBinary');

let claudeBin = null; // resolved once per window: newest Claude Code CLI on the machine
const sessions = new Set();
let lastEditor = null; // last code editor used; the room panel steals focus, so track it

let output;
const log = (s) => output && output.appendLine(`[${new Date().toISOString()}] ${s}`);

function firstExisting(candidates) {
  for (const c of candidates) if (c && (c.indexOf('/') === -1 || fs.existsSync(c))) return c;
  return candidates[candidates.length - 1];
}

// Display name for the human: the setting, else the first name in git's identity, else the OS login.
function defaultName() {
  try { const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/)[0]; if (n) return n; } catch { /* no git */ }
  return os.userInfo().username || 'You';
}

function settings() {
  const c = vscode.workspace.getConfiguration('wagonCircle');
  const home = os.homedir();
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return {
    claudeModel: c.get('claudeModel') || null,
    claude: claudeBin || (claudeBin = findClaude(c.get('claudePath') || null)),
    codexExe: firstExisting([c.get('codexPath'), path.join(home, '.local/bin/codex'), path.join(home, '.codex/packages/standalone/current/codex'), 'codex']),
    hopCap: c.get('hopCap'),
    userName: (c.get('userName') || '').trim() || defaultName(),
    defaultTarget: c.get('defaultTarget') || 'claude',
    claudeEffort: c.get('claudeEffort') || null,
    codexModel: c.get('codexModel') || null,
    codexEffort: c.get('codexEffort') || null,
    bothMode: c.get('bothMode') || 'sequential',
    taskMode: ['auto', 'chat', 'work'].includes(c.get('taskMode')) ? c.get('taskMode') : 'auto',
    taskDefaults: cleanLimits({ ...PRESETS.balanced, ...(c.get('taskDefaults') || {}) }),
    cwd: c.get('cwd') || (ws ? ws.uri.fsPath : home)
  };
}

class RoomSession {
  constructor(context, meta, state) {
    this.context = context; this.meta = meta; this.state = state; this.quota = null;
    this.file = path.join(context.globalStorageUri.fsPath, 'rooms', `${meta.id}.json`);
    this.attDir = path.join(context.globalStorageUri.fsPath, 'rooms', meta.id, 'attachments');
    this.pendingAtts = new Map();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.meta.claudeSessionId = this.claude ? this.claude.sessionId : this.meta.claudeSessionId;
    fs.writeFileSync(this.file, JSON.stringify({ meta: this.meta, state: this.room ? this.room.state : this.state }, null, 1));
  }

  async boot({ forkFrom = null, claudeFrom = null } = {}) {
    const s = settings();
    this.meta.humanName = s.userName;
    const human = s.userName;
    const m = this.meta;
    if (m.claudeModel === undefined) m.claudeModel = s.claudeModel;
    if (m.claudeEffort === undefined) m.claudeEffort = s.claudeEffort;
    if (m.codexModel === undefined) m.codexModel = s.codexModel;
    if (m.codexEffort === undefined) m.codexEffort = s.codexEffort;
    if (m.ideContext === undefined) m.ideContext = c_ide();
    this.claudeVersion = s.claude.version;
    if (m.defaultTarget === undefined) m.defaultTarget = s.defaultTarget;
    if (m.bothMode === undefined) m.bothMode = s.bothMode;
    if (m.hopCap === undefined) m.hopCap = s.hopCap;
    this.codex = new CodexClient({ exe: s.codexExe, cwd: this.meta.cwd, tools: toolSpecs(['claude']), log });
    await this.codex.start();
    this.codex.on('notification', (method) => { if (method === 'account/rateLimits/updated') this.refreshQuota(); });
    this.codex.on('exit', (e) => { log(`codex exited: ${e.message}`); this.post({ type: 'notice', text: 'Codex process exited. Reopen the room to restart it.' }); });

    let seed = null;
    if (this.meta.codexThreadId) {
      await this.codex.resumeThread(this.meta.codexThreadId);
    } else if (forkFrom) {
      // app-server takes typed tools only on thread/start, so a forked thread keeps the prose hand-off rule.
      const t = await this.codex.forkThread(forkFrom.id, roomPrompt('codex', 'claude', human));
      this.meta.codexThreadId = t.id; this.meta.forkedFrom = forkFrom.id; this.meta.codexTyped = false;
      try { seed = await this.codex.recentMessages(forkFrom.id, 8); } catch (e) { log(`history read failed: ${e.message}`); seed = []; }
    } else {
      const t = await this.codex.startThread(roomPrompt('codex', 'claude', human, true));
      this.meta.codexThreadId = t.id; this.meta.codexTyped = true; this.meta.codexTypedThreads = [t.id];
    }
    await this.codex.setName(this.meta.codexThreadId, `Wagon Circle: ${this.meta.name}`);
    this.codexModels = await this.codex.listModels();

    // A forked Claude session keeps its full memory (--resume --fork-session); Codex gets its recent text, read from disk.
    let claudeSeed = null;
    if (claudeFrom && !this.meta.claudeSessionId) {
      this.meta.claudeForkedFrom = claudeFrom.id;
      try { claudeSeed = claudeHistory.recentMessages(claudeFrom.path, 8); } catch (e) { log(`claude history read failed: ${e.message}`); claudeSeed = []; }
    }
    this.claude = new ClaudeClient({ exe: s.claude.path, cwd: this.meta.cwd, model: m.claudeModel, effort: m.claudeEffort || null, fast: !!m.claudeFast && this.claudeFastOk(m.claudeModel), onNotice: (t) => this.room && this.room.note(`Claude: ${t}`), systemPrompt: roomPrompt('claude', 'codex', human, true), tools: toolSpecs(['codex']), sessionId: this.meta.claudeSessionId || null, forkFrom: claudeSeed ? claudeFrom.id : null, addDirs: [this.attDir], log });

    const codex = this.codex, meta = this.meta;
    const agents = {
      claude: this.claude,
      codex: { typed: !!meta.codexTyped, send: (text, onDelta, onActivity, files, onTool) => codex.runTurn(meta.codexThreadId, text, onDelta, onActivity, files, { model: meta.codexModel, effort: meta.codexEffort, fast: meta.codexFast, onTool }).finally(() => this.refreshQuota()), interrupt: () => codex.interrupt(), steer: (text, files) => codex.steer(meta.codexThreadId, text, files) }
    };
    const labelFor = (n) => { const c = this.controls()[n]; const x = c.models.find((y) => y.id === c.model); return [x ? (x.name || x.id) : c.model, c.effort, c.fast ? '⚡' : ''].filter(Boolean).join(' · '); };
    this.room = new Room({ agents, hopCap: m.hopCap, state: this.state, humanName: human, defaultTarget: m.defaultTarget, bothMode: m.bothMode, labelFor });
    if (!this.room.tasks.state.defaults) { this.room.tasks.setDefaults(s.taskDefaults); this.room.tasks.mode = s.taskMode; }
    if (seed) {
      this.room.seedHistory(seed, 'codex');
      this.room.note(`Joined a fork of Codex thread ${forkFrom.id.slice(0, 8)} ("${(forkFrom.name || forkFrom.preview || '').slice(0, 60)}"). ${seed.length} recent messages loaded for Claude; the original thread is untouched.`);
    }
    if (claudeSeed) {
      this.room.seedHistory(claudeSeed, 'claude');
      this.room.note(`Joined a fork of Claude session ${claudeFrom.id.slice(0, 8)} ("${(claudeFrom.title || claudeFrom.preview || '').slice(0, 60)}"). Claude keeps its full memory; ${claudeSeed.length} recent messages loaded for Codex. The original session is untouched.`);
    }
    // Rooms made before v0.4.4 briefed Codex with the old "any @mention hands off" rule; its thread keeps that brief.
    if ((this.meta.handoffRule || 0) < 3) {
      if (this.state.transcript.length) this.room.note(`Agents now ask each other with a typed request, tracked as a task with a turn and time allowance, instead of @mentions.${this.meta.codexTyped ? '' : ' This room\'s Codex thread predates that, so Codex still hands off with a line that starts with @claude; a new room gives Codex the typed request too.'}`);
      this.meta.handoffRule = 3;
    }
    this.room.on('message', (entry) => this.post({ type: 'message', entry: this.view(entry) }));
    this.room.on('draft', (d) => this.post({ type: 'draft', ...d }));
    this.room.on('activity', (a) => this.post({ type: 'activity', ...a }));
    this.room.on('status', (st) => this.post({ type: 'status', ...st, cost: this.claude.totalCostUsd, usage: this.claude.lastUsage || null }));
    this.room.on('changed', () => this.save());
    this.room.on('task', () => this.postTask());
    // The one host timer (scheduler.js). Tonight it enforces task time; cloud sync sources register here too.
    this.scheduler = new Scheduler({ log });
    this.scheduler.add('task-clock', { everyMs: 15000, check: async () => { this.room.tick(); return 'quiet'; } });
    this.room.on('message', (e) => { if (e.from === 'claude' || (e.from === 'system' && /^Claude/.test(e.text))) this.refreshClaudeUsage(); });
    this.claudeExe = s.claude.path;
    this.save();
    this.refreshQuota();
    this.refreshClaudeUsage(true);
  }

  // Claude plan usage via headless `/usage` (no model call, free). Throttled; refreshed after Claude replies.
  async refreshClaudeUsage(force) {
    if (!force && this.usageAt && Date.now() - this.usageAt < 45000) return;
    this.usageAt = Date.now();
    const u = await claudeUsage.fetch(this.claudeExe, this.meta.cwd);
    if (!u) return;
    this.claudeUsage = u;
    this.post({ type: 'claudeUsage', usage: u });
    this.postMeta();
  }

  // Save this room's model and effort for a vendor as the defaults for new rooms (user settings).
  async saveDefaults(vendor) {
    const cfg = vscode.workspace.getConfiguration('wagonCircle'), m = this.meta, G = vscode.ConfigurationTarget.Global;
    if (vendor === 'claude') { await cfg.update('claudeModel', m.claudeModel || '', G); await cfg.update('claudeEffort', m.claudeEffort || '', G); }
    else { await cfg.update('codexModel', m.codexModel || '', G); await cfg.update('codexEffort', m.codexEffort || '', G); }
    const c = this.controls()[vendor], x = c.models.find((y) => y.id === c.model);
    this.room.note(`Saved: new rooms start ${vendor === 'claude' ? 'Claude' : 'Codex'} on ${x ? x.name || x.id : c.model || 'its default model'} · ${c.effort || 'default effort'}.`);
  }

  async refreshQuota() {
    const r = await this.codex.rateLimits();
    if (!r) return;
    const snap = r.rateLimits || {};
    this.quota = { primary: snap.primary, secondary: snap.secondary, resetCredits: r.rateLimitResetCredits ? Number(r.rateLimitResetCredits.availableCount) : null, reached: snap.rateLimitReachedType || null };
    this.post({ type: 'quota', quota: this.quota });
  }

  attach(panel) {
    this.panel = panel; sessions.add(this);
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') this.postInit();
      else if ((m.type === 'send' || m.type === 'steer') && this.room && typeof m.text === 'string') {
        const files = (Array.isArray(m.attachmentIds) ? m.attachmentIds : []).map((id) => this.pendingAtts.get(id)).filter(Boolean);
        files.forEach((f) => this.pendingAtts.delete(f.id));
        const snap = m.ide && this.meta.ideContext !== false ? ideSnapshot(this.meta.cwd) : null;
        const ide = snap ? { summary: ideContext.summary(snap), text: ideContext.format(snap) } : null;
        if (!m.text.trim() && !files.length) return;
        if (m.type === 'steer') this.room.steerFromHuman(m.text.trim(), files, ide);
        else this.room.postFromHuman(m.text.trim(), files, ide);
      }
      else if (m.type === 'saveDefaults' && (m.vendor === 'claude' || m.vendor === 'codex')) this.saveDefaults(m.vendor);
      else if (m.type === 'toggleIde') { this.meta.ideContext = !!m.on; this.postMeta(); }
      else if (m.type === 'openDiff' && typeof m.diff === 'string') openDiff(m.diff, this.meta.cwd);
      else if (m.type === 'command' && this.room && typeof m.text === 'string') this.runCommand(m.text);
      else if (m.type === 'attachData' && typeof m.data === 'string') this.addAttachment({ name: m.name, data: m.data });
      else if (m.type === 'attachUris' && Array.isArray(m.uris)) m.uris.forEach((u) => { try { this.addAttachment({ name: path.basename(vscode.Uri.parse(u).fsPath), fromPath: vscode.Uri.parse(u).fsPath }); } catch (e) { this.post({ type: 'attachError', text: e.message }); } });
      else if (m.type === 'pickFiles') vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' }).then((uris) => (uris || []).forEach((u) => this.addAttachment({ name: path.basename(u.fsPath), fromPath: u.fsPath })));
      else if (m.type === 'unattach') { const a = this.pendingAtts.get(m.id); if (a) { this.pendingAtts.delete(m.id); fs.rm(a.path, () => {}); } }
      else if (m.type === 'stop' && this.room) this.room.stopAll();
      else if (m.type === 'session' && this.room && ['claude', 'codex'].includes(m.vendor) && ['new', 'continue', 'fork'].includes(m.action)) this.switchSession(m.vendor, m.action).catch((e) => this.room.note(`Couldn't switch the working session: ${e.message}`));
      else if (m.type === 'taskPause' && this.room) this.room.pauseTask();
      else if (m.type === 'taskResume' && this.room) this.room.resumeTask();
      else if (m.type === 'taskMode' && this.room && ['auto', 'chat', 'work'].includes(m.mode)) { this.room.tasks.mode = m.mode; this.room.note(`Mode: ${MODE_TEXT[m.mode]}`); this.postTask(); }
      else if ((m.type === 'taskLimits' || m.type === 'taskDefaults') && this.room && m.limits) {
        const lim = cleanLimits(m.limits);
        if (m.type === 'taskLimits') this.room.setTaskLimits(lim);
        else { this.room.tasks.setDefaults(lim); vscode.workspace.getConfiguration('wagonCircle').update('taskDefaults', this.room.tasks.defaults, vscode.ConfigurationTarget.Global); this.room.note(`Saved as your defaults for new tasks: ${lim.turns} turns (${lim.reserve} kept for wrapping up), ${lim.minutes} minutes. Tasks already running keep their own settings.`); }
        this.postTask();
      }
    });
    panel.onDidDispose(() => this.dispose());
  }

  post(msg) { if (this.panel) this.panel.webview.postMessage(msg); }

  // Working session picker. New starts fresh; Fork branches a copy (the original is never written); Continue
  // resumes the chosen session itself, so the human is warned first: Wagon Circle cannot see whether another
  // Claude Code or Codex window has it open. Switches wait for the agent to be idle; the room's cursor, tasks and
  // allowances stay, and the room history is not replayed into the new session.
  async switchSession(vendor, action) {
    const room = this.room, m = this.meta, L = vendor === 'claude' ? 'Claude' : 'Codex';
    if (room.busy[vendor]) { room.note(`${L} is working; switch its session when it finishes.`); return; }
    let pick = null;
    if (action !== 'new') {
      const items = vendor === 'claude'
        ? claudeHistory.listSessions(40).filter((x) => x.cwd === m.cwd && x.id !== this.claude.sessionId).map((x) => ({ label: x.title || x.preview, description: `claude ${x.id.slice(0, 8)} · ${new Date(x.mtime).toLocaleString()}`, id: x.id, mtime: x.mtime, name: x.title || x.preview }))
        : (await this.codex.listThreads(null, 40)).filter((t) => t.id !== m.codexThreadId).map((t) => ({ label: t.name || (t.preview || '').slice(0, 80) || t.id, description: `codex ${t.id.slice(0, 8)}`, detail: t.cwd, id: t.id, mtime: t.updatedAt ? t.updatedAt * 1000 : null, name: t.name || t.preview }));
      if (!items.length) { room.note(vendor === 'claude' ? `No other Claude sessions from ${m.cwd}. Claude can only resume sessions started in the room's folder.` : 'No other Codex threads found.'); return; }
      pick = await vscode.window.showQuickPick(items, { title: `${L} working session: ${action === 'fork' ? 'fork (the original stays untouched)' : 'continue (writes to that session)'}`, matchOnDescription: true });
      if (!pick) return;
      if (action === 'continue') {
        const recent = pick.mtime && Date.now() - pick.mtime < 120000;
        const go = await vscode.window.showWarningMessage(`Continue "${String(pick.name || pick.id).slice(0, 60)}" in this room?`,
          { modal: true, detail: `${recent ? 'It changed in the last two minutes, so it may be open elsewhere right now. ' : ''}Wagon Circle will write to this ${L} session directly. If another ${L} window has it open, both will write to it and neither sees the other's turns. Close it there first, or fork it instead.` },
          'Continue', 'Fork instead');
        if (!go) return;
        if (go === 'Fork instead') action = 'fork';
      }
    }
    if (room.busy[vendor]) { room.note(`${L} started working; switch its session when it finishes.`); return; }
    const human = m.humanName || 'You';
    if (vendor === 'claude') {
      this.claude.stop();
      this.claude.sessionId = action === 'continue' ? pick.id : null;
      this.claude.forkFrom = action === 'fork' ? pick.id : null;
      m.claudeSessionId = this.claude.sessionId;
    } else {
      let t;
      if (action === 'new') t = await this.codex.startThread(roomPrompt('codex', 'claude', human, true));
      else if (action === 'fork') t = await this.codex.forkThread(pick.id, roomPrompt('codex', 'claude', human));
      else t = await this.codex.resumeThread(pick.id);
      m.codexThreadId = t.id;
      if (action === 'new') m.codexTypedThreads = [...(m.codexTypedThreads || []), t.id];
      // Only threads this room started carry the typed tools (app-server takes them on thread/start only).
      m.codexTyped = (m.codexTypedThreads || []).includes(t.id);
      room.agents.codex.typed = m.codexTyped;
    }
    const what = action === 'new' ? 'a new session' : action === 'fork' ? `a fork of ${pick.id.slice(0, 8)}` : `${pick.id.slice(0, 8)}, continued`;
    room.note(`${L}'s working session is now ${what}. Room tasks and allowances carry over; earlier room messages are not replayed into it.${vendor === 'codex' && !m.codexTyped ? ' This thread has no typed request tool, so Codex\'s hand-offs show as suggestions for you to send.' : ''}`);
    this.postMeta(); this.postTask();
  }

  postTask() {
    if (!this.room) return;
    const t = this.room.tasks;
    this.post({ type: 'task', task: t.summary(), mode: t.mode, defaults: t.defaults, presets: PRESETS, typed: { claude: true, codex: !!this.meta.codexTyped } });
  }

  claudeFastOk(model) {
    const cat = commands.CLAUDE_CATALOG.find((x) => x.id === model);
    return !!(cat && cat.fast && atLeast(this.claudeVersion, '2.1.205'));
  }

  // What the pickers show: each vendor's models, efforts and fast mode, gated by what this machine can run.
  controls() {
    const m = this.meta, v = this.claudeVersion;
    const codexModels = (this.codexModels || []).map((x) => ({ id: x.id, name: x.displayName, efforts: x.supportedReasoningEfforts.map((e) => e.reasoningEffort), defaultEffort: x.defaultReasoningEffort, fast: (x.serviceTiers || []).find((t) => t.id === 'priority') || null }));
    return {
      claude: { session: this.claude ? this.claude.sessionId || this.claude.forkFrom : m.claudeSessionId, typed: true, cli: v ? v.join('.') : '?', model: m.claudeModel, effort: m.claudeEffort || null, fast: !!m.claudeFast, efforts: commands.CLAUDE_EFFORTS,
        models: commands.CLAUDE_CATALOG.map((x) => ({ ...x, available: atLeast(v, x.minCli), blocked: claudeUsage.blockFor(this.claudeUsage, x.name), fastOk: !!x.fast && atLeast(v, '2.1.205') })) },
      codex: { session: m.codexThreadId, typed: !!m.codexTyped, model: m.codexModel || (codexModels[0] && codexModels[0].id) || null, effort: m.codexEffort || null, fast: !!m.codexFast, models: codexModels }
    };
  }

  cmdSpecs() { return commands.specs({ codexModels: this.codexModels || [], codexModel: this.meta.codexModel }); }

  postMeta() { this.save(); this.post({ type: 'meta', meta: this.meta, commands: this.cmdSpecs(), controls: this.controls() }); }

  async runCommand(text) {
    const room = this.room, m = this.meta;
    const { spec, arg, error } = commands.parse(text, this.cmdSpecs());
    if (error) { room.note(error); return; }
    const say = (t) => room.note(t);
    switch (spec.cmd) {
      case '/help': {
        const lines = []; let g = null;
        for (const s of this.cmdSpecs()) { if (s.group !== g) { g = s.group; lines.push(`${g}:`); } lines.push(`  ${s.cmd}${s.args ? ' <' + s.args.slice(0, 4).join('|') + (s.args.length > 4 ? '|…' : '') + '>' : ''}: ${s.desc}`); }
        say(lines.join('\n')); return;
      }
      case '/stop': room.stopAll(); return;
      case '/default': {
        room.defaultTarget = m.defaultTarget = arg;
        const L = { claude: 'Claude', codex: 'Codex' };
        say(arg === 'both' ? 'Both agents now lead together: messages with no @mention go to both, taking turns.'
          : `${L[arg]} is now the lead: messages with no @mention go to ${L[arg]}, and ${L[arg]} drives the work. ${L[arg === 'claude' ? 'codex' : 'claude']} helps when asked or handed something.`);
        break;
      }
      case '/both': room.bothMode = m.bothMode = arg; say(arg === 'sequential' ? '@both now takes turns: the second agent sees the first answer and builds on it.' : '@both now answers at once; the agents do not see each other\'s replies until later.'); break;
      case '/hops': room.hopCap = m.hopCap = Number(arg); say(`Agent-to-agent hand-offs are now capped at ${arg} per message.`); break;
      case '/claude fast': {
        const on = arg === 'on';
        if (on && !this.claudeFastOk(m.claudeModel)) { say(atLeast(this.claudeVersion, '2.1.205') ? 'Fast mode needs Opus 5.5. Switch with /claude model claude-opus-5-5 first.' : `Fast mode needs Claude Code 2.1.205 or newer; this CLI is ${this.claudeVersion ? this.claudeVersion.join('.') : 'unknown'}.`); break; }
        m.claudeFast = on; this.claude.setOptions({ fast: on });
        say(on ? 'Claude fast mode on: up to 2.5x faster Opus, billed to your usage credits (not your plan). If credits run out it falls back to normal speed.' : 'Claude fast mode off.'); break;
      }
      case '/codex fast': m.codexFast = arg === 'on'; say(m.codexFast ? 'Codex fast mode on (priority tier): faster, uses more of your Codex quota.' : 'Codex fast mode off.'); break;
      case '/claude model': case '/claude effort': {
        const key = spec.cmd.endsWith('model') ? 'model' : 'effort';
        const cat = commands.CLAUDE_CATALOG.find((x) => x.id === arg);
        const blocked = key === 'model' && cat && claudeUsage.blockFor(this.claudeUsage, cat.name);
        if (blocked) { say(`${cat.name} isn't available right now: ${blocked}. Staying on ${m.claudeModel}.`); break; }
        if (key === 'model' && m.claudeFast && !this.claudeFastOk(arg)) { m.claudeFast = false; this.claude.setOptions({ fast: false }); say('Fast mode is Opus-only, so it is now off.'); }
        m[key === 'model' ? 'claudeModel' : 'claudeEffort'] = arg; this.claude.setOptions({ [key]: arg });
        say(`Claude ${key} set to ${arg}. It restarts on the same session${room.busy.claude ? ' after its current reply' : ''}, so it keeps its memory.`); break;
      }
      case '/codex model': {
        m.codexModel = arg;
        const model = (this.codexModels || []).find((x) => x.id === arg);
        if (m.codexEffort && model && !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === m.codexEffort)) { say(`${arg} doesn't support effort ${m.codexEffort}; using its default (${model.defaultReasoningEffort}).`); m.codexEffort = null; }
        say(`Codex model set to ${arg} from the next turn.`); break;
      }
      case '/codex effort': m.codexEffort = arg; say(`Codex effort set to ${arg} from the next turn.`); break;
      case '/claude compact': case '/codex compact': {
        const who = spec.cmd.startsWith('/claude') ? 'claude' : 'codex';
        if (room.busy[who]) { say(`${who === 'claude' ? 'Claude' : 'Codex'} is busy; try again when it finishes.`); return; }
        room.busy[who] = true; room.emit('status', { name: who, busy: true, since: Date.now() }); room.emit('activity', { name: who, phase: 'thinking', label: 'compacting context' });
        try { if (who === 'claude') await this.claude.compact(); else await this.codex.compact(m.codexThreadId); say(`${who === 'claude' ? 'Claude' : 'Codex'} compacted its context.`); }
        catch (e) { say(`${who === 'claude' ? 'Claude' : 'Codex'} compact failed: ${e.message}`); }
        finally { room.busy[who] = false; room.emit('status', { name: who, busy: false }); room.emit('draft', { name: who, text: null }); if (room.pending[who]) { room.pending[who] = false; room.deliver(who); } }
        break;
      }
    }
    this.postMeta();
  }

  postInit() {
    this.post({ type: 'ide', summary: ideContext.summary(ideSnapshot(this.meta.cwd)) });
    if (this.claudeUsage) this.post({ type: 'claudeUsage', usage: this.claudeUsage });
    this.postTask();
    this.post({ type: 'init', meta: this.meta, commands: this.cmdSpecs(), controls: this.room ? this.controls() : null, transcript: this.room ? this.room.state.transcript.map((e) => this.view(e)) : [], busy: this.room ? this.room.busy : {}, quota: this.quota, cost: this.claude ? this.claude.totalCostUsd : 0 });
  }

  // Webview copy of an attachment: image thumbnails get a webview-safe URL.
  viewAtt(a) { return { ...a, src: a.kind === 'image' && this.panel ? this.panel.webview.asWebviewUri(vscode.Uri.file(a.path)).toString() : null }; }
  view(entry) { return entry.attachments ? { ...entry, attachments: entry.attachments.map((a) => this.viewAtt(a)) } : entry; }

  addAttachment(spec) {
    try {
      const a = attachments.store(this.attDir, spec);
      this.pendingAtts.set(a.id, a);
      this.post({ type: 'attached', att: this.viewAtt(a) });
    } catch (e) { this.post({ type: 'attachError', text: e.message }); }
  }

  dispose() { sessions.delete(this); if (this.scheduler) this.scheduler.dispose(); this.save(); if (this.codex) this.codex.stop(); if (this.claude) this.claude.stop(); this.panel = null; }
}

const MODE_TEXT = {
  auto: 'Auto. A task starts when an agent asks the other for help; the task keeps turn and time allowances.',
  chat: 'Chat. Each message allows one consultation between the agents, with no task.',
  work: 'Work. Each message starts a task, with its allowances, even before the agents ask each other anything.'
};
const cleanLimits = (l) => {
  const n = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const turns = n(l.turns, 1, 200, 20);
  return { turns, reserve: n(l.reserve, 0, Math.max(0, turns - 1), 2), minutes: n(l.minutes, 1, 24 * 60, 30) };
};

const c_ide = () => vscode.workspace.getConfiguration('wagonCircle').get('ideContext') !== false;

// Snapshot of the last code editor: file, selection or visible lines, open tabs, problems.
// Only files inside the room's folder are shared automatically; anything else goes in with + (attach).
function ideSnapshot(root) {
  const ed = lastEditor; if (!ed || ed.document.isClosed || !root || !paths.isInside(root, ed.document.uri.fsPath)) return null;
  const doc = ed.document, sel = ed.selection;
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const lineText = (a, b) => doc.getText(new vscode.Range(a, 0, b, doc.lineAt(b).text.length));
  let selection = null, visible = null;
  if (!sel.isEmpty) selection = { start: sel.start.line + 1, end: sel.end.line + 1, text: doc.getText(sel) };
  else {
    const vr = ed.visibleRanges[0] || new vscode.Range(sel.active, sel.active);
    const a = Math.max(0, Math.min(vr.start.line, sel.active.line - 30)), b = Math.min(doc.lineCount - 1, a + ideContext.LIMITS.visibleLines - 1);
    visible = { start: a + 1, end: b + 1, text: lineText(a, b) };
  }
  const sev = ['Error', 'Warning', 'Info', 'Hint'];
  const problems = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.severity <= 1).map((d) => ({ severity: sev[d.severity], line: d.range.start.line + 1, message: d.message.split('\n')[0] }));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.uri).filter((u) => u && u.scheme === 'file' && paths.isInside(root, u.fsPath)).map((u) => vscode.workspace.asRelativePath(u, false));
  return { file: rel, language: doc.languageId, cursor: sel.active.line + 1, selection, visible, problems, tabs: [...new Set(tabs)] };
}

let ideTimer = null;
function broadcastIde() {
  clearTimeout(ideTimer);
  ideTimer = setTimeout(() => { for (const x of sessions) x.post({ type: 'ide', summary: ideContext.summary(ideSnapshot(x.meta.cwd)) }); }, 150);
}

// Show a unified diff in VS Code's diff editor: the file as it is, beside the file with the patch applied in memory.
const proposed = new Map();
async function openDiff(text, cwd) {
  const files = diffs.parse(text);
  if (!files.length) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); return vscode.window.showTextDocument(doc, { preview: true }); }
  for (const f of files.slice(0, 5)) {
    const rel = f.newPath || f.oldPath, abs = paths.resolveInside(cwd, rel);
    if (!abs) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); await vscode.window.showTextDocument(doc, { preview: true }); vscode.window.showWarningMessage(`Wagon Circle: ${rel} is outside the room's folder, so the diff opened as plain text.`); continue; }
    const original = f.oldPath && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const patched = diffs.apply(original, f.hunks);
    if (patched === null) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); await vscode.window.showTextDocument(doc, { preview: true }); vscode.window.showWarningMessage(`Wagon Circle: the diff for ${rel} no longer matches the file, so it opened as plain text.`); continue; }
    const key = `/${Date.now()}-${Math.random().toString(36).slice(2)}/${path.basename(rel)}`;
    proposed.set(key, patched);
    const left = fs.existsSync(abs) ? vscode.Uri.file(abs) : vscode.Uri.parse(`wagon-circle-proposed:/empty/${path.basename(rel)}`);
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.parse(`wagon-circle-proposed:${key}`), `${path.basename(rel)} ↔ proposed (Wagon Circle)`);
  }
}

function panelHtml(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'room.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'room.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Wagon Circle</title></head>
<body data-wc="${require('../package.json').version}"><header id="hdr"><div><div id="title"></div><div id="ids"></div></div><div id="quota"></div></header>
<main id="log" aria-live="polite"></main>
<footer><div class="dock">
<section id="task" class="task" hidden aria-live="polite"></section>
<div id="menu" role="listbox" hidden></div><div id="pop" class="pop" hidden></div>
<div class="composer"><div class="composer-in">
<div id="tray" hidden></div>
<textarea id="input" rows="1" aria-label="Message" placeholder="Message Claude and Codex…   @ to mention · / for commands"></textarea>
<div class="tools">
<button id="attach" class="icon" title="Attach files (or paste a screenshot, or Shift-drag files in)" aria-label="Attach files">+</button>
<button id="ide" class="chip ide" title="IDE context: what you are looking at in VS Code is attached to your message. Click to turn off."></button>
<button id="vc-claude" class="chip vendor claude" aria-haspopup="true"></button>
<button id="vc-codex" class="chip vendor codex" aria-haspopup="true"></button>
<button id="lead" class="chip lead" aria-haspopup="true" title="Who leads: messages without an @mention go to the lead"></button>
<button id="tc" class="chip tc" aria-haspopup="true" title="Task controls: mode and allowances"></button>
<span id="who"></span>
<button id="stop" class="round stop" title="Stop both agents" aria-label="Stop" hidden>■</button>
<button id="send" class="round send" title="Send (Enter)" aria-label="Send">↑</button>
</div></div></div>
<div class="hint">Untagged messages go to <span id="deftarget">Claude</span> · @ to mention · / for commands · Enter to send, Shift+Enter for a new line</div>
</div></footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

async function openSession(context, session, opts) {
  const panel = vscode.window.createWebviewPanel('wagonCircle', `Wagon Circle: ${session.meta.name}`, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.globalStorageUri, 'rooms')]
  });
  panel.webview.html = panelHtml(panel.webview, context.extensionUri);
  session.attach(panel);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Wagon Circle: starting Codex and Claude…' }, () => session.boot(opts));
    session.postInit();
  } catch (e) {
    log(`boot failed: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Wagon Circle could not start: ${e.message}`);
    session.post({ type: 'notice', text: `Could not start: ${e.message}` });
  }
}

function newMeta(name) {
  return { id: crypto.randomUUID(), name, cwd: settings().cwd, createdAt: new Date().toISOString(), codexThreadId: null, claudeSessionId: null };
}

function activate(context) {
  output = vscode.window.createOutputChannel('Wagon Circle');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('wagon-circle-proposed', { provideTextDocumentContent: (uri) => proposed.get(uri.path) || '' }));
  const track = (ed) => { if (ed && ed.document.uri.scheme === 'file') { lastEditor = ed; broadcastIde(); } };
  track(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(track), vscode.window.onDidChangeTextEditorSelection((e) => track(e.textEditor)), vscode.window.onDidChangeTextEditorVisibleRanges((e) => track(e.textEditor)));

  context.subscriptions.push(vscode.commands.registerCommand('wagonCircle.newRoom', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Room name', value: `Room ${new Date().toLocaleDateString()}` });
    if (!name) return;
    await openSession(context, new RoomSession(context, newMeta(name), null), {});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('wagonCircle.joinExisting', async () => {
    const FRESH = { label: '$(add) Start fresh', description: 'no earlier conversation' };
    const probe = new CodexClient({ exe: settings().codexExe, cwd: settings().cwd, log });
    let threads = [];
    try { await probe.start(); threads = await probe.listThreads(null, 30); } catch (e) { log(`codex list: ${e.message}`); } finally { probe.stop(); }
    const cx = await vscode.window.showQuickPick([FRESH, ...threads.map((t) => ({ label: t.name || (t.preview || '').slice(0, 80) || t.id, description: `codex ${t.id.slice(0, 8)}`, detail: t.cwd, t }))],
      { title: 'Wagon Circle (1/2): Codex side', placeHolder: 'Fork a Codex thread into the room? The original is never written to.', matchOnDetail: true });
    if (!cx) return;
    const sessions = claudeHistory.listSessions(30);
    const cl = await vscode.window.showQuickPick([FRESH, ...sessions.map((s) => ({ label: s.title || s.preview, description: `claude ${s.id.slice(0, 8)} · ${new Date(s.mtime).toLocaleString()}`, detail: s.cwd, s }))],
      { title: 'Wagon Circle (2/2): Claude side', placeHolder: 'Fork a Claude session into the room? The original is never written to.', matchOnDetail: true });
    if (!cl) return;
    if (!cx.t && !cl.s) { vscode.commands.executeCommand('wagonCircle.newRoom'); return; }
    const name = `with ${[cx.t && cx.label, cl.s && cl.label].filter(Boolean).map((l) => l.slice(0, 30)).join(' + ')}`;
    const meta = newMeta(name);
    // claude --resume only finds a session from its own project folder, so a forked Claude session sets the room's folder.
    if (cl.s) meta.cwd = cl.s.cwd;
    await openSession(context, new RoomSession(context, meta, null), { forkFrom: cx.t || null, claudeFrom: cl.s || null });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('wagonCircle.openRoom', async () => {
    const dir = path.join(context.globalStorageUri.fsPath, 'rooms');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    const rooms = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.meta.createdAt).localeCompare(String(a.meta.createdAt)));
    if (!rooms.length) { vscode.window.showInformationMessage('No saved rooms yet.'); return; }
    const pick = await vscode.window.showQuickPick(rooms.map((r) => ({ label: r.meta.name, description: new Date(r.meta.createdAt).toLocaleString(), r })));
    if (!pick) return;
    await openSession(context, new RoomSession(context, pick.r.meta, pick.r.state), {});
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, roomPrompt, AGENTS };
