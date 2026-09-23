// Wagon Circle webview. Agent output is untrusted: everything renders through textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input');
  const NAMES = { human: 'You', claude: 'Claude', codex: 'Codex', system: 'Wagon Circle' };
  const drafts = {}; let busy = {}; let cost = 0; let usage = null;
  const act = {}; const since = {}; let ticker = null;
  let pending = []; // attachments waiting to be sent

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // Code fences become <pre>; everything else is plain pre-wrapped text.
  function body(text) {
    const wrap = el('div', 'body');
    String(text).split(/```[^\n]*\n?/).forEach((part, i) => { if (part) wrap.appendChild(el(i % 2 ? 'pre' : 'div', i % 2 ? 'code' : 'text', part.replace(/\n$/, ''))); });
    return wrap;
  }

  function bubble(entry) {
    const b = el('article', `msg from-${entry.from}${entry.kind ? ' kind-' + entry.kind : ''}`);
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'who', entry.kind === 'history' ? `${entry.from === 'human' ? 'User' : NAMES[entry.from]} · earlier` : NAMES[entry.from]));
    if (entry.ts) meta.appendChild(el('span', 'ts', new Date(entry.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    b.appendChild(meta); if (entry.text) b.appendChild(body(entry.text)); else b.appendChild(el('div', 'body'));
    if (entry.attachments && entry.attachments.length) b.appendChild(files(entry.attachments));
    if (entry.steps && entry.steps.length) {
      const d = el('details', 'steps'); d.appendChild(el('summary', null, `${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'}`));
      const ol = el('ol'); entry.steps.forEach((s) => ol.appendChild(el('li', null, s))); d.appendChild(ol); b.appendChild(d);
    }
    return b;
  }

  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  // Attachments: image thumbnails, other files as chips. Optional remove button for the tray.
  function files(list, onRemove) {
    const row = el('div', 'files');
    for (const a of list) {
      const chip = el('div', `file kind-${a.kind}`);
      if (a.kind === 'image' && a.src) { const img = el('img'); img.alt = a.name; img.addEventListener('load', () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 400) log.scrollTop = log.scrollHeight; }); img.src = a.src; chip.appendChild(img); }
      chip.appendChild(el('span', 'fname', `${a.kind === 'image' ? '' : '📄 '}${a.name} · ${kb(a.size)}`));
      if (onRemove) { const x = el('button', 'x', '×'); x.title = `Remove ${a.name}`; x.setAttribute('aria-label', `Remove ${a.name}`); x.addEventListener('click', () => onRemove(a)); chip.appendChild(x); }
      row.appendChild(chip);
    }
    return row;
  }
  function renderTray() {
    const t = $('tray'); t.textContent = ''; t.hidden = !pending.length;
    if (pending.length) t.appendChild(files(pending, (a) => { pending = pending.filter((p) => p.id !== a.id); vscode.postMessage({ type: 'unattach', id: a.id }); renderTray(); }));
  }
  function readAndAttach(fileList) {
    for (const f of fileList) {
      const r = new FileReader();
      r.onload = () => vscode.postMessage({ type: 'attachData', name: f.name || `pasted-${Date.now()}.png`, data: String(r.result).split(',')[1] || '' });
      r.readAsDataURL(f);
    }
  }

  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function add(node) { const stick = atBottom(); log.appendChild(node); if (stick) log.scrollTop = log.scrollHeight; }

  // In-progress bubble: live step line, collapsible thinking, then the reply as it streams.
  function ensureDraft(name) {
    if (drafts[name]) return drafts[name];
    const d = bubble({ from: name, text: '' }); d.classList.add('draft');
    const line = el('div', 'act'); d.insertBefore(line, d.querySelector('.body'));
    const th = el('details', 'thinking'); th.hidden = true; th.appendChild(el('summary', null, 'thinking')); th.appendChild(el('div', 'thought'));
    d.insertBefore(th, d.querySelector('.body'));
    drafts[name] = d; add(d); return d;
  }
  function setDraft(name, text) {
    if (text == null) { if (drafts[name]) { drafts[name].remove(); delete drafts[name]; } return; }
    const d = ensureDraft(name), stick = atBottom();
    d.replaceChild(body(text), d.querySelector('.body'));
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function setActivity(a) {
    act[a.name] = a;
    const d = ensureDraft(a.name), stick = atBottom();
    d.querySelector('.act').textContent = a.label;
    d.querySelector('.act').className = `act phase-${a.phase}`;
    if (a.thinking) { const th = d.querySelector('.thinking'); th.hidden = false; th.querySelector('.thought').textContent = a.thinking; }
    renderWho(); if (stick) log.scrollTop = log.scrollHeight;
  }

  function renderWho() {
    const w = $('who'); w.textContent = '';
    for (const n of ['claude', 'codex']) if (busy[n]) {
      const secs = since[n] ? Math.max(0, Math.round((Date.now() - since[n]) / 1000)) : 0;
      w.appendChild(el('span', `typing t-${n}`, `${NAMES[n]} · ${act[n] ? act[n].label : 'starting'} · ${secs}s`));
    }
    $('stop').disabled = !busy.claude && !busy.codex;
    if ((busy.claude || busy.codex) && !ticker) ticker = setInterval(renderWho, 1000);
    if (!busy.claude && !busy.codex && ticker) { clearInterval(ticker); ticker = null; }
    const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const c = $('cost'); if (c) c.textContent = cost ? `Claude $${cost.toFixed(3)}${usage ? ` · last turn ${k(usage.input + usage.cacheWrite)} new, ${k(usage.cacheRead)} cached` : ''}` : '';
    if (c) c.title = 'New tokens are billed at full price; cached tokens are re-read at a fraction of it.';
  }

  function when(sec) { return sec ? new Date(sec * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '?'; }
  function renderQuota(q) {
    const box = $('quota'); box.textContent = '';
    if (!q) { box.appendChild(el('span', 'dim', 'Codex quota: unknown')); }
    else {
      const span = (w, fallback) => !w.windowDurationMins ? fallback : w.windowDurationMins >= 10080 ? 'week' : w.windowDurationMins >= 1440 ? `${Math.round(w.windowDurationMins / 1440)}d` : `${Math.round(w.windowDurationMins / 60)}h`;
      for (const [k, w] of [['short', q.primary], ['long', q.secondary]]) if (w) {
        const pill = el('span', `pill${w.usedPercent >= 100 ? ' full' : w.usedPercent >= 80 ? ' warn' : ''}`, `Codex ${span(w, k)} ${Math.round(w.usedPercent)}%`);
        pill.title = `resets ${when(w.resetsAt)}`; box.appendChild(pill);
      }
      if (q.resetCredits != null) { const p = el('span', 'pill dim', `${q.resetCredits} reset credit${q.resetCredits === 1 ? '' : 's'} (Wagon Circle never spends them)`); box.appendChild(p); }
    }
    const c = el('span', 'pill dim'); c.id = 'cost'; box.appendChild(c); renderWho();
  }

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'init') {
      log.textContent = ''; Object.keys(drafts).forEach((k) => delete drafts[k]);
      NAMES.human = m.meta.humanName || 'You';
      $('title').textContent = m.meta.name;
      $('ids').textContent = [m.meta.codexThreadId && `codex ${m.meta.codexThreadId.slice(0, 8)}`, m.meta.forkedFrom && `fork of ${m.meta.forkedFrom.slice(0, 8)}`, m.meta.cwd].filter(Boolean).join(' · ');
      (m.transcript || []).forEach((e) => add(bubble(e)));
      busy = m.busy || {}; cost = m.cost || 0; renderQuota(m.quota); log.scrollTop = log.scrollHeight;
    } else if (m.type === 'message') { setDraft(m.entry.from, null); add(bubble(m.entry)); }
    else if (m.type === 'draft') setDraft(m.name, m.text);
    else if (m.type === 'status') { busy[m.name] = m.busy; if (m.busy) since[m.name] = m.since || Date.now(); else { delete act[m.name]; delete since[m.name]; } if (typeof m.cost === 'number') cost = m.cost; if (m.usage) usage = m.usage; renderWho(); }
    else if (m.type === 'activity') setActivity(m);
    else if (m.type === 'attached') { pending.push(m.att); renderTray(); }
    else if (m.type === 'attachError') add(bubble({ from: 'system', kind: 'error', text: `Couldn't attach: ${m.text}`, ts: Date.now() }));
    else if (m.type === 'quota') renderQuota(m.quota);
    else if (m.type === 'notice') add(bubble({ from: 'system', kind: 'error', text: m.text, ts: Date.now() }));
  });

  function send() {
    const t = input.value.trim(); if (!t && !pending.length) return;
    vscode.postMessage({ type: 'send', text: t, attachmentIds: pending.map((a) => a.id) });
    input.value = ''; pending = []; renderTray(); input.focus();
  }
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  input.addEventListener('paste', (e) => { const fl = e.clipboardData && e.clipboardData.files; if (fl && fl.length) { e.preventDefault(); readAndAttach(fl); } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dropping');
    const dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length) return readAndAttach(dt.files);
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
    if (uris.length) vscode.postMessage({ type: 'attachUris', uris });
  });
  $('send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.querySelectorAll('#chips button[data-m]').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.m; if (!input.value.includes(m)) input.value = `${m} ${input.value}`.trimEnd() + ' '; input.focus();
  }));
  vscode.postMessage({ type: 'ready' });
})();
