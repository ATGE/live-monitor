// La reanudación por fases, contra el cuerpo real de `runPipeline`.
//
// Es la única prueba que ve las guardas. Las demás sustituyen
// `pipelineHooks.run`, así que miran el cuerpo desde fuera: con ellas solas se
// podía revertir el uso de `todo` dentro de `runPipeline` —traer main siempre,
// volver al `skipDone` de antes— con la suite entera en verde y la #1125 viva.
// Aquí los pasos entran como parámetro, el cuerpo corre entero, y lo que se
// comprueba es exactamente qué llamó y qué no.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';

const dataDir = tempDir('hfsmon-resume-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let settings;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ settings } = await import('../src/settings.js'));
  settings.update({ autoStart: false, browserQa: true });
  // A project with no suite of its own: the blank-repo case (`e2e: null`).
  const { saveProjects, listProjects } = await import('../src/projects.js');
  saveProjects([
    ...listProjects(),
    { id: BLANK, name: BLANK, repoPath: 'C:/src/blank', worktreeRoot: 'C:/src/blank-wt', repo: null, assignee: 'x', reviewer: null, overrides: { e2e: null, stack: null } },
  ]);
});

const HEAD = '5835cde9aa11bb22cc33';
const BLANK = 'blank';
const issueOf = (over = {}) => ({ number: 1125, title: 'Bulk import log never refreshes', labels: [], body: '', ...over });

let n = 8000;

/** La tarea de la #1125: el QA corrió y no pasó, el PR no llegó a abrirse. */
function parked(over = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, over.project ?? 'hfs');
  return Object.assign(task, {
    state: 'error',
    prevState: 'browser_qa',
    phase: 'pr',
    error: 'No se publica el título del PR: el texto supera 256 caracteres (265)',
    branch: 'fix/1125-bulk-import-log',
    worktreePath: 'C:/src/hfs-wt/fix-1125',
    complexity: 'simple',
    fixedAt: HEAD,
    e2ePassedAt: HEAD,
    browserQa: 'on',
    qa: { ui: true, passedAt: null, ranAtHead: HEAD, results: { verdict: 'unverified', counts: { passed: 5, failed: 0, unverified: 7 } } },
    prPark: { proposal: 'fix: el título de 265 caracteres', problems: ['el texto supera 256 caracteres (265)'], at: new Date().toISOString() },
    ...over,
  });
}

/** Los pasos que `runPipeline` pide fuera, contados en orden. */
function stubs(over = {}) {
  const calls = [];
  const step = (name, fn) => async (...args) => { calls.push(name); return fn?.(...args); };
  return {
    calls,
    getIssue: async () => issueOf(),
    classifyIssue: step('classifyIssue', async () => ({ state: 'assigned', branches: [], prs: [], reasons: [] })),
    isProjectWorktree: async () => true,
    ensureWorktree: step('ensureWorktree', async () => 'C:/src/hfs-wt/fix-1125'),
    bringMain: step('bringMain', async () => ({ merged: false, behind: 0, conflicts: [], blocked: null })),
    headCommit: async () => HEAD,
    hasCommits: async () => true,
    continuationContext: async () => '',
    triagePhase: step('triagePhase'),
    // Las dependencias del proyecto, antes de la sesión que las necesita: el
    // paso existe para que el fix no tenga que instalarlas por su cuenta.
    prepareDependencies: step('prepareDependencies', async () => ({ ok: true })),
    fixPhase: step('fixPhase'),
    testPhase: step('testPhase'),
    browserQaPhase: step('browserQaPhase'),
    composePrBody: step('composePrBody'),
    draftPrPhase: step('draftPrPhase', async (task) => {
      task.prNumber = 1126;
      task.prUrl = 'https://github.com/x/pull/1126';
      task.prPark = null;
    }),
    generateDemoSteps: step('generateDemoSteps'),
    ...over,
  };
}

test('#1125 reanudada en «pr»: ni main, ni fix, ni tests, ni QA — el PR y la demo', async () => {
  // La pasada que aparcó el título ya había redactado el cuerpo: es lo que
  // hace la fase antes de `draftPrPhase`.
  const task = parked({ prBody: '## At a glance: before vs. after\n\nCloses #1125\n' });
  const steps = stubs();
  await pipeline.runPipeline(task, 'pr', steps);

  assert.deepEqual(steps.calls, ['generateDemoSteps', 'draftPrPhase'], 'lo que costó 25 minutos no se vuelve a pagar');
  assert.ok(task.log.some((l) => /PR body was already written/.test(l.line)), 'ni se paga otra vez una sesión por el cuerpo');
  assert.ok(task.log.some((l) => /main is not merged/.test(l.line)), 'y se dice por qué no se trae main');
  assert.ok(task.log.some((l) => /already ran on this commit/.test(l.line)));
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, null, 'la ejecución terminó: no hay fase desde la que reanudar');
});

test('con el PR ya abierto no se redacta cuerpo: `draftPrPhase` lo adoptaría y el texto se tiraría', async () => {
  const task = parked({ prNumber: 1126, prBody: null, prPark: null });
  const steps = stubs();
  await pipeline.runPipeline(task, 'pr', steps);

  assert.deepEqual(steps.calls, ['generateDemoSteps', 'draftPrPhase']);
  assert.equal(task.prBody, null, 'y la tarjeta no dice que hay un cuerpo que el PR real no tiene');
  assert.ok(task.log.some((l) => /#1126 is already open/.test(l.line)));
});

test('desde el arranque pasa por todo, que es lo que da sentido a la prueba anterior', async () => {
  const task = parked({
    state: 'assigned', phase: null, prevState: null, error: null,
    complexity: null, fixedAt: null, e2ePassedAt: null, qa: null, prPark: null,
  });
  const steps = stubs();
  await pipeline.runPipeline(task, 'assigned', steps);

  assert.deepEqual(steps.calls, [
    'ensureWorktree', 'bringMain', 'triagePhase', 'prepareDependencies', 'fixPhase', 'prepareDependencies', 'bringMain', 'testPhase', 'browserQaPhase', 'generateDemoSteps', 'composePrBody', 'draftPrPhase',
  ]);
});

test('un ciclo nuevo en el mismo HEAD regenera la demo: `beginNewCycle` borra la marca de la anterior', async () => {
  const task = parked({
    state: 'assigned', phase: null, prevState: null, error: null,
    complexity: null, fixedAt: null, e2ePassedAt: null, qa: null, prPark: null,
  });
  const first = stubs();
  await pipeline.runPipeline(task, 'assigned', first);
  assert.equal(task.demoAt, HEAD, 'la primera pasada dejó la marca de su demo');
  assert.equal(first.calls.filter((c) => c === 'generateDemoSteps').length, 1);

  // Reabierta, o un change request: otro ciclo sobre el mismo commit.
  pipeline.beginNewCycle(task, 'test');
  assert.equal(task.demoAt, null);
  const second = stubs();
  await pipeline.runPipeline(task, 'assigned', second);
  assert.equal(second.calls.filter((c) => c === 'generateDemoSteps').length, 1, 'el ciclo nuevo no hereda una demo que ya no es suya');
});

test('tras el fix, si el install falla una vez: UNA ronda de fix con {continuing:true} y el pipeline sigue (con e2e null es el único install tras el fix)', async () => {
  const task = parked({
    state: 'assigned', phase: null, prevState: null, error: null,
    complexity: null, fixedAt: null, e2ePassedAt: null, qa: null, prPark: null, project: BLANK,
  });
  let installs = 0;
  const fixArgs = [];
  const steps = stubs({
    // Antes del fix no hay manifiesto (ok); tras el fix el install falla una vez.
    prepareDependencies: async () => {
      steps.calls.push('prepareDependencies');
      installs += 1;
      return installs === 2 ? { ok: false, stage: 'install', tail: 'npm error code EJSONPARSE' } : { ok: true };
    },
    fixPhase: async (...args) => { steps.calls.push('fixPhase'); fixArgs.push(args); },
  });
  await pipeline.runPipeline(task, 'assigned', steps);

  assert.equal(fixArgs.length, 2, 'el fix y UNA ronda de reparación del install');
  assert.deepEqual(fixArgs[1][3], { continuing: true });
  assert.match(fixArgs[1][2], /EJSONPARSE/, 'la ronda recibe el fallo del install');
  assert.match(fixArgs[1][2], /package.json/);
  assert.deepEqual(steps.calls.slice(3, 8), ['prepareDependencies', 'fixPhase', 'prepareDependencies', 'fixPhase', 'prepareDependencies']);
  assert.ok(steps.calls.includes('testPhase'), 'el pipeline sigue');
});

test('tras el fix, si el install falla dos veces: error «No se pudieron preparar las dependencias»', async () => {
  const task = parked({
    state: 'assigned', phase: null, prevState: null, error: null,
    complexity: null, fixedAt: null, e2ePassedAt: null, qa: null, prPark: null, project: BLANK,
  });
  let installs = 0;
  const steps = stubs({
    prepareDependencies: async () => {
      steps.calls.push('prepareDependencies');
      installs += 1;
      return installs === 1 ? { ok: true } : { ok: false, stage: 'install', tail: 'npm error code ERESOLVE' };
    },
  });
  await assert.rejects(
    () => pipeline.runPipeline(task, 'assigned', steps),
    /Could not prepare the project dependencies/,
  );
  assert.equal(steps.calls.filter((c) => c === 'fixPhase').length, 2, 'el fix y una sola ronda de reparación');
  assert.equal(steps.calls.includes('testPhase'), false);
  // The real runner parks a thrown task in `error`; do it here so the task does
  // not linger mid-fix for the quota tests that share the store.
  store.setState(task, 'error');
});

test('reanudada en «testing»: el fix no se repite, los tests y el QA sí', async () => {
  const task = parked({ phase: 'testing', e2ePassedAt: null, qa: null });
  const steps = stubs();
  await pipeline.runPipeline(task, 'testing', steps);

  // Dos «bringMain»: el del arranque y el de antes de los tests. Reanudar aquí
  // todavía integra main — solo deja de hacerlo del PR en adelante.
  assert.deepEqual(steps.calls, ['bringMain', 'bringMain', 'testPhase', 'browserQaPhase', 'generateDemoSteps', 'composePrBody', 'draftPrPhase']);
});

test('reanudada tarde con un QA de otro commit: se ejecuta igual, avisando, y sin traer main', async () => {
  const task = parked({ qa: { ui: true, passedAt: null, ranAtHead: 'aa00bb11cc22', results: { verdict: 'fail' } } });
  const steps = stubs();
  await pipeline.runPipeline(task, 'pr', steps);

  assert.deepEqual(steps.calls, ['browserQaPhase', 'generateDemoSteps', 'composePrBody', 'draftPrPhase']);
  assert.ok(task.log.some((l) => /not from this commit/.test(l.line)), 'no se cuelga 25 minutos en silencio');
});

test('un QA que sí pasó en este commit se omite aunque la ejecución empiece antes', async () => {
  const task = parked({ phase: 'browser_qa', qa: { ui: true, passedAt: HEAD, ranAtHead: HEAD, results: { verdict: 'pass' } } });
  const steps = stubs();
  await pipeline.runPipeline(task, 'browser_qa', steps);

  assert.deepEqual(steps.calls, ['bringMain', 'generateDemoSteps', 'composePrBody', 'draftPrPhase']);
  assert.ok(task.log.some((l) => /already passed on this commit/.test(l.line)));
});

test('reanudada en «demo» no deja la tarjeta en error sin error', async () => {
  const withPr = parked({ phase: 'demo', prNumber: 1126, prPark: null });
  const steps = stubs();
  await pipeline.runPipeline(withPr, 'demo', steps);
  assert.deepEqual(steps.calls, ['generateDemoSteps']);
  assert.equal(withPr.state, 'pr_draft');
  assert.equal(withPr.error, null);
  assert.equal(withPr.phase, null);

  // Sin PR no hay «pr_draft» que valga: vuelve al sitio del que se reanuda.
  const noPr = parked({ phase: 'demo', prPark: null });
  await pipeline.runPipeline(noPr, 'demo', stubs());
  assert.equal(noPr.state, 'started');
  assert.equal(noPr.error, null);

  // Ni con un PR ya mergeado: la clasificación deja `prNumber` en null en
  // cuanto el PR se mergea (solo un PR abierto es del ciclo), y un PR del
  // historial no convierte la tarjeta en «pr_draft» — eso era la #787.
  const merged = parked({
    phase: 'demo', prPark: null, prNumber: null,
    prs: [{ number: 826, url: 'https://github.com/x/pull/826', title: 'fix: x', state: 'MERGED', createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-02T00:00:00Z', closedAt: '2026-09-02T00:00:00Z' }],
  });
  await pipeline.runPipeline(merged, 'demo', stubs());
  assert.equal(merged.state, 'started', 'se reanuda a «Ya iniciada», no a un draft sobre el PR mergeado');
  assert.equal(merged.error, null);
});

test('con la demo apagada la ejecución termina igual: sin fase pendiente y en «pr_draft»', async () => {
  const task = parked({ demo: 'off' });
  const steps = stubs();
  await pipeline.runPipeline(task, 'pr', steps);

  assert.deepEqual(steps.calls, ['composePrBody', 'draftPrPhase'], 'la fase de demo no corre');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, null, 'y no queda un punto de reanudación fantasma');
  assert.ok(task.log.some((l) => /demo disabled/.test(l.line)));
});

test('el botón de generar pasos ignora el interruptor: un clic es explícito', async () => {
  const task = parked({ demo: 'off', worktreePath: null });
  // Llega hasta la comprobación del worktree, que es el siguiente obstáculo
  // real: si hubiera una guarda por `demo`, habría parado antes.
  await assert.rejects(() => pipeline.generateDemoSteps(task, issueOf()), /worktree/i);
});

// ---------------------------------------------------------------------------
// La fase del PR de verdad: el aparcadero

const prStubs = (over = {}) => ({
  pushBranch: async () => {},
  findPrForBranch: async () => null,
  createDraftPr: async () => ({ number: 1126, url: 'https://github.com/x/pull/1126' }),
  commitSubject: async () => null,
  prView: async (number) => ({ number, state: 'DRAFT', isDraft: true }),
  ...over,
});

test('el cuerpo del PR: el que redactó el agente, y si no lo hubo el de siempre', async () => {
  // The signature is the config's `identity.prSignature`; this test brings its own
  // rather than relying on the loaded config declaring one.
  const { config } = await import('../src/config.js');
  const previousIdentity = config.identity;
  config.identity = { ...config.identity, prSignature: '🤖 Generated by claude-agent' };
  try {
    const bodies = [];
    const capture = prStubs({ createDraftPr: async ({ body }) => { bodies.push(body); return { number: 1126, url: 'https://github.com/x/pull/1126' }; } });

    const written = parked({ prPark: null, prTitle: 'fix: keep the bulk import log fresh', prBody: '## At a glance: before vs. after\n\nCloses #1125' });
    await pipeline.draftPrPhase(written, issueOf(), capture);
    assert.match(bodies[0], /^## At a glance/, 'el cuerpo del agente va tal cual, sin el «Closes» del tablero delante');
    assert.doesNotMatch(bodies[0], /the log never refreshed/);

    const none = parked({ prPark: null, prTitle: 'fix: keep the bulk import log fresh', prBody: null, triageSummary: 'the log never refreshed' });
    await pipeline.draftPrPhase(none, issueOf(), capture);
    assert.match(bodies[1], /^Closes #1125/);
    assert.match(bodies[1], /the log never refreshed/);

    // La firma se mantiene en los dos caminos.
    for (const body of bodies) assert.match(body, /claude-agent/);
  } finally {
    if (previousIdentity === undefined) delete config.identity; else config.identity = previousIdentity;
  }
});

test('un fallo redactando el cuerpo abre el PR igual; la cuota lo aparca en «pr» sin cuerpo a medias', async () => {
  const normal = parked({ prBody: null });
  const steps = stubs({ composePrBody: async () => { throw new Error('el proceso murió'); } });
  await pipeline.runPipeline(normal, 'pr', steps);
  assert.deepEqual(steps.calls, ['generateDemoSteps', 'draftPrPhase'], 'el PR se abre igual');
  assert.equal(normal.prBody, null, 'y se abre con el cuerpo de siempre');
  assert.equal(normal.state, 'pr_draft');
  assert.ok(normal.log.some((l) => /could not write the PR body.*el proceso murió/.test(l.line)));

  const parkedByQuota = parked({ prBody: null });
  const quotaSteps = stubs({ composePrBody: async () => { throw new pipeline.QuotaExhausted('pr'); } });
  await assert.rejects(() => pipeline.runPipeline(parkedByQuota, 'pr', quotaSteps), (e) => e.name === 'QuotaExhausted' && e.resumeFrom === 'pr');
  assert.deepEqual(quotaSteps.calls, ['generateDemoSteps'], 'la demo ya salió junto al cuerpo del PR; el PR no llegó a abrirse');
  assert.equal(parkedByQuota.prBody, null);
  assert.equal(parkedByQuota.phase, 'pr', 'y se vuelve exactamente aquí');
});

test('un fallo del push no aparca ningún título, y se lleva por delante el aparcadero viejo', async () => {
  const task = parked();
  await assert.rejects(
    () => pipeline.draftPrPhase(task, issueOf(), prStubs({
      pushBranch: async () => { throw new Error('git push failed: updates were rejected'); },
    })),
    /updates were rejected/,
  );
  assert.equal(task.prPark, null, 'la tarjeta no puede ofrecer «Publicar PR» por un fallo que no es del título');
});

test('un título que no se puede publicar aparca la propuesta con sus motivos', async () => {
  const task = parked({ prPark: null });
  await assert.rejects(
    () => pipeline.draftPrPhase(task, issueOf({ title: 'añade el botón de publicación' }), prStubs({
      commitSubject: async () => 'wip: uncommitted work',
    })),
    /Publish PR/,
  );
  assert.match(task.prPark.proposal, /añade el botón/);
  assert.ok(task.prPark.problems.length);
  assert.ok(task.prPark.at);
  assert.equal(task.prNumber, null);
});

test('lo que falla en gh también aparca, con el motivo del título si lo tiene', async () => {
  const task = parked({ prPark: null });
  await assert.rejects(
    () => pipeline.draftPrPhase(task, issueOf(), prStubs({
      createDraftPr: async () => { throw new Error('gh pr create failed: HTTP 502'); },
    })),
    /Publish PR/,
  );
  assert.deepEqual(task.prPark.problems, ['gh pr create failed: HTTP 502']);
});

test('con el título que escribiste se crea el PR y el aparcadero desaparece', async () => {
  const title = 'fix(ui): refresh the bulk import submission log while the server records entries';
  const task = parked({ prTitle: title });
  const seen = [];
  await pipeline.draftPrPhase(task, issueOf(), prStubs({
    createDraftPr: async (args) => { seen.push(args); return { number: 1126, url: 'https://github.com/x/pull/1126' }; },
  }));
  assert.equal(seen[0].title, title);
  assert.equal(task.prNumber, 1126);
  assert.equal(task.prPark, null);
});

test('una PR abierta que ya existe se adopta, y tampoco deja aparcadero', async () => {
  const task = parked();
  let created = 0;
  await pipeline.draftPrPhase(task, issueOf(), prStubs({
    findPrForBranch: async () => ({ number: 7, url: 'https://github.com/x/pull/7', state: 'OPEN' }),
    createDraftPr: async () => { created += 1; return { number: 1126, url: 'https://github.com/x/pull/1126' }; },
  }));
  assert.equal(created, 0);
  assert.equal(task.prNumber, 7);
  assert.equal(task.prs[0].number, 7, 'y entra en el historial de PRs');
  assert.equal(task.prPark, null);
});

test('una PR mergeada de la rama no se adopta: se crea otra, como la primera vez', async () => {
  // `findPrForBranch` ya solo devuelve OPEN/DRAFT; la fase no se fía y lo
  // comprueba igualmente, porque adoptar un PR mergeado es la #787 entera.
  const task = parked({ prPark: null, reopenedAt: '2026-09-20T10:00:00.000Z' });
  await pipeline.draftPrPhase(task, issueOf(), prStubs({
    findPrForBranch: async () => ({ number: 826, url: 'https://github.com/x/pull/826', state: 'MERGED' }),
  }));
  assert.equal(task.prNumber, 1126);
  assert.equal(task.prs[0].number, 1126);
  assert.equal(task.prs[0].state, 'DRAFT', 'con la forma completa aunque gh solo diga número y URL');
  assert.ok(task.prs[0].createdAt);
  assert.equal(task.reopenedAt, null, 'el ciclo ya tiene PR: la pill «Reabierta» se va');
});

test('un prNumber de un PR ya mergeado no hace saltarse la fase: se pregunta en vivo y se crea otro', async () => {
  const task = parked({
    prPark: null, prNumber: 826, prUrl: 'https://github.com/x/pull/826',
    prs: [{ number: 826, url: 'https://github.com/x/pull/826', title: 'fix: old', state: 'MERGED', createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-02T00:00:00Z', closedAt: '2026-09-02T00:00:00Z' }],
  });
  const asked = [];
  await pipeline.draftPrPhase(task, issueOf(), prStubs({
    prView: async (number) => { asked.push(number); return { number, state: 'MERGED', isDraft: false }; },
  }));
  assert.deepEqual(asked, [826]);
  assert.equal(task.prNumber, 1126);
  assert.deepEqual(task.prs.map((p) => p.number), [1126, 826], 'los dos PRs, el nuevo primero');
  assert.ok(task.log.some((l) => /#826 is merged/.test(l.line)));

  // Y uno que sigue abierto sí es el reintento tras un fallo entre el push y
  // aquí: no se crea nada.
  const open = parked({ prPark: null, prNumber: 7 });
  let created = 0;
  await pipeline.draftPrPhase(open, issueOf(), prStubs({
    prView: async (number) => ({ number, state: 'OPEN', isDraft: false }),
    createDraftPr: async () => { created += 1; return { number: 1, url: 'u' }; },
  }));
  assert.equal(created, 0);
  assert.equal(open.prNumber, 7);
});

// ---------------------------------------------------------------------------
// Cuota agotada: aparcar sin `error`, y reanudar exactamente donde se paró.
//
// Estas tres van por `startPipelineOf`, no por `runPipeline` a secas: el
// aparcamiento vive en el `catch` del lanzador, y una prueba que llame al
// cuerpo directamente no lo ve — que es justo lo que la cuota promete.

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => { setImmediate(r); });
};

/** Corre el cuerpo real con estos pasos, a través del lanzador de verdad. */
async function throughLauncher(task, resumeFrom, steps) {
  const previous = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = (t, from) => pipeline.runPipeline(t, from, steps);
  try {
    pipeline.startPipelineOf(task, resumeFrom);
    await settle();
  } finally {
    pipeline.pipelineHooks.run = previous;
  }
}

test('aparcada por cuota en el fix: se reanuda ahí, sin repetir worktree ni triage', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  const task = parked({
    state: 'started', prevState: null, phase: 'fixing', error: null,
    fixedAt: null, e2ePassedAt: null, qa: { ui: true }, prPark: null,
  });
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 60 * 60_000 });
  pipeline.parkTaskForQuotaOf(task, 'fixing');
  assert.notEqual(task.state, 'error', 'aparcar nunca pasa por error');
  assert.equal(task.quotaPark.resumeFrom, 'fixing');

  // Y ahora la ventana reabre, con el cuerpo real de `runPipeline` detrás.
  const steps = stubs();
  const previous = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = (t, from) => pipeline.runPipeline(t, from, steps);
  try {
    const hold = quota.quotaHold();
    hold.until = Date.now() - 1000;
    quota.evaluateQuota();
    await settle();
  } finally {
    pipeline.pipelineHooks.run = previous;
  }

  assert.equal(task.quotaPark, null, 'el marcador se va al relanzar');
  assert.ok(!steps.calls.includes('ensureWorktree'), 'el worktree ya está: no se rehace');
  assert.ok(!steps.calls.includes('triagePhase'), 'el triage ya está pagado');
  assert.deepEqual(steps.calls, ['bringMain', 'prepareDependencies', 'fixPhase', 'prepareDependencies', 'bringMain', 'testPhase', 'browserQaPhase', 'generateDemoSteps', 'composePrBody', 'draftPrPhase']);
  assert.notEqual(task.state, 'error');
  quota.resetQuotaForTests();
});

test('una fase que lanza por cuota no deja la tarea en `error` ni toca `e2ePassedAt`', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 60 * 60_000 });
  const task = parked({ state: 'started', prevState: null, phase: 'testing', error: null, e2ePassedAt: null, qa: { ui: true } });
  const steps = stubs({
    testPhase: async () => { throw new pipeline.QuotaExhausted('testing'); },
  });
  await throughLauncher(task, 'testing', steps);

  assert.notEqual(task.state, 'error', 'esto es lo que obligaba al clic humano horas después');
  assert.equal(task.e2ePassedAt, null, 'unos tests que no terminaron no marcan el commit');
  assert.equal(task.phase, 'testing');
  assert.equal(task.quotaPark.resumeFrom, 'testing');
  assert.ok(task.log.some((l) => /quota exhausted/.test(l.line)));
  quota.resetQuotaForTests();
});

test('la demo aparcada conserva su fase en vez de perderla', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 60 * 60_000 });
  const task = parked({ state: 'pr_draft', prevState: null, phase: 'demo', error: null, prNumber: 1126, prPark: null });
  const steps = stubs({
    generateDemoSteps: async () => { throw new pipeline.QuotaExhausted('demo'); },
  });
  await throughLauncher(task, 'demo', steps);

  // El `catch` que se traga los fallos de la demo deja pasar este, o el punto
  // de reanudación se perdería con un `task.phase = null`.
  assert.equal(task.phase, 'demo');
  assert.equal(task.quotaPark.resumeFrom, 'demo');
  assert.equal(task.state, 'pr_draft', 'la tarjeta se queda donde estaba');
  quota.resetQuotaForTests();
});
