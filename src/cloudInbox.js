'use strict';
// Pure durable-sync reducer. Host persists the returned state before publishing/acknowledging events.
// This module never starts a model, submits remote work, applies code, or grants permissions.
const copy = (value) => JSON.parse(JSON.stringify(value));
const key = (binding) => JSON.stringify([binding.provider, binding.remoteId, binding.generation]);

function createCloudInbox(binding) {
  if (!binding || typeof binding.provider !== 'string' || typeof binding.remoteId !== 'string'
      || !binding.provider || !binding.remoteId || !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new Error('Invalid cloud binding');
  return { version: 1, binding: copy(binding), cursor: null, coverage: 'unknown',
    state: 'active', events: [], lastSuccessfulSync: null };
}

function receiveCloudEvents(state, binding, result, now = Date.now()) {
  if (key(state.binding) !== key(binding)) return { state, stale: true };
  if (!result || !Array.isArray(result.events) || result.events.length > 1000
      || (result.cursor != null && typeof result.cursor !== 'string')
      || !['full', 'partial', 'status-only', 'status-and-diff', 'unavailable'].includes(result.coverage)) throw new Error('Invalid cloud sync result');
  const next = copy(state), seen = new Set(next.events.map((entry) => entry.id));
  for (const event of result.events) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 512
        || event.remoteId !== binding.remoteId || !['message', 'status', 'artifact'].includes(event.kind)) throw new Error('Invalid or cross-session cloud event');
    if (!seen.has(event.id)) {
      if (next.events.length >= 1000) throw new Error('Cloud inbox retention limit reached; archive acknowledged history before continuing.');
      next.events.push({ id: event.id, source: copy(binding), receivedAt: now, acknowledged: false,
        actionable: false, event: copy(event) });
      seen.add(event.id);
    }
  }
  // Cursor advances only in the same durable transaction as the retained incoming events.
  next.cursor = result.cursor == null ? null : result.cursor;
  next.coverage = result.coverage; next.lastSuccessfulSync = now;
  return { state: next, stale: false };
}

function acknowledgeCloudEvent(state, binding, eventId) {
  if (key(state.binding) !== key(binding)) throw new Error('Stale cloud acknowledgment');
  const next = copy(state), event = next.events.find((entry) => entry.id === eventId);
  if (!event) throw new Error('Unknown cloud event');
  event.acknowledged = true;
  return next;
}

function setCloudInboxState(state, status) {
  if (!['active', 'paused', 'stopped'].includes(status)) throw new Error('Invalid cloud inbox state');
  if (state.state === 'stopped' && status !== 'stopped') throw new Error('Stopped bindings need a new user-authorized generation');
  return { ...state, state: status };
}

function pendingCloudEvents(state) {
  // While paused/stopped the UI may retain synchronized evidence, but there is no dispatch candidate.
  return state.state === 'active' ? copy(state.events.filter((event) => !event.acknowledged)) : [];
}

module.exports = { createCloudInbox, receiveCloudEvents, acknowledgeCloudEvent, setCloudInboxState, pendingCloudEvents };
