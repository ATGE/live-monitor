import { parseTaggedJson } from './tagged.js';
// `Task` in SDK 0.1.x, `Agent` from 0.3 on: one list, declared in the gate.
import { SUBAGENT_TOOLS } from './subagentgate.js';

/**
 * The WORK_PLAN contract: how a phase declares the pieces of work it found and
 * which of them can run at the same time, and how the board checks that claim.
 *
 * Why a contract at all. Asking a prompt to "parallelise" was already in place
 * and measured: of 5033 tool calls made from this board's chats, 34 were
 * subagents (0.7%); the fix phase, the only prompt that asked, reached 1.6%. A
 * request is not a contract — nothing read the answer, nothing counted, nothing
 * could tell a session that fanned out from one that went single file.
 *
 * What can actually be checked without running anything is small, so this
 * module checks exactly that and no more: the ids exist and are unique, the
 * dependencies point somewhere and don't loop, and — the one that matters —
 * two tasks that may run at the same time never name the same file. Subagents
 * share the worktree, so an overlap there is the same silent clobber two
 * parallel chats produce, with the last writer winning and nobody told.
 *
 * A plan remains an assertion, not a proof: a model can declare five
 * independent tasks and be wrong about it. What the board adds is that the
 * claim is now written down, checked for the part that is checkable, and
 * compared afterwards against how many subagents actually ran.
 */

export const WORK_PLAN_TAG = 'WORK_PLAN';

/** Enough for any real fix; past this the plan is noise, not a plan. */
export const MAX_TASKS = 40;

const bad = (problem) => ({ ok: false, problem });

/**
 * The block a prompt carries to ask for the plan. `subject` names what the
 * tasks stand for, because the same contract serves a phase planning its own
 * turn and a phase planning the work that comes after it.
 */
export function workPlanContract(subject = 'el trabajo de esta fase') {
  return `
## Antes de terminar: el WORK_PLAN

Tu turno debe incluir, al final, **una línea** que empiece por \`${WORK_PLAN_TAG}:\` seguida
de un JSON válido en esa misma línea, sin bloque de código:

${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"qué hace esta pieza","files":["src/config/loader.py"],"dependsOn":[],"check":"python -m mypy src/config"},{"id":"t2","what":"otra pieza","files":["tests/config/test_loader.py"],"dependsOn":["t1"],"check":"cd tests && python -m pytest config/test_loader.py"}]}

Ese plan describe **${subject}**, repartido en piezas:

- **\`dependsOn: []\` significa «esto puede ir a la vez que las demás».** Pon un id
  ahí sólo si de verdad necesitas el resultado de esa pieza para empezar la tuya.
  Encadenar por costumbre convierte el plan en una fila.
- **\`files\`**: los archivos que esa pieza va a tocar, en rutas relativas a la raíz
  del repositorio. Dos tareas que puedan ir a la vez **no pueden compartir un
  archivo**: el tablero lo comprueba y te devuelve el plan si se solapan. Si dos
  piezas necesitan el mismo archivo, o las encadenas con \`dependsOn\` o las juntas
  en una sola.
- **\`check\`** (opcional): una línea de **bash** (Git Bash en Windows) — el mismo
  shell que tu herramienta Bash, así que \`VAR=valor comando\`, \`&&\` y \`cd\` valen —
  que corre en la raíz del worktree sin nada que sólo tenga tu sesión, y que
  demuestra que la pieza quedó bien — la comprobación rápida del módulo que
  tocaste (compilar, tipos, lint), un test concreto, un \`curl\`. El tablero lo
  ejecuta al terminar la pieza y no la da por hecha si falla. Que sea rápido y
  suyo: no la suite entera.
- **Si el trabajo es una sola cosa, declara una sola tarea.** No infles el plan:
  el tablero compara lo que declaras con lo que ejecutas, y cinco tareas
  «paralelas» hechas una detrás de otra se registran como incumplimiento.`;
}

/** Reads and validates the plan out of a finished turn's text. */
export function readWorkPlan(text) {
  const raw = parseTaggedJson(text, WORK_PLAN_TAG);
  if (raw === null) return bad(`no hay ninguna línea \`${WORK_PLAN_TAG}: {...}\` con JSON válido`);
  return validateWorkPlan(raw);
}

/** Checks a parsed plan. Returns `{ ok, plan }` or `{ ok: false, problem }`. */
export function validateWorkPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('el WORK_PLAN no es un objeto JSON');

  const list = raw.tasks;
  if (!Array.isArray(list) || !list.length) return bad('falta la lista `tasks`, o viene vacía');
  if (list.length > MAX_TASKS) return bad(`el plan trae ${list.length} tareas y el máximo es ${MAX_TASKS}`);

  const tasks = [];
  const ids = new Set();
  for (const [i, entry] of list.entries()) {
    const where = `la tarea nº${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad(`${where} no es un objeto`);

    const id = String(entry.id ?? '').trim();
    if (!id) return bad(`${where} no tiene \`id\``);
    if (ids.has(id)) return bad(`el id \`${id}\` está repetido`);
    ids.add(id);

    const what = String(entry.what ?? '').trim();
    if (!what) return bad(`la tarea \`${id}\` no dice en \`what\` qué hace`);

    const files = entry.files ?? [];
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
      return bad(`\`files\` de \`${id}\` debe ser una lista de rutas`);
    }
    const dependsOn = entry.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
      return bad(`\`dependsOn\` de \`${id}\` debe ser una lista de ids`);
    }
    // How the board tells the task is done: a shell command run in the
    // worktree once the task's session ends. Optional — without it the task
    // is done when its session ends well.
    if (entry.check !== undefined && entry.check !== null && typeof entry.check !== 'string') {
      return bad(`\`check\` de \`${id}\` debe ser un comando (texto)`);
    }

    tasks.push({
      id,
      what,
      files: files.map((f) => f.trim()).filter(Boolean),
      dependsOn: [...new Set(dependsOn.map((d) => d.trim()).filter(Boolean))],
      check: String(entry.check ?? '').trim() || null,
    });
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) return bad(`la tarea \`${task.id}\` depende de sí misma`);
      if (!ids.has(dep)) return bad(`la tarea \`${task.id}\` depende de \`${dep}\`, que no existe`);
    }
  }

  const waves = layer(tasks);
  if (!waves) return bad('las dependencias forman un ciclo: no hay por dónde empezar');

  const clash = fileClash(tasks);
  if (clash) return bad(clash);

  return { ok: true, plan: { tasks, waves } };
}

/**
 * Groups tasks into rounds: everything in a round can run at once, and a round
 * only starts when the one before it finished. Null when a cycle leaves tasks
 * that never become ready.
 */
function layer(tasks) {
  const pending = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const done = new Set();
  const waves = [];

  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => deps.every((d) => done.has(d))).map(([id]) => id);
    if (!ready.length) return null;
    waves.push(ready);
    for (const id of ready) pending.delete(id);
    for (const id of ready) done.add(id);
  }
  return waves;
}

// Same file, written two ways: Windows separators and a `./` prefix are the two
// that show up in practice, and the filesystem here does not care about case.
const fileKey = (f) => f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** Every task each task transitively waits for. Safe once `layer` found no cycle. */
function ancestors(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();

  const walk = (id) => {
    const cached = memo.get(id);
    if (cached) return cached;
    const acc = new Set();
    memo.set(id, acc); // guards against re-entry even if a cycle slipped through
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      acc.add(dep);
      for (const up of walk(dep)) acc.add(up);
    }
    return acc;
  };

  return new Map(tasks.map((t) => [t.id, walk(t.id)]));
}

/**
 * The only guarantee worth having here: two tasks with no ordering between them
 * must not name the same file.
 */
function fileClash(tasks) {
  const anc = ancestors(tasks);
  const keys = new Map(tasks.map((t) => [t.id, new Set(t.files.map(fileKey))]));

  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i];
      const b = tasks[j];
      if (anc.get(a.id).has(b.id) || anc.get(b.id).has(a.id)) continue; // ordered: no race
      const shared = a.files.find((f) => keys.get(b.id).has(fileKey(f)));
      if (shared) {
        return `\`${a.id}\` y \`${b.id}\` pueden ir a la vez y las dos tocan \`${shared}\``
          + '; encadénalas con `dependsOn` o repártelas por archivos distintos';
      }
    }
  }
  return null;
}

/** total, how many can start immediately, and the widest round. */
export function planStats(plan) {
  const total = plan.tasks.length;
  const independent = plan.tasks.filter((t) => !t.dependsOn.length).length;
  const widest = Math.max(...plan.waves.map((w) => w.length));
  return { total, independent, widest, rounds: plan.waves.length };
}

/** How many subagents a finished turn actually launched. */
export function subagentsUsed(toolCounts = {}) {
  return SUBAGENT_TOOLS.reduce((n, name) => n + (toolCounts[name] ?? 0), 0);
}

/**
 * Declared a fan-out and ran single file. Two is the threshold on both sides:
 * one subagent is not parallelism, and a one-task plan is not a failure — a
 * one-line fix in one file should not be split, and forcing it would be worse.
 */
export function planIgnored(plan, toolCounts) {
  return planStats(plan).independent >= 2 && subagentsUsed(toolCounts) < 2;
}

/** The line the board writes to the task log, so the claim is checkable there. */
export function parallelismLine(plan, toolCounts, elapsedMs) {
  const { total, independent } = planStats(plan);
  const parts = [`plan: ${total} task${total === 1 ? '' : 's'}, ${independent} independent`];
  if (toolCounts) parts.push(`execution: ${subagentsUsed(toolCounts)} subagents`);
  if (Number.isFinite(elapsedMs)) parts.push(`${Math.max(1, Math.round(elapsedMs / 60000))} min`);
  return parts.join(' · ');
}

/** The plan, written back into the prompt of the call that has to carry it out. */
export function renderWorkPlan(plan) {
  const lines = plan.waves.map((wave, i) => {
    const rows = wave.map((id) => {
      const t = plan.tasks.find((x) => x.id === id);
      const files = t.files.length ? ` — archivos: ${t.files.map((f) => `\`${f}\``).join(', ')}` : '';
      const check = t.check ? ` — comprobación: \`${t.check}\`` : '';
      return `  - \`${t.id}\`: ${t.what}${files}${check}`;
    }).join('\n');
    const head = wave.length > 1
      ? `- Ronda ${i + 1} — estas ${wave.length} van A LA VEZ, un subagente cada una, todas lanzadas en el MISMO mensaje:`
      : `- Ronda ${i + 1}:`;
    return `${head}\n${rows}`;
  }).join('\n');

  return `
## El plan de trabajo, ya acordado

Esto salió de tu propio análisis y el tablero ya lo validó (los archivos de las
tareas que van a la vez no se solapan). Ejecútalo:

${lines}

Una ronda no empieza hasta que la anterior terminó, y dentro de una ronda todo
va a la vez. Si al ejecutar descubres que el plan estaba mal, cámbialo y **di en
tu respuesta qué cambiaste y por qué** — pero no lo conviertas en una fila sin
decirlo: el tablero cuenta cuántos subagentes lanzaste y lo compara con esto.`;
}

/** What to tell a phase that came back without a usable plan. */
export function workPlanComplaint(problem) {
  return `\n\nTu turno anterior no dejó un ${WORK_PLAN_TAG} utilizable: ${problem}.`
    + ` Devuélvelo ahora, en una sola línea que empiece por \`${WORK_PLAN_TAG}:\`,`
    + ' sin rehacer el trabajo que ya hiciste.';
}
