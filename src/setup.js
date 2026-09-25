'use strict';
// Explicit, read-only setup probes. The host supplies trusted configured executables.
const { execFile } = require('child_process');
const GUIDES = Object.freeze({
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
});
const VERSION = Object.freeze({
  codex: /^codex-cli\s+(\d+\.\d+\.\d+)(?:\S*)$/,
  claude: /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/,
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
  const match = String(version.stdout || '').trim().match(VERSION[provider]);
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
// Version only, for problem reports: no sign-in probe, no raw output returned.
async function cliVersion(provider, executable, { run = runProbe } = {}) {
  if (!Object.hasOwn(VERSION, provider) || typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) return 'unknown';
  let r;
  try { r = await run(executable, ['--version']); } catch { return 'unknown'; }
  if (r.code === 'ENOENT') return 'not found';
  const m = r.code === 0 && String(r.stdout || '').trim().match(VERSION[provider]);
  return m ? m[1] : 'unknown';
}

// First run: check each provider the new room's seats use, once. A provider that passed before is not probed
// again. Only a missing or non-executable CLI or an explicit signed-out answer stops a room. A probe that timed
// out, failed or could not read the version does not: it is not proof of a broken setup.
const PASSED_KEY = 'wagonWheel.setupPassed';
function firstRunProviders(seats, passed) {
  const done = passed && typeof passed === 'object' ? passed : {};
  return [...new Set((seats || []).map((p) => p && p.provider))].filter((p) => Object.hasOwn(GUIDES, p) && done[p] !== true);
}
const blocking = (p) => p.installation === 'missing' || p.issue === 'missing' || p.issue === 'not-executable' || p.authentication === 'signed-out';
const passes = (p) => p.installation === 'available' && p.authentication === 'present';

module.exports = { checkProvider, checkSetup, runProbe, cliVersion, firstRunProviders, blocking, passes, PASSED_KEY, GUIDES };
