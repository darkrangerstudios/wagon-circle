// Campfire webview. Agent output is untrusted: everything renders through textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input');
  const NAMES = { human: 'You', claude: 'Claude', codex: 'Codex', system: 'Campfire' };
  const drafts = {}; let busy = {}; let cost = 0;

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
    b.appendChild(meta); b.appendChild(body(entry.text));
    return b;
  }

  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function add(node) { const stick = atBottom(); log.appendChild(node); if (stick) log.scrollTop = log.scrollHeight; }

  function setDraft(name, text) {
    if (text == null) { if (drafts[name]) { drafts[name].remove(); delete drafts[name]; } return; }
    if (!drafts[name]) { drafts[name] = bubble({ from: name, text: '' }); drafts[name].classList.add('draft'); add(drafts[name]); }
    const stick = atBottom();
    drafts[name].replaceChild(body(text || '…'), drafts[name].querySelector('.body'));
    log.appendChild(drafts[name]); if (stick) log.scrollTop = log.scrollHeight;
  }

  function renderWho() {
    const w = $('who'); w.textContent = '';
    for (const n of ['claude', 'codex']) if (busy[n]) w.appendChild(el('span', `typing t-${n}`, `${NAMES[n]} is thinking`));
    $('stop').disabled = !busy.claude && !busy.codex;
    const c = $('cost'); if (c) c.textContent = cost ? `Claude $${cost.toFixed(3)}` : '';
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
      if (q.resetCredits != null) { const p = el('span', 'pill dim', `${q.resetCredits} reset credit${q.resetCredits === 1 ? '' : 's'} (Campfire never spends them)`); box.appendChild(p); }
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
    else if (m.type === 'status') { busy[m.name] = m.busy; if (typeof m.cost === 'number') cost = m.cost; renderWho(); }
    else if (m.type === 'quota') renderQuota(m.quota);
    else if (m.type === 'notice') add(bubble({ from: 'system', kind: 'error', text: m.text, ts: Date.now() }));
  });

  function send() { const t = input.value.trim(); if (!t) return; vscode.postMessage({ type: 'send', text: t }); input.value = ''; input.focus(); }
  $('send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.querySelectorAll('#chips button[data-m]').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.m; if (!input.value.includes(m)) input.value = `${m} ${input.value}`.trimEnd() + ' '; input.focus();
  }));
  vscode.postMessage({ type: 'ready' });
})();
