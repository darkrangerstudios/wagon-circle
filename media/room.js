// Campfire webview. Agent output is untrusted: everything renders through textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input');
  const NAMES = { human: 'You', claude: 'Claude', codex: 'Codex', system: 'Campfire' };
  const drafts = {}; let busy = {}; let cost = 0; let usage = null;
  const act = {}; const since = {}; let ticker = null;

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
    if (entry.steps && entry.steps.length) {
      const d = el('details', 'steps'); d.appendChild(el('summary', null, `${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'}`));
      const ol = el('ol'); entry.steps.forEach((s) => ol.appendChild(el('li', null, s))); d.appendChild(ol); b.appendChild(d);
    }
    return b;
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
    else if (m.type === 'status') { busy[m.name] = m.busy; if (m.busy) since[m.name] = m.since || Date.now(); else { delete act[m.name]; delete since[m.name]; } if (typeof m.cost === 'number') cost = m.cost; if (m.usage) usage = m.usage; renderWho(); }
    else if (m.type === 'activity') setActivity(m);
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
