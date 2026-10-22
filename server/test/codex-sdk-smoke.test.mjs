import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCodexSdkRead } from '../tools/codex-sdk-smoke-verifier.mjs';

const expected = { name: 'hfs-monitor', scripts: { build: 'npm run build --prefix web' } };
const result = { ok: true, sessionId: 'codex:session-12345', resultText: 'PROJECT_NAME=hfs-monitor\nBUILD_SCRIPT=npm run build --prefix web' };
const events = () => [
  { kind: 'tool', id: 'read-1', name: 'Bash', args: { command: "/bin/bash -lc 'cat package.json'" } },
  { kind: 'tool_end', id: 'read-1', name: 'Bash', ok: true, output: JSON.stringify(expected) },
];

test('SDK read smoke accepts a verified shell read and exact answer', () => {
  assert.equal(verifyCodexSdkRead({ result, events: events(), expected }), true);
});

test('SDK read smoke rejects a guessed text-only answer', () => {
  assert.throws(() => verifyCodexSdkRead({ result, events: [], expected }), /No successful/);
});

test('SDK read smoke rejects a denied shell command', () => {
  const e = events(); e[1].ok = false;
  assert.throws(() => verifyCodexSdkRead({ result, events: e, expected }), /No successful/);
});

test('SDK read smoke rejects a tool that did not read package.json', () => {
  const e = events(); e[0].args.command = 'printf foo';
  assert.throws(() => verifyCodexSdkRead({ result, events: e, expected }), /No successful/);
});

test('SDK read smoke rejects a mismatched tool output', () => {
  const e = events(); e[1].output = JSON.stringify({ ...expected, name: 'invented' });
  assert.throws(() => verifyCodexSdkRead({ result, events: e, expected }), /No successful/);
});

test('SDK read smoke rejects incorrect model text even after a good read', () => {
  assert.throws(() => verifyCodexSdkRead({ result: { ...result, resultText: 'PROJECT_NAME=guess' }, events: events(), expected }), /did not exactly match/);
});

test('SDK read smoke rejects a file editing tool even after a good read', () => {
  assert.throws(() => verifyCodexSdkRead({ result, events: [...events(), { kind: 'tool', name: 'Edit' }], expected }), /outside the permitted/);
});

test('SDK read smoke rejects unsuccessful turns and malformed session IDs', () => {
  assert.throws(() => verifyCodexSdkRead({ result: { ...result, ok: false }, events: events(), expected }), /turn failed/);
  assert.throws(() => verifyCodexSdkRead({ result: { ...result, sessionId: 'claude:abc' }, events: events(), expected }), /namespaced/);
});
