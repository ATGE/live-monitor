// El PR de un proyecto cualquiera: el aviso de «sin verificación», la firma, el
// idioma, la línea `Closes #N` desde el primer borrador, y «Listo para
// revisión» sin escribir nada antes de saber a quién se le pide.
//
// GitHub y git entran por los pasos inyectables (`PR_STEPS`, `READY_STEPS`);
// la sesión que redacta el cuerpo, por la costura `claudeHooks.query`.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects, projectOf } = await import('../src/projects.js');
const { claudeHooks } = await import('../src/claude.js');
const { keyOf } = await import('../src/keys.js');
const { ensureClosesLine } = await import('../src/prbody.js');
const pipeline = await import('../src/pipeline.js');
const { draftPrPhase, markReady, composePrBody, noVerificationLine, hasNoVerification } = pipeline;

const SUITE = { relativeCwd: '.', installCommand: 'npm install', testCommand: 'npm test', env: { CI: '1' } };
const base = (id, extra = {}) => ({
  id, name: id, repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot,
  repo: `eterceros/${id}`, assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null }, ...extra,
});
const entries = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  base('bare-en'),
  base('bare-es', { language: 'es' }),
  base('suite', { overrides: { e2e: SUITE, stack: null }, reviewer: 'alice' }),
  base('noreviewer', { lastReviewer: 'bob' }),
  base('sig-empty', { overrides: { e2e: SUITE, stack: null, identity: { prSignature: '' } } }),
  base('sig-own', { overrides: { e2e: SUITE, stack: null, identity: { prSignature: '_OWN-SIGNATURE_' } } }),
];
const savedSignature = config.identity?.prSignature;
before(() => {
  saveProjects(entries());
  config.identity = { ...(config.identity ?? {}), prSignature: '_SIGNATURE-LINE_' };
});
after(() => {
  saveProjects(entries());
  config.identity = { ...(config.identity ?? {}), prSignature: savedSignature };
});

let n = 8100;
function taskOf(project, fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  return Object.assign(task, fields);
}
const issueOf = (task) => ({ number: task.issue, title: `Issue ${task.issue}`, body: 'Something is broken.' });

/** Lo que `draftPrPhase` toca fuera de sí, contado. */
function prSteps() {
  const created = [];
  return {
    created,
    pushBranch: async () => {},
    findPrForBranch: async () => null,
    prView: async () => null,
    commitSubject: async () => 'fix: the thing',
    createDraftPr: async (args) => { created.push(args); return { number: 77, url: 'https://github.com/x/pull/77' }; },
  };
}

// ---------------------------------------------------------------------------
// Sin verificación

test('sin comando de pruebas: el cuerpo de siempre lo dice en inglés y no lleva la firma de e2e', async () => {
  const task = taskOf('bare-en');
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const [call] = steps.created;
  assert.match(call.body, new RegExp(`Closes #${task.issue}`));
  assert.ok(call.body.includes('No automated verification is configured for this project.'), call.body);
  assert.ok(!call.body.includes('_SIGNATURE-LINE_'), 'la firma afirma una validación e2e: sin e2e no se pone');
  assert.ok(!('language' in call), 'github.js reads the language itself: no dead key');
});

test('el idioma del proyecto manda: `es` publica la línea en español y github.js lo lee solo', async () => {
  const task = taskOf('bare-es');
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const [call] = steps.created;
  assert.ok(call.body.includes('Sin verificación automática configurada para este proyecto.'), call.body);
  assert.ok(!('language' in call), 'github.js reads the language itself: no dead key');
});

test('con suite de pruebas: sin aviso y con la firma', async () => {
  const task = taskOf('suite');
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const [call] = steps.created;
  assert.ok(!/verification/i.test(call.body) && !/verificación/.test(call.body), call.body);
  assert.ok(call.body.includes('_SIGNATURE-LINE_'));
});

test('la firma es del proyecto: sin override de `identity`, la global sale intacta', async () => {
  const task = taskOf('suite', { prBody: 'Body.\n' });
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const body = steps.created[0].body;
  assert.equal(body, `${ensureClosesLine('Body.\n', task.issue)}\n\n_SIGNATURE-LINE_`);
});

test('la firma es del proyecto: `identity.prSignature = ""` la quita, sin línea en blanco de sobra', async () => {
  const task = taskOf('sig-empty', { prBody: 'Body.\n' });
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const body = steps.created[0].body;
  assert.ok(!body.includes('_SIGNATURE-LINE_'), JSON.stringify(body));
  assert.equal(body, ensureClosesLine('Body.\n', task.issue));
  assert.ok(!/\n\n$/.test(body), JSON.stringify(body));
});

test('la firma es del proyecto: una firma propia sustituye a la global', async () => {
  const task = taskOf('sig-own', { prBody: 'Body.\n' });
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  const body = steps.created[0].body;
  assert.equal(body, `${ensureClosesLine('Body.\n', task.issue)}\n\n_OWN-SIGNATURE_`);
});

test('un cuerpo ya redactado al que le falta `Closes #N` lo recibe en el borrador', async () => {
  const task = taskOf('suite', { prBody: '## At a glance: before vs. after\n\nBefore: broken. After: fixed.\n' });
  const steps = prSteps();
  await draftPrPhase(task, issueOf(task), steps);
  assert.match(steps.created[0].body, new RegExp(`Closes #${task.issue}\\b`));
});

test('hasNoVerification y la frase, por idioma', () => {
  assert.equal(hasNoVerification(taskOf('bare-en')), true);
  assert.equal(hasNoVerification(taskOf('suite')), false);
  assert.match(noVerificationLine('en'), /^No automated verification/);
  assert.match(noVerificationLine('es-BO'), /^Sin verificación/);
  assert.match(noVerificationLine('fr'), /^No automated verification/, 'solo hay frase en inglés y en español');
});

test('la fase de pruebas se salta sin test command, lo dice y marca verification = none', async () => {
  const noE2e = taskOf('bare-en');
  await pipeline.PIPELINE_STEPS.testPhase(noE2e);
  assert.equal(noE2e.verification, 'none');
  assert.ok(noE2e.log.some((l) => l.phase === 'e2e' && /no verification configured: there is no test command/.test(l.line)));

  // `e2e` presente pero sin `testCommand` (un perfil con solo installCommand): también se salta.
  saveProjects([...entries().filter((p) => p.id !== 'bare-en'), base('bare-en', { overrides: { e2e: { installCommand: 'npm install' }, stack: null } })]);
  try {
    const noCommand = taskOf('bare-en');
    await pipeline.PIPELINE_STEPS.testPhase(noCommand);
    assert.equal(noCommand.verification, 'none');
    assert.ok(noCommand.log.some((l) => /no verification configured: there is no test command/.test(l.line)));
    assert.equal(hasNoVerification(noCommand), true);
  } finally {
    saveProjects(entries());
  }
});

// ---------------------------------------------------------------------------
// composePrBody: la sesión de verdad, contra el SDK de mentira

const GOOD_BODY = '## At a glance: before vs. after\n\nBefore: it crashed. After: it works.\n';
const uuidOf = (s) => s.sent[0]?.uuid;
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** Un `query` falso: drena el prompt y contesta cada turno con la siguiente respuesta. */
function fakeSdk(answers) {
  const state = { prompts: [], inputClosed: false };
  const queue = [...answers];
  const original = claudeHooks.query;
  claudeHooks.query = ({ prompt }) => {
    const sent = [];
    (async () => { for await (const m of prompt) sent.push(m); state.inputClosed = true; })();
    return (async function* stream() {
      await tick();
      state.prompts.push(sent[0]?.message?.content);
      const text = queue.shift() ?? '';
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' };
      yield {
        type: 'assistant', user_message_uuid: uuidOf({ sent }), session_id: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      };
      yield {
        type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0,
        session_id: 's1', user_message_uuid: uuidOf({ sent }), user_message_uuids: [uuidOf({ sent })],
      };
      for (let i = 0; i < 500 && !state.inputClosed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return { state, restore: () => { claudeHooks.query = original; } };
}

test('composePrBody: añade `Closes #N` si la sesión lo olvidó y el aviso de «sin verificación»', async () => {
  const task = taskOf('bare-en');
  const sdk = fakeSdk([GOOD_BODY]);
  try {
    const body = await composePrBody(task, issueOf(task));
    assert.match(body, new RegExp(`Closes #${task.issue}\\b`), body);
    assert.ok(body.includes('No automated verification is configured for this project.'));
    assert.equal(task.prBody, body);
    assert.equal(sdk.state.prompts.length, 1, 'ningún reintento por la falta de la línea');
  } finally { sdk.restore(); }
});

test('composePrBody: un cuerpo en español en un proyecto en inglés se pide otra vez', async () => {
  const task = taskOf('suite');
  const spanish = `## At a glance: before vs. after\n\nAntes el servicio fallaba siempre. Ahora funciona y además respeta las opciones.\n\nCloses #${task.issue}\n`;
  const fixed = `${GOOD_BODY}\nCloses #${task.issue}\n`;
  const sdk = fakeSdk([spanish, fixed]);
  try {
    const body = await composePrBody(task, issueOf(task));
    assert.equal(sdk.state.prompts.length, 2);
    assert.ok(body.includes('it works'));
    assert.ok(task.log.some((l) => /the PR body is not usable .*español/.test(l.line)), JSON.stringify(task.log.map((l) => l.line)));
  } finally { sdk.restore(); }
});

test('composePrBody: un proyecto en español no se rechaza por el idioma', async () => {
  const task = taskOf('bare-es');
  const spanish = `## At a glance: before vs. after\n\nAntes el servicio fallaba siempre. Ahora funciona y además respeta las opciones.\n`;
  const sdk = fakeSdk([spanish]);
  try {
    const body = await composePrBody(task, issueOf(task));
    assert.equal(sdk.state.prompts.length, 1);
    assert.match(body, /Sin verificación automática/);
    assert.match(body, new RegExp(`Closes #${task.issue}\\b`));
  } finally { sdk.restore(); }
});

// ---------------------------------------------------------------------------
// «Listo para revisión»: a quién, antes de escribir nada

function ready({ author = 'carol', state = 'DRAFT', reviewerFails = false } = {}) {
  const calls = [];
  return {
    calls,
    prView: async (number) => { calls.push(['prView']); return { number, state, isDraft: state === 'DRAFT', author }; },
    mergeBeforeReview: async () => { calls.push(['mergeBeforeReview']); },
    pushBeforeReview: async () => { calls.push(['pushBeforeReview']); },
    readyPr: async () => { calls.push(['readyPr']); },
    reclassify: async () => {},
    addReviewer: async (number, project, login) => {
      calls.push(['addReviewer', login]);
      if (reviewerFails) throw new Error('gh pr edit failed: not a collaborator');
    },
  };
}
const drafted = (project) => taskOf(project, { state: 'pr_draft', prNumber: 5, prs: [{ number: 5, state: 'DRAFT' }] });

test('sin revisor en el registro ni elegido: responde needsReviewer y no escribe nada', async () => {
  const task = drafted('noreviewer');
  const steps = ready();
  const logBefore = task.log.length;
  const r = await markReady(keyOf(task), {}, steps);
  assert.deepEqual(r, { needsReviewer: true, suggested: 'bob', excludeLogin: 'carol' });
  assert.deepEqual(steps.calls, [['prView']], 'solo lectura: ni merge, ni push, ni gh pr ready');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.log.length, logBefore, 'tampoco se escribe en el log');
});

test('con el revisor del registro no pregunta, y el orden de escritura es el de siempre', async () => {
  const task = drafted('suite');
  const steps = ready();
  assert.equal(await markReady(keyOf(task), {}, steps), undefined);
  assert.deepEqual(steps.calls.map((c) => c[0]), ['prView', 'mergeBeforeReview', 'pushBeforeReview', 'readyPr', 'addReviewer']);
  assert.equal(task.state, 'ready');
  assert.ok(task.log.some((l) => /reviewer: alice/.test(l.line)));
});

test('un revisor elegido se pide, se recuerda como lastReviewer y NO pasa a ser el del proyecto', async () => {
  const task = drafted('noreviewer');
  const steps = ready();
  await markReady(keyOf(task), { reviewer: 'dave' }, steps);
  assert.deepEqual(steps.calls.find((c) => c[0] === 'addReviewer'), ['addReviewer', 'dave']);
  assert.equal(task.state, 'ready');
  assert.equal(projectOf('noreviewer').lastReviewer, 'dave');
  assert.equal(projectOf('noreviewer').reviewer ?? null, null);
});

test('con «siempre», el revisor elegido se queda como el del proyecto', async () => {
  const task = drafted('noreviewer');
  await markReady(keyOf(task), { reviewer: 'erin', always: true }, ready());
  assert.equal(projectOf('noreviewer').reviewer, 'erin');
  assert.equal(projectOf('noreviewer').lastReviewer, 'erin');
  saveProjects(entries());
});

test('noReviewer: el PR queda listo, nadie recibe la petición y el log lo cuenta como éxito', async () => {
  const task = drafted('noreviewer');
  const steps = ready();
  assert.equal(await markReady(keyOf(task), { noReviewer: true }, steps), undefined);
  assert.deepEqual(steps.calls.map((c) => c[0]), ['prView', 'mergeBeforeReview', 'pushBeforeReview', 'readyPr']);
  assert.equal(task.state, 'ready');
  assert.ok(task.log.some((l) => /ready for review; no reviewer/.test(l.line)));
  assert.ok(!task.log.some((l) => /⚠️/.test(l.line)));
});

test('si GitHub rechaza al revisor elegido: PR listo, ⚠️ con su nombre y no se recuerda', async () => {
  const task = drafted('noreviewer');
  saveProjects(entries());
  await markReady(keyOf(task), { reviewer: 'mallory' }, ready({ reviewerFails: true }));
  assert.equal(task.state, 'ready');
  assert.ok(task.log.some((l) => /⚠️.*mallory.*not a collaborator/.test(l.line)), JSON.stringify(task.log.map((l) => l.line)));
  assert.equal(projectOf('noreviewer').lastReviewer, 'bob', 'un login que GitHub no acepta no se vuelve la sugerencia');
});

test('un revisor con login inválido se rechaza antes de escribir nada (ni merge, ni push, ni ready, ni addReviewer)', async () => {
  for (const bad of ['-bad', 'a b', 'x'.repeat(40), 'ev;il']) {
    const task = drafted('noreviewer');
    const steps = ready();
    await assert.rejects(() => markReady(keyOf(task), { reviewer: bad }, steps), /Invalid GitHub login/);
    assert.deepEqual(steps.calls.map((c) => c[0]), ['prView'], `solo lectura con ${bad}`);
    assert.equal(task.state, 'pr_draft');
  }
});

test('«sin revisor» configurado para el proyecto: no pregunta, lista el PR y lo cuenta', async () => {
  saveProjects([...entries().filter((e) => e.id !== 'noreviewer'), base('noreviewer', { lastReviewer: 'bob', noReviewer: true })]);
  try {
    const task = drafted('noreviewer');
    const steps = ready();
    assert.equal(await markReady(keyOf(task), {}, steps), undefined);
    assert.deepEqual(steps.calls.map((c) => c[0]), ['prView', 'mergeBeforeReview', 'pushBeforeReview', 'readyPr']);
    assert.equal(task.state, 'ready');
    assert.ok(task.log.some((l) => /ready for review; no reviewer \(configured for this project\)/.test(l.line)));
  } finally { saveProjects(entries()); }
});

test('el revisor del registro gana sobre noReviewer', async () => {
  saveProjects([...entries().filter((e) => e.id !== 'noreviewer'), base('noreviewer', { reviewer: 'alice', noReviewer: true })]);
  try {
    const task = drafted('noreviewer');
    const steps = ready();
    await markReady(keyOf(task), {}, steps);
    assert.ok(steps.calls.some((c) => c[0] === 'addReviewer'));
  } finally { saveProjects(entries()); }
});

test('noReviewer + always: se guarda para el proyecto solo cuando el PR ya quedó listo', async () => {
  saveProjects(entries());
  const failing = drafted('noreviewer');
  const boom = ready();
  boom.readyPr = async () => { throw new Error('gh pr ready failed'); };
  await assert.rejects(() => markReady(keyOf(failing), { noReviewer: true, always: true }, boom), /gh pr ready failed/);
  assert.notEqual(projectOf('noreviewer').noReviewer, true, 'nothing was remembered before the PR step accepted');

  const task = drafted('noreviewer');
  await markReady(keyOf(task), { noReviewer: true, always: true }, ready());
  assert.equal(projectOf('noreviewer').noReviewer, true);
  assert.equal(projectOf('noreviewer').reviewer ?? null, null);

  const plain = drafted('noreviewer');
  saveProjects(entries());
  await markReady(keyOf(plain), { noReviewer: true }, ready());
  assert.notEqual(projectOf('noreviewer').noReviewer, true, 'without «always» nothing is remembered');
  saveProjects(entries());
});

test('un revisor con «siempre» borra noReviewer del proyecto', async () => {
  saveProjects([...entries().filter((e) => e.id !== 'noreviewer'), base('noreviewer', { lastReviewer: 'bob', noReviewer: true })]);
  try {
    const task = drafted('noreviewer');
    await markReady(keyOf(task), { reviewer: 'erin', always: true }, ready());
    assert.equal(projectOf('noreviewer').reviewer, 'erin');
    assert.equal(Object.hasOwn(projectOf('noreviewer'), 'noReviewer'), false);
  } finally { saveProjects(entries()); }
});
