import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatusHooks, codexCliStatus, codexLimits, providerCapabilities } from '../src/agents/status.js';

const originalRun = agentStatusHooks.run;
const originalClient = agentStatusHooks.client;
after(() => {
  agentStatusHooks.run = originalRun;
  agentStatusHooks.client = originalClient;
});

test('installed and signed-in Codex status returns no account identity', async () => {
  agentStatusHooks.run = async (_, args) => args[0] === '--version'
    ? { ok: true, stdout: 'codex-cli 0.163.0\n' }
    : { ok: true, stdout: 'Logged in using ChatGPT (private@example.com)' };
  const status = await codexCliStatus();
  assert.deepEqual(status, { installed: true, authenticated: true, version: 'codex-cli 0.163.0' });
  assert.doesNotMatch(JSON.stringify(status), /private@example.com/);
});

test('missing CLI and failed login are separate statuses', async () => {
  agentStatusHooks.run = async () => ({ ok: false, stderr: 'command not found' });
  assert.deepEqual(await codexCliStatus(), { installed: false, authenticated: false, version: null });
  agentStatusHooks.run = async (_, args) => args[0] === '--version'
    ? { ok: true, stdout: 'codex-cli 0.163.0' } : { ok: false, stderr: 'not logged in' };
  assert.equal((await codexCliStatus()).authenticated, false);
});

test('rate limit read uses App Server, always closes, never calls Anthropic quota', async () => {
  let closed = false;
  let called;
  agentStatusHooks.client = () => ({
    open: async () => {},
    request: async (method, params) => {
      called = [method, params];
      return { rateLimits: { primary: { usedPercent: 22 } } };
    },
    close: () => { closed = true; },
  });
  const r = await codexLimits();
  assert.equal(r.ok, true);
  assert.deepEqual(called, ['account/rateLimits/read', {}]);
  assert.equal(r.limits.rateLimits.primary.usedPercent, 22);
  assert.equal(closed, true);
});

test('rate limit RPC failure is reported separately and connection still closes', async () => {
  let closed = false;
  agentStatusHooks.client = () => ({
    open: async () => {},
    request: async () => { throw new Error('not authenticated'); },
    close: () => { closed = true; },
  });
  const r = await codexLimits();
  assert.equal(r.ok, false);
  assert.match(r.error, /not authenticated/);
  assert.equal(r.limits, null);
  assert.equal(closed, true);
  assert.equal(providerCapabilities().codex.remoteRunner, false);
});
