// La rama base y el contexto de un proyecto que no es hfs: lo que el pipeline le
// pide a git, lo que dicen las plantillas y lo que triage ve según haya o no QA.
//
// `localMachine().exec` es la costura de git (se sustituye y se restaura); el
// SDK de mentira es `claudeHooks.query`.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects } = await import('../src/projects.js');
const { localMachine } = await import('../src/machine.js');
const { claudeHooks } = await import('../src/claude.js');
const { renderPrompt, NO_QA_NOTE } = await import('../src/prompts.js');
const { keyOf } = await import('../src/keys.js');
const pipeline = await import('../src/pipeline.js');

const entry = (id, extra = {}) => ({
  id, name: id, repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot,
  repo: `eterceros/${id}`, assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null }, ...extra,
});
const entries = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  entry('trunk-dev', { baseBranch: 'develop' }),
  entry('trunk-main'),
];
before(() => saveProjects(entries()));
after(() => saveProjects(entries()));

let n = 8400;
function taskOf(project, fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  return Object.assign(task, fields);
}

/** Sustituye `exec` de la máquina local mientras corre `fn`; devuelve los argumentos de git que vio. */
async function withGitSpy(fn) {
  const machine = localMachine();
  const seen = [];
  const original = machine.exec;
  machine.exec = async (file, args) => { seen.push([file, ...args]); return { ok: true, code: 0, stdout: '', stderr: '' }; };
  try { await fn(); } finally { machine.exec = original; }
  return seen.map((a) => a.join(' '));
}

// ---------------------------------------------------------------------------
// La rama base

test('continuationContext compara contra la rama base del proyecto, no contra main', async () => {
  const dev = taskOf('trunk-dev');
  const seen = await withGitSpy(() => pipeline.continuationContext(dev));
  assert.ok(seen.some((c) => c.includes('origin/develop..HEAD')), seen.join('\n'));
  assert.ok(seen.some((c) => c.includes('origin/develop...HEAD')), seen.join('\n'));
  assert.ok(!seen.some((c) => c.includes('origin/main')), seen.join('\n'));

  const main = taskOf('trunk-main');
  const seenMain = await withGitSpy(() => pipeline.continuationContext(main));
  assert.ok(seenMain.some((c) => c.includes('origin/main..HEAD')), 'sin `baseBranch` en el registro sigue siendo main');
});

test('hasCommits y pendingWork reciben la base: la rama develop es la que se mide', async () => {
  const { hasCommits, pendingWork } = await import('../src/worktree.js');
  const seen = await withGitSpy(async () => {
    await hasCommits(localMachine(), '/wt/x', { base: 'develop' });
    await pendingWork(localMachine(), '/wt/x', 'fix/x', { base: 'develop' });
  });
  assert.ok(seen.every((c) => !c.includes('origin/main')), seen.join('\n'));
  assert.ok(seen.some((c) => c.includes('origin/develop')));
});

// ---------------------------------------------------------------------------
// Plantillas

test('qa-plan y demo nombran la base del proyecto (baseBranch declarado en ALLOWED)', () => {
  const qa = renderPrompt('qa-plan', {
    projectId: 'trunk-dev', issueNumber: 1, issueTitle: 't', branch: 'b', issueBody: 'x', initialPlan: 'p',
    diffStat: 'd', e2eTail: 'e', stackSection: 's', processRule: 'r', baseBranch: 'develop',
  });
  assert.match(qa, /git diff origin\/develop\.\.\.HEAD/);
  assert.doesNotMatch(qa, /origin\/main/);

  const demo = renderPrompt('demo', {
    projectId: 'trunk-dev', issueNumber: 1, issueTitle: 't', branch: 'b', diffSection: 'd', serversSection: 's', baseBranch: 'develop',
  });
  assert.match(demo, /git diff origin\/develop\.\.\.HEAD/);
  assert.doesNotMatch(demo, /<rama base>/);
});

test('un proyecto sin registrar LANZA al renderizar {{projectContext}}: nunca se le presta el contexto de hfs', () => {
  assert.throws(
    () => renderPrompt('triage', {
      projectId: 'no-existe', issueNumber: 1, issueTitle: 't', issueLabels: '', issueBody: 'x',
    }),
    /Proyecto desconocido/,
  );
  // Una plantilla que no lleva {{projectContext}} no resuelve ningún proyecto.
  assert.doesNotThrow(() => renderPrompt('handoff', { projectId: 'no-existe' }));
});

test('el comentario de promptVarsFor describe el resolutor tardío y el lanzamiento', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /setProjectResolver/);
  assert.match(src, /An unregistered project throws in `renderPrompt`/);
  assert.doesNotMatch(src, /Falling back to hfs's descriptor is the lesser wrong/);
});

// ---------------------------------------------------------------------------
// Triage y QA

/** Un `query` falso que registra el primer prompt y termina la sesión con error. */
function failingSdk() {
  const prompts = [];
  const original = claudeHooks.query;
  claudeHooks.query = ({ prompt }) => {
    let closed = false;
    (async () => {
      for await (const m of prompt) prompts.push(m.message?.content);
      closed = true;
    })();
    return (async function* stream() {
      await new Promise((r) => { setImmediate(r); });
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 's1', num_turns: 0, total_cost_usd: 0 };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return { prompts, restore: () => { claudeHooks.query = original; } };
}

const issue = (task) => ({ number: task.issue, title: 'Titulo', labels: [], body: 'cuerpo' });

test('triage de un proyecto sin stack ni qa: el prompt dice que no hay Browser QA', async () => {
  const task = taskOf('trunk-main');
  const sdk = failingSdk();
  try {
    await assert.rejects(() => pipeline.PIPELINE_STEPS.triagePhase(task, issue(task)), /Triage failed/);
  } finally { sdk.restore(); }
  assert.ok(sdk.prompts[0]?.includes(NO_QA_NOTE.trim().slice(0, 40)), String(sdk.prompts[0]).slice(0, 300));
});

test('triage de un proyecto con stack y qa: la nota no aparece', async () => {
  saveProjects([
    ...entries().filter((p) => p.id !== 'trunk-main'),
    entry('trunk-main', { overrides: { e2e: null, stack: { start: 'npm start' }, qa: { model: 'haiku' } } }),
  ]);
  try {
    const task = taskOf('trunk-main');
    const sdk = failingSdk();
    try {
      await assert.rejects(() => pipeline.PIPELINE_STEPS.triagePhase(task, issue(task)), /Triage failed/);
    } finally { sdk.restore(); }
    assert.ok(sdk.prompts[0], 'se abrió la sesión');
    assert.ok(!sdk.prompts[0].includes(NO_QA_NOTE.trim().slice(0, 40)));
  } finally {
    saveProjects(entries());
  }
});

test('keyOf sigue distinguiendo proyectos (sanidad del arnés de este archivo)', () => {
  assert.notEqual(keyOf(taskOf('trunk-dev')), keyOf(taskOf('trunk-main')));
});
