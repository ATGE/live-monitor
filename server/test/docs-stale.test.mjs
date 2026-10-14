// El informe de deriva de los capítulos (`tools/docs/stale.mjs`).
//
// Es informativo y nunca debe lanzar: un sello ilegible o un árbol sin git son
// una fila que lo dice, no una excepción. Estas pruebas fijan eso, y que cuente
// lo que el verificador cuenta como cita (y nada más).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sealOf, citedFiles, report, renderText } from '../../tools/docs/stale.mjs';

let tmp;
let repo;
let plain;
let sha1;

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const write = (root, rel, content) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const thirtyLines = (tag) => Array.from({ length: 30 }, (_, i) => `// ${tag} ${i + 1}`).join('\n') + '\n';

const chapter = (sha) =>
  [
    '# G — PR y merge',
    '',
    `**Verificado contra.** \`${sha}\` · 2026-09-20`,
    '',
    'Cita `server/src/a.js:5` y `server/src/a.js:10-12`.',
    '',
    '```',
    'no cuenta `server/src/b.js:3`',
    '```',
    '',
  ].join('\n');

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfsmon-stale-'));
  // Nothing above the temp dir may be taken for the repository under test.
  process.env.GIT_CEILING_DIRECTORIES = tmp;
  repo = path.join(tmp, 'repo');
  plain = path.join(tmp, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);

  git(repo, 'init', '-q');
  write(repo, 'server/src/a.js', thirtyLines('v1'));
  write(repo, 'server/src/b.js', thirtyLines('b'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  sha1 = git(repo, 'rev-parse', '--short', 'HEAD');

  write(repo, 'docs/prd/G-pr-y-merge.md', chapter(sha1));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chapter');

  write(repo, 'server/src/a.js', thirtyLines('v2'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change a');
});

after(() => {
  delete process.env.GIT_CEILING_DIRECTORIES;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A locked temp dir is not a failure of the report.
  }
});

test('sealOf lee el sello y devuelve null si falta o está mal formado', () => {
  assert.deepEqual(sealOf('# T\n\n**Verificado contra.** `abc1234` · 2026-09-20\n'), { sha: 'abc1234', fecha: '2026-09-20' });
  assert.equal(sealOf('# T\n\nsin sello\n'), null);
  assert.equal(sealOf('**Verificado contra.** abc1234 2026-09-20\n'), null);
  // A seal quoted inside a fence is not the seal.
  assert.equal(sealOf('```\n**Verificado contra.** `abc1234` · 2026-09-20\n```\n'), null);
});

test('citedFiles cuenta citas y archivos existentes, no las de una valla ni `:123` sin ruta', () => {
  const root = path.join(tmp, 'cites');
  write(root, 'server/src/x.js', thirtyLines('x'));
  write(root, 'web/y.js', thirtyLines('y'));
  const text = [
    'Una `server/src/x.js:3` y un rango `server/src/x.js:5-9`, luego `web/y.js:1`.',
    'Sin ruta: `:123` no es cita. Inexistente: `server/src/nope.js:4`. Fuera: `../fuera.js:1`.',
    'No son citas: `HFSMON_NO_AUTOSTART`, `npm run restart`.',
    '```',
    'fenced `server/src/x.js:7` y `web/y.js:2`',
    '```',
  ].join('\n');
  const { citations, files } = citedFiles(text, root);
  assert.equal(citations, 3);
  assert.deepEqual(files, ['server/src/x.js', 'web/y.js']);
});

test('el informe cuenta un archivo citado y un commit desde el sello', () => {
  const { head, rows } = report(repo);
  assert.match(head, /^[0-9a-f]{7,}$/);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.chapter, 'PRD-G');
  assert.equal(row.sha, sha1);
  assert.equal(row.fecha, '2026-09-20');
  assert.equal(row.citations, 2);
  assert.equal(row.files, 1);
  assert.equal(row.changed, 1);
  assert.equal(row.commits, 1);
  assert.deepEqual(row.top, { file: 'server/src/a.js', commits: 1 });
  assert.equal(row.note, null);
  assert.match(renderText({ head, rows }), /PRD-G\s+\S+\s+2026-09-20\s+2\s+1\s+1\s+1\s+server\/src\/a\.js \(1\)/);
});

test('un sello con sha inexistente da «sello ilegible» y no lanza', () => {
  const root = path.join(tmp, 'badseal');
  fs.cpSync(repo, root, { recursive: true });
  write(root, 'docs/prd/G-pr-y-merge.md', chapter('0000000'));
  const { rows } = report(root);
  assert.equal(rows[0].note, 'sello ilegible');
  assert.equal(rows[0].changed, null);
  assert.match(renderText({ head: 'x', rows }), /sello ilegible/);
});

test('fuera de un repositorio no lanza: «sin git»', () => {
  write(plain, 'server/src/a.js', thirtyLines('v1'));
  write(plain, 'docs/prd/G-pr-y-merge.md', chapter('abc1234'));
  let result;
  assert.doesNotThrow(() => {
    result = report(plain);
  });
  assert.equal(result.head, null);
  assert.equal(result.rows[0].note, 'sin git');
  assert.equal(result.rows[0].citations, 2);
  assert.doesNotThrow(() => report(path.join(tmp, 'no-such-dir')));
});
