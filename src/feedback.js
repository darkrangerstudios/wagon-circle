'use strict';
// Report a Problem: builds a prefilled GitHub issue from versions, the room's roster and, only when the person
// opts in, a few scrubbed log lines. Pure: the caller gathers facts and opens the URL. Nothing is sent from here;
// the person reviews and submits on GitHub. Never add transcript, prompt, attachment or session content.
const ISSUES_URL = 'https://github.com/darkrangerstudios/wagon-wheel/issues/new';
const MAX_URL = 7500; // GitHub rejects very long new-issue URLs; stay well under its limit
const LOG_LINES = 10;
const LINE_CHARS = 200;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Best-effort removal of personal and secret-shaped text from a log line. The person still sees every line
// before choosing to include it; this only lowers the chance of a careless paste.
function scrub(line, { home, user } = {}) {
  let s = String(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
  if (home && home.length > 1) s = s.replace(new RegExp(escapeRe(home), 'g'), '~');
  s = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, '<redacted>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<redacted>')
    // Long unbroken runs with a digit look like keys or ids. Slashes split runs, so ordinary paths survive.
    .replace(/(?=[A-Za-z_=+-]*\d)[A-Za-z0-9_=+-]{32,}/g, '<redacted>');
  if (user && user.length >= 3) s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(user)}(?=$|[^A-Za-z0-9])`, 'g'), '$1<user>');
  return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s;
}

function tail(lines, who) {
  return (Array.isArray(lines) ? lines : []).slice(-LOG_LINES).map((l) => scrub(l, who));
}

const cli = (c) => `${c.name}: ${c.version ? c.version : c.state || 'unknown'}`;
const seat = (p) => `${p.label || p.id} (${[p.provider, p.model || 'default model', p.effort].filter(Boolean).join(', ')})`;

function body(f, logLines) {
  const env = [
    `- Wagon Wheel: ${f.extension}`,
    `- VS Code: ${f.vscode} (${f.platform}${f.remote ? `, remote: ${f.remote}` : ''})`,
    ...(f.clis || []).map((c) => `- ${cli(c)}`),
    `- Room: ${f.seats && f.seats.length ? f.seats.map(seat).join(', ') : 'no room open'}`,
  ];
  const parts = [
    '**What happened**', '', '<!-- What did you do, and what went wrong? -->', '',
    '**What you expected**', '', '',
    '---',
    'Filled in by Wagon Wheel: Report a Problem. It contains no conversation, prompts, files or session contents. Edit or delete anything before you submit.',
    '', ...env,
  ];
  if (logLines.length) parts.push('', `<details><summary>Last ${logLines.length} log lines (scrubbed)</summary>`, '', '```', ...logLines, '```', '</details>');
  return parts.join('\n');
}

// Returns { url, logLines } where logLines is what actually made it in (older lines drop first if too long).
function issueUrl(facts, { includeLog = false, home, user } = {}) {
  let lines = includeLog ? tail(facts.log, { home, user }) : [];
  const title = facts.title || '';
  const make = () => `${ISSUES_URL}?${new URLSearchParams({ title, body: body(facts, lines) })}`;
  let url = make();
  while (url.length > MAX_URL && lines.length) { lines = lines.slice(1); url = make(); }
  return { url, logLines: lines };
}

module.exports = { issueUrl, scrub, tail, ISSUES_URL, MAX_URL, LOG_LINES };
