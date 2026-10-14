// The two facts the plan-mode design rests on, checked against the real CLI
// with the local login. Costs two short sessions, so only when asked for:
//
//   HFSMON_LIVE=1 node --test server/test/interactive.test.mjs
//
// (a) `AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`,
//     whatever the SDK's warning says, and the answer goes back as
//     `updatedInput`. (b) In `plan` mode, `ExitPlanMode` reaches `canUseTool`,
//     `settings.plansDirectory` puts the plan file where the board expects it,
//     and after `setPermissionMode('bypassPermissions')` + allow the model goes
//     on to write. Measured green on 2026-09-13 with CLI 2.1.270.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tempDir } from './teardown.mjs';

const live = process.env.HFSMON_LIVE === '1';
const skip = live ? false : 'HFSMON_LIVE=1 para lanzarlo';

async function drive({ prompt, options, onTool }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const seen = [];
  let handle;
  const q = query({
    prompt,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user'], env, maxTurns: 12,
      allowDangerouslySkipPermissions: true,
      ...options,
      canUseTool: async (name, input, ctx) => { seen.push(name); return onTool(name, input, ctx, handle); },
    },
  });
  handle = q;
  let result = null;
  for await (const m of q) if (m.type === 'result') result = m;
  return { seen, result };
}

test('en vivo: AskUserQuestion llega a canUseTool bajo bypassPermissions y la respuesta vuelve', { skip }, async () => {
  const { seen, result } = await drive({
    prompt: 'Use the AskUserQuestion tool once to ask me which greeting I prefer, with two options: "Hola" and "Bonjour". After I answer, reply with exactly the single word I chose.',
    options: { cwd: tmpdir(), permissionMode: 'bypassPermissions' },
    onTool: (name, input) => (name === 'AskUserQuestion'
      ? { behavior: 'allow', updatedInput: { questions: input.questions, answers: { [input.questions[0].question]: 'Bonjour' } } }
      : { behavior: 'allow' }),
  });
  assert.ok(seen.includes('AskUserQuestion'), `herramientas vistas: ${seen.join(', ')}`);
  assert.equal(result?.subtype, 'success');
  assert.match(result.result, /Bonjour/);
});

test('en vivo: ExitPlanMode llega en modo plan, el plan cae en plansDirectory, y tras aprobar el modelo ejecuta', { skip }, async () => {
  const dir = tempDir('hfsmon-plan-');
  const plansRel = 'tmp/hfsmon-plans/t1';
  let files = [];
  const { seen, result } = await drive({
    prompt: 'Write a very short plan (three lines) to create a file named hello.txt containing "hi". End the plan file with a line `WORK_PLAN: {"tasks":[{"id":"t1","what":"create hello.txt","files":["hello.txt"],"dependsOn":[]}]}`. Then call ExitPlanMode. After the plan is approved, create hello.txt and reply "done".',
    options: { cwd: dir, permissionMode: 'plan', settings: { plansDirectory: plansRel } },
    onTool: async (name, input, ctx, q) => {
      if (name !== 'ExitPlanMode') return { behavior: 'allow' };
      const planDir = path.join(dir, plansRel);
      files = existsSync(planDir) ? readdirSync(planDir) : [];
      await q.setPermissionMode('bypassPermissions');
      return { behavior: 'allow' };
    },
  });
  assert.ok(seen.includes('ExitPlanMode'), `herramientas vistas: ${seen.join(', ')}`);
  assert.equal(files.filter((f) => f.endsWith('.md')).length, 1, `archivos del plan: ${files.join(', ')}`);
  assert.match(readFileSync(path.join(dir, plansRel, files[0]), 'utf8'), /WORK_PLAN:/);
  assert.equal(result?.subtype, 'success');
  assert.ok(existsSync(path.join(dir, 'hello.txt')), 'tras aprobar, el modelo escribió el archivo');
});
