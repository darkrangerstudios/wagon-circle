// Start a Room: one screen instead of a chain of pop-up questions. Plain English, a short line under every choice.
// Security: everything shown comes from the extension host and is rendered with textContent only (no innerHTML).
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const NAME = { claude: 'Claude', codex: 'Codex' };
  const APP = { claude: 'Claude Code', codex: 'Codex' };
  const MAX = 6;
  const S = { init: false, name: '', folder: '', folderLabel: '', agents: [], setup: null, lists: null, busy: false, error: '', existing: false };

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const help = (text) => el('div', 'help', text);
  const ago = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 172800) return 'yesterday'; if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const agent = (provider, n) => ({ provider, label: n > 1 ? `${NAME[provider]} ${n}` : NAME[provider], model: '', effort: '', start: S.existing ? 'copy' : 'fresh',
    conversation: null, share: false, search: '', folder: S.folder, folderLabel: S.folderLabel });
  const countOf = (p) => S.agents.filter((a) => a.provider === p).length;
  const convs = (p) => (S.lists && S.lists.conversations[p]) || [];
  const models = (p) => (S.lists && S.lists.models[p]) || [];
  const picked = (a) => convs(a.provider).find((c) => c.id === a.conversation) || null;
  const bringsIn = (a) => a.start !== 'fresh';

  // Re-rendering replaces the page; keep the caret where the person was typing.
  function render() {
    const f = document.activeElement, key = f && f.dataset ? f.dataset.key : null, caret = f && typeof f.selectionStart === 'number' ? f.selectionStart : null;
    app.textContent = '';
    if (!S.init) { app.appendChild(el('p', 'muted', 'Loading…')); return; }
    const head = el('header');
    head.appendChild(el('h1', null, 'Start a room'));
    head.appendChild(el('p', 'lede', 'Pick the AI agents you want to talk to together. They can read files in their folder. They can\'t edit files or change anything on your computer.'));
    app.appendChild(head);

    const who = el('section'); who.appendChild(el('h2', null, 'Who\'s in the room'));
    S.agents.forEach((a, i) => who.appendChild(card(a, i)));
    const adds = el('div', 'adds');
    for (const p of ['claude', 'codex']) {
      const b = el('button', 'ghost', `+ Add ${NAME[p]}`);
      b.title = `Add another ${NAME[p]}. Each agent has its own separate conversation.`;
      b.disabled = S.agents.length >= MAX;
      b.addEventListener('click', () => { S.agents.push(agent(p, countOf(p) + 1)); render(); });
      adds.appendChild(b);
    }
    if (S.agents.length >= MAX) adds.appendChild(help(`A room holds up to ${MAX} agents.`));
    who.appendChild(adds); app.appendChild(who);

    const nm = el('section'); nm.appendChild(el('h2', null, 'Name the room'));
    const input = el('input', 'text'); input.value = S.name; input.dataset.key = 'room-name'; input.maxLength = 80; input.setAttribute('aria-label', 'Room name');
    input.addEventListener('input', () => { S.name = input.value; });
    nm.appendChild(input); nm.appendChild(help('Rooms are saved. You can reopen this one later from the Wagon Wheel panel on the left.'));
    app.appendChild(nm);

    const foot = el('footer');
    const summary = el('p', 'summary', summaryText()); foot.appendChild(summary);
    if (S.error) { const e = el('div', 'error', S.error); e.setAttribute('role', 'alert'); foot.appendChild(e); }
    const notReady = S.agents.filter((a) => S.setup && S.setup[a.provider] && !S.setup[a.provider].ready).map((a) => a.label);
    if (notReady.length) foot.appendChild(help(`${notReady.join(' and ')} ${notReady.length > 1 ? 'aren\'t' : 'isn\'t'} ready yet and won't be able to answer until ${notReady.length > 1 ? 'they are' : 'it is'}. You can still start the room.`));
    const go = el('button', 'primary', S.busy ? 'Starting…' : 'Start room'); go.disabled = S.busy;
    go.addEventListener('click', start);
    foot.appendChild(go); app.appendChild(foot);

    if (key) { const back = app.querySelector(`[data-key="${CSS.escape(key)}"]`); if (back) { back.focus(); if (caret != null && back.setSelectionRange) try { back.setSelectionRange(caret, caret); } catch { /* not a text field */ } } }
  }

  function statusLine(a) {
    const box = el('div', 'status');
    const st = S.setup && S.setup[a.provider];
    if (!S.setup) { box.appendChild(el('span', 'dot wait')); box.appendChild(el('span', 'muted', `Checking ${APP[a.provider]}…`)); return box; }
    if (!st) { box.appendChild(el('span', 'dot wait')); box.appendChild(el('span', 'muted', 'Couldn\'t check this app.')); return box; }
    box.appendChild(el('span', `dot ${st.ready ? 'ok' : 'bad'}`));
    box.appendChild(el('span', st.ready ? null : 'warn', st.text));
    if (st.fix) {
      const g = el('button', 'link', st.fix === 'signin' ? 'How to sign in' : 'How to install');
      g.title = `Opens the official ${APP[a.provider]} guide in your browser.`;
      g.addEventListener('click', () => vscode.postMessage({ type: 'guide', provider: a.provider }));
      box.appendChild(g);
      const r = el('button', 'link', 'Check again'); r.title = 'Run the check again after you install or sign in.';
      r.addEventListener('click', () => { S.setup = null; render(); vscode.postMessage({ type: 'recheck' }); });
      box.appendChild(r);
    }
    return box;
  }

  function card(a, i) {
    const c = el('div', `card ${a.provider}`);
    const top = el('div', 'row top');
    top.appendChild(el('span', `badge ${a.provider}`, NAME[a.provider]));
    const name = el('input', 'text name'); name.value = a.label; name.maxLength = 60; name.dataset.key = `label-${i}`; name.setAttribute('aria-label', `${NAME[a.provider]} agent name`);
    name.title = 'What you and the other agents call it. Type @ and this name in the room to talk to it directly.';
    name.addEventListener('input', () => { a.label = name.value; });
    top.appendChild(name);
    if (S.agents.length > 1) { const rm = el('button', 'link', 'Remove'); rm.title = 'Take this agent out of the room.'; rm.addEventListener('click', () => { S.agents.splice(i, 1); render(); }); top.appendChild(rm); }
    c.appendChild(top);
    c.appendChild(statusLine(a));

    // Model and thinking effort.
    const mrow = el('div', 'row');
    const ms = el('select'); ms.setAttribute('aria-label', 'Model'); ms.title = 'Which model this agent uses. "Your default" uses whatever the app is set to.';
    ms.appendChild(new Option('Model: your default', ''));
    for (const m of models(a.provider)) ms.appendChild(new Option(m.note ? `${m.name} (${m.note})` : m.name, m.id));
    ms.value = a.model;
    ms.addEventListener('change', () => { a.model = ms.value; const ok = efforts(a); if (a.effort && !ok.includes(a.effort)) a.effort = ''; render(); });
    const es = el('select'); es.setAttribute('aria-label', 'Thinking'); es.title = 'More thinking is slower and uses more of your plan, but handles harder problems.';
    es.appendChild(new Option('Thinking: default', ''));
    for (const e of efforts(a)) es.appendChild(new Option(`Thinking: ${e}`, e));
    es.value = a.effort; es.addEventListener('change', () => { a.effort = es.value; });
    mrow.appendChild(ms); mrow.appendChild(es); c.appendChild(mrow);
    if (!S.lists) c.appendChild(help('Loading models…'));

    // Where it starts.
    c.appendChild(el('div', 'label', 'Starts with'));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup');
    for (const [v, text, tip] of [['fresh', 'A fresh conversation', 'A brand-new conversation that knows nothing yet.'],
      ['copy', `One of your ${NAME[a.provider]} conversations`, `Bring in a conversation you already had in ${APP[a.provider]}, so this agent picks up where you left off.`]]) {
      const on = v === 'fresh' ? a.start === 'fresh' : a.start !== 'fresh';
      const b = el('button', on ? 'on' : null, text); b.title = tip; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => { a.start = v === 'fresh' ? 'fresh' : (a.start === 'original' ? 'original' : 'copy'); render(); });
      seg.appendChild(b);
    }
    c.appendChild(seg);
    if (bringsIn(a)) c.appendChild(chooser(a, i));

    // Folder.
    const frow = el('div', 'row folder');
    const conv = bringsIn(a) ? picked(a) : null;
    const locked = conv && (a.provider === 'claude' || conv.folder);
    frow.appendChild(el('span', 'label inline', 'Works in'));
    frow.appendChild(el('code', null, locked ? conv.folder : a.folderLabel || a.folder));
    if (!locked) { const ch = el('button', 'link', 'Change…'); ch.title = 'Choose a different folder for this agent.'; ch.addEventListener('click', () => vscode.postMessage({ type: 'pickFolder', index: i })); frow.appendChild(ch); }
    c.appendChild(frow);
    c.appendChild(help(locked ? 'Uses the folder where this conversation started, so it can pick up where it left off.' : 'It can read files in this folder and its subfolders.'));
    return c;
  }

  function efforts(a) {
    const ms = models(a.provider);
    const m = ms.find((x) => x.id === a.model) || (a.provider === 'codex' ? ms[0] : ms[0]);
    return (m && m.efforts) || [];
  }

  function chooser(a, i) {
    const box = el('div', 'chooser');
    if (!S.lists) { box.appendChild(help(`Loading your ${NAME[a.provider]} conversations…`)); return box; }
    const all = convs(a.provider);
    if (!all.length) { box.appendChild(help(`No ${NAME[a.provider]} conversations found on this computer. Start fresh instead.`)); return box; }
    const q = el('input', 'text search'); q.placeholder = `Search your ${NAME[a.provider]} conversations`; q.value = a.search; q.dataset.key = `search-${i}`;
    q.setAttribute('aria-label', `Search ${NAME[a.provider]} conversations`);
    q.addEventListener('input', () => { a.search = q.value; render(); });
    box.appendChild(q);
    const needle = a.search.trim().toLowerCase();
    const shown = all.filter((cv) => !needle || cv.title.toLowerCase().includes(needle) || cv.folder.toLowerCase().includes(needle)).slice(0, 40);
    const list = el('div', 'list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${NAME[a.provider]} conversations`);
    for (const cv of shown) {
      const on = a.conversation === cv.id;
      const item = el('button', `item${on ? ' on' : ''}`); item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(on));
      item.appendChild(el('span', 't', cv.title));
      item.appendChild(el('span', 'm', [cv.folder, ago(cv.when)].filter(Boolean).join(' · ')));
      item.addEventListener('click', () => { a.conversation = cv.id; render(); });
      list.appendChild(item);
    }
    if (!shown.length) list.appendChild(help('Nothing matches that search.'));
    box.appendChild(list);
    if (!picked(a)) { box.appendChild(help('Pick a conversation above.')); return box; }

    const how = el('div', 'how'); how.setAttribute('role', 'radiogroup');
    for (const [v, text, sub] of [['copy', 'Work on a copy (recommended)', 'Your original conversation stays exactly as it is. The agent continues from a copy.'],
      ['original', 'Keep going in the original', `Adds to your original conversation. Only choose this if it isn't open in ${APP[a.provider]} or another window right now.`]]) {
      const b = el('button', `opt${a.start === v ? ' on' : ''}`); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(a.start === v));
      b.appendChild(el('span', 'o', text)); b.appendChild(el('span', 's', sub));
      b.addEventListener('click', () => { a.start = v; render(); });
      how.appendChild(b);
    }
    box.appendChild(how);
    const share = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = a.share;
    cb.addEventListener('change', () => { a.share = cb.checked; });
    share.appendChild(cb); share.appendChild(el('span', null, 'Let the other agents read its last few messages'));
    share.title = 'Shares the last 8 exchanges of this conversation with the other agents in the room, so everyone starts on the same page.';
    box.appendChild(share);
    box.appendChild(help('Off by default. Nothing else from the conversation is shared.'));
    if (a.provider === 'codex') box.appendChild(help('A Codex conversation you bring in can\'t use the room\'s built-in hand-off tools, so the other agents reach it with @mentions instead.'));
    return box;
  }

  function summaryText() {
    if (!S.agents.length) return 'Add at least one agent.';
    const part = (a) => {
      if (!bringsIn(a)) return `${a.label || NAME[a.provider]} (fresh)`;
      const cv = picked(a);
      return `${a.label || NAME[a.provider]} (${a.start === 'original' ? 'your original' : 'a copy'} of "${cv ? cv.title.slice(0, 40) : '…'}")`;
    };
    const names = S.agents.map(part);
    return `Starting ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}.`;
  }

  function start() {
    S.error = '';
    vscode.postMessage({ type: 'start', form: { name: S.name, agents: S.agents.map((a) => ({ provider: a.provider, label: a.label, model: a.model || null, effort: a.effort || null,
      start: a.start, conversation: bringsIn(a) ? a.conversation : null, folder: a.folder, share: bringsIn(a) && a.share })) } });
  }

  window.addEventListener('message', ({ data: m }) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      S.init = true; S.existing = !!m.existing; S.name = m.defaults.name; S.folder = m.defaults.folder; S.folderLabel = m.defaults.folderLabel;
      S.agents = [agent('claude', 1), agent('codex', 1)];
    } else if (m.type === 'mode') { if (m.existing) for (const a of S.agents) if (a.start === 'fresh') a.start = 'copy'; }
    else if (m.type === 'setup') S.setup = { claude: m.claude, codex: m.codex };
    else if (m.type === 'lists') S.lists = { conversations: m.conversations || { claude: [], codex: [] }, models: m.models || { claude: [], codex: [] } };
    else if (m.type === 'folder' && S.agents[m.index]) { S.agents[m.index].folder = m.folder; S.agents[m.index].folderLabel = m.folderLabel; }
    else if (m.type === 'busy') S.busy = !!m.on;
    else if (m.type === 'error') S.error = String(m.text || 'Something went wrong.');
    else return;
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
