#!/usr/bin/env node
// Drift report for the PRD/FSD chapters: how far has the code moved since each
// chapter was sealed?
//
// Every chapter carries `**Verificado contra.** `<sha>` · <date>`, and cites
// code as `path:line` all over. `server/test/docs.test.mjs` only checks that a
// cited line EXISTS, on purpose (a content check would turn the suite red on
// any commit by anybody), so citations rot silently. This report makes the rot
// visible without changing the format: per chapter, the commit it was sealed
// against and how many of the code files it cites have changed since.
//
// It is INFORMATIVE. It never breaks `npm test`, and its exit code is always 0
// unless `--fail-over N` is given explicitly (for whoever wants it in CI).
// Nothing here throws: a missing sha or a tree without git is a row that says
// so, not an exception.
//
// Imports nothing from `server/src`: this is a tool, not part of the server.
//
//   node tools/docs/stale.mjs                 # text table on the real repository
//   node tools/docs/stale.mjs --json          # machine output
//   node tools/docs/stale.mjs --fail-over 5   # exit 1 if a chapter has >= 5 changed files
//   node tools/docs/stale.mjs --root <dir>    # another tree (tests)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { structuralLines } from '../decisions/core.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Chapters: `A-intake.md` … `O-conocimiento.md`, under `docs/prd/` and `docs/fsd/`. */
export const CHAPTER_NAME_RE = /^[A-O]-[a-z0-9-]+\.md$/;
export const CHAPTER_KINDS = [
  { kind: 'PRD', dir: 'prd' },
  { kind: 'FSD', dir: 'fsd' },
];

// COPIED from `server/test/docs.test.mjs` (SELLO_RE, SHA_RE, CODE_SPAN_RE,
// CITA_RE, looksLikePath and the open-span handling of `checkCitas`). That file
// is a test: it does not export these for tools, and a tool must not import a
// test. If the recognition rules change there, change them here too.
const SELLO_RE = /^\*\*Verificado contra\.\*\*\s*`([^`]*)`\s*·\s*(\S+)\s*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const CODE_SPAN_RE = /`([^`]+)`/g;
const CITA_RE = /^([^:\s]*?):(\d+)(?:-(\d+))?$/;
const looksLikePath = (p) => p.includes('/') || /^[\w.-]+\.[A-Za-z0-9]+$/.test(p);

/**
 * The seal of a chapter: `{ sha, fecha }`, or `null` when the chapter has none
 * (or it is malformed). Fenced bodies are stepped over, as in the verifier.
 */
export function sealOf(text) {
  for (const [, line] of structuralLines(String(text ?? ''))) {
    if (!/^\*\*Verificado contra\.\*\*/.test(line)) continue;
    const m = SELLO_RE.exec(line);
    return m ? { sha: m[1], fecha: m[2] } : null;
  }
  return null;
}

/**
 * The code citations of a chapter: `{ citations, files }`.
 *
 * `citations` is the number of `` `path:line` `` / `` `path:from-to` `` literals
 * whose file exists under `root`; `files` is the sorted list of those distinct
 * files (root-relative, `/` separators). Citations inside a fenced block do not
 * count, a `:123` with no path is not a citation, and anything that escapes the
 * root or is not an existing file is ignored.
 */
export function citedFiles(text, root) {
  const seen = new Map();
  let citations = 0;
  const isFile = new Map();
  const fileOk = (dest) => {
    if (!isFile.has(dest)) {
      let ok = false;
      try {
        ok = fs.statSync(dest).isFile();
      } catch {
        ok = false;
      }
      isFile.set(dest, ok);
    }
    return isFile.get(dest);
  };

  // An odd tick count on a line means a span is still open: the unclosed tail
  // is carried into the next line (same rule as the verifier).
  let openTail = false;
  for (const [, rawLine] of structuralLines(String(text ?? ''))) {
    let line = rawLine;
    if (openTail) {
      const closeAt = line.indexOf('`');
      if (closeAt === -1) continue;
      line = line.slice(closeAt + 1);
      openTail = false;
    }
    if ((line.match(/`/g) ?? []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf('`'));
      openTail = true;
    }
    for (const span of line.matchAll(CODE_SPAN_RE)) {
      const cita = CITA_RE.exec(span[1].trim());
      if (!cita) continue;
      const ruta = cita[1];
      if (ruta === '' || !looksLikePath(ruta) || path.isAbsolute(ruta)) continue;
      const dest = path.resolve(root, ruta);
      if (path.relative(root, dest).startsWith('..')) continue;
      if (!fileOk(dest)) continue;
      const rel = path.relative(root, dest).split(path.sep).join('/');
      citations += 1;
      seen.set(rel, (seen.get(rel) ?? 0) + 1);
    }
  }
  return { citations, files: [...seen.keys()].sort() };
}

/** Run git in `root` without a shell. Returns trimmed stdout, or `null` on any failure. */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The drift report of a tree: `{ head, rows }`. Never throws.
 *
 * Each row: `{ chapter, file, sha, fecha, citations, files, changed, commits,
 * top, note }`. `note` is `null` for a normal row, or `sin sello`,
 * `sello ilegible` or `sin git` when nothing could be measured (then `changed`
 * and `commits` are `null`).
 */
export function report(root) {
  root = path.resolve(root);
  const inRepo = git(root, ['rev-parse', '--git-dir']) !== null;
  const head = inRepo ? git(root, ['rev-parse', '--short', 'HEAD']) : null;

  const shaOk = new Map();
  const shaResolves = (sha) => {
    if (!shaOk.has(sha)) {
      shaOk.set(sha, SHA_RE.test(sha) && git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== null);
    }
    return shaOk.get(sha);
  };
  const counts = new Map();
  const countSince = (sha, file) => {
    const key = `${sha}\0${file}`;
    if (!counts.has(key)) {
      const out = git(root, ['rev-list', '--count', `${sha}..HEAD`, '--', file]);
      counts.set(key, /^\d+$/.test(out ?? '') ? Number(out) : 0);
    }
    return counts.get(key);
  };

  const rows = [];
  for (const { kind, dir } of CHAPTER_KINDS) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, 'docs', dir)).filter((n) => CHAPTER_NAME_RE.test(n)).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const file = `docs/${dir}/${name}`;
      let text = null;
      try {
        text = fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        text = null;
      }
      const row = {
        chapter: `${kind}-${name[0]}`,
        file,
        sha: null,
        fecha: null,
        citations: 0,
        files: 0,
        changed: null,
        commits: null,
        top: null,
        note: null,
      };
      rows.push(row);
      if (text === null) {
        row.note = 'sin lectura';
        continue;
      }
      const cited = citedFiles(text, root);
      row.citations = cited.citations;
      row.files = cited.files.length;
      const seal = sealOf(text);
      if (!seal) {
        row.note = 'sin sello';
        continue;
      }
      row.sha = seal.sha;
      row.fecha = seal.fecha;
      if (!inRepo) {
        row.note = 'sin git';
        continue;
      }
      if (!shaResolves(seal.sha)) {
        row.note = 'sello ilegible';
        continue;
      }
      let changed = 0;
      let commits = 0;
      let top = null;
      for (const f of cited.files) {
        const n = countSince(seal.sha, f);
        if (n > 0) {
          changed += 1;
          commits += n;
          if (!top || n > top.n) top = { file: f, n };
        }
      }
      row.changed = changed;
      row.commits = commits;
      row.top = top ? { file: top.file, commits: top.n } : null;
    }
  }

  // Most drifted first; rows that could not be measured go last.
  rows.sort((a, b) => (b.commits ?? -1) - (a.commits ?? -1) || a.chapter.localeCompare(b.chapter));
  return { head, rows };
}

const HEADERS = ['capítulo', 'sello', 'fecha', 'citas', 'archivos', 'cambiados', 'commits', 'más cambiado'];

/** The text table of a report. */
export function renderText({ head, rows }) {
  const lines = [`HEAD = ${head ?? '(sin git)'}`, ''];
  const cells = rows.map((r) => [
    r.chapter,
    r.sha ?? '-',
    r.fecha ?? '-',
    String(r.citations),
    String(r.files),
    r.changed === null ? '-' : String(r.changed),
    r.commits === null ? '-' : String(r.commits),
    r.note ?? (r.top ? `${r.top.file} (${r.top.commits})` : '-'),
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const fmt = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ');
  lines.push(fmt(HEADERS), fmt(widths.map((w) => '-'.repeat(w))));
  for (const c of cells) lines.push(fmt(c));
  lines.push(
    '',
    'Informativo: no rompe la suite ni npm test. Repasar un capítulo es el procedimiento de docs/README.md §5.',
  );
  return lines.join('\n');
}

/** CLI entry. Returns the exit code; never throws on bad input. */
export function main(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let json = false;
  let failOver = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--root') root = path.resolve(argv[(i += 1)] ?? root);
    else if (a === '--fail-over') {
      const n = Number(argv[(i += 1)]);
      if (Number.isInteger(n) && n > 0) failOver = n;
      else {
        console.error('--fail-over espera un entero positivo');
        return 2;
      }
    } else {
      console.error(`argumento desconocido: ${a}`);
      return 2;
    }
  }
  const result = report(root);
  console.log(json ? JSON.stringify(result, null, 2) : renderText(result));
  if (failOver !== null && result.rows.some((r) => (r.changed ?? 0) >= failOver)) return 1;
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
