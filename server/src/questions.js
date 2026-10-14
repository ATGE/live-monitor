/**
 * Questions with options: what the model asks through `AskUserQuestion`, and
 * what the board asks on its own (a task that failed every retry). One shape
 * for both, so the panel draws one dialog and the answer route checks one
 * thing.
 *
 * Pure functions over plain objects, kept free of the SDK and the store.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** A label the model marks as its pick, in either language the board speaks. */
const RECOMMENDED = /\s*\((recommended|recomendad[oa])\)\s*$/i;

export const isRecommended = (label) => RECOMMENDED.test(String(label ?? ''));

/** The label without its "(Recommended)" tail. */
export const bareLabel = (label) => String(label ?? '').replace(RECOMMENDED, '').trim();

/** Recommended options first, the rest in their own order. */
export function sortRecommendedFirst(options) {
  const yes = options.filter((o) => isRecommended(o.label));
  const no = options.filter((o) => !isRecommended(o.label));
  return [...yes, ...no];
}

const fail = (problem) => ({ ok: false, problem });

/**
 * Checks the tool's input and returns the questions in the shape the panel
 * shows. Strict on purpose: a malformed question would draw a dialog nobody
 * can answer, and the model is told what was wrong instead.
 */
export function normalizeQuestions(input) {
  const list = input?.questions;
  if (!Array.isArray(list) || !list.length) return fail('faltan las preguntas');
  if (list.length > MAX_QUESTIONS) return fail(`como mucho ${MAX_QUESTIONS} preguntas, llegaron ${list.length}`);

  const questions = [];
  const seen = new Set();
  for (const [i, q] of list.entries()) {
    const where = `la pregunta nº${i + 1}`;
    const question = String(q?.question ?? '').trim();
    if (!question) return fail(`${where} no tiene texto`);
    if (seen.has(question)) return fail(`${where} está repetida`);
    seen.add(question);
    const options = Array.isArray(q?.options) ? q.options : [];
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return fail(`${where} debe tener entre ${MIN_OPTIONS} y ${MAX_OPTIONS} opciones, tiene ${options.length}`);
    }
    const labels = new Set();
    const clean = [];
    for (const o of options) {
      const label = String(o?.label ?? '').trim();
      if (!label) return fail(`${where} tiene una opción sin etiqueta`);
      if (labels.has(label)) return fail(`${where} repite la opción «${label}»`);
      labels.add(label);
      const option = { label, description: String(o?.description ?? '').trim() };
      if (typeof o?.preview === 'string' && o.preview.trim()) option.preview = o.preview;
      clean.push(option);
    }
    questions.push({
      question,
      header: String(q?.header ?? '').trim().slice(0, 12) || `P${i + 1}`,
      multiSelect: q?.multiSelect === true,
      options: clean,
    });
  }
  return { ok: true, questions };
}

/**
 * Checks the user's answers against the questions and returns them in the
 * shape the tool expects: one entry per question, a label or free text for a
 * single choice, a list for a multi-select. Free text is anything that is not
 * one of the labels — that is the "Other" the dialog offers.
 */
export function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return fail('las respuestas no son un objeto');
  const known = new Set(questions.map((q) => q.question));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) return fail(`«${key.slice(0, 60)}» no es una de las preguntas`);
  }
  const out = {};
  for (const q of questions) {
    const raw = answers[q.question];
    if (q.multiSelect) {
      const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : []);
      const clean = list.map((v) => String(v ?? '').trim()).filter(Boolean);
      if (!clean.length) return fail(`«${q.header}» está sin responder`);
      out[q.question] = clean;
    } else {
      const value = Array.isArray(raw) ? raw[0] : raw;
      const clean = String(value ?? '').trim();
      if (!clean) return fail(`«${q.header}» está sin responder`);
      out[q.question] = clean;
    }
  }
  return { ok: true, answers: out };
}

/** One line for the task log: header → answer, per question. */
export function describeAnswers(questions, answers) {
  return questions
    .map((q) => {
      const a = answers[q.question];
      const text = Array.isArray(a) ? a.join(', ') : String(a ?? '');
      return `${q.header} → ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
    })
    .join(' · ');
}

/**
 * What the board asks when a plan task failed every retry. Same shape as the
 * model's questions, so the same dialog answers it; the answer decides what
 * the executor does next.
 *
 * An unrecoverable failure (`failure.unrecoverable`: the same check failed the
 * same way over an unchanged worktree) is asked before the retries run out,
 * and says so: recommending «Retry» there would recommend the loop the
 * executor just refused. The options keep their order and leading words —
 * `readBoardDecision` reads the answer by them.
 */
export function boardQuestion({ taskId, what, attempts, failure }) {
  const tail = String(failure?.output ?? '').split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
  const kind = failure?.kind === 'check' ? 'the check' : 'the session';
  const name = `t${taskId.replace(/^t/, '')} «${what}»`;
  const unrecoverable = Boolean(failure?.unrecoverable);
  return {
    questions: [{
      question: unrecoverable
        ? `${name} failed ${attempts} times, the last two the same way: the check gave the same error and the worktree files did not change. Retrying as is will not fix it: the problem is in the plan or the environment, not in the code. How do we go on? To change the check, write \`check: <command>\` in «Other» (bash, runs from the worktree root).`
        : `${name} failed ${attempts} times (the last one in ${kind}). How do we go on? To change the check, write \`check: <command>\` in «Other» (bash, runs from the worktree root).`,
      header: 'How to go on',
      multiSelect: false,
      options: [
        unrecoverable
          ? { label: 'Retry anyway', description: 'It will fail the same way unless something changes: fix the environment first, or write in «Other» what it should do differently.' }
          : { label: 'Retry once more (Recommended)', description: 'The task session tries again, with what it already knows.' },
        { label: 'Mark as done', description: 'The task is marked done without passing the check; use it if you already verified it yourself.' },
        { label: 'Skip the task', description: 'This task and the ones that depend on it are skipped; the rest of the plan goes on.' },
        { label: 'Stop the plan', description: 'Everything stops. «Continue» resumes it from where it stopped.' },
      ],
      preview: tail ? `Last failure:\n\n\`\`\`\n${tail}\n\`\`\`` : null,
    }],
  };
}

/**
 * What a board question's answer means for the executor. Free text is a hint
 * for another retry, except `check: <command>`, which rewrites the task's check.
 */
export function readBoardDecision(answer) {
  const raw = String(Array.isArray(answer) ? answer[0] : answer ?? '').trim();
  const text = bareLabel(raw).toLowerCase();
  if (text.startsWith('retry') || text.startsWith('reintentar')) return { action: 'retry', hint: null };
  if (text === 'mark as done' || text === 'dar por hecha') return { action: 'done' };
  if (text.startsWith('skip') || text.startsWith('saltar')) return { action: 'skip' };
  if (text.startsWith('stop') || text.startsWith('detener')) return { action: 'stop' };
  // Matched on the original text: lowercasing would mangle the command.
  const m = /^\s*check\s*:\s*([\s\S]+)$/i.exec(raw);
  if (m) {
    let check = m[1].trim();
    if (check.length >= 2 && check.startsWith('`') && check.endsWith('`')) check = check.slice(1, -1).trim();
    if (check) return { action: 'set-check', check };
  }
  return { action: 'retry', hint: raw };
}
