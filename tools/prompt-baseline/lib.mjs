/**
 * The frozen baseline of every prompt this board renders.
 *
 * Why it exists: a second watched project is coming, and with it a
 * `{{projectContext}}` block in `server/prompts/`. Before those templates are
 * touched, the text they produce today has to be written down, so that
 * afterwards it can be shown that the hfs prompt is byte-for-byte what it was
 * except for the inserted block. This module only renders, hashes and
 * normalises — it changes no behaviour and owns no CLI.
 *
 * Three rules shape everything here:
 *
 * 1. **Never reach a writer.** `store.js`, `quota.js`, `settings.js` and
 *    `upgrade.js` rewrite the live board the moment they are imported.
 *    `server/test/data-dir.test.mjs` walks the import graph and says so. Only
 *    `prompts.js` and the contract modules are imported, and none of them wake
 *    a writer. No computed `import()` either: the analyser cannot follow one
 *    and treats it as an offender.
 * 2. **Normalise line endings before hashing.** `git ls-files --eol` reports
 *    `i/lf w/crlf` for the templates: this laptop reads them with CRLF, the
 *    Linux runner with LF. Everything is normalised to `\n` before it is
 *    hashed, written or compared — including the sample text read back from
 *    the fixture, which suffers the same `autocrlf` on checkout.
 * 3. **The fixture is self-contained.** Nothing here reads
 *    `server/data/tasks.json`; only the `freeze` command of `baseline.mjs`
 *    does, once (or `freeze --from-fixture`, which reuses the fixture's own
 *    task list and reads no store at all). That file is gitignored, 44 MB, grows with every poll and is
 *    a different file on the runner.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED, renderPrompt } from '../../server/src/prompts.js';
import { PARALLEL_BLOCK, PARALLEL_CORE, COLLECT_RULE } from '../../server/src/parallel.js';
import { workPlanContract } from '../../server/src/workplan.js';
import { qaPlanContract, qaResultsContract } from '../../server/src/qa.js';
import { planBriefContract } from '../../server/src/planbrief.js';
import {
  PROCESS_RULE,
  processRuleFor,
  shellRuleFor,
  tmpRuleFor,
  GITHUB_LANGUAGE_RULE,
  GITHUB_PUBLISH_RULE,
} from '../../server/src/rules.js';

// Derived from this file's own location, never from `process.cwd()`: the CLI
// and the test are run from different directories. Same pattern as
// `tools/decisions/extract.mjs`.
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const FIXTURE_DIR = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'prompt-baseline');
export const BASELINE_FILE = path.join(FIXTURE_DIR, 'baseline.json');
export const SAMPLES_DIR = path.join(FIXTURE_DIR, 'samples');
export const CONTRACTS_DIR = path.join(FIXTURE_DIR, 'contracts');

/**
 * Every template, in `ALLOWED` order. Taken whole and without judgement: when
 * this was frozen only nine templates carried hfs literals in the file, but the
 * coupling reached almost all of them through the injected text — `parallel.js`
 * ("Reparte por archivo o por módulo", "por crate" until 2026-09-26) rides in
 * every template that uses `{{parallel}}`, `workplan.js` in the five with
 * `{{workPlan}}`, `planbrief.js` in the three with `{{planBrief}}`.
 *
 * Both halves lost those literals on 2026-09-26 — `9ebff62` the templates,
 * `40e2357` the contracts the board injects — and the baseline was refrozen
 * once over the whole wave (`cd4f69e`). Freezing every template rather than the
 * nine is what made that diff readable: the change showed up in the twelve
 * renders it actually reached.
 */
export const TEMPLATES = Object.keys(ALLOWED);

/**
 * `ALLOWED` as it goes into the fixture, in iteration order. Frozen too: a
 * variable added to a template is a change to the prompt's contract even when
 * the rendered text happens to stay the same.
 */
export const ALLOWED_SNAPSHOT = Object.fromEntries(TEMPLATES.map((name) => [name, [...ALLOWED[name]]]));

/**
 * The names `prompts.js` fills in by itself.
 *
 * Hand-copied from the keys of `AUTOMATIC` in `server/src/prompts.js` (the
 * object is a module-level `const` and is deliberately not exported). **Keep
 * this list in step with that one**: a name added there and forgotten here
 * turns into a sentinel and the frozen text moves for no reason.
 *
 * Deducing it by catching the "Faltan variables" error from
 * `renderPrompt` would be worse: that error only lists what is missing from a
 * particular template, so the list would depend on which templates exist.
 */
export const AUTOMATIC_NAMES = [
  'parallel',
  'workPlan',
  'qaPlan',
  'qaResults',
  'processRule',
  'planBrief',
  'githubRule',
  'githubPublishRule',
  'handoff',
  'machineNote',
  'triageSummary',
  'qaSection',
  'previousAttempt',
  'carriedNote',
  'shellRule',
  'tmpRule',
  // Composed inside `renderPrompt`, like `projectContext`: `e2eRule` from the
  // caller's `e2ePortEnv` (see `varsFor`), `qaAvailable` from a boolean that
  // defaults to «QA available» (empty).
  'e2eRule',
  'qaAvailable',
  // Not a key of `AUTOMATIC` — it cannot be, because that object is built once
  // at import and the descriptor has to reload hot. `renderPrompt` fills it in
  // by itself all the same (`prompts.js`, in the body of `renderPrompt`), which
  // is what this list is for: a name here is a name no caller has to pass, so
  // `sentinelNames` leaves it alone and `EXTRA_SENTINELS` decides its value.
  'projectContext',
];

/**
 * The only four values that come straight off a task, untransformed. Verified
 * against `pipeline.js:1984-1987` and its siblings. Everything else a phase
 * passes is composed in code (a diff, a plan, a GitHub body) and gets a
 * sentinel instead.
 */
export const TASK_VAR_NAMES = ['issueNumber', 'issueTitle', 'issueLabels', 'branch'];

/**
 * Names forced to a sentinel although `prompts.js` fills them in by itself.
 *
 * `renderPrompt` only checks the variables a template is *missing*; extra ones
 * are ignored (`prompts.js:201`), so this costs nothing now. It bought the
 * diff it was meant to buy: `{{projectContext}}` landed in `triage`, `fix` and
 * `plan-task`, and its value comes from the `project.md` of the watched
 * checkout (`.hfs-monitor/project.md` in hfs), a file that team edits, plus
 * whatever `prompt-invariants.js` puts back. Baking that text into the fixture
 * would turn this test red every time somebody over there saved a paragraph.
 * With the sentinel in from the start, the diff read exactly "identical except
 * `<<projectContext>>` inserted".
 */
export const EXTRA_SENTINELS = ['projectContext'];

/**
 * Names `dump --real` lets through with their live value instead of a
 * sentinel, so a human can eyeball the real injected block.
 */
export const LIVE_IN_DUMP = ['projectContext'];

/** How a task with no branch, and every composed value, is stood in for. */
export const sentinel = (name) => `<<${name}>>`;

/** CRLF to LF. Applied before hashing, before writing and after reading. */
export const normalize = (text) => String(text).replace(/\r\n/g, '\n');

/** SHA-256, hex, over the UTF-8 bytes of the already normalised text. */
export const hashText = (text) => createHash('sha256').update(normalize(text), 'utf8').digest('hex');

/** The four fields of a task the baseline freezes. No `body`: it is not there. */
export function taskEntry(task) {
  return {
    issue: Number(task.issue),
    title: String(task.title ?? ''),
    labels: Array.isArray(task.labels) ? task.labels.map(String) : [],
    branch: task.branch ?? null,
  };
}

/** Tasks by ascending issue number: the fixed iteration order of everything here. */
export function sortedEntries(entries) {
  return [...entries].sort((a, b) => a.issue - b.issue);
}

/**
 * The frozen tasks of a `baseline.json` (`tasks`), as `freeze --from-fixture`
 * re-renders them. Same filter as the live path: no issue number, no entry; and
 * an empty list throws, so a damaged fixture cannot freeze nothing.
 */
export function fixtureEntries(tasks) {
  const entries = Object.values(tasks ?? {}).map(taskEntry).filter((t) => Number.isFinite(t.issue));
  if (!entries.length) throw new Error('el fixture no trae ninguna tarea con número de issue');
  return sortedEntries(entries);
}

/** The variables of a template that have no real value and take a sentinel. */
export function sentinelNames(template) {
  const allowed = ALLOWED[template];
  if (!allowed) throw new Error(`Plantilla desconocida: ${template}`);
  return allowed.filter((v) => !AUTOMATIC_NAMES.includes(v) && !TASK_VAR_NAMES.includes(v));
}

/**
 * The variable bag for one (template, task) pair. `live` names the variables
 * that must keep their real value instead of a sentinel — only `dump --real`
 * passes anything.
 */
export function varsFor(entry, template, { live = [] } = {}) {
  const vars = {
    issueNumber: entry.issue,
    issueTitle: entry.title,
    issueLabels: entry.labels.join(', ') || '(ninguno)',
    branch: entry.branch ?? sentinel('branch'),
  };
  for (const name of sentinelNames(template)) vars[name] = sentinel(name);
  // `e2eRule` is derived from this one inside `renderPrompt`; `fix` no longer
  // lists it in `ALLOWED`, so it would not get a sentinel by itself.
  if (ALLOWED[template]?.includes('e2eRule')) vars.e2ePortEnv = sentinel('e2ePortEnv');
  for (const name of EXTRA_SENTINELS) {
    if (!live.includes(name)) vars[name] = sentinel(name);
  }
  return vars;
}

/** One rendered prompt, normalised. The single place the baseline is produced. */
export function renderFor(entry, template, options = {}) {
  return normalize(renderPrompt(template, varsFor(entry, template, options)));
}

/**
 * How the three sample tasks are chosen. Written into `baseline.json` so a
 * later `freeze` on another machine, with a different `tasks.json`, picks by
 * the same rule instead of by whatever happened to be first.
 */
export const SAMPLE_RULE = 'la tarea de menor `issue`, la de mayor `issue`, y la de menor `issue` '
  + 'con `labels` no vacías y `branch` no nulo (sin repetir)';

/** Applies `SAMPLE_RULE`. Returns issue numbers, ascending, at most three. */
export function sampleIssues(entries) {
  const sorted = sortedEntries(entries);
  if (!sorted.length) return [];
  const rich = sorted.find((t) => t.labels.length > 0 && t.branch !== null);
  const picked = [sorted[0].issue, sorted[sorted.length - 1].issue];
  if (rich) picked.push(rich.issue);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/**
 * The strings the pipeline injects by calling these functions itself (sixteen
 * today), with arguments that the `AUTOMATIC` defaults do not reproduce.
 * Freezing them covers what the runner actually sees without rendering every
 * template for every task twice.
 *
 * The two `workPlanContract` subjects are copied verbatim from
 * `pipeline.js:1989` and `pipeline.js:3394`.
 */
export const CONTRACTS = [
  { name: 'parallel-block', call: 'PARALLEL_BLOCK', text: PARALLEL_BLOCK },
  { name: 'parallel-core', call: 'PARALLEL_CORE', text: PARALLEL_CORE },
  { name: 'collect-rule', call: 'COLLECT_RULE', text: COLLECT_RULE },
  { name: 'work-plan-default', call: 'workPlanContract()', text: workPlanContract() },
  {
    name: 'work-plan-triage',
    call: "workPlanContract('el trabajo que hará falta para resolver este issue, tal y como lo ves ahora')",
    text: workPlanContract('el trabajo que hará falta para resolver este issue, tal y como lo ves ahora'),
  },
  {
    name: 'work-plan-demo',
    call: "workPlanContract('las comprobaciones que hiciste para escribir estos pasos')",
    text: workPlanContract('las comprobaciones que hiciste para escribir estos pasos'),
  },
  { name: 'qa-plan-default', call: 'qaPlanContract()', text: qaPlanContract() },
  {
    name: 'qa-plan-continuity',
    call: 'qaPlanContract(undefined, { continuity: true })',
    text: qaPlanContract(undefined, { continuity: true }),
  },
  { name: 'qa-results', call: 'qaResultsContract()', text: qaResultsContract() },
  { name: 'plan-brief', call: 'planBriefContract()', text: planBriefContract() },
  { name: 'process-rule', call: 'PROCESS_RULE', text: PROCESS_RULE },
  { name: 'process-rule-runner', call: "processRuleFor({ kind: 'runner' })", text: processRuleFor({ kind: 'runner' }) },
  { name: 'shell-rule-win32', call: "shellRuleFor({ platform: 'win32' })", text: shellRuleFor({ platform: 'win32' }) },
  { name: 'tmp-rule-runner', call: "tmpRuleFor({ kind: 'runner' })", text: tmpRuleFor({ kind: 'runner' }) },
  { name: 'github-language-rule', call: 'GITHUB_LANGUAGE_RULE', text: GITHUB_LANGUAGE_RULE },
  { name: 'github-publish-rule', call: 'GITHUB_PUBLISH_RULE', text: GITHUB_PUBLISH_RULE },
];

/** Where the full text of one sample lives. */
export const samplePath = (template, issue) => path.join(SAMPLES_DIR, `${template}.${issue}.md`);

/** Where the full text of one contract lives. */
export const contractPath = (name) => path.join(CONTRACTS_DIR, `${name}.md`);

/** The frozen index. Throws with a usable message when nobody ran `freeze`. */
export function readBaseline(file = BASELINE_FILE) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`No existe ${file}. Créalo con: node tools/prompt-baseline/baseline.mjs freeze`);
    }
    throw e;
  }
  return JSON.parse(raw);
}

/** The fs operations the freeze swap uses; a test injects a failing one. */
export const REAL_FS = { existsSync, mkdirSync, renameSync, rmSync, writeFileSync };

/**
 * Replaces each `to` directory with its `from` directory, whole, keeping the
 * old one in `holdDir` until every pair is in place. If any step throws, what
 * already moved is moved back (in reverse, each undo best-effort) and the
 * original error is rethrown, so a half-done swap never leaves a fixture with
 * a missing `samples/` or `contracts/`. `holdDir` must be on the same volume.
 */
export function swapDirs(pairs, holdDir, fsOps = REAL_FS) {
  fsOps.mkdirSync(holdDir, { recursive: true });
  const states = [];
  try {
    for (const { from, to } of pairs) {
      const hold = path.join(holdDir, `old-${path.basename(to)}`);
      const st = { from, to, hold, aside: false, in: false };
      states.push(st);
      if (fsOps.existsSync(to)) {
        fsOps.renameSync(to, hold);
        st.aside = true;
      }
      fsOps.renameSync(from, to);
      st.in = true;
    }
  } catch (e) {
    for (const st of states.reverse()) {
      if (st.in) { try { fsOps.renameSync(st.to, st.from); } catch { /* best effort */ } }
      if (st.aside) { try { fsOps.renameSync(st.hold, st.to); } catch { /* best effort */ } }
    }
    throw e;
  }
}

/** Writes a file through a sibling temp file and a rename, so a reader never sees half of it. */
export function writeFileAtomic(file, text, fsOps = REAL_FS) {
  fsOps.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fsOps.writeFileSync(tmp, normalize(text), 'utf8');
  fsOps.renameSync(tmp, file);
}

/**
 * Renders every (template, task) pair into `<dir>/.freeze-tmp`, and only when
 * all of them succeeded swaps `samples/` and `contracts/` in and writes
 * `baseline.json`. A render that throws leaves the fixture untouched and the
 * scratch removed; the scratch is also removed (never throwing) at the end,
 * because on Windows an open file can make the removal fail.
 */
export function freezeFixture({ entries, dir = FIXTURE_DIR, render = renderFor, fsOps = REAL_FS }) {
  const samples = sampleIssues(entries);
  const samplesDir = path.join(dir, path.basename(SAMPLES_DIR));
  const contractsDir = path.join(dir, path.basename(CONTRACTS_DIR));
  const scratch = path.join(dir, '.freeze-tmp');
  const scratchSamples = path.join(scratch, path.basename(SAMPLES_DIR));
  const scratchContracts = path.join(scratch, path.basename(CONTRACTS_DIR));
  const put = (file, text) => {
    fsOps.mkdirSync(path.dirname(file), { recursive: true });
    fsOps.writeFileSync(file, normalize(text), 'utf8');
  };
  const cleanScratch = () => {
    try { fsOps.rmSync(scratch, { recursive: true, force: true }); } catch { /* leftover, ignored by git */ }
  };
  cleanScratch();

  const hashes = {};
  let pairs = 0;
  let contracts;
  try {
    for (const template of TEMPLATES) {
      hashes[template] = {};
      for (const entry of entries) {
        const text = render(entry, template);
        hashes[template][String(entry.issue)] = hashText(text);
        pairs += 1;
        if (samples.includes(entry.issue)) {
          put(path.join(scratchSamples, path.basename(samplePath(template, entry.issue))), text);
        }
      }
    }
    contracts = CONTRACTS.map(({ name, call, text }) => {
      put(path.join(scratchContracts, path.basename(contractPath(name))), text);
      return { name, call, hash: hashText(text) };
    });
  } catch (e) {
    cleanScratch();
    throw e;
  }

  const baseline = {
    note: 'Generado por `node tools/prompt-baseline/baseline.mjs freeze`. No se edita a mano. '
      + 'Congela el texto que producen las plantillas ANTES de que llegue `{{projectContext}}`.',
    normalization: 'CRLF -> LF antes de hashear y de guardar; los textos del fixture se normalizan al leerlos.',
    hash: 'sha256 hex sobre el UTF-8 del texto ya normalizado',
    sentinels: 'toda variable que no sale directa de la tarea se renderiza como `<<nombre>>`, '
      + '`projectContext` incluido aunque hoy ninguna plantilla lo use',
    sampleRule: SAMPLE_RULE,
    sampleIssues: samples,
    templates: TEMPLATES,
    allowed: ALLOWED_SNAPSHOT,
    tasks: Object.fromEntries(entries.map((t) => [String(t.issue), t])),
    hashes,
    contracts,
  };

  // A stale sample of a template that no longer exists would sit there
  // forever, so both directories are replaced whole, only now that every
  // render succeeded.
  try {
    swapDirs([
      { from: scratchSamples, to: samplesDir },
      { from: scratchContracts, to: contractsDir },
    ], scratch, fsOps);
    writeFileAtomic(path.join(dir, path.basename(BASELINE_FILE)), `${JSON.stringify(baseline, null, 2)}\n`, fsOps);
  } finally {
    cleanScratch();
  }
  return { pairs, samples, contracts: contracts.length };
}

/** A frozen text file, normalised on read — the fixture is checked out with CRLF here. */
export function readFrozenText(file) {
  return normalize(readFileSync(file, 'utf8'));
}

/**
 * The first line where two texts differ, with the lines just before it.
 *
 * A whole-prompt assertion that only says "not equal" is useless: these are
 * two hundred lines of Spanish prose and the eye does not find the changed
 * word. Returns `null` when the texts are identical.
 */
export function firstDifference(expected, actual, { context = 3 } = {}) {
  const a = normalize(expected).split('\n');
  const b = normalize(actual).split('\n');
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue;
    const from = Math.max(0, i - context);
    const before = a.slice(from, i).map((line, k) => `    ${String(from + k + 1).padStart(4)} | ${line}`);
    const show = (label, line) => `  ${label.padEnd(11)} ${String(i + 1).padStart(4)} | ${line === undefined ? '(fin del texto)' : line}`;
    return {
      line: i + 1,
      expected: a[i],
      actual: b[i],
      report: [
        `primera línea que difiere: ${i + 1}`,
        ...(before.length ? ['  contexto (del fixture):', ...before] : []),
        show('fixture', a[i]),
        show('renderizado', b[i]),
      ].join('\n'),
    };
  }
  return null;
}
