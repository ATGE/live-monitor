/**
 * Where a chat's plan files live, and how to tell which one a turn wrote.
 *
 * The CLI writes the plan itself, into `plansDirectory` — a setting relative
 * to the project root, which for a chat is the task's worktree. The board
 * only needs to find the file back when `ExitPlanMode` arrives: the path the
 * turn's own Write tool call named is the surest sign; failing that, the
 * `.md` that was not there when the turn started.
 *
 * Pure functions: the file system is the caller's.
 */

/** Relative to the worktree root. `tmp/` is gitignored in hfs. */
export const PLANS_DIR = 'tmp/hfsmon-plans';

/** The directory for one chat's plans, as a path on the task's machine. */
export function planDirFor(machine, worktreePath, chatId) {
  return machine.path.join(worktreePath, ...PLANS_DIR.split('/'), String(chatId));
}

/**
 * Picks the plan file among `names` (a directory listing). `hint` is the path
 * the turn's own Write named, if any; `before` is the listing at turn start.
 */
export function pickPlanFile(names, { before = [], hint = null } = {}) {
  const md = names.filter((n) => /\.md$/i.test(n));
  if (hint) {
    const base = String(hint).split(/[\\/]/).pop();
    if (md.includes(base)) return base;
  }
  const fresh = md.filter((n) => !before.includes(n));
  if (fresh.length === 1) return fresh[0];
  if (fresh.length > 1) return fresh.sort().at(-1);
  if (md.length === 1) return md[0];
  return null;
}

export const skipMessage = () =>
  'El usuario prefiere no contestar esa pregunta: decide tú con tu mejor criterio, dilo en una línea, y sigue adelante.';

export const reviseMessage = (feedback) =>
  `El usuario pide cambios en el plan:\n\n${feedback}\n\nRevisa el plan con eso en cuenta, reescribe el archivo del plan y vuelve a llamar a ExitPlanMode.`;

export const approveMessage = () =>
  'El plan está aprobado y el tablero lo ejecuta por ti, tarea a tarea y en paralelo. Tu turno termina aquí: no hagas nada más.';

export const timeoutMessage = (minutes) =>
  `El usuario no contestó en ${minutes} minutos. Decide tú con tu mejor criterio, di en una línea qué elegiste, y sigue adelante.`;
