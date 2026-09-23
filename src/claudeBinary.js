'use strict';
// Pick the newest Claude Code CLI on the machine. A stale ~/.local/bin/claude can lag far behind the one
// bundled with the VS Code extension, and new models refuse to run on old CLIs.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

function version(exe) {
  try { const m = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 }).match(/(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1).map(Number) : null; } catch { return null; }
}
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const atLeast = (v, s) => !!v && cmp(v, s.split('.').map(Number)) >= 0;

function candidates() {
  const home = os.homedir(), out = [path.join(home, '.local/bin/claude')];
  for (const root of [path.join(home, '.vscode/extensions'), path.join(home, '.cursor/extensions')]) {
    let dirs = []; try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-')); } catch { /* none */ }
    for (const d of dirs) out.push(path.join(root, d, 'resources/native-binary/claude'));
  }
  return out.filter((p) => fs.existsSync(p));
}

// setting wins when set; otherwise the highest version found.
function findClaude(setting) {
  if (setting) return { path: setting, version: version(setting) };
  let best = null;
  for (const p of candidates()) { const v = version(p); if (v && (!best || cmp(v, best.version) > 0)) best = { path: p, version: v }; }
  return best || { path: 'claude', version: version('claude') };
}

module.exports = { findClaude, atLeast, version };
