// Wagon Wheel webview. Agent output is untrusted: everything renders through textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  // The extension host keeps its code until the window reloads, but this script and the stylesheet load fresh.
  // If the page was built by a different version, say so instead of rendering a broken layout.
  const EXPECT = '0.6.1';
  if (document.body.dataset.wc !== EXPECT) {
    document.body.textContent = '';
    const box = document.createElement('div');
    box.style.cssText = 'margin:40px auto;max-width:520px;padding:18px 20px;border:1px solid var(--vscode-focusBorder);border-radius:12px;font-family:var(--vscode-font-family);line-height:1.5';
    box.textContent = `Wagon Wheel was updated (page built by ${document.body.dataset.wc || 'an older version'}, files are ${EXPECT}). Run "Developer: Reload Window" from the Command Palette, then reopen the room.`;
    document.body.appendChild(box);
    return;
  }
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input');
  const NAMES = { human: 'You', claude: 'Claude', codex: 'Codex', system: 'Wagon Wheel' };
  const GLYPH = { claude: '✳', codex: '>_' };
  const providers = { claude: 'claude', codex: 'codex' };
  const participantUsage = {}, participantCost = {};
  let busy = {}, local = null, quota = null, cusage = null, meta = {}, specs = [], controls = null, ideSummary = null;
  let pending = [];                                  // attachments waiting to be sent
  const drafts = {}, act = {}, since = {};           // in-progress replies per agent
  const menu = { items: [], sel: 0, open: false };
  let ticker = null;
  let task = null, taskMode = 'auto', taskDefaults = null, presets = {}, typedAgents = {};

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const secs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const participants = () => meta.participants || [{ id: 'claude', label: 'Claude', provider: 'claude' }, { id: 'codex', label: 'Codex', provider: 'codex' }];
  const provider = (id) => providers[id] || 'other';
  function syncParticipants() {
    NAMES.human = meta.humanName || 'You';
    for (const p of participants()) {
      NAMES[p.id] = p.label || p.id; providers[p.id] = p.provider;
      GLYPH[p.id] = p.provider === 'codex' ? '>_' : p.provider === 'claude' ? '✳' : '◆';
    }
  }
  const allLabel = () => participants().length === 2 ? 'Both' : 'Everyone';

  // ---------- message bodies: text, code fences, diffs ----------
  const looksLikeDiff = (t) => /^(---|\+\+\+) /m.test(t) && /^@@ /m.test(t);
  function diffCard(text) {
    const wrap = el('div');
    const files = []; let cur = null;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      if (line.startsWith('diff --git')) continue;
      if (line.startsWith('--- ')) { cur = { name: '', lines: [], add: 0, del: 0 }; files.push(cur); cur.old = line.slice(4).replace(/^a\//, ''); continue; }
      if (line.startsWith('+++ ') && cur && !cur.name) { const n = line.slice(4).replace(/^b\//, ''); cur.name = n === '/dev/null' ? cur.old : n; continue; }
      if (!cur) { cur = { name: 'changes', lines: [], add: 0, del: 0 }; files.push(cur); }
      if (line.startsWith('@@')) cur.lines.push(['hunk', line]);
      else if (line.startsWith('+')) { cur.lines.push(['add', line.slice(1)]); cur.add++; }
      else if (line.startsWith('-')) { cur.lines.push(['del', line.slice(1)]); cur.del++; }
      else if (line.startsWith(' ')) cur.lines.push(['ctx', line.slice(1)]);
    }
    for (const f of files) {
      const card = el('div', 'diff'), head = el('div', 'dhead');
      head.appendChild(el('span', 'dname', f.name || f.old || 'changes'));
      const right = el('span'); const st = el('span', 'dstat'); st.appendChild(el('span', 'a', `+${f.add}`)); st.appendChild(el('span', 'd', `−${f.del}`)); right.appendChild(st);
      const open = el('button', 'open', 'Open in diff editor'); open.style.marginLeft = '10px';
      open.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', diff: text }));
      right.appendChild(open); head.appendChild(right); card.appendChild(head);
      const b = el('div', 'dbody'); for (const [kind, t] of f.lines) b.appendChild(el('div', `ln ${kind}`, t)); card.appendChild(b);
      wrap.appendChild(card);
    }
    return wrap;
  }
  // Text with ``` fences. An unclosed fence (mid-stream) runs to the end. Diff fences become diff cards.
  function body(text) {
    const wrap = el('div', 'body'), s = String(text || '');
    const addText = (t) => { t = t.replace(/^\n/, '').replace(/\n$/, ''); if (t) wrap.appendChild(looksLikeDiff(t) ? diffCard(t) : el('div', 'text', t)); };
    const re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g; let m, last = 0;
    while ((m = re.exec(s))) {
      addText(s.slice(last, m.index));
      const lang = m[1].trim(), code = m[2].replace(/\n$/, '');
      wrap.appendChild(/^(diff|patch)$/i.test(lang) || looksLikeDiff(code) ? diffCard(code) : el('pre', 'code', code));
      last = re.lastIndex; if (last >= s.length) break;
    }
    addText(s.slice(last));
    return wrap;
  }
  function files(list, onRemove) {
    const row = el('div', 'files');
    for (const a of list) {
      const chip = el('div', `file kind-${a.kind}`);
      if (a.kind === 'image' && a.src) { const img = el('img'); img.alt = a.name; img.addEventListener('load', keepBottom); img.src = a.src; chip.appendChild(img); }
      chip.appendChild(el('span', 'fname', `${a.kind === 'image' ? '' : '📄 '}${a.name} · ${kb(a.size)}`));
      if (onRemove) { const x = el('button', 'x', '×'); x.setAttribute('aria-label', `Remove ${a.name}`); x.addEventListener('click', () => onRemove(a)); chip.appendChild(x); }
      row.appendChild(chip);
    }
    return row;
  }

  // ---------- rows ----------
  function agentShell(name, tag) {
    const row = el('article', `row agent ${provider(name)}`);
    row.dataset.participant = name;
    row.appendChild(el('div', `avatar ${provider(name)}`, GLYPH[name]));
    const col = el('div'); const head = el('div', 'head');
    head.appendChild(el('span', 'name', NAMES[name])); if (tag) head.appendChild(el('span', 'tag', tag));
    col.appendChild(head); row.appendChild(col);
    return { row, col, head };
  }
  function modelTag(name) {
    if (!controls) return '';
    const c = controls[name]; const m = c && (c.models || []).find((x) => x.id === c.model);
    return m ? (m.name || m.id) : (c && c.model) || '';
  }
  // Every message says when: today as "9:36 AM", then "Yesterday 9:36 PM", "Sep 22, 9:36 PM"; full date on hover.
  function stamp(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day(now) - day(d)) / 864e5);
    if (ago === 0) return t;
    if (ago === 1) return `Yesterday ${t}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })}, ${t}`;
  }
  const fullTime = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
  function render(entry) {
    const time = stamp(entry.ts);
    if (entry.from === 'system') {
      const row = el('div', `row system${entry.kind ? ' kind-' + entry.kind : ''}`); row.appendChild(el('div', 'text', entry.text));
      if (entry.ts) { const s = el('span', 'ts', time); s.title = fullTime(entry.ts); row.appendChild(s); }
      if (entry.kind === 'suggestion' && entry.suggest) {
        // Only the human can turn an agent's prose hand-off into a message.
        const b = el('button', 'tbtn', `Hand to ${NAMES[entry.suggest.to]}`);
        b.addEventListener('click', () => { vscode.postMessage({ type: 'send', text: `@${entry.suggest.to} ${NAMES[entry.suggest.from]} asked for you above; please take it.` }); b.disabled = true; });
        row.appendChild(b);
      }
      return row;
    }
    if (entry.from === 'human') {
      const row = el('article', `row human${entry.kind === 'history' ? ' history' : ''}`);
      const who = el('div', 'who', entry.kind === 'history' ? 'earlier · User' : entry.kind === 'steer' ? `${NAMES.human} · ↪ steering ${entry.steer.map((n) => NAMES[n]).join(' and ')} · ${time}` : `${NAMES.human} · ${time}`);
      if (entry.ts) who.title = fullTime(entry.ts);
      row.appendChild(who);
      const b = el('div', 'bubble'); b.appendChild(body(entry.text)); row.appendChild(b);
      if (entry.attachments && entry.attachments.length) row.appendChild(files(entry.attachments));
      if (entry.ide) row.appendChild(el('div', 'idechip', `📍 ${entry.ide.summary}`));
      return row;
    }
    if (entry.kind === 'request') {
      const { row, col, head } = agentShell(entry.from, time);
      if (entry.ts) head.title = fullTime(entry.ts);
      row.classList.add('request');
      col.appendChild(el('div', 'reqhead', `asks ${NAMES[entry.to]} · ${entry.purpose} · ${entry.request}${entry.task ? ` · task ${entry.task}` : ''}`));
      col.appendChild(body(entry.text));
      return row;
    }
    const answers = (entry.answers || []).map((a) => a.request);
    const { row, col, head } = agentShell(entry.from, entry.kind === 'history' ? '' : [answers.length ? `answers ${answers.join(', ')}` : '', entry.model || '', time].filter(Boolean).join(' · '));
    if (entry.ts && entry.kind !== 'history') head.title = fullTime(entry.ts);
    if (entry.kind === 'history') row.classList.add('history');
    col.appendChild(body(entry.text));
    if (entry.diff) { const d = el('details', 'fold'); d.open = true; d.appendChild(el('summary', null, 'Changes this turn')); d.appendChild(diffCard(entry.diff)); col.appendChild(d); }
    if (entry.steps && entry.steps.length || entry.took) {
      const d = el('details', 'fold');
      d.appendChild(el('summary', null, [entry.took ? `Worked for ${secs(entry.took)}` : '', entry.steps ? `${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')));
      if (entry.steps) { const ol = el('ol'); entry.steps.forEach((s) => ol.appendChild(el('li', null, s))); d.appendChild(ol); }
      col.appendChild(d);
    }
    return row;
  }
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 90; }
  function keepBottom() { if (log.scrollHeight - log.scrollTop - log.clientHeight < 420) log.scrollTop = log.scrollHeight; }
  function add(node) { const stick = atBottom(); log.appendChild(node); if (stick) log.scrollTop = log.scrollHeight; }

  // ---------- in-progress replies ----------
  function ensureDraft(name) {
    if (drafts[name]) return drafts[name];
    const { row, col } = agentShell(name, modelTag(name));
    const line = el('div', 'act'); line.appendChild(el('span', 'dot')); line.appendChild(el('span', 'shimmer', 'Starting'));
    const th = el('details', 'fold'); th.hidden = true; th.appendChild(el('summary', null, 'Thinking')); th.appendChild(el('div', 'thought'));
    col.appendChild(line); col.appendChild(th); col.appendChild(el('div', 'body'));
    drafts[name] = { row, col, line, th }; add(row); return drafts[name];
  }
  function setDraft(name, text) {
    if (text == null) { if (drafts[name]) { drafts[name].row.remove(); delete drafts[name]; } return; }
    const d = ensureDraft(name), stick = atBottom();
    d.col.replaceChild(body(text), d.col.querySelector('.body'));
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function setActivity(a) {
    act[a.name] = a;
    const d = ensureDraft(a.name), stick = atBottom();
    d.line.lastChild.textContent = a.label.charAt(0).toUpperCase() + a.label.slice(1);
    if (a.thinking) { d.th.hidden = false; d.th.querySelector('.thought').textContent = a.thinking; }
    renderWho(); if (stick) log.scrollTop = log.scrollHeight;
  }

  // ---------- composer: status, chips, pickers ----------
  function renderWho() {
    const w = $('who'); w.textContent = '';
    for (const n of Object.keys(busy)) if (busy[n]) {
      w.appendChild(el('span', `w ${provider(n)}`, `${NAMES[n]} · ${act[n] ? act[n].label : 'starting'} · ${secs(Date.now() - (since[n] || Date.now()))}`));
    }
    const any = Object.values(busy).some(Boolean), typed = !!(input.value.trim() || pending.length);
    $('stop').hidden = !any; $('send').hidden = !!any && !typed;
    const steering = any && typed && !input.value.trim().startsWith('/');
    $('send').textContent = steering ? '↪' : '↑';
    $('send').title = steering ? `Steer ${Object.keys(busy).filter((n) => busy[n]).map((n) => NAMES[n]).join(' and ')} now (Enter) · ${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+Enter queues it instead` : 'Send (Enter)';
    if (any && !ticker) ticker = setInterval(renderWho, 1000);
    if (!any && ticker) { clearInterval(ticker); ticker = null; }
  }
  function renderChips() {
    const box = $('participants'); box.textContent = '';
    for (const p of participants()) {
      const name = p.id, v = controls && controls[name];
      const btn = el('button', `chip vendor ${provider(name)}`); btn.id = `vc-${name}`;
      btn.appendChild(el('span', 'glyph', GLYPH[name]));
      btn.appendChild(el('span', 'seatlabel', NAMES[name]));
      if (v) btn.appendChild(el('span', 'seatmodel', `${modelTag(name) || 'default'} · ${v.effort || 'auto'}`));
      if (v && v.fast) btn.appendChild(el('span', 'bolt', '⚡'));
      btn.title = `${NAMES[name]} (@${name}): session, model and history${p.cwd ? '\n' + p.cwd : ''}`;
      btn.setAttribute('aria-label', `${NAMES[name]} controls`);
      btn.addEventListener('click', () => openPop(name)); box.appendChild(btn);
    }
    const ideBtn = $('ide'); ideBtn.textContent = ideSummary ? `📍 ${ideSummary}` : '';
    ideBtn.classList.toggle('off', meta.ideContext === false);
    const lead = meta.defaultTarget || 'claude';
    $('deftarget').textContent = lead === 'both' ? `${allLabel().toLowerCase()}, ${meta.bothMode === 'parallel' ? 'at once' : 'in turn'}` : NAMES[lead];
    const lb = $('lead'); lb.textContent = '';
    lb.appendChild(el('span', 'muted', 'Lead')); lb.appendChild(el('span', `glyph ${provider(lead)}`, lead === 'both' ? '◎' : GLYPH[lead]));
    lb.appendChild(el('span', null, lead === 'both' ? allLabel() : NAMES[lead]));
  }
  // ---------- usage: one header button with a meter per app, details one click away ----------
  // Plan limits as rows: { who, label, pct, resets }. Claude from its /usage screen, Codex from its rate limits.
  function limitRows() {
    const rows = [];
    const span = (w, fb) => !w.windowDurationMins ? fb : w.windowDurationMins >= 10080 ? 'this week' : w.windowDurationMins >= 1440 ? `${Math.round(w.windowDurationMins / 1440)} days` : `${Math.round(w.windowDurationMins / 60)} hours`;
    const at = (sec) => (sec ? new Date(sec * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
    if (cusage) {
      if (cusage.session) rows.push({ who: 'claude', label: 'Claude · current session', pct: cusage.session.pct, resets: cusage.session.resets || '' });
      if (cusage.week) rows.push({ who: 'claude', label: 'Claude · this week', pct: cusage.week.pct, resets: cusage.week.resets || '' });
      for (const [name, v] of Object.entries(cusage.models || {})) if (v && v.pct >= 50) rows.push({ who: 'claude', label: `${name} · this week`, pct: v.pct, resets: v.resets || '' });
    }
    if (quota) for (const [fb, w] of [['short window', quota.primary], ['long window', quota.secondary]]) if (w) rows.push({ who: 'codex', label: `Codex · ${span(w, fb)}`, pct: w.usedPercent, resets: at(w.resetsAt) });
    return rows;
  }
  const level = (pct) => (pct >= 100 ? ' full' : pct >= 80 ? ' warn' : '');
  // A limit meter turns amber at 80% and red at 100%; a share meter (plain) never does.
  function meter(pct, cls, plain = false) {
    const m = el('span', `meter${cls ? ' ' + cls : ''}${plain ? '' : level(pct)}`); const f = el('span', 'fill');
    f.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`; m.appendChild(f); return m;
  }
  function renderQuota() {
    const box = $('quota'); box.textContent = '';
    const rows = limitRows();
    const b = el('button', 'pill btn usagebtn'); b.setAttribute('aria-label', 'Usage: plan limits and token use');
    b.appendChild(el('span', 'ulabel', 'Usage'));
    for (const who of ['claude', 'codex']) {
      const mine = rows.filter((r) => r.who === who); // the header shows each app's closest limit
      if (!mine.length) continue;
      const worst = mine.reduce((x, y) => (y.pct > x.pct ? y : x));
      const g = el('span', `gauge ${who}${level(worst.pct)}`); g.appendChild(el('span', 'gname', who === 'claude' ? 'Claude' : 'Codex'));
      g.appendChild(meter(worst.pct, 'mini')); g.appendChild(el('span', 'gpct', `${Math.round(worst.pct)}%`));
      b.appendChild(g);
    }
    b.title = rows.length ? `${rows.map((r) => `${r.label}: ${Math.round(r.pct)}% used${r.resets ? `, resets ${r.resets}` : ''}`).join('\n')}\nClick for details.` : 'Plan limits and token use. Click for details.';
    b.addEventListener('click', () => openUsage());
    box.appendChild(b);
  }

  // ---------- task card and controls ----------
  const STATUS = { active: 'Working', paused: 'Paused', exhausted: 'Allowance used', completed: 'Complete', stopped: 'Stopped' };
  const mins = (ms) => `${Math.floor(ms / 60000)}m`;
  function renderTask() {
    const box = $('task'); box.textContent = '';
    const tc = $('tc'); tc.textContent = '';
    tc.appendChild(el('span', 'muted', 'Task')); tc.appendChild(el('span', null, `${taskMode[0].toUpperCase()}${taskMode.slice(1)}`));
    const t = task; box.hidden = !t; if (!t) return;
    const head = el('div', 'taskhead');
    const title = el('div', 'tasktitle');
    title.appendChild(el('span', `badge ${t.status}`, STATUS[t.status] || t.status));
    head.appendChild(title);
    const btns = el('div', 'taskbtns');
    const b = (label, fn, cls, tip) => { const x = el('button', `tbtn${cls ? ' ' + cls : ''}`, label); x.title = tip || label; x.addEventListener('click', fn); btns.appendChild(x); };
    if (t.status === 'active') b('Pause', () => vscode.postMessage({ type: 'taskPause' }), '', 'Pause: running turns finish, nothing new starts');
    else b('Resume', () => vscode.postMessage({ type: 'taskResume' }), '', 'Resume the task (raise its allowance first if it ran out)');
    b('Controls', () => openTaskControls(), '', 'Task allowances and mode');
    b('Stop', () => cmd('/stop'), 'danger', 'Stop the task and everything running under it');
    head.appendChild(btns); box.appendChild(head);
    // Keep controls visible while long requests and activity scroll inside the card.
    const detail = el('div', 'taskbody');
    detail.tabIndex = 0; detail.setAttribute('role', 'region'); detail.setAttribute('aria-label', 'Task details');
    detail.appendChild(el('div', 'obj', t.objective || t.id)); box.appendChild(detail);
    const m = el('div', 'taskmeta');
    // Numbers, not only colour: turns and minutes as used / allowed, plus what stays reserved.
    m.appendChild(el('span', null, `${t.turns}/${t.limits.turns} turns${t.limits.reserve ? ` (${t.limits.reserve} kept for wrap-up)` : ''}`));
    m.appendChild(el('span', null, `${mins(t.usedMs)} of ${t.limits.minutes}m`));
    m.appendChild(el('span', null, `lead ${NAMES[t.lead]}`));
    m.appendChild(el('span', null, 'read-only'));
    m.appendChild(el('span', null, `${t.answered} answered · ${t.open.length} open`));
    detail.appendChild(m);
    const us = Object.entries(t.usage || {});
    if (us.length) {
      const tk = el('div', 'taskmeta');
      tk.appendChild(el('span', null, `Tokens: ${us.map(([n, x]) => `${NAMES[n] || n} ${k(x.fresh + x.cacheWrite)} new · ${k(x.cached)} cached · ${k(x.output)} out${x.unreported ? ` (+${x.unreported} turn${x.unreported > 1 ? 's' : ''} unreported)` : ''}`).join(' · ')}`));
      detail.appendChild(tk);
    }
    if (t.open.length || (t.log && t.log.length)) {
      const d = el('details', 'fold'); d.appendChild(el('summary', null, t.open.length ? t.open.map((r) => `${r.id} ${NAMES[r.from]} → ${NAMES[r.to]} · ${r.purpose} · ${r.status === 'delivered' ? 'with ' + NAMES[r.to] : 'waiting'}`).join('   ') : 'Activity'));
      const ol = el('ol'); for (const r of t.open) ol.appendChild(el('li', null, `${r.id}: ${r.question}`));
      for (const x of t.log || []) ol.appendChild(el('li', 'muted', `${stamp(x.at)} ${x.actor === 'host' ? 'Wagon Wheel' : NAMES[x.actor] || x.actor}: ${x.text}`));
      d.appendChild(ol); detail.appendChild(d);
    }
    if (t.summary) detail.appendChild(el('div', 'tasksum', t.summary));
  }
  function openTaskControls() {
    const pop = $('pop');
    if (!pop.hidden && pop.dataset.for === 'task') return closePop();
    pop.dataset.for = 'task'; pop.textContent = ''; pop.hidden = false;
    const h = el('h4'); h.appendChild(el('span', null, 'Task controls')); h.appendChild(el('small', null, task ? `task ${task.id}` : 'for new tasks')); pop.appendChild(h);
    const md = el('div'); md.appendChild(el('div', 'lbl', 'Mode'));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Mode');
    for (const [v, tip] of [['auto', 'A task starts when an agent asks a peer for help'], ['chat', 'One consultation per message, no task'], ['work', 'Every message starts a task']]) {
      const x = el('button', v === taskMode ? 'on' : '', v[0].toUpperCase() + v.slice(1)); x.title = tip; x.setAttribute('role', 'radio'); x.setAttribute('aria-checked', String(v === taskMode));
      x.addEventListener('click', () => { vscode.postMessage({ type: 'taskMode', mode: v }); closePop(); }); seg.appendChild(x);
    }
    md.appendChild(seg); pop.appendChild(md);
    const cur = { ...(task ? task.limits : taskDefaults || presets.balanced || { turns: 20, reserve: 2, minutes: 30 }) };
    const fields = {};
    const ps = el('div'); ps.appendChild(el('div', 'lbl', 'Preset'));
    const pseg = el('div', 'seg');
    const same = (a, b2) => a && b2 && a.turns === b2.turns && a.reserve === b2.reserve && a.minutes === b2.minutes;
    const mark = () => { const v = read(); for (const x of pseg.children) x.classList.toggle('on', x.dataset.p === 'custom' ? !Object.values(presets).some((p) => same(p, v)) : same(presets[x.dataset.p], v)); };
    for (const name of ['economy', 'balanced', 'thorough', 'custom']) {
      const p = presets[name]; const x = el('button', '', name[0].toUpperCase() + name.slice(1)); x.dataset.p = name;
      if (p) x.title = `${p.turns} turns, ${p.minutes} minutes`;
      x.addEventListener('click', () => { if (p) for (const k2 of Object.keys(fields)) fields[k2].value = p[k2]; mark(); }); pseg.appendChild(x);
    }
    ps.appendChild(pseg); pop.appendChild(ps);
    const grid = el('div', 'limits');
    for (const [key, label, help, max] of [['turns', 'Agent turns', 'Turn starts for this task across all participants, including retries', 200], ['reserve', 'Kept for wrap-up', 'Turns new requests may not use, so answers can come back', 50], ['minutes', 'Minutes', 'Active time; paused time does not count. At the limit running work stops', 1440]]) {
      const id = `lim-${key}`; const lab = el('label', null, label); lab.htmlFor = id; lab.title = help;
      const inp = document.createElement('input'); inp.type = 'number'; inp.id = id; inp.min = key === 'reserve' ? '0' : '1'; inp.max = String(max); inp.value = cur[key]; inp.title = help;
      inp.addEventListener('input', mark); fields[key] = inp; grid.appendChild(lab); grid.appendChild(inp);
    }
    pop.appendChild(grid); mark();
    function read() { return Object.fromEntries(Object.entries(fields).map(([k2, i]) => [k2, Number(i.value)])); }
    pop.appendChild(el('small', 'note', 'Token and dollar limits are not offered: usage arrives only after a turn. Presets never change the model, fast mode or permissions.'));
    pop.appendChild(el('small', 'note', 'Local Codex and Claude Code permissions: read-only. Tasks cover review and investigation. Claude has no shell access; Codex can use its read-only sandbox for local inspection. Editing and development workflows are not supported in this version.'));
    const acts = el('div', 'actions');
    if (task && !['completed', 'stopped'].includes(task.status)) { const a = el('button', 'primary', 'Apply to this task'); a.addEventListener('click', () => { vscode.postMessage({ type: 'taskLimits', limits: read() }); closePop(); }); acts.appendChild(a); }
    const sv = el('button', 'link', 'Save as my defaults'); sv.title = 'New tasks start with these; tasks already running keep theirs';
    sv.addEventListener('click', () => { vscode.postMessage({ type: 'taskDefaults', limits: read() }); closePop(); }); acts.appendChild(sv);
    pop.appendChild(acts);
  }
  // ---------- this computer's usage, broken down ----------
  let usageWin = 'window';
  const chars = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M chars` : n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);
  // Tokens split into what they cost: cached reads are cheap; new input and output are what a plan really spends.
  const total = (u) => u.fresh + u.cached + u.cacheWrite + u.output;
  function mixBar(u) {
    const bar = el('div', 'mix'), t = total(u) || 1;
    for (const [key, v, label] of [['cached', u.cached, 'reused from cache'], ['fresh', u.fresh + u.cacheWrite, 'new input'], ['out', u.output, 'written by the model']]) {
      if (!v) continue; const seg = el('span', `m-${key}`); seg.style.width = `${Math.max(1, (v / t) * 100)}%`; seg.title = `${k(v)} ${label}`; bar.appendChild(seg);
    }
    return bar;
  }
  function openUsage() {
    const pop = $('pop');
    if (!pop.hidden && pop.dataset.for === 'usage') return closePop();
    pop.dataset.for = 'usage'; pop.textContent = ''; pop.hidden = false; pop.classList.add('usagepop');
    pop.appendChild(el('h4', null, 'Usage'));

    // 1. Plan limits: the numbers that decide whether the next turn works.
    const lim = el('div', 'usec'); lim.appendChild(el('div', 'lbl', 'Plan limits'));
    const rows = limitRows();
    if (!rows.length) lim.appendChild(el('small', 'note', 'Shown after the first reply from each app.'));
    for (const r of rows) {
      const row = el('div', 'limit');
      const top = el('div', 'lrow'); top.appendChild(el('span', null, r.label)); top.appendChild(el('span', `lpct${level(r.pct)}`, `${Math.round(r.pct)}%`));
      row.appendChild(top); row.appendChild(meter(r.pct, r.who));
      if (r.resets) row.appendChild(el('small', 'note', `Resets ${r.resets}`));
      lim.appendChild(row);
    }
    pop.appendChild(lim);

    // 2. This room: each agent's last reply, plus Claude's running cost at API prices.
    const seats = participants().filter((p) => participantUsage[p.id] || participantCost[p.id]);
    if (seats.length) {
      const rm = el('div', 'usec'); rm.appendChild(el('div', 'lbl', 'This room'));
      for (const p of seats) {
        const u = participantUsage[p.id], dollars = participantCost[p.id];
        const line = el('div', 'lrow');
        line.appendChild(el('span', null, p.label || NAMES[p.id]));
        const parts = [];
        if (u) { const t = u.fresh + u.cacheWrite + u.cached; parts.push(`last reply read ${k(t)} tokens${t ? `, ${Math.round((u.cached / t) * 100)}% reused` : ''}`); }
        if (dollars) parts.push(`≈$${dollars.toFixed(2)} so far at API prices`);
        line.appendChild(el('span', 'val', parts.join(' · ')));
        rm.appendChild(line);
      }
      rm.appendChild(el('small', 'note', 'API prices are for comparison only. A subscription doesn\'t charge per token.'));
      pop.appendChild(rm);
    }

    // 3. This computer: every local Claude Code and Codex session, from their own logs.
    if (local) {
      const pc = el('div', 'usec'); pop.appendChild(pc);
      const head = el('div', 'lrow'); head.appendChild(el('span', 'lbl', 'This computer'));
      const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Period');
      head.appendChild(seg); pc.appendChild(head);
      const body = el('div', 'usage'); pc.appendChild(body);
      for (const [v, label] of [['today', 'Today'], ['window', `${local.windowDays} days`]]) {
        const x = el('button', v === usageWin ? 'on' : '', label); x.setAttribute('role', 'radio'); x.setAttribute('aria-checked', String(v === usageWin));
        x.addEventListener('click', () => { usageWin = v; for (const b of seg.children) { b.classList.toggle('on', b === x); b.setAttribute('aria-checked', String(b === x)); } render(); });
        seg.appendChild(x);
      }
      const legend = el('div', 'legend');
      for (const [key, label] of [['cached', 'Reused from cache (cheap)'], ['fresh', 'New input'], ['out', 'Written by the model']]) { const l = el('span'); l.appendChild(el('span', `sw m-${key}`)); l.appendChild(el('span', null, label)); legend.appendChild(l); }
      function section(name, x) {
        const s = el('div', 'psec'); body.appendChild(s);
        if (x === null) { s.appendChild(el('div', 'lrow', `${name}: no conversations on this computer`)); return; }
        if (x.unknown) { s.appendChild(el('div', 'lrow', `${name}: couldn't read its logs`)); return; }
        const u = x[usageWin], d = x.detail && x.detail[usageWin];
        const top = el('div', 'lrow'); top.appendChild(el('span', 'pname', name));
        top.appendChild(el('span', 'val', `${k(total(u))} tokens${usageWin === 'window' && x.sessions ? ` · ${x.sessions} conversation${x.sessions === 1 ? '' : 's'}` : ''}`));
        s.appendChild(top);
        if (total(u)) s.appendChild(mixBar(u));
        if (!d) { s.appendChild(el('small', 'note', 'Reload the window to see models and details.')); return; }
        const models = Object.entries(d.models).filter(([, mu]) => total(mu) > 0).sort((a, b) => total(b[1]) - total(a[1])); // Claude Code logs a zero-token placeholder model ('<synthetic>'); it is not a row
        const all = total(u) || 1;
        for (const [m, mu] of models.slice(0, 3)) {
          const r = el('div', 'model'); r.appendChild(el('span', 'mname', m === 'unknown' ? 'model not logged' : m));
          const share = (total(mu) / all) * 100;
          r.appendChild(meter(share, name === 'Claude' ? 'claude' : 'codex', true)); r.appendChild(el('span', 'val', share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`));
          s.appendChild(r);
        }
        if (models.length > 3) s.appendChild(el('small', 'note', `${models.length - 3} more model${models.length - 3 === 1 ? '' : 's'}`));
        // The fine print, folded away.
        const more = el('details', 'more'); more.dataset.section = name; more.appendChild(el('summary', null, 'More detail'));
        const line = (label, value, tip) => { const r = el('div', 'lrow'); r.appendChild(el('span', null, label)); const v = el('span', 'val', value); if (tip) v.title = tip; r.appendChild(v); more.appendChild(r); };
        line('Reused from cache', k(u.cached)); line('New input', k(u.fresh + u.cacheWrite)); line('Written by the model', k(u.output));
        if (u.output && d.thinking) line(name === 'Codex' ? 'Of which reasoning' : 'Of which thinking', k(d.thinking));
        if (total(d.lanes.subagent)) line('Helper agents (subagents)', `${Math.round((total(d.lanes.subagent) / all) * 100)}% of tokens`);
        const tools = Object.entries(d.tools).sort((a, b) => b[1].calls - a[1].calls);
        // Connector tools are logged as mcp__<server>__<tool>; show the tool, with the server when it has a readable name.
        const friendly = (t) => { if (!t.startsWith('mcp__')) return t; const [, server, ...rest] = t.split('__'); const tool = rest.join('__') || server; return /^[0-9a-f-]{16,}$/i.test(server) || !rest.length ? tool : `${server} ${tool}`; };
        if (tools.length) line('Tools used most', tools.slice(0, 3).map(([t, tu]) => `${friendly(t)} ${tu.calls}×`).join(', '), `${d.toolCalls} tool calls in total`);
        s.appendChild(more);
      }
      function render() { body.textContent = ''; section('Claude', local.claude); section('Codex', local.codex); body.appendChild(legend); }
      render();
      pc.appendChild(el('small', 'note', 'Every Claude Code and Codex conversation on this computer, read from their own logs. Web apps, other computers and cloud tasks aren\'t included.'));
      pc.appendChild(el('small', 'note', `Updated ${new Date(local.scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
    }
  }
  // An open usage popover re-renders in place when its numbers change (limits, this room, this computer).
  function refreshUsagePop() {
    const pop = $('pop');
    if (pop.hidden || pop.dataset.for !== 'usage') return;
    // Keep what the person had open: which "More detail" sections, and where they had scrolled.
    const open = new Set(walk(pop).filter((e) => e.tagName && e.tagName.toLowerCase() === 'details' && e.open).map((d) => d.dataset.section));
    const top = pop.scrollTop;
    closePop(); openUsage();
    walk(pop).filter((e) => e.tagName && e.tagName.toLowerCase() === 'details').forEach((d) => { if (open.has(d.dataset.section)) d.open = true; });
    pop.scrollTop = top;
  }
  function walk(node) { const out = []; for (const c of node.children || []) out.push(c, ...walk(c)); return out; }
  function closePop() { $('pop').hidden = true; $('pop').classList.toggle('usagepop', false); }
  function cmd(text) { vscode.postMessage({ type: 'command', text }); }
  function openPop(name) {
    const pop = $('pop'); if (!controls) return;
    if (!pop.hidden && pop.dataset.for === name) return closePop();
    pop.dataset.for = name; pop.textContent = ''; pop.hidden = false; pop.classList.toggle('usagepop', false);
    const c = controls[name] || participants().find((p) => p.id === name); if (!c) { closePop(); return; }
    const kind = c.provider || provider(name);
    const h = el('h4'); h.appendChild(el('span', null, `${GLYPH[name]}  ${NAMES[name]}`)); h.appendChild(el('small', null, kind === 'claude' ? `Claude Code ${c.cli || ''}` : kind === 'codex' ? 'Codex on this computer' : 'Experimental ACP')); pop.appendChild(h);
    pop.appendChild(el('small', 'note seatcontext', `@${name}${c.cwd ? ' · ' + c.cwd : ''}`));
    if (!['claude', 'codex'].includes(kind)) { pop.appendChild(el('small', 'note', 'Experimental agent: local process, provider-managed permissions. Model, effort and history controls are not available here.')); return; }
    const models = el('div'); models.appendChild(el('div', 'lbl', 'Model'));
    for (const m of c.models || []) {
      const b = el('button', `opt${m.id === c.model ? ' on' : ''}`); const l = el('span', null, m.name || m.id);
      const why = m.available === false ? `needs Claude Code ${m.minCli}+` : m.blocked || m.note;
      if (why) l.appendChild(el('small', null, `  ${why}`));
      b.appendChild(l); b.disabled = m.available === false || !!m.blocked;
      if (m.blocked) b.title = m.blocked;
      b.addEventListener('click', () => { cmd(`/${name} model ${m.id}`); closePop(); }); models.appendChild(b);
    }
    pop.appendChild(models);
    const cur = (c.models || []).find((m) => m.id === c.model) || {};
    const efforts = kind === 'claude' ? (c.efforts || []) : (cur.efforts || []);
    if (efforts.length) {
      const e = el('div'); e.appendChild(el('div', 'lbl', `Thinking${kind === 'codex' && cur.defaultEffort ? ` · default ${cur.defaultEffort}` : ''}`));
      const seg = el('div', 'seg');
      for (const v of efforts) { const b = el('button', v === c.effort ? 'on' : '', v); b.addEventListener('click', () => { cmd(`/${name} effort ${v}`); closePop(); }); seg.appendChild(b); }
      e.appendChild(seg); pop.appendChild(e);
    }
    const fastOk = kind === 'claude' ? !!cur.fastOk : !!cur.fast;
    const row = el('div', 'fastrow'); const txt = el('div');
    txt.appendChild(el('span', null, '⚡ Fast mode'));
    txt.appendChild(el('small', null, kind === 'claude' ? (fastOk ? 'Up to 2.5x faster Opus · billed to usage credits' : 'Opus 5.5 only, on Claude Code 2.1.205+') : (fastOk ? `${cur.fast.description} · priority tier` : 'Not offered for this model')));
    const sw = el('button', `switch${c.fast ? ' on' : ''}`); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!c.fast)); sw.setAttribute('aria-label', 'Fast mode');
    sw.disabled = !fastOk && !c.fast;
    sw.addEventListener('click', () => { cmd(`/${name} fast ${c.fast ? 'off' : 'on'}`); closePop(); });
    row.appendChild(txt); row.appendChild(sw); pop.appendChild(row);
    const ws = el('div'); ws.appendChild(el('div', 'lbl', `Conversation${c.typed ? '' : ' · reached by @mention'}`));
    const wseg = el('div', 'seg');
    for (const [a, label, tip] of [['new', 'Start over', 'Give this agent a brand-new conversation. The room keeps its messages.'],
      ['switch', 'Switch to one of your conversations…', 'Bring in a conversation you already had. Next you choose a copy (recommended) or the original.']]) {
      const x = el('button', '', label); x.title = tip; x.disabled = !!busy[name];
      x.addEventListener('click', () => { vscode.postMessage({ type: 'session', vendor: name, action: a }); closePop(); }); wseg.appendChild(x);
    }
    ws.appendChild(wseg); pop.appendChild(ws);
    pop.appendChild(el('div', 'lbl', 'Sharing'));
    const readers = c.readers || participants().filter((p) => p.id !== name).map((p) => ({ ...p, shared: !!c.shared }));
    for (const reader of readers) {
      const hr = el('div', 'fastrow'); const ht = el('div');
      ht.appendChild(el('span', null, `Let ${reader.label || NAMES[reader.id]} read this conversation`));
      ht.appendChild(el('small', null, 'They can look things up in it but can\'t change it.'));
      const hs = el('button', `switch${reader.shared ? ' on' : ''}`); hs.setAttribute('role', 'switch'); hs.setAttribute('aria-checked', String(!!reader.shared)); hs.setAttribute('aria-label', `Share ${NAMES[name]} history with ${reader.label || NAMES[reader.id]}`);
      hs.addEventListener('click', () => { vscode.postMessage({ type: 'historyShare', source: name, reader: reader.id, on: !reader.shared }); closePop(); });
      hr.appendChild(ht); hr.appendChild(hs); pop.appendChild(hr);
    }
    if (readers.some((r) => r.shared)) {
      const ar = el('div', 'fastrow'); const at = el('div');
      at.appendChild(el('span', null, 'Include earlier history'));
      at.appendChild(el('small', null, c.allHistory !== false ? 'Allowed readers can read the whole session.' : 'Allowed readers can read only what is said from when you turned this off.'));
      const as = el('button', `switch${c.allHistory !== false ? ' on' : ''}`); as.setAttribute('role', 'switch'); as.setAttribute('aria-checked', String(c.allHistory !== false)); as.setAttribute('aria-label', 'Include earlier history');
      as.addEventListener('click', () => { cmd(`/history all ${name} ${c.allHistory !== false ? 'off' : 'on'}`); closePop(); });
      ar.appendChild(at); ar.appendChild(as); pop.appendChild(ar);
    }
    // What this agent can do here: one line, full detail on hover.
    const cap = el('small', 'note cap', kind === 'claude' ? 'Can read files. Can\'t edit them, run commands or use the web.' : 'Can read files and run look-only commands. Can\'t edit files, use the web or connectors.');
    cap.title = kind === 'claude' ? 'Read, Glob and Grep inside the room folder, plus the room tools (ask the other agent, read shared history, finish a task). No edits, no shell, no web, no other MCP servers. Your own Claude settings do not apply here.'
      : 'Read-only sandbox for local inspection, plus the room tools when its thread has them. Read access is not confined to the room folder. Every approval request is declined. Web search, connected apps and external MCP tools are disabled and checked before the thread is used.';
    pop.appendChild(cap);
    const save = el('button', 'link', 'Use these settings for new rooms');
    save.addEventListener('click', () => { vscode.postMessage({ type: 'saveDefaults', vendor: name }); closePop(); });
    pop.appendChild(save);
  }

  // ---------- attachments ----------
  function renderTray() {
    const t = $('tray'); t.textContent = ''; t.hidden = !pending.length;
    if (pending.length) t.appendChild(files(pending, (a) => { pending = pending.filter((p) => p.id !== a.id); vscode.postMessage({ type: 'unattach', id: a.id }); renderTray(); }));
    renderWho();
  }
  function readAndAttach(list) {
    for (const f of list) { const r = new FileReader(); r.onload = () => vscode.postMessage({ type: 'attachData', name: f.name || `pasted-${Date.now()}.png`, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f); }
  }

  // ---------- messages from the extension ----------
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'init') {
      log.textContent = ''; Object.keys(drafts).forEach((x) => delete drafts[x]);
      meta = m.meta || {}; syncParticipants();
      specs = m.commands || specs; controls = m.controls || controls;
      $('title').textContent = meta.name || 'Wagon Wheel';
      $('ids').textContent = [meta.cwd, meta.forkedFrom && `codex fork of ${meta.forkedFrom.slice(0, 8)}`, meta.claudeForkedFrom && `claude fork of ${meta.claudeForkedFrom.slice(0, 8)}`].filter(Boolean).join(' · ');
      (m.transcript || []).forEach((e) => add(render(e)));
      busy = m.busy || {}; if (m.quota) quota = m.quota;
      for (const id of Object.keys(participantUsage)) delete participantUsage[id];
      for (const id of Object.keys(participantCost)) delete participantCost[id];
      Object.assign(participantUsage, m.participantUsage || {}); Object.assign(participantCost, m.participantCost || {});
      renderQuota(); renderChips(); renderWho(); renderTask(); log.scrollTop = log.scrollHeight;
    } else if (m.type === 'message') { setDraft(m.entry.from, null); add(render(m.entry)); }
    else if (m.type === 'draft') setDraft(m.name, m.text);
    else if (m.type === 'activity') setActivity(m);
    else if (m.type === 'status') {
      busy[m.name] = m.busy;
      if (m.busy) since[m.name] = m.since || Date.now(); else { delete act[m.name]; delete since[m.name]; }
      if (m.participantUsage) participantUsage[m.name] = m.participantUsage;
      if (typeof m.participantCost === 'number') participantCost[m.name] = m.participantCost;
      renderWho(); renderQuota(); if (!m.busy) refreshUsagePop(); // usage changes when a turn ends, not while it streams
    }
    else if (m.type === 'quota') { quota = m.quota; renderQuota(); refreshUsagePop(); }
    else if (m.type === 'localUsage') { local = m.usage; renderQuota(); refreshUsagePop(); } // a refresh while open re-renders it
    else if (m.type === 'task') { task = m.task; taskMode = m.mode || 'auto'; taskDefaults = m.defaults; presets = m.presets || presets; typedAgents = m.typed || {}; renderTask(); }
    else if (m.type === 'claudeUsage') { cusage = m.usage; renderQuota(); refreshUsagePop(); }
    else if (m.type === 'meta') { meta = m.meta; syncParticipants(); specs = m.commands || specs; controls = m.controls || controls; renderChips(); }
    else if (m.type === 'ide') { ideSummary = m.summary; renderChips(); }
    else if (m.type === 'attached') { pending.push(m.att); renderTray(); }
    else if (m.type === 'attachError') add(render({ from: 'system', kind: 'error', text: `Couldn't attach: ${m.text}` }));
    else if (m.type === 'notice') add(render({ from: 'system', kind: 'error', text: m.text }));
  });

  // ---------- sending ----------
  // While an agent is working, Enter steers it; Cmd/Ctrl+Enter queues the message as an ordinary one instead.
  function send(queue) {
    const t = input.value.trim(); if (!t && !pending.length) return;
    const steer = !queue && Object.values(busy).some(Boolean);
    if (t.startsWith('/')) cmd(t);
    else { vscode.postMessage({ type: steer ? 'steer' : 'send', text: t, attachmentIds: pending.map((a) => a.id), ide: meta.ideContext !== false }); pending = []; renderTray(); }
    input.value = ''; grow(); closeMenu(); input.focus();
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; }

  // ---------- autocomplete: @ agents, / commands grouped by platform ----------
  const mentions = () => [...participants().map((p) => ({ label: '@' + p.id, insert: '@' + p.id + ' ', desc: p.label })), { label: '@all', insert: '@all ', desc: 'All participants' }, { label: '@both', insert: '@both ', desc: 'All participants (alias)' }];
  function suggestions() {
    const caret = input.selectionStart, before = input.value.slice(0, caret);
    const at = before.match(/(^|\s)@([\w-]*)$/);
    if (at) return { from: caret - at[2].length - 1, to: caret, items: mentions().filter((a) => a.label.slice(1).startsWith(at[2].toLowerCase())) };
    if (/^\/[^\n]*$/.test(before)) {
      const q = before.replace(/\s+/g, ' ');
      const withArg = specs.filter((s) => s.args && q.startsWith(s.cmd + ' ')).sort((a, b) => b.cmd.length - a.cmd.length)[0];
      if (withArg) { const part = q.slice(withArg.cmd.length + 1); return { from: 0, to: caret, items: withArg.args.filter((a) => a.startsWith(part)).map((a) => ({ label: a, insert: `${withArg.cmd} ${a}`, desc: withArg.cmd, group: withArg.group })) }; }
      return { from: 0, to: caret, items: specs.filter((s) => s.cmd.startsWith(q.trimEnd()) || s.cmd.startsWith(q)).map((s) => ({ label: s.cmd, insert: s.cmd + (s.args ? ' ' : ''), desc: s.desc, group: s.group })) };
    }
    return null;
  }
  function closeMenu() { menu.open = false; $('menu').hidden = true; }
  function renderMenu() {
    const s = suggestions(), box = $('menu');
    if (!s || !s.items.length) return closeMenu();
    closePop();
    menu.items = s.items; menu.range = s; menu.sel = Math.min(menu.sel, s.items.length - 1); menu.open = true;
    box.textContent = ''; box.hidden = false; let g = null;
    s.items.forEach((it, i) => {
      if (it.group && it.group !== g) { g = it.group; box.appendChild(el('div', `mgroup t-${g.toLowerCase()}`, g)); }
      const row = el('div', `mitem${i === menu.sel ? ' sel' : ''}`); row.setAttribute('role', 'option');
      row.appendChild(el('span', 'mlabel', it.label)); if (it.desc) row.appendChild(el('span', 'mdesc', it.desc));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); menu.sel = i; accept(); });
      box.appendChild(row);
    });
    const selEl = box.querySelector('.mitem.sel'); if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }
  function accept() {
    const it = menu.items[menu.sel]; if (!it) return;
    const v = input.value, r = menu.range;
    input.value = v.slice(0, r.from) + it.insert + v.slice(r.to);
    const pos = r.from + it.insert.length; input.setSelectionRange(pos, pos); input.focus();
    menu.sel = 0; renderMenu();
  }

  // ---------- wiring ----------
  input.addEventListener('input', () => { menu.sel = 0; grow(); renderMenu(); renderWho(); });
  input.addEventListener('click', renderMenu);
  input.addEventListener('blur', () => setTimeout(closeMenu, 120));
  input.addEventListener('keydown', (e) => {
    if (menu.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); menu.sel = (menu.sel + 1) % menu.items.length; return renderMenu(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); menu.sel = (menu.sel - 1 + menu.items.length) % menu.items.length; return renderMenu(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeMenu(); }
      const it = menu.items[menu.sel];
      const complete = it && input.value.slice(menu.range.from, menu.range.to).trim() === it.insert.trim();
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !complete)) { e.preventDefault(); return accept(); }
    }
    if (e.key === 'Escape') closePop();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.metaKey || e.ctrlKey); }
  });
  input.addEventListener('paste', (e) => { const fl = e.clipboardData && e.clipboardData.files; if (fl && fl.length) { e.preventDefault(); readAndAttach(fl); } });
  $('send').addEventListener('click', (e) => send(e.metaKey || e.ctrlKey));
  $('stop').addEventListener('click', () => cmd('/stop'));
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  $('ide').addEventListener('click', () => vscode.postMessage({ type: 'toggleIde', on: meta.ideContext === false }));
  $('tc').addEventListener('click', () => openTaskControls());
  // Lead picker: who drives the work and hears untagged messages.
  $('lead').addEventListener('click', () => {
    const pop = $('pop');
    if (!pop.hidden && pop.dataset.for === 'lead') return closePop();
    pop.dataset.for = 'lead'; pop.textContent = ''; pop.hidden = false;
    const h = el('h4'); h.appendChild(el('span', null, 'Who leads?')); h.appendChild(el('small', null, 'untagged messages go to the lead')); pop.appendChild(h);
    const cur = meta.defaultTarget || 'claude';
    for (const [v, label, note] of [...participants().map((p) => [p.id, `${GLYPH[p.id]}  ${p.label}`, `@${p.id} leads; peers help when asked`]), ['both', `◎  ${allLabel()}`, meta.bothMode === 'parallel' ? 'All answer independently' : 'All answer, taking turns']]) {
      const b = el('button', `opt${v === cur ? ' on' : ''}`); const l = el('span', null, label); l.appendChild(el('small', null, `  ${note}`)); b.appendChild(l);
      b.addEventListener('click', () => { cmd(`/default ${v}`); closePop(); }); pop.appendChild(b);
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#pop') && !e.target.closest('.vendor') && !e.target.closest('#lead') && !e.target.closest('#tc') && !e.target.closest('#task') && !e.target.closest('#quota .btn')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dropping');
    const dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length) return readAndAttach(dt.files);
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
    if (uris.length) vscode.postMessage({ type: 'attachUris', uris });
  });
  syncParticipants(); renderChips(); renderWho(); renderTask(); grow();
  vscode.postMessage({ type: 'ready' });
})();
