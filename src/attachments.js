'use strict';
// Attachments: store user files with the room, and turn them into each agent's native input.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yml', '.yaml', '.toml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.cs', '.sh', '.zsh', '.ps1', '.sql', '.log', '.ini', '.env.example', '.diff', '.patch']);
const LIMITS = { imageBytes: 5 * 1024 * 1024, inlineTextBytes: 200 * 1024, fileBytes: 25 * 1024 * 1024 };

function kindOf(name, buf) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime: IMAGE_TYPES[ext] };
  if (ext === '.pdf') return { kind: 'file', mime: 'application/pdf' };
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain' };
  if (buf && !buf.subarray(0, 8192).includes(0)) return { kind: 'text', mime: 'text/plain' }; // no NUL bytes: treat as text
  return { kind: 'file', mime: 'application/octet-stream' };
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  return base || 'file';
}

// Copy (or write) a file into the room's attachment folder. Returns the stored attachment record.
function store(dir, { name, data, fromPath }) {
  const buf = data ? Buffer.from(data, 'base64') : fs.readFileSync(fromPath);
  if (buf.length > LIMITS.fileBytes) throw new Error(`${name} is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${LIMITS.fileBytes / 1048576} MB`);
  const { kind, mime } = kindOf(name, buf);
  if (kind === 'image' && buf.length > LIMITS.imageBytes) throw new Error(`${name} is over the ${LIMITS.imageBytes / 1048576} MB image limit`);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const stored = path.join(dir, `${id}-${safeName(name)}`);
  fs.writeFileSync(stored, buf);
  return { id, name: safeName(name), path: stored, kind, mime, size: buf.length };
}

function inlineText(att) {
  if (att.size > LIMITS.inlineTextBytes) return null;
  return fs.readFileSync(att.path, 'utf8');
}

// The text an agent reads for non-image files: inline content when small, otherwise a path to open.
function describeForText(att) {
  if (att.kind === 'text') {
    const body = inlineText(att);
    if (body != null) return `[Attached file: ${att.name}]\n\`\`\`\n${body.replace(/```/g, '`​``')}\n\`\`\``;
  }
  return `[Attached file: ${att.name} (${att.mime}, ${Math.round(att.size / 1024)} KB) at ${att.path}. Open it with your read tools if you need it.]`;
}

// Claude stream-json user content: text first, then images as base64 blocks, other files described in text.
function toClaudeContent(text, atts = []) {
  const extra = atts.filter((a) => a.kind !== 'image').map(describeForText);
  const content = [{ type: 'text', text: [text, ...extra].filter(Boolean).join('\n\n') }];
  for (const a of atts.filter((x) => x.kind === 'image')) {
    content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } });
  }
  return content;
}

// Codex turn/start input: text (with non-image files described), then local image paths.
function toCodexInput(text, atts = []) {
  const extra = atts.filter((a) => a.kind !== 'image').map(describeForText);
  const input = [{ type: 'text', text: [text, ...extra].filter(Boolean).join('\n\n'), text_elements: [] }];
  for (const a of atts.filter((x) => x.kind === 'image')) input.push({ type: 'localImage', path: a.path });
  return input;
}

module.exports = { store, kindOf, toClaudeContent, toCodexInput, describeForText, LIMITS };
