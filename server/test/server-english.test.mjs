// Server messages that reach the screen are English-only (issue #64). This scans
// server/src for Spanish inside the three places such a message is born:
// `new Error(...)`, `httpError(...)` and `.json({ error: ... })`.
//
// What it does NOT see (the reviewer and the manual walk cover it): fields the web
// renders that are assigned outside those calls (`task.error`, `chat.activity`,
// `stack.error`, chat messages the board writes), and Spanish that has no accent
// and no word from FUNCTION_WORDS.
//
// The task-log lines the board writes (issue #66) get the same treatment further
// down: `addLog(...)` messages, the wrappers in LOG_SINKS and the builders in
// LOG_BUILDERS. Phase labels (the second argument) are never scanned.
//
// HFSMON_ENGLISH_ONLY narrows the scan while the migration is in flight:
//   unset or empty -> every file (what `npm test` runs)
//   none           -> no file (only the detector self-tests)
//   a.js,b/c.js    -> only those files, by basename or by path under server/src
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Files whose Spanish is not screen text, with the reason. An exception that no
// longer names a file fails, so the list cannot rot.
const EXCEPTIONS = new Map([
  ['language.js', 'the GitHub publish gate: its reasons are a fixed contract (issue #64 forbids touching it)'],
  ['prompts.js', 'builds prompt text for agents'],
  ['prompt-invariants.js', 'guards the agent prompt templates'],
  ['parallel.js', 'agent-facing parallelism text'],
  ['rules.js', 'rules injected into agent prompts'],
  ['ghgate.js', 'deny text returned to the SDK hooks, read by agents'],
  ['installgate.js', 'deny text returned to the SDK hooks, read by agents'],
  ['subagentgate.js', 'deny text returned to the SDK hooks, read by agents'],
  ['waitgate.js', 'deny text returned to the SDK hooks, read by agents'],
  ['fixbrief.js', 'brief written for an agent'],
  ['planbrief.js', 'brief and re-ask text written for an agent'],
  ['advisorplan.js', 'brief and re-ask text written for an agent'],
  ['prbody.js', 'problems fed back to the agent that writes the PR body'],
  ['plans.js', 'plan text written for agents'],
  ['nudge.js', 'nudges sent to a running agent'],
  ['zen-proxy.js', 'proxy for an agent provider, text goes to agents'],
  ['runner/app.js', 'internal start-up assertions of the runner'],
]);

const ACCENTED = /[áéíóúñÁÉÍÓÚÑ¿¡]/;

// Words that are Spanish and not English. Deliberately without «no», «es», «sin
// título»-style ambiguity: a hit must be evidence, not a guess.
const FUNCTION_WORDS = new Set((
  'de del la las los el un una unos unas que para con sin ya hay falta faltan debe deben puede pueden ' +
  'se ese esa esos esas este esta estos estas ni pero porque cuando como por al han ser nada todo todos ' +
  'todas ninguna ninguno ahora desde hasta entre sobre tambien existe existen tarea tareas archivo ' +
  'archivos proyecto carpeta ruta tablero usa usar sino aun todavia otra otro ' +
  'modo activado desactivado terminado terminada cerrado cerrada reabierto reabierta creado creada denegado denegada'
).split(' '));

export function looksSpanish(text) {
  if (ACCENTED.test(text)) return true;
  return text.toLowerCase().split(/[^\p{L}]+/u).some((w) => FUNCTION_WORDS.has(w));
}

// A small JavaScript tokenizer: words, punctuation and string pieces. Comments and
// regex literals are dropped; a template literal yields one string token per text
// chunk and its `${ ... }` contents are tokenized as code, so a Spanish word inside
// an expression is found too.
export function tokenize(src) {
  const toks = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  let prev = '';
  const REGEX_AFTER = '(,=:[!&|?{};';

  const readTemplate = () => {
    let buf = '';
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { toks.push({ t: 's', text: buf, pos: start }); i++; prev = '`'; return; }
      if (c === '$' && src[i + 1] === '{') {
        toks.push({ t: 's', text: buf, pos: start });
        stack.push('tpl');
        toks.push({ t: 'p', ch: '{', pos: i });
        i += 2;
        prev = '{';
        return;
      }
      buf += c;
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let buf = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { buf += src[i + 1] ?? ''; i += 2; continue; }
        buf += src[i++];
      }
      i++;
      toks.push({ t: 's', text: buf, pos: start });
      prev = 'q';
      continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/') {
      if (prev === '' || REGEX_AFTER.includes(prev)) {
        i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[a-z]/.test(src[i])) i++;
        prev = 'r';
        continue;
      }
      i++;
      prev = '/';
      continue;
    }
    if (c === '{') { stack.push('b'); toks.push({ t: 'p', ch: c, pos: i }); i++; prev = c; continue; }
    if (c === '}') {
      const popped = stack.pop();
      toks.push({ t: 'p', ch: c, pos: i });
      i++;
      prev = c;
      if (popped === 'tpl') readTemplate();
      continue;
    }
    if ('()[],:.'.includes(c)) { toks.push({ t: 'p', ch: c, pos: i }); i++; prev = c; continue; }
    if (/[\p{L}\p{N}_$]/u.test(c)) {
      const start = i;
      while (i < n && /[\p{L}\p{N}_$]/u.test(src[i])) i++;
      toks.push({ t: 'w', text: src.slice(start, i), pos: start });
      prev = 'w';
      continue;
    }
    i++;
    prev = c;
  }
  return toks;
}

const isP = (tok, ch) => tok?.t === 'p' && tok.ch === ch;
const isW = (tok, text) => tok?.t === 'w' && tok.text === text;

// String pieces inside the argument that starts at toks[from]. `stopAtComma` is for
// an object value, which ends at a top-level comma or at the closing brace.
function pieces(toks, from, stopAtComma) {
  const out = [];
  let depth = 0;
  for (let k = from; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t === 'p') {
      if ('([{'.includes(tok.ch)) depth++;
      else if (')]}'.includes(tok.ch)) {
        if (depth === 0) break;
        depth--;
      } else if (tok.ch === ',' && depth === 0 && stopAtComma) break;
    } else if (tok.t === 's') out.push(tok);
  }
  return out;
}

/** Every string literal that sits inside a screen-bound error: [{ pos, text }]. */
export function errorLiterals(src) {
  const toks = tokenize(src);
  const found = [];
  for (let k = 0; k < toks.length; k++) {
    if (isW(toks[k], 'new') && isW(toks[k + 1], 'Error') && isP(toks[k + 2], '(')) {
      found.push(...pieces(toks, k + 3, false));
    } else if (isW(toks[k], 'httpError') && isP(toks[k + 1], '(') && !isW(toks[k - 1], 'function')) {
      found.push(...pieces(toks, k + 2, false));
    } else if (
      isP(toks[k], '.') && isW(toks[k + 1], 'json') && isP(toks[k + 2], '(') &&
      isP(toks[k + 3], '{') && isW(toks[k + 4], 'error') && isP(toks[k + 5], ':')
    ) {
      found.push(...pieces(toks, k + 6, true));
    }
  }
  return found;
}

export function spanishInErrors(src) {
  const line = (pos) => src.slice(0, pos).split('\n').length;
  return errorLiterals(src)
    .filter((l) => looksSpanish(l.text))
    .map((l) => ({ line: line(l.pos), text: l.text.trim().slice(0, 80) }));
}

// ---------------------------------------------------------------------------
// Task-log text the board writes itself (issue #66). The log panel and the task
// card show these lines on screen, so they are English like the errors above.
//
// Seen: the message arguments of `addLog(task, phase, line)` (the first two
// arguments, task and phase label, are skipped: phase labels such as 'estado' stay
// as they are, CSS and the metrics tool read them), the per-file wrappers in
// LOG_SINKS, and the bodies of the line builders in LOG_BUILDERS.
// Not seen: a message that reaches the log through a variable, a call into a
// sink from another file, and raw command output or agent text (never literals).
// ---------------------------------------------------------------------------

// Wrappers that forward to the task log: file -> [{ name, recv?, skip }]. `skip` is
// the number of leading arguments that are not the message; `recv` the object a
// method is called on (`host.log(`). `onLine?.(` is read too: the tokenizer drops `?`.
export const LOG_SINKS = new Map([
  ['move.js', [{ name: 'log', skip: 1 }]],
  ['stack.js', [{ name: 'log', skip: 0 }]],
  ['nudge.js', [{ name: 'log', skip: 0 }]],
  ['planexec.js', [{ name: 'log', recv: 'host', skip: 0 }]],
  ['worktree.js', [{ name: 'onLine', skip: 0 }]],
]);

// Functions and tables whose whole body is log text: file -> [name].
export const LOG_BUILDERS = new Map([
  ['quota.js', ['quotaWaitLine', 'describeResume', 'untilResume']],
  ['workplan.js', ['parallelismLine']],
  ['planexec.js', ['attemptLabel', 'parallelismReportLine', 'doneLine']],
  ['qa.js', ['describeCut']],
  ['phases.js', ['PHASE_LABEL']],
]);

// The log guard has its OWN exception list, empty on purpose: EXCEPTIONS above
// excuses nudge.js for its agent prompts, but its `log(...)` lines are log text.
export const LOG_EXCEPTIONS = new Map();

const ADDLOG = { name: 'addLog', recv: '*', skip: 2 };

// String pieces of a call's arguments after the first `skip` ones. `from` is the
// token right after the opening parenthesis.
function argPieces(toks, from, skip) {
  const out = [];
  let depth = 0;
  let arg = 0;
  for (let k = from; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t === 'p') {
      if ('([{'.includes(tok.ch)) depth++;
      else if (')]}'.includes(tok.ch)) {
        if (depth === 0) break;
        depth--;
      } else if (tok.ch === ',' && depth === 0) arg++;
    } else if (tok.t === 's' && arg >= skip) out.push(tok);
  }
  return out;
}

/** String literals in the message arguments of every call to `spec.name`. */
function callPieces(toks, spec) {
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    if (!isW(toks[k], spec.name)) continue;
    const before = toks[k - 1];
    if (isW(before, 'function')) continue;
    if (spec.recv === '*') { /* any receiver, or none */ }
    else if (spec.recv) { if (!(isP(before, '.') && isW(toks[k - 2], spec.recv))) continue; }
    else if (isP(before, '.')) continue;
    let j = k + 1;
    if (isP(toks[j], '.') && isP(toks[j + 1], '(')) j++;
    if (!isP(toks[j], '(')) continue;
    out.push(...argPieces(toks, j + 1, spec.skip));
  }
  return out;
}

// Index of the token after the bracket that closes the one at toks[open].
function afterBalanced(toks, open) {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].t !== 'p') continue;
    if ('([{'.includes(toks[k].ch)) depth++;
    else if (')]}'.includes(toks[k].ch) && --depth === 0) return k + 1;
  }
  return toks.length;
}

/**
 * Every string in the body of the declaration `name` (`function`, `const`, `let`
 * or `var`): a block body, an object table, or an arrow with an expression body,
 * which is taken to end at the first `;` that ends a line.
 */
function builderPieces(src, toks, name) {
  const out = [];
  let found = false;
  for (let k = 1; k < toks.length; k++) {
    if (!isW(toks[k], name)) continue;
    if (!['function', 'const', 'let', 'var'].some((w) => isW(toks[k - 1], w))) continue;
    found = true;
    let j = k + 1;
    if (isP(toks[j], '(')) j = afterBalanced(toks, j);
    if (isP(toks[j], '{')) {
      const end = afterBalanced(toks, j);
      for (let t = j; t < end; t++) if (toks[t].t === 's') out.push(toks[t]);
    } else {
      const m = /;[ \t]*(\r?\n|$)/.exec(src.slice(toks[k].pos));
      const end = m ? toks[k].pos + m.index : src.length;
      for (let t = j; t < toks.length && toks[t].pos < end; t++) if (toks[t].t === 's') out.push(toks[t]);
    }
  }
  return { found, pieces: out };
}

/** Every log-text literal of one file: [{ pos, text }]; `file` is relative to server/src. */
export function logLiterals(src, file) {
  const toks = tokenize(src);
  const found = [...callPieces(toks, ADDLOG)];
  for (const spec of LOG_SINKS.get(file) ?? []) found.push(...callPieces(toks, spec));
  for (const name of LOG_BUILDERS.get(file) ?? []) found.push(...builderPieces(src, toks, name).pieces);
  const seen = new Set();
  return found.filter((l) => !seen.has(l.pos) && seen.add(l.pos)).sort((a, b) => a.pos - b.pos);
}

export function spanishInLog(src, file) {
  const line = (pos) => src.slice(0, pos).split('\n').length;
  const hits = logLiterals(src, file)
    .filter((l) => looksSpanish(l.text))
    .map((l) => ({ line: line(l.pos), text: l.text.trim().slice(0, 80) }));
  // A template yields one piece per text chunk: report each line once.
  return hits.filter((h, i) => i === 0 || h.line !== hits[i - 1].line);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.js')) yield p;
  }
}

const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

function selected(files) {
  const filter = (process.env.HFSMON_ENGLISH_ONLY ?? '').trim();
  if (filter === '') return files;
  if (filter === 'none') return [];
  const wanted = new Set(filter.split(',').map((s) => s.trim()).filter(Boolean));
  return files.filter((f) => wanted.has(rel(f)) || wanted.has(path.basename(f)));
}

test('the Spanish detector tells Spanish from English', () => {
  for (const s of ['Falta la ruta del archivo', 'ese chat no existe', 'El título no puede estar vacío', '¿Seguro?', 'Año', 'pregunta ya no está pendiente', 'chat cerrado', 'plan terminado', 'PR draft creada', 'modo plan activado']) {
    assert.equal(looksSpanish(s), true, s);
  }
  for (const s of ['The title cannot be empty', 'gh issue view failed: boom', 'Missing destination machine', 'EADDRINUSE on port', 'Untitled', '']) {
    assert.equal(looksSpanish(s), false, s);
  }
});

test('the extractor reads the three screen-bound shapes and nothing else', () => {
  const src = [
    "throw new Error('Falta la ruta');",
    'throw httpError(400, `máquina «${name}» desconocida`);',
    "res.status(400).json({ error: 'Esa pregunta ya no está pendiente', code: 'GONE' });",
    "res.status(400).json({ error: e.message, note: 'una nota con acento: ñ' });",
    "// throw new Error('falta un comentario');",
    "/* new Error('falta otro') */",
    "console.log('falta el log');",
    "const doc = 'new Error(\"falta en una cadena\")';",
    "const re = /new Error\\('falta'\\)/;",
    "function httpError(status, message) { return new Error(message); }",
    "throw new Error(`bad ${x ? 'sí' : 'no'} value`);",
    "throw new Error('English only');",
  ].join('\n');
  const hits = spanishInErrors(src);
  assert.deepEqual(hits.map((h) => h.line), [1, 2, 3, 11]);
  assert.equal(errorLiterals(src).some((l) => l.text === 'una nota con acento: ñ'), false);
});

test('a comment, a regex or a string that merely mentions an error call is not scanned', () => {
  const src = "const a = 'falta'; // new Error('falta')\nconst b = /'/; throw new Error('fine');\n";
  assert.deepEqual(spanishInErrors(src), []);
});

test('every excepted file exists, so the list cannot rot', () => {
  const all = new Set([...walk(SRC)].map(rel));
  const missing = [...EXCEPTIONS.keys()].filter((f) => !all.has(f));
  assert.deepEqual(missing, []);
});

test('no Spanish in the errors that reach the screen', () => {
  const files = selected([...walk(SRC)].filter((f) => !EXCEPTIONS.has(rel(f))));
  const problems = [];
  for (const file of files) {
    for (const h of spanishInErrors(readFileSync(file, 'utf8'))) {
      problems.push(`server/src/${rel(file)}:${h.line}  ${h.text}`);
    }
  }
  assert.deepEqual(problems, [], `${problems.length} Spanish message(s) to translate into English`);
});

test('the log extractor reads the message of addLog, the wrappers and the builders, not the phase label', () => {
  const addLogSrc = [
    "store.addLog(task, 'estado', 'la tarea se reasignó');",            // 1 red
    "store.addLog(task, 'máquina', 'moved to the other machine');",     // 2 green: Spanish label only
    "store.addLog(task, 'modo', variable);",                            // 3 green: no literal
    'store.addLog(task, \'guard\', `la rama ${branch} no existe`);',    // 4 red
    'store.addLog(task, \'inicio\', ok',                                // 5 green
    "  ? 'started'",                                                    // 6 green
    "  : 'no se pudo arrancar');",                                      // 7 red
    "store.addLog(task, 'x', `ran ${n ? 'con éxito' : 'nothing'}`);",   // 8 red: Spanish inside ${}
    "// store.addLog(task, 'x', 'falta un comentario');",                // 9 green: comment
    "console.log('la tarea');",                                         // 10 green: not addLog
    "function addLog(task, phase, line) { return 'la línea'; }",        // 11 green: the declaration
    "store.addLog(task, 'estado', 'moved to review');",                 // 12 green
  ].join('\n');
  assert.deepEqual(spanishInLog(addLogSrc, 'poller.js').map((h) => h.line), [1, 4, 7, 8]);

  const sinkSrc = [
    "log(task, 'está listo');",             // 1 red (move.js skips the task)
    "log(task, `done ${x}`);",              // 2 green
    "console.log('la tarea');",             // 3 green: a method of something else
    "function log(task, line) { return 'la línea'; }", // 4 green: declaration
    "log(variable);",                       // 5 green
  ].join('\n');
  assert.deepEqual(spanishInLog(sinkSrc, 'move.js').map((h) => h.line), [1]);
  assert.deepEqual(spanishInLog("log('hay una pausa de cuota');", 'poller.js'), [], 'no sink in a file that has none');
  assert.deepEqual(spanishInLog("log('hay una pausa de cuota');", 'nudge.js').map((h) => h.line), [1], 'nudge.js log lines are checked');
  assert.deepEqual(spanishInLog("host.log(`${id}: la reparación falló`);\nlog('la tarea');", 'planexec.js').map((h) => h.line), [1]);
  assert.deepEqual(spanishInLog("onLine?.(`no se pudo adoptar ${b}`);\nonLine(`la rama`);\nonLine?.(`ok ${b}`);", 'worktree.js').map((h) => h.line), [1, 2]);

  const builderSrc = [
    'const doneLine = (task) => `${task.id}: hecha${task.attempts > 1 ? \' al intento\' : \'\'}`;', // 1 red
    "const other = (t) => 'la tarea';",                                      // 2 green: not a builder
    "export function attemptLabel(task) {",
    "  return task.extra ? 'extra retry' : 'reintento a petición';",              // 4 red
    "}",
    "function parallelismReportLine(plan) { return 'minutes in a row'; }",   // 6 green
  ].join('\n');
  assert.deepEqual(spanishInLog(builderSrc, 'planexec.js').map((h) => h.line), [1, 4]);
  const table = "export const PHASE_LABEL = {\n  assigned: 'el arranque',\n  pr: 'opening the PR',\n};\nconst x = 'la tarea';";
  assert.deepEqual(spanishInLog(table, 'phases.js').map((h) => h.line), [2]);
});

test('the log tables name files and declarations that exist, so they cannot rot', () => {
  const all = new Set([...walk(SRC)].map(rel));
  const missing = [...LOG_SINKS.keys(), ...LOG_BUILDERS.keys(), ...LOG_EXCEPTIONS.keys()].filter((f) => !all.has(f));
  assert.deepEqual(missing, []);
  const gone = [];
  for (const [file, names] of LOG_BUILDERS) {
    const src = readFileSync(path.join(SRC, file), 'utf8');
    const toks = tokenize(src);
    for (const name of names) if (!builderPieces(src, toks, name).found) gone.push(`${file}#${name}`);
  }
  assert.deepEqual(gone, []);
  assert.equal(LOG_EXCEPTIONS.size, 0, 'no file is excused from the log guard');
});

test('no Spanish in the task-log lines the board writes', () => {
  const files = selected([...walk(SRC)].filter((f) => !LOG_EXCEPTIONS.has(rel(f))));
  const problems = [];
  for (const file of files) {
    for (const h of spanishInLog(readFileSync(file, 'utf8'), rel(file))) {
      problems.push(`server/src/${rel(file)}:${h.line}  ${h.text}`);
    }
  }
  assert.deepEqual(problems, [], `${problems.length} Spanish log line(s) to translate into English`);
});
