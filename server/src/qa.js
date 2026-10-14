import { parseTaggedJson } from './tagged.js';

/**
 * Browser QA: the contract between the board and the session that verifies an
 * issue the way a human tester would — in a browser, against the task's own
 * running servers, leaving screenshots and video behind.
 *
 * Two tagged lines. `QA_PLAN` comes out of triage (what a tester would do,
 * before any code exists) and again, refined, at the start of the phase (with
 * the fix and the e2e run already known). `QA_RESULTS` comes out of the run:
 * per step, what happened and the files that prove it.
 *
 * The one rule this module enforces above all others: **a step that passed
 * without a screenshot did not pass.** A QA that reports green with nothing to
 * look at is the most expensive failure this phase can have, because it looks
 * like success.
 *
 * Pure: strings in, objects out. Playwright, ffmpeg and the store live elsewhere.
 */

export const QA_PLAN_TAG = 'QA_PLAN';
export const QA_RESULTS_TAG = 'QA_RESULTS';
// Hard net on steps, counting every scenario together.
export const MAX_STEPS = 30;
// Soft: it lives in the prompt, never in the validator. Rejecting a plan for
// having a fourth scenario would burn a whole triage turn on a style point;
// the board says so in the log instead and runs it anyway.
export const SUGGESTED_SCENARIOS = 3;
// The label ends up in a `test()` title and from there in a Playwright output
// directory name; on Windows a long one runs into the path-length limit.
const MAX_SCENARIO_LABEL = 60;

const bad = (problem) => ({ ok: false, problem });

/**
 * The block a prompt carries to ask for the plan.
 *
 * `continuity`: only the QA-phase refine step (never triage, which has no
 * earlier attempt to speak of) tells the model about `carried` — a triage
 * session that learned the field would have nothing to apply it to, and an
 * unused instruction is one more thing to misread.
 */
export function qaPlanContract(subject = 'lo que un QA haría en el navegador para comprobar este issue', { continuity = false } = {}) {
  return `
## El plan de Browser QA

Termina también con **una línea** que empiece por \`${QA_PLAN_TAG}:\` seguida de un
JSON válido en esa misma línea, sin bloque de código:

${QA_PLAN_TAG}: {"ui":true,"steps":[{"id":"q1","scenario":"Importar y revisar informes","what":"Abrir /items y buscar 'informe-mensual'","expect":"la fila «Informe mensual» aparece con su recuento"},{"id":"q2","scenario":"Importar y revisar informes","what":"Lanzar la importación de un archivo pequeño","expect":"la barra llega a 100% y el estado pasa a Completed","longWait":true}]}

Ese plan describe **${subject}**:

- **\`ui\`**: \`true\` si el issue toca algo que una persona ve o hace en el
  navegador (una pantalla, un botón, un mensaje, un listado). \`false\` si es
  puramente de API, persistencia o CLI — entonces \`steps\` va vacío y la fase
  se salta.
- Cada paso, **en lenguaje de usuario**: qué pantalla, qué clic, qué se escribe;
  y en \`expect\`, **qué debe verse** para dar el paso por bueno. Nada de
  selectores CSS aquí: eso se descubre en el navegador.
- **Compón, no enumeres.** Lo que es condición previa de otro paso —entrar,
  navegar hasta la pantalla, crear el dato— va DENTRO del paso que lo necesita,
  no como un paso propio. «Abrir /items y buscar "informe-mensual"» es **un**
  paso, no dos. Un paso es una comprobación con su \`expect\`, no un clic; y una
  precondición repetida en cinco pasos es cinco vídeos del mismo login.
- **Escenarios: como mucho ${SUGGESTED_SCENARIOS}.** Un escenario es un
  recorrido de usuario de principio a fin, y se ejecuta como un solo test que
  graba un solo vídeo. Marca cada paso con \`scenario\`: el mismo texto exacto
  en todos los pasos del escenario, y sus pasos **seguidos** en la lista — una
  etiqueta que reaparece después de otra se rechaza. Elige los pocos
  recorridos que prueban lo que el issue cambió; el tope de ${MAX_STEPS} pasos
  sigue contando todos los escenarios juntos.
- **\`longWait: true\`** en los pasos que esperan a un proceso (un import, un
  export, una indexación). Y para esos, elige el **dato más pequeño** que
  demuestre lo mismo: diez recursos, no un millón. Un QA no mira una barra de
  progreso tres horas.
- Entre 1 y ${MAX_STEPS} pasos. Pocos y verificables valen más que muchos vagos.${continuity ? `
- **\`carried: true\`**: sólo en un paso que el intento anterior dejó en \`pass\`
  y que repites **letra por letra** (mismo \`id\`, mismo \`what\`, mismo
  \`expect\`, mismo \`longWait\`). Es la señal de «esto ya está probado»: el
  tablero lo da por bueno con su evidencia anterior y **no se vuelve a
  ejecutar**. Cambia una coma y deja de estar probado: se ejecuta entero otra
  vez. Así que márcalo cuando de verdad siga valiendo, y no lo marques cuando
  este fix haya podido romperlo.
- Un paso que ya pasó **no se reformula**. Reescribirlo no añade información y
  obliga a grabar de nuevo lo que ya estaba grabado.` : ''}`;
}

/** The block the run prompt carries to report what happened. */
export function qaResultsContract() {
  return `
## Cómo terminas: los resultados

Termina con **una línea** que empiece por \`${QA_RESULTS_TAG}:\` seguida de un JSON
válido en esa misma línea:

${QA_RESULTS_TAG}: {"steps":[{"id":"q1","status":"pass","note":"la fila aparece con 12 elementos","evidence":["results/q1-list.png","results/q1-buscar-informe/video.webm"]},{"id":"q2","status":"fail","note":"el estado se queda en Processing; la barra no avanza del 40%","evidence":["results/q2-import.png","results/q2-import/video.webm"]}],"verdict":"fail","summary":"<2-3 frases en inglés>"}

- **Un objeto por paso de este plan**, con su \`id\`. \`status\`: \`pass\`, \`fail\`, o
  \`unverified\` (no se pudo comprobar: la espera superó el tope, el dato no
  existía…). Di en \`note\` qué viste.
- **\`evidence\` no puede ir vacío en un paso \`pass\`**: rutas relativas al
  directorio de QA, capturas y vídeos. El tablero rechaza un paso que pasa sin
  nada que mirar.
- \`verdict\`: \`pass\` sólo si todos los pasos pasan; \`fail\` si alguno falla por
  el fix; \`unverified\` si ninguno falla pero alguno no se pudo comprobar.
- Un paso que **no puede cumplirse** es un fallo del fix, y se dice. No lo
  reescribas para que pase.
- **Ningún paso del plan se queda sin objeto.** Si un escenario se cortó a la
  mitad —Playwright aborta el \`test()\` en la primera aserción que falla—,
  los pasos que no llegaron a ejecutarse van igualmente, como \`unverified\`,
  con una \`note\` que lo diga.`;
}

/** Reads and validates the plan out of a turn's text. */
export function readQaPlan(text) {
  const raw = parseTaggedJson(text, QA_PLAN_TAG);
  if (raw === null) return bad(`no hay ninguna línea \`${QA_PLAN_TAG}: {...}\` con JSON válido`);
  return validateQaPlan(raw);
}

export function validateQaPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`el ${QA_PLAN_TAG} no es un objeto JSON`);
  const ui = raw.ui === true;
  const list = Array.isArray(raw.steps) ? raw.steps : null;
  if (list === null) return bad('falta la lista `steps`');
  if (!ui) return { ok: true, plan: { ui: false, steps: [] } };
  if (!list.length) return bad('`ui` es true pero no hay pasos: un issue de UI se comprueba con algo');
  if (list.length > MAX_STEPS) return bad(`${list.length} pasos; el máximo es ${MAX_STEPS}`);

  const steps = [];
  const ids = new Set();
  const seenLabels = new Set();
  for (const [i, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object') return bad(`el paso nº${i + 1} no es un objeto`);
    const id = String(entry.id ?? '').trim();
    if (!id) return bad(`el paso nº${i + 1} no tiene \`id\``);
    if (ids.has(id)) return bad(`el id \`${id}\` está repetido`);
    ids.add(id);
    const what = String(entry.what ?? '').trim();
    const expect = String(entry.expect ?? '').trim();
    if (!what) return bad(`el paso \`${id}\` no dice qué hacer en \`what\``);
    if (!expect) return bad(`el paso \`${id}\` no dice qué debe verse en \`expect\``);
    // Folded to one line: the label becomes a `### title` header in the
    // prompt and a Playwright test title, and a newline in either opens a
    // section of its own inside a document the model then reads as orders.
    const scenario = String(entry.scenario ?? '').replace(/\s+/g, ' ').trim();
    if (scenario.length > MAX_SCENARIO_LABEL) return bad(`la etiqueta \`scenario\` del paso \`${id}\` tiene ${scenario.length} caracteres; el máximo es ${MAX_SCENARIO_LABEL}`);
    // Consecutive only: `scenariosOf` groups neighbours, so [A, B, A] would come
    // out as two "A" groups — a duplicated header and a scenario split by accident.
    if (scenario && seenLabels.has(scenario) && steps[steps.length - 1].scenario !== scenario) {
      return bad(`la etiqueta \`scenario\` «${scenario}» reaparece en el paso \`${id}\` después de otra distinta: los pasos de un escenario van seguidos`);
    }
    if (scenario) seenLabels.add(scenario);
    // `carried` is the model's own claim that this step is a copy of one that
    // already passed. It is read here so `splitPlan` can see it, but it is a
    // veto, never a grant: `splitPlan` still requires the text to match the
    // earlier passed step byte for byte before it actually skips anything.
    steps.push({ id, what, expect, longWait: entry.longWait === true, carried: entry.carried === true, scenario });
  }
  return { ok: true, plan: { ui: true, steps } };
}

/**
 * The plan's steps grouped into scenarios: consecutive steps sharing the same
 * non-empty `scenario`. A step without a label — or with none at all, which is
 * what every plan saved before the field existed looks like — is its own group
 * with `title: ''`, so an old flat plan yields N one-step groups and behaves as
 * it always did, no migration. Pure: nothing is mutated, steps keep identity.
 */
export function scenariosOf(steps) {
  const groups = [];
  for (const step of steps ?? []) {
    const title = step.scenario ?? '';
    const last = groups[groups.length - 1];
    if (title && last && last.title === title) last.steps.push(step);
    else groups.push({ title, steps: [step] });
  }
  return groups;
}

/** Reads and validates the results against the plan they were supposed to follow. */
export function readQaResults(text, plan) {
  const raw = parseTaggedJson(text, QA_RESULTS_TAG);
  if (raw === null) return bad(`no hay ninguna línea \`${QA_RESULTS_TAG}: {...}\` con JSON válido`);
  return validateQaResults(raw, plan);
}

const STATUSES = new Set(['pass', 'fail', 'unverified']);

export function validateQaResults(raw, plan) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`el ${QA_RESULTS_TAG} no es un objeto JSON`);
  const list = Array.isArray(raw.steps) ? raw.steps : null;
  if (!list) return bad('falta la lista `steps`');

  const wanted = new Set(plan.steps.map((s) => s.id));
  const seen = new Set();
  const steps = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return bad('un resultado no es un objeto');
    const id = String(entry.id ?? '').trim();
    if (!wanted.has(id)) return bad(`el resultado \`${id || '?'}\` no corresponde a ningún paso del plan`);
    if (seen.has(id)) return bad(`el paso \`${id}\` aparece dos veces`);
    seen.add(id);
    const status = String(entry.status ?? '').trim();
    if (!STATUSES.has(status)) return bad(`el paso \`${id}\` tiene un status desconocido: "${status}"`);
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim().replace(/\\/g, '/'))
      : [];
    if (evidence.some((e) => e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.includes('..'))) {
      return bad(`el paso \`${id}\` cita evidencia fuera del directorio de QA`);
    }
    if (status === 'pass' && !evidence.length) {
      return bad(`el paso \`${id}\` pasa sin ninguna captura ni vídeo: un paso sin evidencia no ha pasado`);
    }
    steps.push({ id, status, note: String(entry.note ?? '').trim(), evidence });
  }
  const missing = [...wanted].filter((id) => !seen.has(id));
  if (missing.length) return bad(`faltan resultados para: ${missing.join(', ')}`);

  const failed = steps.filter((s) => s.status === 'fail').length;
  const unverified = steps.filter((s) => s.status === 'unverified').length;
  const verdict = failed ? 'fail' : unverified ? 'unverified' : 'pass';
  return {
    ok: true,
    results: { steps, verdict, summary: String(raw.summary ?? '').trim(), counts: { failed, unverified, passed: steps.length - failed - unverified } },
  };
}

/** What to tell a session that came back without a usable line. */
export const qaComplaint = (tag, problem) =>
  `\n\nTu turno anterior no dejó un ${tag} utilizable: ${problem}. Devuélvelo ahora, en una sola línea que empiece por \`${tag}:\`.`;

// ---------------------------------------------------------------------------
// Carrying a step across attempts: what stops a retry from re-proving what an
// earlier attempt already did, and from mixing its evidence with the new run.

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** Two steps are the same step only when they read the same, word for word. */
export const sameStep = (a, b) =>
  a.id === b.id && a.what === b.what && a.expect === b.expect && a.longWait === b.longWait
  // `??`: carries already stored in tasks.json have no `scenario`; without it
  // every live carry would be invalidated the first time this runs.
  && (a.scenario ?? '') === (b.scenario ?? '');

/** A carry only applies to the attempt that wrote it, on the machine that ran it. */
export const usableCarry = (carry, { dir, machine }) =>
  (carry && carry.dir === dir && carry.machine === machine ? carry : null);

/**
 * The refined plan cut in two: what an earlier attempt already proved (never
 * run again — its old evidence stands), and what this one has to run.
 *
 * `carried: true` on a step is the model's claim, never taken on its own:
 * `sameStep` must also hold against the step that actually passed, and that
 * step's cited evidence must still be on disk (`files`) — a plan can claim
 * continuity for a step whose screenshot got swept by an unrelated cleanup,
 * and this is what stops that from silently becoming unproven evidence.
 *
 * A scenario is one `test()` and one video, so it is re-run whole: if any of
 * its steps is fresh, the carried ones in the same scenario are demoted to
 * fresh too. Do not "optimise" this back to per-step. The pipeline deletes
 * everything not in `keep` (pipeline.js:3498-3505) and re-condenses everything
 * not in `spared` (3572-3584); leaving half a scenario's evidence on disk while
 * the scenario is re-recorded would mix two attempts into one video.
 *
 * An attempt that ends up with nothing new to run proves nothing: `fresh`
 * empty means the split is discarded and the whole plan runs instead, rather
 * than reporting `pass` on zero minutes of browser time.
 */
export function splitPlan(plan, carry, { files = [] } = {}) {
  const onDisk = new Set(files.map(normPath));
  const proven = new Map((carry?.steps ?? []).map((e) => [e.step.id, e]));
  const verdicts = new Map();
  for (const step of plan.steps) {
    const was = proven.get(step.id);
    const why = !was ? null
      : !step.carried ? 'the plan does not mark it as already proven'
      : !sameStep(step, was.step) ? 'the step text changed'
      : was.status !== 'pass' ? `the previous attempt left it at ${was.status}`
      : was.evidence.some((e) => !onDisk.has(normPath(e))) ? 'its evidence is no longer on disk'
      : '';
    verdicts.set(step, { was, why });
  }
  const carried = [];
  const fresh = [];
  const keep = [];
  const dropped = [];
  for (const group of scenariosOf(plan.steps)) {
    const rerun = group.steps.some((s) => verdicts.get(s).why !== '');
    for (const step of group.steps) {
      const { was, why } = verdicts.get(step);
      if (!rerun) { carried.push(was); keep.push(...was.evidence.map(normPath)); continue; }
      fresh.push(step);
      // `why === null`: no earlier step to speak of, so nothing to report — a
      // first attempt would otherwise print one line per step.
      if (why === '') dropped.push({ id: step.id, why: 'its scenario has new steps: it is rerun whole' });
      else if (why) dropped.push({ id: step.id, why });
    }
  }
  if (!fresh.length) {
    return { carried: [], fresh: plan.steps, keep: [], dropped: [{ id: '*', why: 'no new step was left: the whole plan runs' }] };
  }
  return { carried, fresh, keep, dropped };
}

/**
 * This attempt's results with the carried steps folded back in, in plan
 * order — the verdict the commit actually gets. `null` when there is nothing
 * honest to report: no readable results is not a verdict, and neither is a
 * results object that does not cover the whole plan (carried steps included).
 */
export function mergeQaResults(results, carried, plan) {
  if (!results) return null;
  const mine = new Map(results.steps.map((s) => [s.id, s]));
  const old = new Map(carried.map((c) => [c.step.id, {
    id: c.step.id, status: c.status, note: c.note, evidence: c.evidence, carriedFrom: c.at ?? null,
  }]));
  const steps = plan.steps.map((s) => mine.get(s.id) ?? old.get(s.id)).filter(Boolean);
  if (steps.length !== plan.steps.length) return null;
  const failed = steps.filter((s) => s.status === 'fail').length;
  const unverified = steps.filter((s) => s.status === 'unverified').length;
  return {
    steps, verdict: failed ? 'fail' : unverified ? 'unverified' : 'pass', summary: results.summary ?? '',
    counts: { failed, unverified, passed: steps.length - failed - unverified },
  };
}

/**
 * What this attempt leaves behind for the next one — every step of the
 * merged verdict, not only the passed ones, so `previousAttemptSection` can
 * show the refining session what failed too. `null` on a green verdict: nothing
 * left to carry once the commit is proven, and a stale carry surviving a green
 * QA would let a later *manual* re-run skip a plan it never actually ran.
 */
export function nextCarry(merged, plan, carry, { attempt, at, dir, machine }) {
  if (merged?.verdict === 'pass') return null;
  const planIds = new Set(plan.steps.map((s) => s.id));
  if (!merged) {
    // No readable results this attempt (quota, an unusable QA_RESULTS line):
    // nothing new was proven, so whatever survived keeps standing — pruned to
    // steps the current plan still asks about.
    const steps = (carry?.steps ?? []).filter((c) => planIds.has(c.step.id));
    return steps.length ? { ...carry, steps, attempt } : null;
  }
  const steps = merged.steps.filter((s) => planIds.has(s.id)).map((s) => {
    const isPass = s.status === 'pass';
    return {
      step: plan.steps.find((p) => p.id === s.id),
      status: s.status,
      note: s.note ?? '',
      evidence: isPass ? (s.evidence ?? []) : [],
      at: isPass ? (s.carriedFrom ?? at) : at,
    };
  });
  return { attempt, at, dir, machine, steps };
}

const CARRY_MARK = { pass: '✅ YA PASÓ', fail: '❌ FALLÓ', unverified: '⚠️ NO SE PUDO COMPROBAR' };

/** The previous attempt of this same phase, for the refining session. */
export function previousAttemptSection(carry) {
  if (!carry?.steps?.length) return '(este es el primer intento de este Browser QA: no hay nada comprobado todavía)';
  const head = `Intento nº${carry.attempt} sobre el commit ${String(carry.at ?? '').slice(0, 8) || 'desconocido'}:`;
  const lines = carry.steps.map((e) => `- **${e.step.id}** ${CARRY_MARK[e.status]} — «${e.step.what}» → debía verse: «${e.step.expect}»`
    + (e.status === 'pass' ? ` · evidencia grabada: ${e.evidence.length} archivo(s)` : '')
    + (e.note ? ` · lo que vio: ${e.note.slice(0, 300)}` : ''));
  return `${head}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The harness the board writes into the QA directory before the run.

/**
 * A Playwright config for one task's QA, outside the repo. Video, screenshots
 * and traces on for every test — the evidence is the point — and the spec's
 * timeout wide enough for a bounded long wait.
 */
export function playwrightConfig({ baseURL, maxWaitMinutes = 45, longWaitsPerTest = 1 }) {
  // `MAX_WAIT_MS` caps each wait, but Playwright's timeout is per `test()` and a
  // scenario is one test: with two `longWait` steps inside it, a single wait's
  // worth of budget kills the test halfway and the whole scenario is lost.
  const timeoutMs = (maxWaitMinutes * Math.max(1, longWaitsPerTest) + 5) * 60_000;
  return `// Written by hfs-monitor for this task's Browser QA. Not part of the repo.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\\.spec\\.ts$/,
  outputDir: './results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: ${timeoutMs},
  reporter: [['list'], ['json', { outputFile: './results/report.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: ${JSON.stringify(baseURL)},
    video: 'on',
    screenshot: 'on',
    trace: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
`;
}

/**
 * The security-camera helpers. Playwright cannot pause a recording, so a wait
 * has to be made of moments worth seeing: `waitForChange` polls a condition
 * and keeps a screenshot only when the page changed; `waitWithoutBrowser`
 * closes the page (ending its video) while an API is polled, and hands back a
 * fresh page when there is something to look at again.
 *
 * `resultsDir` is the QA directory's own `results/` folder, as an absolute
 * path on the machine the spec runs on. `page.screenshot({ path })` resolves
 * a relative path against the *process*'s cwd, not against the Playwright
 * config's `outputDir` — and the spec is launched with its cwd inside the
 * read-only worktree (`cd {{e2eDir}} && npx playwright test …`), so a bare
 * `results/…` string here would land the screenshot inside the worktree, not
 * in `resultsDir`, where nothing downstream would ever find it. The path
 * returned to the caller stays the short relative one: that is what
 * `QA_RESULTS`'s `evidence` and `listEvidence`'s tagging already expect.
 */
export function qaHelpers({ maxWaitMinutes = 45, resultsDir }) {
  return `// Written by hfs-monitor. Helpers for waits that would otherwise fill a video with nothing.
import { expect, type Page, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';

export const MAX_WAIT_MS = ${maxWaitMinutes} * 60_000;
// Absolute: page.screenshot({ path }) resolves a relative one against the
// process's cwd, not the config's outputDir — see this module's doc comment.
const RESULTS_DIR = ${JSON.stringify(resultsDir)};

/**
 * Waits for \`done(page)\` to be true, polling every \`everyMs\`. Takes a
 * screenshot into \`results/<name>-<n>.png\` ONLY when the page looks different
 * from the last time — a progress bar that did not move is not worth a frame.
 * Returns false when the cap ran out: the caller reports the step as unverified.
 */
export async function waitForChange(
  page: Page,
  done: (page: Page) => Promise<boolean>,
  name: string,
  { everyMs = 5_000, maxMs = MAX_WAIT_MS } = {},
): Promise<boolean> {
  const started = Date.now();
  let last = '';
  let shot = 0;
  while (Date.now() - started < maxMs) {
    const png = await page.screenshot({ fullPage: false });
    const hash = createHash('sha1').update(png).digest('hex');
    if (hash !== last) {
      last = hash;
      shot += 1;
      await page.screenshot({ path: \`\${RESULTS_DIR}/\${name}-\${String(shot).padStart(2, '0')}.png\` });
    }
    if (await done(page)) return true;
    await page.waitForTimeout(everyMs);
  }
  return false;
}

/**
 * For waits that are really long: closes the page (its video ends there),
 * polls \`ready()\` without a browser, and opens a new page when it is true.
 * Returns null when the cap ran out.
 */
export async function waitWithoutBrowser(
  context: BrowserContext,
  page: Page,
  ready: () => Promise<boolean>,
  { everyMs = 10_000, maxMs = MAX_WAIT_MS } = {},
): Promise<Page | null> {
  await page.close();
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    if (await ready()) return context.newPage();
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/** A screenshot named after the step, for the evidence list. */
export async function evidence(page: Page, name: string): Promise<string> {
  const file = \`results/\${name}.png\`;
  await page.screenshot({ path: \`\${RESULTS_DIR}/\${name}.png\`, fullPage: true });
  return file;
}

export { expect };
`;
}

/** The Playwright MCP, as the SDK's `mcpServers` entry, headless and disposable. */
export function mcpServers({ version, outputDir }) {
  return {
    playwright: {
      command: 'npx',
      args: ['-y', `@playwright/mcp@${version}`, '--headless', '--isolated', '--output-dir', outputDir],
    },
  };
}

// ---------------------------------------------------------------------------
// Video: turning ffmpeg's frame log into "what was cut".

/**
 * From the `showinfo` lines of a pass that kept only frames with change
 * (`select='gt(scene,…)'`), the stretches of stillness: any gap between two
 * kept frames longer than `minGapSeconds`. What a viewer wants to know is
 * "38 minutes of nothing from 2:10", not the frame numbers.
 */
export function stillStretches(showinfoLog, { minGapSeconds = 8 } = {}) {
  const times = [...String(showinfoLog ?? '').matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const cuts = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (gap >= minGapSeconds) cuts.push({ from: round(times[i - 1]), seconds: round(gap) });
  }
  return cuts;
}

const round = (n) => Math.round(n * 10) / 10;

/** "38 min unchanged from 2:10" */
export function describeCut({ from, seconds }) {
  const at = `${Math.floor(from / 60)}:${String(Math.floor(from % 60)).padStart(2, '0')}`;
  const len = seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`;
  return `${len} unchanged from ${at}`;
}

/**
 * What a finished QA leaves on the task, as marks against the commit it ran on.
 *
 * Two marks, not one. `passedAt` is the old one and still means "green here":
 * only a `pass` writes it. `ranAtHead` says the phase was *paid for* on this
 * commit, whatever the verdict — an incomplete session that stopped at 5 of 12
 * steps ran for 25 minutes all the same, and a failure at a later step (opening
 * the PR, say) must not charge for those minutes twice.
 *
 * `ran` is the third case, and the one the quota incident uncovered: a session
 * that died against the account's limit verified nothing, so it earned neither
 * mark. Then this writes **nothing at all** — an absent mark leaves whatever
 * was honestly earned on this same commit standing, while a `ranAtHead` it did
 * not earn would make the next run skip the QA and publish unverified work.
 */
export const qaMarks = (verdict, head, { ran = true } = {}) => {
  if (!ran) return {};
  return {
    passedAt: verdict === 'pass' ? (head ?? null) : null,
    ranAtHead: head ?? null,
  };
};

/**
 * The evidence the panel lists: every screenshot and video under the results
 * directory, with the steps it belongs to when the name says so.
 *
 * `steps`, plural: a scenario is one `test()` titled after all its steps
 * (`q1+q2 — …`) and Playwright names the video's directory after that title,
 * so one file answers to several ids. Reporting only the first would leave the
 * panel silent about the video of q2.
 */
export function listEvidence(files, { steps = [] } = {}) {
  // Plan order is kept; the delimiters, not the search order, keep `q1` off `q10`.
  const ids = steps.map((s) => s.id);
  return files
    .filter((f) => /\.(png|jpg|jpeg|webm|mp4)$/i.test(f))
    .map((f) => {
      const base = f.split('/').pop();
      const kind = /\.(webm|mp4)$/i.test(f) ? 'video' : 'image';
      // The id must be delimited on both sides, so `q1` never claims `q10`.
      // `+` and whitespace delimit ids inside a scenario title.
      const named = ids.filter((id) => new RegExp(`(^|[-_/+\\s])${escape(id)}([-_./+\\s]|$)`).test(f));
      return { path: f, name: base, kind, steps: named };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The single byte range a request asks for, or what to do instead of one.
 *
 * `null` when there is no header, `'invalid'` when it is multi-range or does
 * not parse — RFC 9110 lets a server ignore a range it does not understand
 * and answer with the whole file — `'unsatisfiable'` when it asks for bytes
 * this file does not have (the 416 names the size instead), and otherwise
 * `{ start, end }`, both inclusive and already clamped to the file.
 */
export function parseRange(header, size) {
  if (header === null || header === undefined) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  // One range only: a comma never matches, so `bytes=0-9,20-29` is 'invalid'.
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return 'invalid';
  const [, from, to] = m;
  if (from === '' && to === '') return 'invalid';
  // Nothing to hand back from an empty file, whatever the range says.
  if (!(size > 0)) return 'unsatisfiable';
  if (from === '') {
    // A suffix: the last N bytes. `bytes=-0` asks for none of them.
    const n = Number(to);
    if (n <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return 'unsatisfiable';
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Answers one evidence request with the bytes already in hand: the whole file,
 * or the slice a `Range` header asked for.
 *
 * It lives here, beside `parseRange`, rather than inline in the route, so the
 * header arithmetic can be driven over real HTTP in a test without booting the
 * whole board (importing `index.js` binds the board's port and starts polling).
 *
 * Nothing here streams and nothing here costs more memory than before:
 * `qaEvidence` already reads the whole file into a buffer before this runs,
 * and `subarray` hands back a view over those very bytes, never a copy.
 */
export function sendEvidence(req, res, bytes, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = parseRange(req.headers?.range, bytes.length);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${bytes.length}`);
    return res.status(416).end();
  }
  if (range && range !== 'invalid') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    return res.end(bytes.subarray(range.start, range.end + 1));
  }
  // Without a length the answer goes out chunked and the browser never learns
  // how big the file is, so its progress bar cannot scrub.
  res.setHeader('Content-Length', String(bytes.length));
  return res.end(bytes);
}
