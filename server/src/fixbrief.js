/**
 * What a fix session is told when it is not starting from nothing.
 *
 * A retry that lands on the fix phase with commits already on the branch used
 * to launch a fix from scratch — expensive, and on a branch you had finished
 * from the chat, pointless. But "the branch has commits" is not "the fix is
 * done": work half-made from the chat has commits too. So the session is told
 * exactly what is there and what stopped the last attempt, and its job
 * changes from "implement" to "review, finish what is missing, verify, and
 * commit only that". If it finds the work complete, saying so is the answer.
 *
 * Pure: the git output comes in as text, the brief goes out as text.
 */
export function continuationBrief({ branch, commits = [], files = [], dirty = 0, lastError = null, base = 'main' }) {
  const list = (items, max = 20) => items.slice(0, max).map((x) => `- ${x}`).join('\n') + (items.length > max ? `\n- …y ${items.length - max} más` : '');
  const parts = [
    '',
    'ESTE ES UN REINTENTO: NO EMPIECES DE CERO.',
    `La rama \`${branch}\` ya tiene ${commits.length} commit(s) sobre origin/${base}:`,
    list(commits),
    '',
    files.length ? `Archivos que esa rama ya cambia respecto a origin/${base}:\n${list(files, 30)}` : `Esa rama no cambia ningún archivo respecto a origin/${base} (commits vacíos o revertidos).`,
  ];
  if (dirty > 0) {
    parts.push('', `Además hay ${dirty} archivo(s) con cambios SIN commitear en el worktree (\`git status\`): pueden ser trabajo a medias de la sesión anterior. Míralos antes de nada.`);
  }
  if (lastError) {
    parts.push('', `El intento anterior se detuvo con este error del tablero:\n> ${String(lastError).trim().replace(/\n/g, '\n> ')}`);
  }
  parts.push(
    '',
    'Tu trabajo ahora:',
    `1. Lee el diff completo (\`git diff origin/${base}...HEAD\` y \`git status\`) y compáralo con lo que pide el issue.`,
    '2. Si falta algo, termínalo, verifícalo con las comprobaciones del repositorio (formato, linter, tests) y **commitea sólo lo que falte** — un commit más, con formato Conventional Commits y "Closes #" como siempre.',
    '3. Si el trabajo ya está completo y verificado, **no hagas ningún commit** (ni vacío ni de retoque): di en tu respuesta final, con todas las letras, que el fix está completo y qué comprobaste. El tablero lo dará por hecho.',
    '4. Si el trabajo que hay está mal, corrígelo en un commit nuevo. Nunca reescribas la historia (ni amend, ni rebase, ni force).',
    '',
  );
  return parts.join('\n');
}
