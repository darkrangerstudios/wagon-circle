// Wagon Wheel webview. Agent output is untrusted: everything renders through textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  // The extension host keeps its code until the window reloads, but this script and the stylesheet load fresh.
  // If the page was built by a different version, say so instead of rendering a broken layout.
  const EXPECT = '0.5.0';
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
  let busy = {}, cost = 0, usage = null, codexUsage = null, local = null, quota = null, cusage = null, meta = {}, specs = [], controls = null, ideSummary = null;
  let pending = [];                                  // attachments waiting to be sent
  const drafts = {}, act = {}, since = {};           // in-progress replies per agent
  const menu = { items: [], sel: 0, open: false };
  let ticker = null;
  let task = null, taskMode = 'auto', taskDefaults = null, presets = {}, typedAgents = {};

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const secs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

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
    const row = el('article', `row agent ${name}`);
    row.appendChild(el('div', `avatar ${name}`, GLYPH[name]));
    const col = el('div'); const head = el('div', 'head');
    head.appendChild(el('span', 'name', NAMES[name])); if (tag) head.appendChild(el('span', 'tag', tag));
    col.appendChild(head); row.appendChild(col);
    return { row, col, head };
  }
  function modelTag(name) {
    if (!controls) return '';
    const c = controls[name]; const m = c && c.models.find((x) => x.id === c.model);
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
      w.appendChild(el('span', `w ${n}`, `${NAMES[n]} · ${act[n] ? act[n].label : 'starting'} · ${secs(Date.now() - (since[n] || Date.now()))}`));
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
    const c = controls; const cb = $('vc-claude'), xb = $('vc-codex');
    for (const [btn, name] of [[cb, 'claude'], [xb, 'codex']]) {
      btn.textContent = ''; btn.appendChild(el('span', 'glyph', GLYPH[name]));
      const v = c && c[name];
      btn.appendChild(el('span', null, v ? `${modelTag(name) || 'default'} · ${v.effort || 'auto'}` : NAMES[name]));
      if (v && v.fast) btn.appendChild(el('span', 'bolt', '⚡'));
      btn.title = `${NAMES[name]}: model, effort and fast mode`;
    }
    const ideBtn = $('ide'); ideBtn.textContent = ideSummary ? `📍 ${ideSummary}` : '';
    ideBtn.classList.toggle('off', meta.ideContext === false);
    const lead = meta.defaultTarget || 'claude';
    $('deftarget').textContent = lead === 'both' ? 'both agents, in turn' : NAMES[lead];
    const lb = $('lead'); lb.textContent = '';
    lb.appendChild(el('span', 'muted', 'Lead')); lb.appendChild(el('span', `glyph ${lead}`, lead === 'both' ? '✳ >_' : GLYPH[lead]));
    lb.appendChild(el('span', null, lead === 'both' ? 'Both' : NAMES[lead]));
  }
  function renderQuota() {
    const box = $('quota'); box.textContent = '';
    const q = quota;
    const span = (w, fb) => !w.windowDurationMins ? fb : w.windowDurationMins >= 10080 ? 'week' : w.windowDurationMins >= 1440 ? `${Math.round(w.windowDurationMins / 1440)}d` : `${Math.round(w.windowDurationMins / 60)}h`;
    if (q) for (const [fb, w] of [['short', q.primary], ['long', q.secondary]]) if (w) {
      const p = el('span', `pill${w.usedPercent >= 100 ? ' full' : w.usedPercent >= 80 ? ' warn' : ''}`, `Codex ${span(w, fb)} ${Math.round(w.usedPercent)}%`);
      if (w.resetsAt) p.title = `Resets ${new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`; box.appendChild(p);
    }
    const cp = (label, v) => { if (!v) return; const p = el('span', `pill${v.pct >= 100 ? ' full' : v.pct >= 80 ? ' warn' : ''}`, `${label} ${Math.round(v.pct)}%`); if (v.resets) p.title = `Resets ${v.resets}`; box.appendChild(p); };
    if (cusage) {
      cp('Claude session', cusage.session); cp('Claude week', cusage.week);
      for (const [name, v] of Object.entries(cusage.models || {})) if (v.pct >= 80) cp(`${name} week`, v);
    }
    // This computer's token totals across all local sessions (not only this room). Hover for the breakdown.
    if (local) {
      const total = (u) => u.fresh + u.cached + u.cacheWrite + u.output;
      const part = (n, x) => (x === null ? `${n} no logs` : x.unknown ? `${n} unknown` : `${n} ${k(total(x.window))}`);
      const p = el('span', 'pill', `This computer · ${local.windowDays} days: ${part('Claude', local.claude)} · ${part('Codex', local.codex)}`);
      const line = (n, x, w) => (x && !x.unknown ? `${n} ${w === 'today' ? 'today' : `${local.windowDays} days`}: ${k(x[w].fresh)} new in · ${k(x[w].cached)} cached · ${k(x[w].cacheWrite)} cache writes · ${k(x[w].output)} out` : `${n}: ${x === null ? 'no local logs found' : 'log format not recognised'}`);
      p.title = [line('Claude', local.claude, 'today'), line('Claude', local.claude, 'window'), line('Codex', local.codex, 'today'), line('Codex', local.codex, 'window'),
        'Tokens from every Claude Code and Codex session on this computer, read from their local logs. Not included: web apps, other machines, cloud tasks. Most are cached reads, which cost far less than new input.',
        `Updated ${new Date(local.scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`].join('\n');
      box.appendChild(p);
    }
    if (codexUsage) { const p = el('span', 'pill', `Codex last turn ${k(codexUsage.fresh + codexUsage.cacheWrite)} new, ${k(codexUsage.cached)} cached`); p.title = `Output ${k(codexUsage.output)}`; box.appendChild(p); }
    if (cost) {
      const p = el('span', 'pill', `Claude ≈$${cost.toFixed(2)} at API rates${usage ? ` · last turn ${k(usage.input + usage.cacheWrite)} new, ${k(usage.cacheRead)} cached` : ''}`);
      p.title = 'Billed to your Claude plan, not charged. This is what the same tokens would cost on the API.'; box.appendChild(p);
    }
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
    title.appendChild(el('span', 'obj', t.objective || t.id));
    head.appendChild(title);
    const btns = el('div', 'taskbtns');
    const b = (label, fn, cls, tip) => { const x = el('button', `tbtn${cls ? ' ' + cls : ''}`, label); x.title = tip || label; x.addEventListener('click', fn); btns.appendChild(x); };
    if (t.status === 'active') b('Pause', () => vscode.postMessage({ type: 'taskPause' }), '', 'Pause: running turns finish, nothing new starts');
    else b('Resume', () => vscode.postMessage({ type: 'taskResume' }), '', 'Resume the task (raise its allowance first if it ran out)');
    b('Controls', () => openTaskControls(), '', 'Task allowances and mode');
    b('Stop', () => cmd('/stop'), 'danger', 'Stop the task and everything running under it');
    head.appendChild(btns); box.appendChild(head);
    const m = el('div', 'taskmeta');
    // Numbers, not only colour: turns and minutes as used / allowed, plus what stays reserved.
    m.appendChild(el('span', null, `${t.turns}/${t.limits.turns} turns${t.limits.reserve ? ` (${t.limits.reserve} kept for wrap-up)` : ''}`));
    m.appendChild(el('span', null, `${mins(t.usedMs)} of ${t.limits.minutes}m`));
    m.appendChild(el('span', null, `lead ${NAMES[t.lead]}`));
    m.appendChild(el('span', null, 'read-only'));
    m.appendChild(el('span', null, `${t.answered} answered · ${t.open.length} open`));
    box.appendChild(m);
    const us = Object.entries(t.usage || {});
    if (us.length) {
      const tk = el('div', 'taskmeta');
      tk.appendChild(el('span', null, `Tokens: ${us.map(([n, x]) => `${NAMES[n] || n} ${k(x.fresh + x.cacheWrite)} new · ${k(x.cached)} cached · ${k(x.output)} out${x.unreported ? ` (+${x.unreported} turn${x.unreported > 1 ? 's' : ''} unreported)` : ''}`).join(' · ')}`));
      box.appendChild(tk);
    }
    if (t.open.length || (t.log && t.log.length)) {
      const d = el('details', 'fold'); d.appendChild(el('summary', null, t.open.length ? t.open.map((r) => `${r.id} ${NAMES[r.from]} → ${NAMES[r.to]} · ${r.purpose} · ${r.status === 'delivered' ? 'with ' + NAMES[r.to] : 'waiting'}`).join('   ') : 'Activity'));
      const ol = el('ol'); for (const r of t.open) ol.appendChild(el('li', null, `${r.id}: ${r.question}`));
      for (const x of t.log || []) ol.appendChild(el('li', 'muted', `${stamp(x.at)} ${x.actor === 'host' ? 'Wagon Wheel' : NAMES[x.actor] || x.actor}: ${x.text}`));
      d.appendChild(ol); box.appendChild(d);
    }
    if (t.summary) box.appendChild(el('div', 'tasksum', t.summary));
  }
  function openTaskControls() {
    const pop = $('pop');
    if (!pop.hidden && pop.dataset.for === 'task') return closePop();
    pop.dataset.for = 'task'; pop.textContent = ''; pop.hidden = false; pop.style.left = 'auto'; pop.style.right = '0';
    const h = el('h4'); h.appendChild(el('span', null, 'Task controls')); h.appendChild(el('small', null, task ? `task ${task.id}` : 'for new tasks')); pop.appendChild(h);
    const md = el('div'); md.appendChild(el('div', 'lbl', 'Mode'));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Mode');
    for (const [v, tip] of [['auto', 'A task starts when an agent asks the other for help'], ['chat', 'One consultation per message, no task'], ['work', 'Every message starts a task']]) {
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
    for (const [key, label, help, max] of [['turns', 'Agent turns', 'Turn starts for this task across both agents, including retries', 200], ['reserve', 'Kept for wrap-up', 'Turns new requests may not use, so answers can come back', 50], ['minutes', 'Minutes', 'Active time; paused time does not count. At the limit running work stops', 1440]]) {
      const id = `lim-${key}`; const lab = el('label', null, label); lab.htmlFor = id; lab.title = help;
      const inp = document.createElement('input'); inp.type = 'number'; inp.id = id; inp.min = key === 'reserve' ? '0' : '1'; inp.max = String(max); inp.value = cur[key]; inp.title = help;
      inp.addEventListener('input', mark); fields[key] = inp; grid.appendChild(lab); grid.appendChild(inp);
    }
    pop.appendChild(grid); mark();
    function read() { return Object.fromEntries(Object.entries(fields).map(([k2, i]) => [k2, Number(i.value)])); }
    pop.appendChild(el('small', 'note', 'Token and dollar limits are not offered: usage arrives only after a turn. Presets never change the model, fast mode or permissions.'));
    pop.appendChild(el('small', 'note', 'Permissions: read-only for both agents. Tasks cover review and investigation. Claude has no shell access; Codex can use its read-only sandbox for local inspection. Editing and development workflows are not supported in this version.'));
    const acts = el('div', 'actions');
    if (task && !['completed', 'stopped'].includes(task.status)) { const a = el('button', 'primary', 'Apply to this task'); a.addEventListener('click', () => { vscode.postMessage({ type: 'taskLimits', limits: read() }); closePop(); }); acts.appendChild(a); }
    const sv = el('button', 'link', 'Save as my defaults'); sv.title = 'New tasks start with these; tasks already running keep theirs';
    sv.addEventListener('click', () => { vscode.postMessage({ type: 'taskDefaults', limits: read() }); closePop(); }); acts.appendChild(sv);
    pop.appendChild(acts);
  }
  function closePop() { $('pop').hidden = true; }
  function cmd(text) { vscode.postMessage({ type: 'command', text }); }
  function openPop(name) {
    const pop = $('pop'); if (!controls) return;
    if (!pop.hidden && pop.dataset.for === name) return closePop();
    pop.dataset.for = name; pop.textContent = ''; pop.hidden = false;
    const c = controls[name];
    const h = el('h4'); h.appendChild(el('span', null, `${GLYPH[name]}  ${NAMES[name]}`)); h.appendChild(el('small', null, name === 'claude' ? `Claude Code ${c.cli}` : 'Codex app-server')); pop.appendChild(h);
    const models = el('div'); models.appendChild(el('div', 'lbl', 'Model'));
    for (const m of c.models) {
      const b = el('button', `opt${m.id === c.model ? ' on' : ''}`); const l = el('span', null, m.name || m.id);
      const why = m.available === false ? `needs Claude Code ${m.minCli}+` : m.blocked || m.note;
      if (why) l.appendChild(el('small', null, `  ${why}`));
      b.appendChild(l); b.disabled = m.available === false || !!m.blocked;
      if (m.blocked) b.title = m.blocked;
      b.addEventListener('click', () => { cmd(`/${name} model ${m.id}`); closePop(); }); models.appendChild(b);
    }
    pop.appendChild(models);
    const cur = c.models.find((m) => m.id === c.model) || {};
    const efforts = name === 'claude' ? c.efforts : (cur.efforts || []);
    if (efforts.length) {
      const e = el('div'); e.appendChild(el('div', 'lbl', `Effort${name === 'codex' && cur.defaultEffort ? ` · default ${cur.defaultEffort}` : ''}`));
      const seg = el('div', 'seg');
      for (const v of efforts) { const b = el('button', v === c.effort ? 'on' : '', v); b.addEventListener('click', () => { cmd(`/${name} effort ${v}`); closePop(); }); seg.appendChild(b); }
      e.appendChild(seg); pop.appendChild(e);
    }
    const fastOk = name === 'claude' ? !!cur.fastOk : !!cur.fast;
    const row = el('div', 'fastrow'); const txt = el('div');
    txt.appendChild(el('span', null, '⚡ Fast mode'));
    txt.appendChild(el('small', null, name === 'claude' ? (fastOk ? 'Up to 2.5x faster Opus · billed to usage credits' : 'Opus 5.5 only, on Claude Code 2.1.205+') : (fastOk ? `${cur.fast.description} · priority tier` : 'Not offered for this model')));
    const sw = el('button', `switch${c.fast ? ' on' : ''}`); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!c.fast)); sw.setAttribute('aria-label', 'Fast mode');
    sw.disabled = !fastOk && !c.fast;
    sw.addEventListener('click', () => { cmd(`/${name} fast ${c.fast ? 'off' : 'on'}`); closePop(); });
    row.appendChild(txt); row.appendChild(sw); pop.appendChild(row);
    const ws = el('div'); ws.appendChild(el('div', 'lbl', `Working session${c.session ? ` · ${String(c.session).slice(0, 8)}` : ''}${c.typed ? '' : ' · no typed requests'}`));
    const wseg = el('div', 'seg');
    for (const [a, label, tip] of [['new', 'New', 'Start a fresh session for this agent'], ['continue', 'Continue…', 'Resume an existing session itself (you will be warned first)'], ['fork', 'Fork…', 'Branch a copy of an existing session; the original is untouched']]) {
      const x = el('button', '', label); x.title = tip; x.disabled = !!busy[name];
      x.addEventListener('click', () => { vscode.postMessage({ type: 'session', vendor: name, action: a }); closePop(); }); wseg.appendChild(x);
    }
    ws.appendChild(wseg); pop.appendChild(ws);
    const other = name === 'claude' ? 'codex' : 'claude';
    pop.appendChild(el('div', 'lbl', 'Shared history'));
    const hr = el('div', 'fastrow'); const ht = el('div');
    ht.appendChild(el('span', null, `Let ${NAMES[other]} read this session`));
    ht.appendChild(el('small', null, 'As read-only reference. Local sessions only.'));
    const hs = el('button', `switch${c.shared ? ' on' : ''}`); hs.setAttribute('role', 'switch'); hs.setAttribute('aria-checked', String(!!c.shared)); hs.setAttribute('aria-label', 'Share session history');
    hs.addEventListener('click', () => { cmd(`/history share ${name} ${c.shared ? 'off' : 'on'}`); closePop(); });
    hr.appendChild(ht); hr.appendChild(hs); pop.appendChild(hr);
    if (c.shared) {
      const ar = el('div', 'fastrow'); const at = el('div');
      at.appendChild(el('span', null, 'Include earlier history'));
      at.appendChild(el('small', null, c.allHistory !== false ? `${NAMES[other]} can read the whole session.` : `${NAMES[other]} can read only what is said from when you turned this off.`));
      const as = el('button', `switch${c.allHistory !== false ? ' on' : ''}`); as.setAttribute('role', 'switch'); as.setAttribute('aria-checked', String(c.allHistory !== false)); as.setAttribute('aria-label', 'Include earlier history');
      as.addEventListener('click', () => { cmd(`/history all ${name} ${c.allHistory !== false ? 'off' : 'on'}`); closePop(); });
      ar.appendChild(at); ar.appendChild(as); pop.appendChild(ar);
    }
    // What this agent can do here: one line, full detail on hover.
    const cap = el('small', 'note cap', name === 'claude' ? 'Read-only · no shell, web or edits' : 'Read-only sandbox · no edits, web or connectors');
    cap.title = name === 'claude' ? 'Read, Glob and Grep inside the room folder, plus the room tools (ask the other agent, read shared history, finish a task). No edits, no shell, no web, no other MCP servers. Your own Claude settings do not apply here.'
      : 'Read-only sandbox for local inspection, plus the room tools when its thread has them. Read access is not confined to the room folder. Every approval request is declined. Web search, connected apps and external MCP tools are disabled and checked before the thread is used.';
    pop.appendChild(cap);
    const save = el('button', 'link', 'Use these settings for new rooms');
    save.addEventListener('click', () => { vscode.postMessage({ type: 'saveDefaults', vendor: name }); closePop(); });
    pop.appendChild(save);
    if (name === 'codex') pop.style.left = 'auto', pop.style.right = '0'; else pop.style.left = '0', pop.style.right = 'auto';
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
      meta = m.meta || {}; NAMES.human = meta.humanName || 'You';
      for (const p of meta.participants || []) { if (!NAMES[p.id]) NAMES[p.id] = p.label; if (!GLYPH[p.id]) GLYPH[p.id] = '◆'; } specs = m.commands || specs; controls = m.controls || controls;
      $('title').textContent = meta.name || 'Wagon Wheel';
      $('ids').textContent = [meta.cwd, meta.forkedFrom && `codex fork of ${meta.forkedFrom.slice(0, 8)}`, meta.claudeForkedFrom && `claude fork of ${meta.claudeForkedFrom.slice(0, 8)}`].filter(Boolean).join(' · ');
      (m.transcript || []).forEach((e) => add(render(e)));
      busy = m.busy || {}; cost = m.cost || 0; if (m.quota) quota = m.quota;
      renderQuota(); renderChips(); renderWho(); renderTask(); log.scrollTop = log.scrollHeight;
    } else if (m.type === 'message') { setDraft(m.entry.from, null); add(render(m.entry)); }
    else if (m.type === 'draft') setDraft(m.name, m.text);
    else if (m.type === 'activity') setActivity(m);
    else if (m.type === 'status') {
      busy[m.name] = m.busy;
      if (m.busy) since[m.name] = m.since || Date.now(); else { delete act[m.name]; delete since[m.name]; }
      if (typeof m.cost === 'number') cost = m.cost; if (m.usage) usage = m.usage; if (m.codexUsage) codexUsage = m.codexUsage;
      renderWho(); renderQuota();
    }
    else if (m.type === 'quota') { quota = m.quota; renderQuota(); }
    else if (m.type === 'localUsage') { local = m.usage; renderQuota(); }
    else if (m.type === 'task') { task = m.task; taskMode = m.mode || 'auto'; taskDefaults = m.defaults; presets = m.presets || presets; typedAgents = m.typed || {}; renderTask(); }
    else if (m.type === 'claudeUsage') { cusage = m.usage; renderQuota(); }
    else if (m.type === 'meta') { meta = m.meta; specs = m.commands || specs; controls = m.controls || controls; renderChips(); }
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
  const AT = [{ label: '@claude', insert: '@claude ', desc: 'Claude only' }, { label: '@codex', insert: '@codex ', desc: 'Codex only' }, { label: '@both', insert: '@both ', desc: 'Both, taking turns' }];
  function suggestions() {
    const caret = input.selectionStart, before = input.value.slice(0, caret);
    const at = before.match(/(^|\s)@(\w*)$/);
    if (at) return { from: caret - at[2].length - 1, to: caret, items: AT.filter((a) => a.label.slice(1).startsWith(at[2].toLowerCase())) };
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
  $('vc-claude').addEventListener('click', () => openPop('claude'));
  $('vc-codex').addEventListener('click', () => openPop('codex'));
  $('tc').addEventListener('click', () => openTaskControls());
  // Lead picker: who drives the work and hears untagged messages.
  $('lead').addEventListener('click', () => {
    const pop = $('pop');
    if (!pop.hidden && pop.dataset.for === 'lead') return closePop();
    pop.dataset.for = 'lead'; pop.textContent = ''; pop.hidden = false; pop.style.left = 'auto'; pop.style.right = '0';
    const h = el('h4'); h.appendChild(el('span', null, 'Who leads?')); h.appendChild(el('small', null, 'untagged messages go to the lead')); pop.appendChild(h);
    const cur = meta.defaultTarget || 'claude';
    for (const [v, label, note] of [['claude', '✳  Claude', 'Claude drives; Codex helps when asked'], ['codex', '>_  Codex', 'Codex drives; Claude helps when asked'], ['both', '✳ >_  Both', 'Both answer, taking turns']]) {
      const b = el('button', `opt${v === cur ? ' on' : ''}`); const l = el('span', null, label); l.appendChild(el('small', null, `  ${note}`)); b.appendChild(l);
      b.addEventListener('click', () => { cmd(`/default ${v}`); closePop(); }); pop.appendChild(b);
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#pop') && !e.target.closest('.vendor') && !e.target.closest('#lead') && !e.target.closest('#tc') && !e.target.closest('#task')) closePop(); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dropping');
    const dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length) return readAndAttach(dt.files);
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
    if (uris.length) vscode.postMessage({ type: 'attachUris', uris });
  });
  renderChips(); renderWho(); renderTask(); grow();
  vscode.postMessage({ type: 'ready' });
})();
