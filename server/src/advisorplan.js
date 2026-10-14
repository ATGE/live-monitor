import { scanMarkdown } from './prbody.js';
import { firstLineOf } from './firstline.js';

/**
 * What the advisor's answer has to look like before it is stored as
 * `task.advisorPlan` and handed to the fix session as its plan.
 *
 * Why it exists. The advisor fans out to subagents and may end a turn on a
 * sentence like "the exploration subagents are still running; I continue with
 * the plan when their reports arrive". Nothing checked the answer, so that
 * sentence became the plan. What can be checked here is, as with the work plan
 * and the PR body, less than what is asked: a heading and a minimum length.
 * Nothing checks that the plan is any good.
 */

/** The line the plan must carry. `advisor.md` asks for it. */
export const ADVISOR_PLAN_HEADING = '## Plan de implementación';

/**
 * Below this there is no plan under the heading, only a stub. The four things
 * the advisor is asked for (approach, files, parallel parts, risks) do not fit
 * in less.
 */
export const MIN_ADVISOR_PLAN_CHARS = 400;

/**
 * Why this advisor answer is not a plan, in Spanish — read on the board's log
 * and handed back to the advisor. Empty means it passes.
 */
export function advisorPlanProblems(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return ['la respuesta está vacía'];

  // No usage-limit check of its own: that notice never carries the heading, so
  // the check below refuses it, and this module stays free of the SDK (the
  // quota itself is read from the session's result, not from its text).
  const { lines, headings } = scanMarkdown(raw);
  const mine = headings.filter((h) => h.title === ADVISOR_PLAN_HEADING);
  if (!mine.length) {
    return [`falta la cabecera \`${ADVISOR_PLAN_HEADING}\`: el texto empieza por «${firstLineOf(raw)}»`];
  }

  // A heading written twice is a model correcting itself: the one with the
  // most text under it is the plan. The plan runs to the end of the answer,
  // sub-headings included.
  const longest = Math.max(...mine.map((h) => lines.slice(h.index + 1).join('\n').trim().length));
  if (longest < MIN_ADVISOR_PLAN_CHARS) {
    return [`el plan bajo \`${ADVISOR_PLAN_HEADING}\` tiene ${longest} caracteres`
      + ` y hacen falta al menos ${MIN_ADVISOR_PLAN_CHARS}: enfoque, archivos, partes en paralelo y riesgos`];
  }
  return [];
}

/**
 * The plan itself: the answer from the mandatory heading on. The validator
 * accepts the heading anywhere, so an answer may open with a sentence like «the
 * subagents are still running» before it; that sentence is not part of the plan
 * and must not reach the fix. The plan runs from the first heading to the end,
 * which is also the span `advisorPlanProblems` measures (a heading written twice
 * leaves the most text under the first). '' when there is none.
 */
export function advisorPlanText(text) {
  const raw = String(text ?? '');
  const { headings } = scanMarkdown(raw);
  const first = headings.find((h) => h.title === ADVISOR_PLAN_HEADING);
  if (!first) return '';
  // Blanked comments keep their line count, so the index also points into the raw text.
  return raw.split(/\r?\n/).slice(first.index).join('\n').trim();
}

/** What to tell an advisor that came back without a plan. */
export function advisorPlanComplaint(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  return `\n\nTu respuesta anterior no es el plan: ${list.join('; ')}.`
    + ` Espera a todos tus subagentes y a tus comandos de fondo, y escribe ahora el plan entero:`
    + ` abre con \`${ADVISOR_PLAN_HEADING}\` y sigue con el enfoque, los archivos y su orden,`
    + ' lo que va en paralelo y los riesgos. Tu último mensaje es el plan; no implementes nada.';
}
