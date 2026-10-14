/**
 * The load-bearing phrases a rendered prompt may not lose, and the backstop
 * that puts them back.
 *
 * ## Why this exists
 *
 * The board is moving its knowledge of the watched project out of its own
 * templates and into the project's descriptor (`.board/project.md`, with the
 * `.hfs-monitor/project.md` fallback — see `project-context.js`). That file is
 * edited by the team that owns the repository, not by the board. So a Tuesday
 * where somebody over there tidies a paragraph away is a Tuesday where the
 * task running that night is briefed with a worse prompt, silently.
 *
 * This module is the net: a short, explicit list of what cannot be missing,
 * checked on every render, and **put back** when it is. When the descriptor
 * says everything, the net does nothing — it is inert by design. When a phrase
 * disappears, it acts and says so, through
 * `vars.onInvariantInjected({id, phrase, source})` in `renderPrompt`.
 *
 * ## Where things stand (2026-09-26)
 *
 * The move happened: the hfs literals left `triage.md`, `fix.md` and
 * `plan-task.md` on 2026-09-26, so these phrases now arrive — or do not —
 * from hfs's own descriptor. Nine of the ten are covered by the merged
 * descriptor and the net stays quiet for them. One is not, on purpose: see
 * «The one entry that injects on every render» below.
 *
 * ## Why here and not in the project registry
 *
 * The plan said the inventory would live with the registry entries. It cannot:
 * `normalize()` in `projects.js` rebuilds every entry field by field and
 * **drops in silence** anything it does not know about, so an `invariants` key
 * in `projects.json` would evaporate on the first load. A table in code is also
 * the honest place for it: these phrases are reviewed like code, in a diff,
 * not typed into a form.
 *
 * ## Per project AND per template
 *
 * The second half matters as much as the first. `cargo fmt --all` belongs to
 * `fix`, not to `triage`: a triage session neither builds nor formats. Without
 * the per-template split, `triage.md` would get a block of build rules it has
 * no use for, and the first thing the backstop would prove is that it cannot
 * be trusted.
 *
 * Only templates that carry `{{projectContext}}` can hold entries — `fix`,
 * `triage` and `plan-task` today. That is not a convention, it is where the
 * block is inserted: inside the value of that variable, never appended to the
 * end of a render. `prompt-invariants.test.mjs` checks the table against
 * `ALLOWED` so an entry for a template without the variable is caught there.
 *
 * ## `phrase` is the probe, `text` is the repair
 *
 * `phrase` is the shortest distinctive marker that says "this knowledge is
 * present" (`cargo fmt --all`). `text` is the full instruction that gets
 * injected when it is not. They are separate because a probe long enough to be
 * a good instruction is a probe that fires on a harmless rewording, and an
 * instruction short enough to be a good probe is not an instruction.
 *
 * ## `pattern`: two things a substring cannot do
 *
 * **One: tell an instruction from its opposite.** The hfs descriptor proves
 * it. One bullet of its rules both forbids `cargo fmt --all` from a worktree
 * and says CI enforces `cargo fmt --all -- --check` as a pre-merge check, so
 * the substring is there in both senses. Tidy the forbidding half away and a
 * substring probe would still find the command, call the phrase covered, put
 * nothing back — and the session would read a recommendation to run what blows
 * up on Windows in a worktree. A correct instruction turned into a dangerous
 * one, silently.
 *
 * **Two: recognise the same fact in other words.** These phrases were seeded
 * from Spanish templates; the descriptor is written in English by the team that
 * owns hfs. «workspace Rust» and «specs R6» are Spanish word order and no
 * English descriptor will ever contain them, so as substrings they would inject
 * on every single render, for ever, right next to a descriptor that already
 * says the thing. Those two entries therefore probe for the *fact*
 * ({@link RUST_WORKSPACE}, {@link R6_SPECS_DIRTY}) and not for the Spanish
 * sentence.
 *
 * So an entry may carry an optional `pattern` (a `RegExp`) that `phrase`
 * cannot express, and the rule it encodes is:
 *
 *   **covered ⇔ at least one NEGATED occurrence exists.**
 *
 * Not "no un-negated occurrence exists". That other rule would fire on every
 * hfs render, because the same descriptor bullet that forbids the command from
 * a worktree also names the CI check that runs it: every card's log would fill
 * with injections and the frozen baseline would move. A descriptor that
 * contradicts itself is fixed at the descriptor, not here.
 *
 * The asymmetry is deliberate and leans towards the false positive: a
 * duplicated line costs one line of prompt, a false negative costs a worktree.
 *
 * Patterns accept a *family* of wordings — a negation within
 * {@link NEGATION_WINDOW} characters, before or after — and never a literal
 * sentence. The descriptor is being rewritten in English by the team that owns
 * it; a probe tied to today's exact words would inject duplicates the day that
 * rewrite lands. {@link negatedNear} builds them so the three fragile entries
 * stay consistent.
 *
 * ## The one entry that injects on every render
 *
 * `hfs/plan-task/check-per-crate` — "verify what is yours with `cargo check -p
 * <crate>` and the one test" — has no equivalent in the merged descriptor. The
 * descriptor does say to verify in debug and lists `cargo check` among the
 * commands, but says nothing about scoping the check to the package you
 * touched, which in a 22-crate workspace is the whole point. So this one is
 * **accepted as a permanent injection**, at the cost of one line per
 * `plan-task` render and one log entry, rather than loosened into a probe that
 * a bare `cargo check` would satisfy: that probe would report the rule present
 * while the session read nothing about scope, which is exactly the failure the
 * polarity section above exists to prevent. The fix belongs upstream, in a rule
 * in hfs's descriptor; the day it lands, this entry goes quiet on its own with
 * no change here.
 *
 * This module is pure: it imports only `keys.js`, touches no disk and holds no
 * state. `prompts.js` can therefore import it without any test that renders a
 * prompt having to isolate its data directory (`data-dir.test.mjs`).
 *
 * @module prompt-invariants
 */

import { DEFAULT_PROJECT_ID } from './keys.js';

/**
 * One load-bearing phrase.
 *
 * @typedef {Object} Invariant
 * @property {string} id     unique across the whole table; what the log line and the callback report.
 * @property {string} phrase the exact substring looked for in the rendered prompt.
 * @property {string} source where the phrase came from, verbatim — a file and line, or a document.
 * @property {string} [text] what gets injected when `phrase` is missing; defaults to `phrase`.
 * @property {RegExp} [pattern] the real probe when a substring cannot tell the instruction from
 *   its opposite. Used INSTEAD of `phrase`, which stays a string because `prompts.js` reports it.
 *   No `g`/`y` flags, and it must match its own repair text — `validateInvariants` checks both.
 */

/**
 * How far from the phrase a negation still counts, in characters.
 *
 * Wide enough for the phrase and its negation to sit on two wrapped lines of a
 * Markdown bullet, narrow enough that the negation of a *different* sentence
 * does not bleed into this one.
 *
 * @type {number}
 */
export const NEGATION_WINDOW = 60;

/** Words that negate what follows them. */
const NEGATION_BEFORE = "never|nunca|do not|don['’]t|no uses|sin";

/** Words that say the thing before them goes wrong. */
const NEGATION_AFTER = 'fails|breaks|revienta';

/** Regex-literal escaping, so a phrase can hold `-`, `*`, `(` or `.` unharmed. */
const escapeRe = (literal) => String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A probe that only matches a NEGATED occurrence of `phrase`.
 *
 * Either a negation word within {@link NEGATION_WINDOW} characters before it,
 * or a "this breaks" word that close after it. The window spans newlines on
 * purpose: these phrases live in wrapped Markdown bullets.
 *
 * Case-insensitive (`NEVER`, `Never` and `never` are the same instruction) and
 * deliberately NOT global: see {@link validateInvariants}.
 *
 * @param {string} phrase the literal command or fragment, escaped here.
 * @returns {RegExp}
 */
export function negatedNear(phrase) {
  const lit = escapeRe(phrase);
  const near = `[\\s\\S]{0,${NEGATION_WINDOW}}`;
  return new RegExp(
    `\\b(?:${NEGATION_BEFORE})\\b${near}${lit}|${lit}${near}\\b(?:${NEGATION_AFTER})\\b`,
    'i',
  );
}

/**
 * "This is a Rust workspace, and its unit of work is the crate."
 *
 * The probe for `hfs/triage/rust-workspace`. `triage.md:1` used to say it in
 * Spanish («workspace Rust de 22 crates: …»), a string an English descriptor
 * cannot contain. What the descriptor does carry, in its Derived section, are
 * the structural markers of a Cargo workspace — `cargo metadata`,
 * `[workspace]` → `default-members` — plus the two words in prose, in either
 * order. Any of them tells the triage session what kind of repository it is
 * looking at, which is all this entry is about. The crate list and the crate
 * count deliberately are not: both have drifted before (hfs's own `CLAUDE.md`
 * says so), and a repair text carrying a stale count is worse than no repair.
 *
 * @type {RegExp}
 */
const RUST_WORKSPACE = /cargo metadata|\[workspace\]|\bRust\b[\s\S]{0,60}\bworkspace\b|\bworkspace\b[\s\S]{0,60}\bRust\b/i;

/**
 * "Compiling leaves thousands of R6 spec files dirty without editing them."
 *
 * The probe for `hfs/fix/r6-specs-dirty`, for the same reason as
 * {@link RUST_WORKSPACE}: the seeded phrase «specs R6» is Spanish word order
 * and the descriptor says "~3,500 R6 spec files `stat`-dirty". Either order
 * counts, and a dirt word (`stat`, `dirty`, `sucio`) has to sit close by,
 * because "R6 spec" on its own can be written for any other reason — the trap
 * is the dirt, not the files.
 *
 * @type {RegExp}
 */
const R6_SPECS_DIRTY = /\b(?:R6[\s\S]{0,30}specs?|specs?[\s\S]{0,30}R6)\b[\s\S]{0,80}(?:dirty|sucio|stat)/i;

/**
 * The inventory: project id -> template name -> entries.
 *
 * A plain mutable object on purpose. These are data, and a test that has to
 * prove the backstop *fires* needs a project whose render is missing something
 * — which, for hfs today, no real template is. `prompt-invariants.test.mjs`
 * adds a synthetic project here and removes it again.
 *
 * The hfs entries were seeded from the templates as they read *before*
 * 2026-09-26, while those lines still carried the hfs literals. They are gone
 * from the templates now, so each `source` cites both where the phrase came
 * from and where it is meant to come from today.
 *
 * @type {Record<string, Record<string, Invariant[]>>}
 */
export const PROMPT_INVARIANTS = {
  hfs: {
    triage: [
      {
        id: 'hfs/triage/rust-workspace',
        phrase: 'workspace Rust',
        pattern: RUST_WORKSPACE,
        source: 'server/prompts/triage.md:1 (hasta 2026-09-26) y `.hfs-monitor/project.md` de hfs → «Derived»',
        text: 'Este repositorio es un workspace de crates de Rust: la unidad de trabajo es el '
          + 'crate, así que estimar la complejidad es, sobre todo, decir qué crates toca el '
          + 'issue. Cuántos hay y cómo se llaman se cuenta en el repositorio, no se copia de aquí.',
      },
    ],
    fix: [
      {
        id: 'hfs/fix/repo-skills',
        phrase: '/test-hfs',
        source: 'server/prompts/fix.md:11 (hasta 2026-09-26) y `.hfs-monitor/project.md` → «Rules»',
        text: 'Respeta el `CLAUDE.md` del repositorio y usa sus skills (`/work-with-ui`, '
          + '`/work-with-hts`, `/test-hfs`…) cuando apliquen.',
      },
      {
        id: 'hfs/fix/fmt-per-crate',
        phrase: 'cargo fmt -p',
        source: 'server/prompts/fix.md:12 (hasta 2026-09-26) y `.hfs-monitor/project.md` → «Rules»',
        text: 'Formatea por crate: `cargo fmt -p <crate>` por cada crate que hayas tocado.',
      },
      {
        id: 'hfs/fix/never-fmt-all',
        phrase: 'cargo fmt --all',
        // The descriptor's own bullet names this command as the pre-merge check
        // CI enforces, right after forbidding it from a worktree, so the
        // substring is present in both senses on every hfs render. Only a
        // negated occurrence counts as coverage here.
        pattern: negatedNear('cargo fmt --all'),
        source: 'server/prompts/fix.md:12 (hasta 2026-09-26) y `CLAUDE.md` de hfs, «Windows and worktree notes»',
        text: 'NUNCA `cargo fmt --all` desde un worktree: revienta en Windows con '
          + '«filename or extension is too long».',
      },
      {
        id: 'hfs/fix/debug-not-release',
        phrase: '--release',
        // `--release` is a flag, not an instruction: any future sentence that
        // mentions it in any sense — a release profile someone documents, a
        // benchmark recipe — would switch this probe off. The instruction is
        // "do not use it", so that is what the probe looks for.
        pattern: negatedNear('--release'),
        source: 'server/prompts/fix.md:14 (hasta 2026-09-26) y `.hfs-monitor/project.md` → «Rules»',
        text: 'Compila en DEBUG, como el resto del proyecto y como CI (`cargo test`, '
          + '`cargo clippy`, `cargo build` sin `--release`). `--release` tarda mucho más y no '
          + 'aporta nada aquí.',
      },
      {
        id: 'hfs/fix/r6-specs-dirty',
        phrase: 'specs R6',
        // Spanish word order: the descriptor says "R6 spec files `stat`-dirty".
        pattern: R6_SPECS_DIRTY,
        source: 'server/prompts/fix.md:15 (hasta 2026-09-26) y `CLAUDE.md` de hfs, «Windows and worktree notes»',
        text: 'Trampa conocida: compilar deja ~3.500 ficheros de specs R6 sucios solo en stat '
          + '(el `git diff` sale vacío). Por eso el staging explícito.',
      },
      {
        id: 'hfs/fix/nul-trap',
        phrase: '> nul',
        // Still in the template, unlike the rest: the rule is about Windows and
        // bash, not about hfs, and `parallel.test.mjs` pins the seam it sits
        // in. Only the two hfs ticket numbers left the line.
        source: 'server/prompts/fix.md:16 (issues #942 y #969 de hfs)',
        text: 'Para descartar salida usa `/dev/null`, NUNCA `> nul`: aquí el shell es bash, así '
          + 'que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree '
          + 'y que después impide borrarlo (pasó en #942 y #969).',
      },
      {
        id: 'hfs/fix/explicit-staging',
        phrase: 'git add -A',
        // Covered twice today, and one of them is luck: `project.md:53` says
        // "never `git add -A`", which is benign — but a tidy-up that turned it
        // into a plain mention of the command would keep the substring and
        // lose the rule. Same shape as the two above, same probe.
        pattern: negatedNear('git add -A'),
        source: 'server/prompts/fix.md:20 (hasta 2026-09-26) y `.hfs-monitor/project.md` → «Rules»',
        text: 'Stagea SOLO tus paths explícitos: nunca `git add -A` ni `git commit -a`, por lo de '
          + 'los specs R6.',
      },
    ],
    'plan-task': [
      {
        // The one entry with no home in the descriptor: it injects on every
        // plan-task render, on purpose. See the module doc, «The one entry that
        // injects on every render».
        id: 'hfs/plan-task/check-per-crate',
        phrase: 'cargo check -p',
        source: 'server/prompts/plan-task.md:11 (hasta 2026-09-26); no está en `.hfs-monitor/project.md`',
        text: 'Verifica lo tuyo con lo que sea rápido y tuyo: `cargo check -p <crate>` y el test '
          + 'concreto. Compila en debug, como CI.',
      },
      {
        id: 'hfs/plan-task/nul-trap',
        phrase: '> nul',
        source: 'server/prompts/plan-task.md:12 (issues #942 y #969 de hfs)',
        text: 'Para descartar salida usa `/dev/null`, nunca `> nul`: el shell es bash y `nul` '
          + 'quedaría como un fichero que impide borrar el worktree.',
      },
    ],
  },
};

/**
 * The heading of the injected block.
 *
 * It says who wrote it and why, because the session reading it has to be able
 * to tell this apart from what the project itself contributed — and because a
 * block of instructions with no provenance is exactly the kind of thing an
 * agent learns to ignore.
 *
 * @type {string}
 */
export const BACKSTOP_HEADING =
  'El tablero repone estas instrucciones porque no aparecen en el contexto que aporta el proyecto:';

/** CRLF to LF. The templates are checked out with CRLF on Windows and LF on the runner. */
const lf = (text) => String(text).replace(/\r\n/g, '\n');

/** What an entry injects: its `text`, or the probe itself when it has none. */
export const invariantText = (entry) => (entry.text === undefined ? entry.phrase : entry.text);

/**
 * The entries declared for one (project, template) pair.
 *
 * Unknown project or unknown template answer `[]`: a project with no inventory
 * yet — app-b, on its first day — must render exactly as it does now.
 *
 * @param {string} [projectId] absent or `undefined` means {@link DEFAULT_PROJECT_ID}.
 * @param {string} template the template name, as in `ALLOWED`.
 * @returns {Invariant[]} in declaration order; empty when there is nothing to check.
 */
export function invariantsFor(projectId, template) {
  const id = projectId === undefined || projectId === null ? DEFAULT_PROJECT_ID : projectId;
  const byTemplate = PROMPT_INVARIANTS[id];
  if (!byTemplate) return [];
  const entries = byTemplate[template];
  return Array.isArray(entries) ? entries : [];
}

/**
 * The entries whose phrase is **not** in the rendered text.
 *
 * Checked against the FULL RENDERED PROMPT, never against the descriptor
 * alone. The descriptor of hfs is 55 lines that *cite* `CLAUDE.md` instead of
 * copying its traps, so a check against it would report every phrase missing
 * and inject a block duplicating what `fix.md` already says. What matters is
 * whether the session ends up reading the phrase, no matter which half of the
 * prompt it came from.
 *
 * Matching is an exact substring after normalising line endings; every phrase
 * in the table is therefore kept on a single line. An entry that carries a
 * `pattern` is matched with it INSTEAD of the substring, because for that
 * entry the substring cannot tell the instruction from its opposite — see the
 * `pattern` section at the top of this file.
 *
 * @param {string} rendered the whole rendered prompt.
 * @param {{projectId?: string, template: string}} where
 * @returns {Invariant[]} the missing entries, in declaration order.
 */
export function missingInvariants(rendered, { projectId, template } = {}) {
  const entries = invariantsFor(projectId, template);
  if (!entries.length) return [];
  const text = lf(rendered);
  return entries.filter((entry) => (entry.pattern
    ? !entry.pattern.test(text)
    : !text.includes(lf(entry.phrase))));
}

/**
 * The block that goes back into the prompt, or `''` for no entries.
 *
 * Ends with a newline and begins with a blank line: it is spliced into the
 * value of `{{projectContext}}`, whose own text ends wherever the descriptor
 * ended, and the two must not run together.
 *
 * @param {Invariant[]} entries
 * @returns {string}
 */
export function backstopBlock(entries) {
  if (!entries || !entries.length) return '';
  const lines = entries.map((entry) => `- ${invariantText(entry)}`);
  return `\n${BACKSTOP_HEADING}\n${lines.join('\n')}\n`;
}

/**
 * Checks the table's own shape. Called once at import, so a malformed entry is
 * a crash at boot and not a phrase that quietly never fires.
 *
 * @param {Record<string, Record<string, Invariant[]>>} [table]
 * @returns {number} how many entries were checked.
 * @throws {Error} on a duplicate id, a missing/empty `id`, `phrase` or `source`, or a
 *   `pattern` that is not a flagless-enough `RegExp` or does not match its own repair text.
 */
export function validateInvariants(table = PROMPT_INVARIANTS) {
  const seen = new Set();
  let count = 0;
  for (const [projectId, byTemplate] of Object.entries(table)) {
    if (!byTemplate || typeof byTemplate !== 'object') {
      throw new Error(`prompt-invariants: ${projectId} debe ser un objeto por plantilla`);
    }
    for (const [template, entries] of Object.entries(byTemplate)) {
      if (!Array.isArray(entries)) {
        throw new Error(`prompt-invariants: ${projectId}.${template} debe ser un array`);
      }
      for (const entry of entries) {
        const where = `${projectId}.${template}`;
        for (const field of ['id', 'phrase', 'source']) {
          if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
            throw new Error(`prompt-invariants: ${where}: falta '${field}' en ${JSON.stringify(entry ?? null)}`);
          }
        }
        if (entry.text !== undefined && (typeof entry.text !== 'string' || !entry.text.trim())) {
          throw new Error(`prompt-invariants: ${entry.id}: 'text' debe ser una cadena no vacía`);
        }
        if (entry.phrase.includes('\n')) {
          throw new Error(`prompt-invariants: ${entry.id}: la frase no puede ocupar dos líneas`);
        }
        if (entry.pattern !== undefined) {
          if (!(entry.pattern instanceof RegExp)) {
            throw new Error(`prompt-invariants: ${entry.id}: 'pattern' debe ser una RegExp`);
          }
          // `.test()` on a `g`/`y` regex advances `lastIndex`, so the same
          // probe over the same prompt would answer differently on the second
          // render. Same trap as `COMPUTED_IMPORT` in `data-dir.test.mjs`.
          if (entry.pattern.global || entry.pattern.sticky) {
            throw new Error(`prompt-invariants: ${entry.id}: 'pattern' no puede llevar las banderas `
              + "'g' ni 'y': su `lastIndex` haría que la misma sonda respondiera distinto en cada llamada");
          }
          // The repair has to close the hole it claims to close: a block that
          // does not satisfy its own probe would be injected on every render,
          // for ever, without ever covering the phrase.
          if (!entry.pattern.test(invariantText(entry))) {
            throw new Error(`prompt-invariants: ${entry.id}: el texto que repone no satisface su propia `
              + `sonda ${entry.pattern}: repondría un bloque que no tapa el hueco`);
          }
        }
        if (seen.has(entry.id)) {
          throw new Error(`prompt-invariants: id repetido: ${entry.id}`);
        }
        seen.add(entry.id);
        count += 1;
      }
    }
  }
  return count;
}

validateInvariants();
