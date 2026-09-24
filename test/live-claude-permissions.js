'use strict';
// Live check of the room Claude's effective toolset, with the same launch flags as a room. Proves that the user's
// own settings (for example an allow rule for a shell command) do not reach the room: the session exposes only
// Read, Glob, Grep and the room's tools, and a shell attempt is refused. Spends a little quota (Haiku).
// Usage: node test/live-claude-permissions.js <scratchCwd>
const { ClaudeClient, READ_ONLY_TOOLS } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const { toolSpecs } = require('../src/tasks');
let failed = false; const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
(async () => {
  const tools = toolSpecs(['codex']);
  const c = new ClaudeClient({ exe: findClaude('').path, cwd: process.argv[2], model: 'haiku', systemPrompt: 'Test session. Follow instructions literally.', tools });
  let initTools = null; const results = [];
  const orig = c._onLine.bind(c);
  c._onLine = (line) => { try { const m = JSON.parse(line); if (m.type === 'system' && m.subtype === 'init') initTools = m.tools; if (m.type === 'user' && m.message && Array.isArray(m.message.content)) for (const b of m.message.content) if (b.type === 'tool_result') results.push(JSON.stringify(b.content)); } catch { /* not JSON */ } orig(line); };
  await c.send('Use the Bash tool to run: echo WW_SHELL_RAN   Then reply with the exact output or the exact error.');
  const expected = [...READ_ONLY_TOOLS, ...tools.map((t) => `mcp__wagon__${t.name}`)].sort();
  check(JSON.stringify((initTools || []).slice().sort()) === JSON.stringify(expected), `session tools are exactly ${expected.join(',')} (got ${(initTools || []).join(',')})`);
  check(!results.some((r) => /WW_SHELL_RAN/.test(r)), 'no shell command ran');
  c.stop(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
