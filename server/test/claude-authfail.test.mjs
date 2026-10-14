import './isolate.mjs';   // first: isolates the data directory
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, claudeHooks } from '../src/claude.js';

const fresh = (over = {}) => {
  const events = [];
  return { events, ctx: { onEvent: (ev) => events.push(ev), toolCounts: {}, machine: 'runner-1', ...over } };
};
const assistant = (over = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] }, ...over });
const failed = (over = {}) => assistant({ error: 'authentication_failed', ...over });

afterEach(() => { claudeHooks.onAuthFailure = null; });

test('authentication_failed on an assistant frame marks the machine and emits one event', () => {
  const seen = [];
  claudeHooks.onAuthFailure = (m) => seen.push(m);
  const { ctx, events } = fresh();
  dispatch(failed(), ctx);
  dispatch(failed(), ctx);
  assert.equal(ctx.auth, true);
  assert.deepEqual(events.filter((e) => e.kind === 'auth'), [{ kind: 'auth', machine: 'runner-1' }]);
  assert.deepEqual(seen, ['runner-1', 'runner-1']);
});

test('system/api_retry with authentication_failed is detected too', () => {
  const { ctx, events } = fresh();
  dispatch({ type: 'system', subtype: 'api_retry', error: 'authentication_failed', attempt: 1, max_retries: 3, retry_delay_ms: 1, error_status: 401 }, ctx);
  assert.equal(ctx.auth, true);
  assert.equal(events.filter((e) => e.kind === 'auth').length, 1);
});

test('ordinary text and other errors are no false positive', () => {
  const seen = [];
  claudeHooks.onAuthFailure = (m) => seen.push(m);
  const { ctx, events } = fresh();
  const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  dispatch(assistant({ message: { content: [{ type: 'text', text }] } }), ctx);
  dispatch(assistant({ error: 'overloaded' }), ctx);
  dispatch(assistant({ error: 'billing_error' }), ctx);
  dispatch({ type: 'system', subtype: 'api_retry', error: 'overloaded' }, ctx);
  assert.equal(ctx.auth, undefined);
  assert.deepEqual(events.filter((e) => e.kind === 'auth'), []);
  assert.deepEqual(seen, []);
});

test('a delegated session (trackQuota: false) never blames the machine', () => {
  const seen = [];
  claudeHooks.onAuthFailure = (m) => seen.push(m);
  const { ctx, events } = fresh({ trackQuota: false });
  dispatch(failed(), ctx);
  assert.equal(ctx.auth, undefined);
  assert.deepEqual(events.filter((e) => e.kind === 'auth'), []);
  assert.deepEqual(seen, []);
});

test('a success result after an auth failure is not ok', () => {
  const { ctx, events } = fresh();
  dispatch(failed(), ctx);
  dispatch({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate', num_turns: 1 }, ctx);
  assert.equal(ctx.ok, false);
  assert.equal(events.find((e) => e.kind === 'result').ok, false);
});

test('a success result without an auth failure stays ok', () => {
  const { ctx } = fresh();
  dispatch(assistant(), ctx);
  dispatch({ type: 'result', subtype: 'success', result: 'listo', num_turns: 1 }, ctx);
  assert.equal(ctx.ok, true);
});

test('the machine defaults to local when the context carries none', () => {
  const { ctx, events } = fresh({ machine: undefined });
  dispatch(failed(), ctx);
  assert.deepEqual(events.find((e) => e.kind === 'auth'), { kind: 'auth', machine: 'local' });
});
