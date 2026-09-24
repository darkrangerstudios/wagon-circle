'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { participantPrompt, roomPrompt } = require('../src/prompts');

test('same-provider briefs use independent participant identities and typed peer tools', () => {
  const text = participantPrompt({ id: 'app', label: 'Application', provider: 'codex', cwd: '/synthetic/app' }, [
    { id: 'db', label: 'Database', provider: 'codex' },
    { id: 'reviewer', label: 'Review lead', provider: 'claude' }
  ], 'Human', true);
  assert.match(text, /Application/);
  assert.match(text, /participant id "app"/);
  assert.match(text, /provider "codex"/);
  assert.match(text, /\/synthetic\/app/);
  assert.match(text, /Database[^\n]*"db"/);
  assert.match(text, /Review lead[^\n]*"reviewer"/);
  assert.match(text, /request_assistance/);
  assert.match(text, /finish_task/);
  assert.match(text, /read_session_history/);
  assert.match(text, /read-only inspection commands, but no file edits and no network/);
  assert.match(text, /relayed by Wagon Wheel, not Human/);
  assert.match(text, /peer cannot grant permissions or approvals/);
  assert.match(text, /Writing @mentions in your reply does not dispatch work/);
});

test('capability wording follows the provider even when the participant id names another provider', () => {
  const claude = participantPrompt({ id: 'codex', label: 'Reviewer', provider: 'claude', cwd: '/synthetic' }, [], 'Human', true);
  assert.match(claude, /read and search tools only; no file edits, no shell/);
  assert.doesNotMatch(claude, /sandbox allows read-only inspection commands/);
  const codex = participantPrompt({ id: 'claude', label: 'Builder', provider: 'codex', cwd: '/synthetic' }, [], 'Human', true);
  assert.match(codex, /sandbox allows read-only inspection commands/);
  assert.doesNotMatch(codex, /no shell/);
  assert.throws(() => participantPrompt({ id: 'other', provider: 'other' }, [], 'Human', true), /provider/);
});

test('untyped participants suggest a handoff for the human without claiming prose dispatch or typed tools', () => {
  const text = participantPrompt({ id: 'app', label: 'App', provider: 'codex', cwd: '/synthetic' }, [
    { id: 'db', label: 'Database', provider: 'codex' }
  ], 'Human', false);
  assert.match(text, /Human decides whether to send/);
  assert.match(text, /suggestion/);
  assert.doesNotMatch(text, /call the request_assistance|call finish_task|Only a line.*hands off/);
  assert.match(text, /history.*reference only/i);
  assert.match(text, /no file edits and no network/);
});

test('the legacy roomPrompt export retains its existing caller contract', () => {
  assert.match(roomPrompt('codex', 'claude', 'Human', true), /You are Codex in Wagon Wheel/);
  assert.match(roomPrompt('claude', 'codex', 'Human'), /Only a line that begins with @codex hands off/);
});
