'use strict';
// Start a Room: the plain-English setup screen. This module is pure: it turns what the screen sends into a validated
// room plan, and turns setup checks into the sentences the screen shows. The screen is our own page, but everything
// it sends is still checked here: a conversation must be one the host listed, folders must exist, the roster must
// pass normalizeParticipants.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeParticipants } = require('./participants');
const { CLAUDE_MODELS, CLAUDE_EFFORTS } = require('./commands');

const PROVIDERS = ['claude', 'codex'];
const NAMES = { claude: 'Claude', codex: 'Codex' };
const APPS = { claude: 'Claude Code', codex: 'Codex' };
const MAX_AGENTS = 6;
const STARTS = ['fresh', 'copy', 'original'];
const RESERVED = new Set(['both', 'all', 'human', 'system']);

// Setup check result -> { ready, text, fix } in plain English for one provider card.
function setupLine(p) {
  if (!p) return { ready: false, text: 'Not checked yet.', fix: null };
  if (p.installation === 'missing' || p.issue === 'missing') return { ready: false, text: `${APPS[p.provider]} isn't installed on this computer.`, fix: 'install' };
  if (p.issue === 'not-executable') return { ready: false, text: `${APPS[p.provider]} is installed but can't be started.`, fix: 'install' };
  if (p.installation !== 'available') return { ready: false, text: `Couldn't check ${APPS[p.provider]}. It may still work.`, fix: 'install' };
  if (p.authentication === 'signed-out') return { ready: false, text: `${APPS[p.provider]} ${p.version} is installed, but you're signed out.`, fix: 'signin' };
  if (p.authentication === 'present') return { ready: true, text: `Ready: ${APPS[p.provider]} ${p.version}, signed in.`, fix: null };
  return { ready: true, text: `${APPS[p.provider]} ${p.version} is installed. Sign-in couldn't be confirmed.`, fix: null };
}

// A conversation row for the screen: title, folder (home shortened to ~) and when it was last used.
function conversationRow(c, home = os.homedir()) {
  const clean = (v, max) => String(v || '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
  const folder = typeof c.cwd === 'string' ? (home && c.cwd.startsWith(home) ? `~${c.cwd.slice(home.length)}` : c.cwd) : '';
  return { id: c.id, title: clean(c.title, 120) || 'Untitled conversation', folder: clean(folder, 200), when: Number.isFinite(c.when) ? c.when : null };
}

function slug(label, provider, taken) {
  let s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  if (!/^[a-z]/.test(s) || RESERVED.has(s) || /^h[0-9]+$/.test(s)) s = provider;
  let id = s, n = 2;
  while (taken.has(id)) id = `${s}-${n++}`;
  taken.add(id);
  return id;
}

const isDir = (p) => { try { return path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

// form: { name, agents: [{ provider, label, model, effort, start, conversation, folder, share }] }
// lists: { claude: [{ id, cwd, when }], codex: [...] } exactly as the host sent them; codexModels: [{ id, efforts }].
// Returns { name, seats, shareSeed, originals } or throws an Error whose message the screen shows as is.
function buildPlan(form, { lists = {}, codexModels = [], defaultCwd, settings = {} } = {}) {
  const fail = (m) => { throw new Error(m); };
  if (!form || typeof form !== 'object' || !Array.isArray(form.agents)) fail('Something went wrong reading the form. Close this tab and try again.');
  const name = typeof form.name === 'string' && form.name.trim() ? form.name.trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80) : '';
  if (!name) fail('Give the room a name.');
  if (form.agents.length < 1) fail('Add at least one agent.');
  if (form.agents.length > MAX_AGENTS) fail(`A room can have up to ${MAX_AGENTS} agents.`);
  const taken = new Set(), originals = new Set(), seats = [], shareSeed = {}, picked = [];
  form.agents.forEach((a, i) => {
    const n = i + 1;
    if (!a || !PROVIDERS.includes(a.provider)) fail(`Agent ${n}: choose Claude or Codex.`);
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    if (!label || label.length > 60 || /[\x00-\x1f\x7f-\x9f]/.test(label)) fail(`Agent ${n}: give it a name of 1 to 60 characters.`);
    const start = STARTS.includes(a.start) ? a.start : fail(`${label}: choose how it starts.`);
    let cwd = typeof a.folder === 'string' && a.folder ? a.folder : defaultCwd, conv = null;
    if (start !== 'fresh') {
      conv = (lists[a.provider] || []).find((c) => c.id === a.conversation);
      if (!conv) fail(`${label}: pick one of your ${NAMES[a.provider]} conversations, or start fresh.`);
      if (start === 'original') {
        const key = `${a.provider}:${conv.id}`;
        if (originals.has(key)) fail(`${label}: two agents can't both keep going in the same original conversation. Use a copy for one of them.`);
        originals.add(key);
      }
      // Claude reopens a conversation only from the folder it started in; Codex keeps its own folder when it has one.
      if (a.provider === 'claude') cwd = conv.cwd;
      else if (conv.cwd && isDir(conv.cwd)) cwd = conv.cwd;
    }
    if (!isDir(cwd)) fail(`${label}: its folder no longer exists. Choose another folder.`);
    const models = a.provider === 'claude' ? CLAUDE_MODELS : codexModels.map((m) => m.id);
    const model = a.model == null || a.model === '' ? null : models.includes(a.model) ? a.model : fail(`${label}: that model isn't available.`);
    const efforts = a.provider === 'claude' ? CLAUDE_EFFORTS : ((codexModels.find((m) => m.id === model) || codexModels[0] || {}).efforts || []);
    const effort = a.effort == null || a.effort === '' ? null : efforts.includes(a.effort) ? a.effort : fail(`${label}: that thinking effort isn't available for this model.`);
    const id = slug(label, a.provider, taken);
    const seat = { id, label, provider: a.provider, cwd, model, effort };
    if (start === 'original') seat.sessionId = conv.id;
    if (start === 'copy') seat.forkFrom = conv.id;
    if (a.provider === 'codex' && start !== 'fresh') seat.typed = false; // a Codex thread's request tools are fixed when it is created
    seats.push(seat);
    if (start !== 'fresh' && a.share === true) shareSeed[id] = true;
    if (start === 'original') picked.push({ label, provider: a.provider, id: conv.id, when: conv.when });
  });
  return { name, seats: normalizeParticipants({ seats }, settings), shareSeed, originals: picked };
}

module.exports = { buildPlan, setupLine, conversationRow, slug, MAX_AGENTS, NAMES };
