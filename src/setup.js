'use strict';
// Explicit, read-only setup probes. The host supplies trusted configured executables.
const { execFile } = require('child_process');
const GUIDES = Object.freeze({
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
});
function runProbe(executable, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(executable, args, { encoding: 'utf8', timeout: 10000,
        maxBuffer: 65536, windowsHide: true, shell: false }, (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, timedOut: !!(error && error.killed), stdout, stderr });
      });
      child.stdin.end();
    } catch { resolve({ code: 'SPAWN_ERROR', stdout: '', stderr: '' }); }
  });
}
function failure(result) {
  if (result.timedOut) return 'timed-out';
  if (result.code === 'ENOENT') return 'missing';
  if (result.code === 'EACCES' || result.code === 'EPERM') return 'not-executable';
  return 'check-failed';
}
async function checkProvider(provider, executable, { run = runProbe } = {}) {
  if (!Object.hasOwn(GUIDES, provider) || typeof executable !== 'string' || !executable.trim()
      || executable.includes('\0')) throw new Error('Invalid setup provider or executable');
  const result = { provider, executable, guide: GUIDES[provider],
    installation: 'unknown', version: null, authentication: 'unknown', issue: null };
  let version;
  try { version = await run(executable, ['--version']); }
  catch { return { ...result, issue: 'check-failed' }; }
  if (version.code !== 0) return { ...result, installation: version.code === 'ENOENT' ? 'missing' : 'unknown', issue: failure(version) };
  const text = String(version.stdout || '').trim();
  const pattern = provider === 'codex' ? /^codex-cli\s+(\d+\.\d+\.\d+)(?:\S*)$/
    : /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/;
  const match = text.match(pattern);
  if (!match) return { ...result, issue: 'unrecognized-version' };
  result.installation = 'available'; result.version = match[1];
  let auth;
  try { auth = await run(executable, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']); }
  catch { return { ...result, issue: 'auth-check-failed' }; }
  if (auth.timedOut || ![0, 1].includes(auth.code)) return { ...result, issue: 'auth-check-failed' };
  if (provider === 'claude') {
    try {
      const parsed = JSON.parse(auth.stdout);
      if (parsed.loggedIn === true && auth.code === 0) result.authentication = 'present';
      else if (parsed.loggedIn === false) result.authentication = 'signed-out';
    } catch { /* unsupported CLI output is unknown, not signed out */ }
  } else {
    const output = `${auth.stdout || ''}\n${auth.stderr || ''}`;
    if (auth.code === 0 && /^Logged in using (ChatGPT|an API key|an access token)\b/m.test(output)) result.authentication = 'present';
    else if (/^Not logged in\s*$/m.test(output)) result.authentication = 'signed-out';
  }
  if (result.authentication === 'unknown') result.issue = 'auth-check-unsupported';
  // Never expose raw auth output: it may contain an email, key prefix or filesystem metadata.
  return result;
}
async function checkSetup({ executables, executionHost, trusted }, options = {}) {
  if (!trusted) return { state: 'workspace-untrusted', providers: [], executionHost };
  if (typeof executionHost !== 'string' || !executionHost.trim()) throw new Error('Execution host label is required');
  const entries = Object.entries(executables || {});
  const providers = await Promise.all(entries.map(([provider, executable]) => checkProvider(provider, executable, options)));
  return { executionHost, providers, state: providers.length && providers.every((p) => p.installation === 'available'
    && p.authentication === 'present') ? 'credentials-present' : 'needs-attention',
  note: 'Sign-in status does not verify quota, model access, or working-session tools.' };
}
module.exports = { checkProvider, checkSetup, runProbe, GUIDES };
