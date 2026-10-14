/**
 * The gate every piece of text crosses before it reaches GitHub.
 *
 * Asking the prompt for English is not a guarantee: an agent reading Spanish
 * instructions, fixing a Spanish-written task, drifts back into Spanish without
 * noticing — and by then the comment is public. So the rule lives at the wire
 * instead: the publishing helpers in github.js refuse text that does not pass,
 * which means a future caller cannot bypass the check by adding one more `gh`
 * command. The prompt still asks for English; this is what makes it true.
 *
 * The check is deliberately conservative. A false positive costs one redraft;
 * a false negative is a Spanish comment on a public PR that a reviewer reads
 * before anyone notices.
 */

/** Spanish-only glyphs. Any of these outside code is decisive on its own. */
const GLYPHS = /[¿¡ñÑ]/;
const ACCENTED = /[áéíóúÁÉÍÓÚ]/g;

/**
 * English borrowings that legitimately carry an accent, so the accent rule
 * does not trip over them.
 */
// Unicode boundaries, not `\b`: JavaScript's word boundary is defined on
// [A-Za-z0-9_], so it never fires next to the very accents this list is about
// — `\bcaf[ée]\b` does not match "café".
const LOANWORDS = /(?<!\p{L})(caf[ée]|r[ée]sum[ée]|clich[ée]|na[ïi]ve|fa[çc]ade|expos[ée]|jalape[ñn]o|pi[ñn]ata|d[ée]j[àa]|voil[àa])(?!\p{L})/giu;

/**
 * Spanish function words that never appear as standalone lowercase words in
 * English prose. The obvious ones are missing on purpose: `todo` and `todos`
 * are everyday English in code, `son`, `era`, `has`, `hay`, `solo`, `con`,
 * `sin` and `no` are English words too, and `sin`/`cos` show up in maths. Each
 * of those would fire on perfectly good English.
 */
const WORDS = new Set([
  'que', 'para', 'porque', 'pero', 'como', 'cuando', 'donde', 'desde', 'hasta',
  'aunque', 'entre', 'sobre', 'segun', 'según', 'tras', 'ante', 'cada', 'esto',
  'esta', 'este', 'esos', 'esas', 'ese', 'esa', 'ellos', 'ellas', 'ella',
  'los', 'las', 'del', 'una', 'unos', 'unas', 'por', 'muy', 'mas', 'más',
  'hemos', 'hace', 'hizo', 'fue', 'fueron', 'estan', 'están', 'está',
  'tiene', 'tienen', 'puede', 'pueden', 'debe', 'deben', 'hacer', 'hecho',
  'cambio', 'cambios', 'archivo', 'archivos', 'revision', 'revisión',
  'comentario', 'comentarios', 'respuesta', 'codigo', 'código', 'linea',
  'línea', 'ahora', 'tambien', 'también', 'ademas', 'además', 'asi', 'así',
  'mismo', 'misma', 'ninguno', 'ningun', 'algun', 'alguna', 'nuestro',
  'nuestra', 'siempre', 'nunca', 'segunda', 'segundo', 'primera', 'primero',
]);

// A review reply is a paragraph or two; a PR body is a document. The caller
// says which it is, and the default is the strict one.
const MAX_CHARS = 4000;

/**
 * Quoted strings are quotations, not the author's own sentences: a PR body that
 * says the button now reads "Iniciar app" is describing a Spanish UI string, not
 * written in Spanish. One line at most, so a stray quote cannot swallow the rest
 * of the document. A straight single quote only counts when it is not an
 * apostrophe (`don't`, `the user's`): it must open after a non-letter and close
 * before one. Callers that hand over raw source where the quotes ARE the prose
 * (a GraphQL mutation, `body: "..."`) pass `keepQuotes`.
 */
// Only spans of at most 80 characters are exempt: a UI string is short, a whole
// quoted Spanish sentence is prose and must still be caught.
const stripQuotes = (text) => text
  .replace(/"[^"\n]{0,80}"/g, ' ')
  .replace(/[“”„][^“”„\n]{0,80}[“”]/g, ' ')
  .replace(/[‘‚][^‘’‚\n]{0,80}’/g, ' ')
  .replace(/«[^«»\n]{0,80}»/g, ' ')
  .replace(/(?<![\p{L}\p{N}])'[^'\n]{0,80}'(?![\p{L}\p{N}])/gu, ' ');

/**
 * Removes what is not prose: code, URLs, paths and handles. A reply about
 * `crates/rest/src/config.rs` is not Spanish because a path contains `del`,
 * and a fenced Rust block is not prose at all.
 */
function prose(text, { keepQuotes = false } = {}) {
  return (keepQuotes ? text : stripQuotes(text))
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/`[^`\n]*`/g, ' ')               // inline code
    .replace(/https?:\/\/\S+/g, ' ')          // links
    .replace(/\b[\w.-]+\/[\w./-]+/g, ' ')     // paths: a/b/c.rs
    .replace(/\b[\w-]+\.(rs|js|jsx|md|toml|json|sh|ps1|yml|yaml|py|sql)\b/gi, ' ')
    .replace(/[@#][\w-]+/g, ' ');             // @handles, #942
}

/** `en`, `en-US`, `EN`; an unset language means English, the historical rule. */
const isEnglish = (language) => {
  const code = String(language ?? '').trim().toLowerCase();
  return code === '' || code === 'en' || code.startsWith('en-') || code.startsWith('en_');
};

/**
 * Why this text must not be published, as a list of human-readable reasons.
 * Empty means it may go out.
 */
export function publishProblems(text, { maxChars = MAX_CHARS, language = 'en', keepQuotes = false } = {}) {
  const problems = [];
  const raw = String(text ?? '');

  if (!raw.trim()) problems.push('el texto está vacío');
  if (raw.length > maxChars) problems.push(`el texto supera ${maxChars} caracteres (${raw.length})`);

  // The accent and stopword heuristics only make sense for English prose. A
  // project written in another language is not held to them; the structural
  // checks above still apply to everyone.
  if (!isEnglish(language)) return problems;

  const clean = prose(raw, { keepQuotes }).replace(LOANWORDS, ' ');

  if (GLYPHS.test(clean)) {
    problems.push(`contiene caracteres que solo existen en español: ${[...new Set(clean.match(/[¿¡ñÑ]/g))].join(' ')}`);
  }

  const accents = [...new Set(clean.match(ACCENTED) ?? [])];
  if (accents.length) problems.push(`contiene vocales acentuadas: ${accents.join(' ')}`);

  // One Spanish-looking word can be a name or a quoted identifier; two is a
  // sentence, and a sentence is what we are guarding against.
  const hits = [...new Set(
    (clean.toLowerCase().match(/[a-záéíóúñü]+/g) ?? []).filter((w) => WORDS.has(w)),
  )];
  if (hits.length >= 2) problems.push(`parece español: ${hits.slice(0, 6).join(', ')}`);

  return problems;
}

export const isPublishable = (text, opts) => publishProblems(text, opts).length === 0;

/**
 * Throws unless the text may be published. `what` names the piece so the error
 * reads on the board's log without having to guess which comment failed.
 */
export function assertPublishable(text, what = 'el texto', opts) {
  const problems = publishProblems(text, opts);
  if (problems.length) {
    throw new Error(`No se publica ${what}: ${problems.join('; ')}`);
  }
  return String(text);
}
