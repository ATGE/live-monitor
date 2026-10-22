import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCodexRead, verifyCodexContinuation } from '../tools/codex-smoke-verifier.mjs';

const script = 'vite build';
const sessionId = 'codex:thread-test-123';
const good = {
  ok: true, sessionId,
  resultText: 'BUILD_SCRIPT=vite build',
};
const passed = [{ kind: 'tool_end', name: 'Bash', id: 'cmd-1', ok: true, output: '"build": "vite build"' }];
const denied = [{ kind: 'tool_end', name: 'Bash', id: 'cmd-1', ok: false, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }];

test('Codex smoke requires a real successful tool result plus the exact build script', () => {
  assert.equal(verifyCodexRead({ result: good, events: passed, expectedScript: script }), true);
});

test('complete App Server turn with failed sandbox is NOT a passing file-read smoke', () => {
  const apology = {
    ...good,
    resultText: 'I could not read package.json because the sandbox failed; retry denied.',
  };
  assert.throws(() => verifyCodexRead({ result: apology, events: denied, expectedScript: script }),
    /commands failed inside the sandbox/);
});

test('model guessing the build script without command evidence fails', () => {
  assert.throws(() => verifyCodexRead({ result: good, events: [], expectedScript: script }),
    /No successful command returned/);
});

test('successful command with the wrong output fails even if the model guesses correctly', () => {
  assert.throws(() => verifyCodexRead({
    result: good,
    events: [{ kind: 'tool_end', name: 'Bash', ok: true, output: 'unrelated output' }],
    expectedScript: script,
  }), /did not prove/);
});

test('correct file evidence but wrong answer fails, as does missing session', () => {
  assert.throws(() => verifyCodexRead({
    result: { ...good, resultText: 'BUILD_SCRIPT=npm build' }, events: passed, expectedScript: script,
  }), /did not return the exact/);
  assert.throws(() => verifyCodexRead({
    result: { ...good, sessionId: null }, events: passed, expectedScript: script,
  }), /No Codex thread ID/);
});

test('follow-up must use same thread and correctly recall web directory', () => {
  const followUp = { ok: true, sessionId, resultText: 'WEB_DIR=web' };
  assert.equal(verifyCodexContinuation({ result: followUp, sessionId }), true);
  assert.throws(() => verifyCodexContinuation({ result: { ...followUp, sessionId: 'codex:another' }, sessionId }),
    /different thread ID/);
  assert.throws(() => verifyCodexContinuation({ result: { ...followUp, resultText: 'cannot determine' }, sessionId }),
    /did not correctly answer/);
});

test('failed turns cannot pass either gate', () => {
  assert.throws(() => verifyCodexRead({
    result: { ...good, ok: false, error: 'sandbox failed' }, events: passed, expectedScript: script,
  }), /Codex turn failed/);
  assert.throws(() => verifyCodexContinuation({
    result: { ok: false, sessionId, error: 'quota' }, sessionId,
  }), /follow-up turn failed/);
});
