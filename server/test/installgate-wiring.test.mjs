// The install gate reaching the sessions.
//
// `installgate.test.mjs` proves the module reads a command line correctly. This
// proves the other half: that the Bash `PreToolUse` hook of the triage and the
// advisor actually asks it, that the fix is left alone, and that the wiring did
// not add a matcher (other suites pin the list to `['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task']`).
import './isolate.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
});

let n = 9700;
const freshTask = () => {
  n += 1;
  return store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
};

const hookOf = (task, phase) => {
  const set = pipeline.ghGateHooks(task, phase);
  const matcher = set.PreToolUse[0];
  assert.equal(matcher.matcher, 'Bash');
  const fn = matcher.hooks[0];
  return (command, extra = {}) => fn({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
};
const decisionOf = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';

const INSTALLS = ['npm ci', 'cd web && npm install', 'npm --prefix web ci', '(npm ci)', 'CI=1 npm ci', 'bash -c "npm ci"'];

for (const phase of ['triage', 'advisor']) {
  test(`installs are denied in the ${phase} stage and the denial is logged`, async () => {
    for (const command of INSTALLS) {
      const task = freshTask();
      const out = await hookOf(task, phase)(command);
      assert.equal(decisionOf(out), 'deny', command);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.ok(task.log.some((l) => l.phase === phase && l.line.startsWith('⛔')), `no denial line for: ${command}`);
    }
  });

  test(`read-only commands stay allowed in the ${phase} stage`, async () => {
    const hook = hookOf(freshTask(), phase);
    for (const command of ['git status', 'cargo build', 'cargo check', 'cargo fetch', 'npm run build', 'grep "npm install" README.md']) {
      assert.equal(decisionOf(await hook(command)), 'allow', command);
    }
  });
}

test('the same installs are allowed in the fix stage', async () => {
  const hook = hookOf(freshTask(), 'fix');
  for (const command of INSTALLS) assert.equal(decisionOf(await hook(command)), 'allow', command);
});

test('the wiring adds no matcher', () => {
  for (const phase of ['triage', 'advisor']) {
    const matchers = pipeline.ghGateHooks(freshTask(), phase).PreToolUse.map((m) => m.matcher);
    assert.deepEqual(matchers, ['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task']);
  }
});
