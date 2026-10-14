import { WORK_PLAN_TAG, renderWorkPlan } from './workplan.js';
import { stripTaggedLine } from './tagged.js';
import { scanMarkdown } from './prbody.js';
import { firstLineOf } from './firstline.js';

/**
 * The paragraph a plan has to open with, before the table of tasks and files.
 *
 * Why it exists. What the board sends you to approve today is `renderWorkPlan`
 * and nothing else: ids, `what` lines, file lists, check commands. That is a
 * manifest, not an explanation — it says `crates/rest/src/config.rs` will be
 * touched, never what the server does wrong now and what it will do after. To
 * decide whether to approve it you had to open the code, which is exactly the
 * work the board was supposed to save.
 *
 * So the plan opens with prose. Three to five sentences, today → after → where,
 * written for someone who has not read the diff.
 *
 * The brief is *the section*, not everything above the tag. A phase that
 * thought out loud for two thousand words and then wrote its summary would
 * otherwise put all of it in front of the table, in the one window where a
 * human decides in ten seconds. `readBrief` starts at the heading and drops
 * what came before it.
 *
 * What can be checked here is, as usual, less than what is asked: a heading
 * and a length. Nothing checks that the prose is *true*, or that it is not the
 * file list written out in words — the contract forbids that in words, and a
 * prompt asks, it does not guarantee. The heading is what makes it visible,
 * and a visible brief is one a human can dismiss in two seconds when it is
 * empty noise.
 */

/** The line the brief must open with. Used by the contract and by the check. */
export const PLAN_BRIEF_HEADING = '## De un vistazo';

/**
 * Below this the brief is a stub, not a paragraph. Three plain sentences run
 * past 200 characters without effort; a "Fixes the bug in config.rs." does not.
 */
export const MIN_BRIEF_CHARS = 200;

/**
 * The tagged line, wherever it sits. `stripTaggedLine` removes the lines that
 * *start* with the tag; `parseTaggedJson` also reads one that starts mid-line
 * (`Ahí va: WORK_PLAN: {…}`), and what it reads must not survive in the prose
 * a person is shown. Greedy to the last brace, exactly as the parser is.
 */
const INLINE_TAG = new RegExp(`${WORK_PLAN_TAG}:\\s*\\{.*\\}`, 'g');

/**
 * The block a prompt carries to ask for the brief. Spanish, like every other
 * contract the board hands a phase, and it sits next to `workPlanContract()`
 * in the same prompts.
 */
export function planBriefContract() {
  return `
## Antes del ${WORK_PLAN_TAG}: el resumen de un vistazo

Tu respuesta debe **empezar** por una sección con esta cabecera exacta:

${PLAN_BRIEF_HEADING}

Debajo, entre 3 y 5 frases que un desarrollador entienda **sin abrir el código**:

- **qué pasa hoy** — el comportamiento que está mal, visto desde fuera;
- **qué pasará después del cambio** — el comportamiento nuevo, también visto desde fuera;
- **dónde se toca** — en una frase: qué parte del sistema (el servidor REST, la UI,
  el validador…), no la lista de archivos.

Escríbelo en prosa. **No vale** que la explicación sea una lista de rutas ni de
nombres de función: \`loader.py\`, \`render_report()\` y \`tests/e2e\` no le dicen
nada a quien tiene que aprobar el plan. Si sólo sabes decir qué archivos tocas,
todavía no sabes qué estás arreglando.

Lo que escribas **antes** de esa cabecera no llega a quien aprueba el plan, así
que no dejes ahí nada que haga falta. La tabla de tareas va después, en la línea
\`${WORK_PLAN_TAG}:\`; el resumen no la repite.`;
}

/** The turn with every trace of the tagged line removed. */
function prose(text) {
  return stripTaggedLine(text, WORK_PLAN_TAG).replace(INLINE_TAG, '').trim();
}

/**
 * The brief's section: where it starts and what is under it, down to the next
 * heading.
 *
 * A heading written twice — an empty one and then the real one — is the shape
 * of a model correcting itself, so the section that carries a body is the
 * brief, not whichever came first.
 */
function briefSection(text) {
  const { lines, headings } = scanMarkdown(text);
  const mine = headings.filter((h) => h.title === PLAN_BRIEF_HEADING);
  if (!mine.length) return null;

  const sections = mine.map((h) => {
    const next = headings.find((x) => x.index > h.index);
    const body = lines.slice(h.index + 1, next ? next.index : lines.length).join('\n').trim();
    return { index: h.index, body };
  });
  sections.sort((a, b) => b.body.length - a.body.length);

  const best = sections[0];
  return { body: best.body, text: lines.slice(best.index).join('\n').trim() };
}

/**
 * The brief a turn left, from its heading to the end — never the thinking that
 * came before it, and never the tagged line. Null when there is nothing left.
 */
export function readBrief(text) {
  const rest = prose(text);
  if (!rest) return null;
  const section = briefSection(rest);
  // No heading: hand back what there is, so the caller sees the same text the
  // complaint is about instead of a silent null.
  return section ? section.text : rest;
}

/**
 * Why this turn's brief is not usable, in Spanish — these are read on the
 * board's log and handed back to the agent. Empty means it passes.
 *
 * Takes either the whole turn or the brief alone: stripping a tagged line that
 * is not there changes nothing.
 */
export function briefProblems(text) {
  const rest = prose(text);
  if (!rest) {
    return [`no hay nada escrito antes de la línea \`${WORK_PLAN_TAG}:\`: falta el resumen \`${PLAN_BRIEF_HEADING}\``];
  }

  const section = briefSection(rest);
  if (!section) {
    return [`falta la cabecera \`${PLAN_BRIEF_HEADING}\`: el texto empieza por «${firstLineOf(rest)}»`];
  }
  if (section.body.length < MIN_BRIEF_CHARS) {
    return [`el resumen bajo \`${PLAN_BRIEF_HEADING}\` tiene ${section.body.length} caracteres`
      + ` y hacen falta al menos ${MIN_BRIEF_CHARS}: son 3–5 frases, no un titular`];
  }
  return [];
}

/**
 * The plan as it goes out to be read and approved: the prose first, the rounds
 * after. Without a usable brief this is exactly what the board sent before, so
 * a missing brief degrades the message instead of breaking it.
 */
export function planText(brief, plan) {
  const text = String(brief ?? '').trim();
  const rendered = renderWorkPlan(plan);
  return text ? `${text}\n\n${rendered}` : rendered;
}

/** What to tell a phase that came back without a usable brief. */
export function briefComplaint(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  return `\n\nTu turno anterior no dejó un resumen utilizable: ${list.join('; ')}.`
    + ` Escríbelo ahora —la sección \`${PLAN_BRIEF_HEADING}\` con 3–5 frases en prosa—`
    + ` y vuelve a dejar la línea \`${WORK_PLAN_TAG}:\` detrás, sin rehacer el trabajo que ya hiciste.`;
}
