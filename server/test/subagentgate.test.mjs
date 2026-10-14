import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subagentGate, subagentGateHooks, SUBAGENT_MATCHER, FOREGROUND_REASON, wantsBackground,
} from '../src/subagentgate.js';

const call = (tool_name, tool_input, options) => subagentGate(options)({ tool_name, tool_input, tool_use_id: 't1' });

test('the hooks object has one PreToolUse entry covering Agent and Task', () => {
  const hooks = subagentGateHooks();
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, SUBAGENT_MATCHER);
  assert.deepEqual(SUBAGENT_MATCHER.split('|'), ['Agent', 'Task']);
  assert.equal(typeof hooks.PreToolUse[0].hooks[0], 'function');
});

for (const name of ['Agent', 'Task']) {
  test(`${name}: an unset or true run_in_background is rewritten to false, rest of the input kept`, async () => {
    const input = { description: 'probe', prompt: 'look', subagent_type: 'Explore', model: 'haiku' };
    for (const extra of [{}, { run_in_background: true }]) {
      const out = await call(name, { ...input, ...extra });
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
      assert.deepEqual(out.hookSpecificOutput.updatedInput, { ...input, run_in_background: false });
    }
  });
}

test('an input already in the foreground passes through', async () => {
  assert.deepEqual(await call('Agent', { prompt: 'x', run_in_background: false }), {});
});

test('the rewrite does not mutate the original input', async () => {
  const input = { prompt: 'x' };
  await call('Agent', input);
  assert.deepEqual(input, { prompt: 'x' });
});

test('other tools are never touched, Bash included', async () => {
  assert.deepEqual(await call('Bash', { command: 'ls', run_in_background: true }), {});
  assert.deepEqual(await call('Read', { file_path: 'a' }), {});
  assert.deepEqual(await call(undefined, {}), {});
});

test('a malformed input passes through instead of throwing', async () => {
  for (const bad of [undefined, null, 'x', ['a'], 3]) assert.deepEqual(await call('Agent', bad), {});
  assert.deepEqual(await subagentGate()(undefined), {});
});

test('mode deny refuses a background launch with the reason, and lets a foreground one pass', async () => {
  const out = await call('Task', { prompt: 'x' }, { mode: 'deny' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, FOREGROUND_REASON);
  assert.match(FOREGROUND_REASON, /run_in_background: false/);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  assert.deepEqual(await call('Task', { prompt: 'x', run_in_background: false }, { mode: 'deny' }), {});
});

test('wantsBackground treats anything but an explicit false as background', () => {
  assert.equal(wantsBackground({}), true);
  assert.equal(wantsBackground({ run_in_background: true }), true);
  assert.equal(wantsBackground({ run_in_background: false }), false);
  assert.equal(wantsBackground(undefined), true);
});

test('a throwing tool_input lets the call through instead of breaking the hook', async () => {
  const input = { tool_name: 'Agent', get tool_input() { throw new Error('boom'); } };
  assert.deepEqual(await subagentGate()(input), {});
  assert.deepEqual(await subagentGate({ mode: 'deny' })(input), {});
});

// Regression guard, not a fix proof: the previous gate returned the same `updatedInput`.
test('regression guard: the gate keys on the tool name alone, so a Task call with no other field is rewritten', async () => {
  const out = await subagentGate()({ tool_name: 'Task', tool_input: {} });
  assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
});
