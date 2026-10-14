/**
 * The shape of a pull request body, checked before it is published.
 *
 * Two things changed at once. The body used to be assembled by the board from
 * the issue and the commits; now an agent writes it, which is the only way it
 * can say what the change actually does — and also the only way it can drift.
 * And a body in this repository carries no media: screenshots and screen
 * recordings were tried and dropped, because they arrive as
 * `user-attachments` links that die with the upload, they cannot be reviewed
 * as text, and half of them were a GIF of a page loading.
 *
 * So this module checks the frame, not the prose: that the body opens with the
 * before/after section a reviewer reads first, that it closes its issue, that
 * it carries no images or video, and that its code fences are balanced — an
 * unterminated ```mermaid swallows the rest of the document into a grey box,
 * and the body looks fine in the editor that wrote it.
 *
 * Language is not checked here. `publishProblems` in language.js is the gate
 * for that, it runs downstream on everything published, and duplicating it
 * would mean two answers to the same question.
 *
 * The problems come back in Spanish even though the body is English: they are
 * read on the board's log and handed back to a session whose instructions are
 * Spanish.
 */

import { firstLineOf } from './firstline.js';

/** The section every body opens with. Exact text, so a reviewer finds it by eye. */
export const AT_A_GLANCE_HEADING = '## At a glance: before vs. after';

/** A markdown heading line, outside code. */
const HEADING = /^\s{0,3}#{1,6}\s/;

/** A fence line: three or more backticks, plus whatever info string follows. */
const FENCE = /^\s{0,3}(`{3,})(.*)$/;

/** The keywords GitHub accepts to close an issue from a body. */
const CLOSES = '(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))';

/** What a link has to end in before it is media rather than a reference. */
const MEDIA_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|mp4|mov|webm|m4v)\b/i;

/** What must never appear in a body here. */
const MEDIA = [
  { test: (t) => /!\[/.test(t), why: 'lleva una imagen en markdown (`![`)' },
  { test: (t) => /<video/i.test(t), why: 'lleva un `<video>`' },
  { test: (t) => /user-attachments/i.test(t), why: 'enlaza a `user-attachments`, que es un fichero subido a GitHub' },
  // A link to a file in a repository is a reference, not a screenshot: HL7
  // fixtures live there. Only the ones that render as media are a problem.
  { test: (t) => (t.match(/raw\.githubusercontent\S*/gi) ?? []).some((link) => MEDIA_FILE.test(link)), why: 'enlaza una imagen o un vídeo en `raw.githubusercontent`' },
];

/**
 * Reads a markdown document once: its headings, and whether a fence was left
 * open. Shared with planbrief.js, which needs the same two answers about a
 * different document and must not grow a second idea of what a heading is.
 *
 * Three things it gets right that a regex over the whole text does not:
 *
 * - HTML comments are blanked out first. `<!-- keep this -->` is how a PR
 *   template is written, and the headings inside one are not the document's.
 *   They are replaced line for line, so every index still points where it did.
 * - A `# build the image` inside a ```bash block is a shell comment.
 * - An opening fence cannot carry a backtick in its info string (CommonMark),
 *   so a line quoting ```` ```rust ```` inline does not open a block that then
 *   reads as never closed.
 */
export function scanMarkdown(raw) {
  const text = String(raw ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  const lines = text.split(/\r?\n/);
  const headings = [];
  let open = null;          // length of the backtick run that opened the fence

  lines.forEach((line, index) => {
    const fence = FENCE.exec(line);
    if (fence) {
      const ticks = fence[1].length;
      const info = fence[2];
      if (open === null) {
        if (!info.includes('`')) open = ticks;
      } else if (ticks >= open && !info.trim()) {
        // A closing fence is at least as long as the opening one and carries
        // no info string; anything else is a line of backticks inside code.
        open = null;
      }
      return;
    }
    if (open === null && HEADING.test(line)) headings.push({ title: line.trim(), index });
  });

  return { text, lines, headings, unclosed: open !== null };
}

/**
 * Why this body cannot be published, as a list of reasons. Empty means it may
 * go out.
 *
 * `issueNumber` is what the body must close. When it is missing or not a
 * number the check is skipped rather than guessed: the board knows the issue
 * of every task it publishes for, and a caller that does not is not in a
 * position to have the body rejected over it.
 */
export function prBodyProblems(body, issueNumber) {
  const problems = [];
  if (!String(body ?? '').trim()) return ['el cuerpo está vacío'];

  const { text, headings, unclosed } = scanMarkdown(body);
  const first = headings[0]?.title ?? null;

  if (first === null) {
    problems.push(`no tiene ninguna sección: el texto empieza por «${firstLineOf(body)}»`
      + ` y el cuerpo tiene que abrir con \`${AT_A_GLANCE_HEADING}\``);
  } else if (first !== AT_A_GLANCE_HEADING) {
    problems.push(`la primera cabecera es \`${first}\` y tiene que ser exactamente \`${AT_A_GLANCE_HEADING}\``);
  }

  const number = Number(issueNumber);
  if (Number.isInteger(number) && number > 0) {
    // GitHub reads the keyword without caring about case, and closes on
    // `Fixes` and `Resolves` too: rejecting those is a redraft that buys
    // nothing. What is checked is that the issue really gets closed.
    if (!new RegExp(`${CLOSES}\\s+#${number}(?!\\d)`, 'i').test(text)) {
      problems.push(`no dice \`Closes #${number}\`, así que el PR no cerrará la issue:`
        + ` añade una línea propia con exactamente \`Closes #${number}\` (al final del cuerpo, fuera de bloques de código)`);
    }
  }

  for (const { test, why } of MEDIA) {
    if (test(text)) problems.push(`${why}: el cuerpo de un PR aquí no lleva imágenes ni vídeo`);
  }

  if (unclosed) {
    problems.push('hay una valla de código ``` abierta y sin cerrar: el resto del cuerpo se traga en un bloque');
  }

  return problems;
}

/**
 * The body with a `Closes #N` line, appended when the body does not already
 * close that issue (any keyword GitHub accepts counts, exactly as in
 * `prBodyProblems`). A missing or non-numeric issue leaves the body alone.
 */
export function ensureClosesLine(body, issueNumber) {
  const original = String(body ?? '');
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number <= 0) return original;
  const { text } = scanMarkdown(original);
  if (new RegExp(`${CLOSES}\\s+#${number}(?!\\d)`, 'i').test(text)) return original;
  const trimmed = original.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}Closes #${number}\n`;
}

/** What to tell the agent so it fixes the body without rewriting the work. */
export function prBodyComplaint(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  return `\n\nEl cuerpo del PR que escribiste no sirve todavía: ${list.join('; ')}.`
    + ` Corrígelo y devuélvelo entero: abre con \`${AT_A_GLANCE_HEADING}\` (antes y después, en prosa),`
    + ' cierra todas las vallas de código, y nada de imágenes ni vídeos.'
    + ' No rehagas el trabajo ni toques el código: sólo el texto.';
}
