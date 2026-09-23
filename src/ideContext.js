'use strict';
// IDE context attached to a message: what the human is looking at in VS Code. Plain data in, text out.
const LIMITS = { selectionChars: 8000, visibleLines: 60, tabs: 15, problems: 10 };

const clipText = (s, n) => (s.length > n ? s.slice(0, n) + '\n…[trimmed]' : s);

// snap: { file, language, selection: {start, end, text} | null, cursor, visible: {start, end, text} | null, tabs: [], problems: [{severity, line, message}] }
function summary(snap) {
  if (!snap || !snap.file) return null;
  const base = snap.file.split('/').pop();
  if (snap.selection) return `${base} · L${snap.selection.start}${snap.selection.end !== snap.selection.start ? '–' + snap.selection.end : ''} selected`;
  return `${base} · L${snap.cursor}`;
}

function format(snap) {
  if (!snap || !snap.file) return null;
  const out = [`Active file: ${snap.file}${snap.language ? ` (${snap.language})` : ''}, cursor on line ${snap.cursor}`];
  if (snap.selection) out.push(`Selected lines ${snap.selection.start}-${snap.selection.end}:\n\`\`\`\n${clipText(snap.selection.text, LIMITS.selectionChars)}\n\`\`\``);
  else if (snap.visible) out.push(`Visible lines ${snap.visible.start}-${snap.visible.end}:\n\`\`\`\n${clipText(snap.visible.text, LIMITS.selectionChars)}\n\`\`\``);
  if (snap.problems && snap.problems.length) out.push(`Problems in this file:\n${snap.problems.slice(0, LIMITS.problems).map((p) => `- ${p.severity} line ${p.line}: ${p.message}`).join('\n')}`);
  if (snap.tabs && snap.tabs.length) out.push(`Open tabs: ${snap.tabs.slice(0, LIMITS.tabs).join(', ')}`);
  return out.join('\n');
}

module.exports = { summary, format, LIMITS };
