// Cerrar un issue sin PR: la capa de GitHub, antes de que exista una red.
//
// Cuando el análisis concluye que no hace falta cambio, el tablero publica un
// comentario de cierre, etiqueta y cierra. Nada de eso se puede probar contra
// GitHub —son escrituras públicas— así que lo que se prueba aquí son las tres
// piezas puras por las que pasa todo: el argv de `gh issue close`, la marca
// invisible que hace idempotente la publicación, y la búsqueda del comentario
// anterior, que es donde está la trampa (el «Quote reply» de GitHub copia el
// markdown crudo, marca incluida, así que la marca NO prueba la autoría).
//
// Aquí no se lanza `gh` ni una sola vez.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeIssueArgs,
  closingCommentMarker,
  findPriorClosingComment,
  repo,
  forgetRepoCache,
} from '../src/github.js';
import { publishProblems } from '../src/language.js';
import { saveProjects } from '../src/projects.js';
import { config } from '../src/config.js';
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HFS = 'HeliosSoftware/hfs';
const BETA = 'eterceros/app-b';

// ---------------------------------------------------------------------------
// El argv de `gh issue close`

test('completed viaja como --reason completed, con el repositorio en el -R', () => {
  const args = closeIssueArgs({ issue: 942, reason: 'completed', repo: HFS });
  assert.deepEqual(args, ['issue', 'close', '942', '-R', HFS, '--reason', 'completed']);
});

test('«not planned» es UN SOLO elemento del array, espacio incluido', () => {
  const args = closeIssueArgs({ issue: 7, reason: 'not_planned', repo: HFS });
  assert.deepEqual(args, ['issue', 'close', '7', '-R', HFS, '--reason', 'not planned']);

  // `run()` usa `spawn` sin shell: no hay comillas que valgan, así que partir
  // esto en dos ('not', 'planned') le daría a `gh` un motivo inválido y un
  // argumento suelto.
  assert.ok(args.includes('not planned'), 'el motivo llega entero');
  assert.ok(!args.includes('not'), 'y nunca partido');
  assert.equal(args.filter((a) => a === '--reason').length, 1);
});

test('duplicado de un ISSUE: --duplicate-of y ningún --reason', () => {
  const args = closeIssueArgs({ issue: 30, reason: 'duplicate', duplicateOf: 12, repo: BETA, targetIsPr: false });
  assert.deepEqual(args, ['issue', 'close', '30', '-R', BETA, '--duplicate-of', '12']);
  assert.ok(!args.includes('--reason'), 'gh deriva el estado del enlace; añadir el motivo sobra');
});

test('duplicado de un PR: --reason duplicate y ningún --duplicate-of', () => {
  const args = closeIssueArgs({ issue: 30, reason: 'duplicate', duplicateOf: 12, repo: BETA, targetIsPr: true });
  assert.deepEqual(args, ['issue', 'close', '30', '-R', BETA, '--reason', 'duplicate']);
  // `--duplicate-of` resuelve un id de *Issue*: un número de PR no le vale, y
  // resolvería el issue con ese mismo número, que es otra cosa.
  assert.ok(!args.includes('--duplicate-of'), 'el PR se cita en el comentario, no en este flag');
});

test('duplicado sin número lanza, apunte a un issue o a un PR', () => {
  for (const targetIsPr of [false, true]) {
    assert.throws(
      () => closeIssueArgs({ issue: 30, reason: 'duplicate', duplicateOf: null, repo: HFS, targetIsPr }),
      /as a duplicate without saying what it duplicates/,
      `targetIsPr=${targetIsPr}`,
    );
  }
  assert.throws(
    () => closeIssueArgs({ issue: 30, reason: 'duplicate', duplicateOf: '  ', repo: HFS }),
    /as a duplicate without saying what it duplicates/,
  );
});

test('un motivo que gh no conoce lanza aquí y no en GitHub', () => {
  assert.throws(
    () => closeIssueArgs({ issue: 1, reason: 'porque-si', repo: HFS }),
    /unknown close reason/,
  );
  assert.throws(() => closeIssueArgs({ issue: 1, repo: HFS }), /unknown close reason/);
});

// ---------------------------------------------------------------------------
// Un cierre va al repositorio de SU proyecto

/** Una entrada de registro completa; solo se escribe lo que la prueba mira. */
const entry = (id, over = {}) => ({
  id,
  name: id,
  repoPath: `/tmp/hfsmon-close-${id}`,
  worktreeRoot: `/tmp/hfsmon-close-${id}-wt`,
  repo: null,
  assignee: 'eterceros',
  reviewer: 'eterceros',
  overrides: {},
  ...over,
});

test('el -R de un cierre es el repositorio del proyecto, no el del tablero', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  saveProjects([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: BETA })]);
  forgetRepoCache();

  const deBeta = closeIssueArgs({ issue: 12, reason: 'completed', repo: repo('app-b') });
  const deHfs = closeIssueArgs({ issue: 12, reason: 'completed', repo: repo(DEFAULT_PROJECT_ID) });

  assert.equal(deBeta[deBeta.indexOf('-R') + 1], BETA);
  assert.equal(deHfs[deHfs.indexOf('-R') + 1], HFS);
  // El mismo número de issue en dos repositorios: cerrar el equivocado es un
  // error público, que es la regresión que este archivo existe para evitar.
  assert.notDeepEqual(deBeta, deHfs);
});

test('closeIssue le pasa a closeIssueArgs el repo() de su proyecto', () => {
  // `closeIssue` no se puede llamar sin `gh`. Lo que sí se puede comprobar sin
  // red es que no invente el repositorio por su cuenta.
  // Normalizado a LF antes de buscar: en Windows el árbol se saca con CRLF
  // (`server/src` no está fijado en `.gitattributes`), y entonces `\n}\n` no
  // casa, el corte sale vacío y el test pasaba a fallar por dónde se clonó el
  // repositorio en vez de por lo que dice el código.
  const source = readFileSync(path.join(HERE, '..', 'src', 'github.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('export async function closeIssue('));
  const upToEnd = body.slice(0, body.indexOf('\n}\n') + 1);

  assert.match(upToEnd, /closeIssueArgs\(\{[^}]*repo: repo\(project\)/, 'el repositorio sale de repo(project)');
});

// ---------------------------------------------------------------------------
// La marca invisible

test('closingCommentMarker es estable y lleva el número del issue', () => {
  assert.equal(closingCommentMarker(942), '<!-- claude-agent:issue-close:942 -->');
  assert.equal(closingCommentMarker('942'), closingCommentMarker(942));
  assert.notEqual(closingCommentMarker(942), closingCommentMarker(943));
  assert.ok(closingCommentMarker(942).includes('942'));
});

test('la marca pasa el filtro de publicación y no nombra al tablero', () => {
  const marker = closingCommentMarker(942);
  assert.deepEqual(publishProblems(marker), [], 'la marca viaja dentro del texto que cruza la puerta');
  // Hacia fuera esto es claude-agent: `publishProblems` rechaza el nombre del
  // tablero, así que una marca que lo llevara bloquearía todos los cierres.
  assert.ok(!/hfs[\s_-]*monitor/i.test(marker), marker);

  // Y pegada a un comentario de verdad tampoco estorba.
  const body = `This is already covered by the validator crate.\n\n${marker}\n`;
  assert.deepEqual(publishProblems(body, { maxChars: 20_000 }), []);
});

// ---------------------------------------------------------------------------
// Encontrar el comentario anterior

const MARK = closingCommentMarker(942);
const MINE = 'claude-agent-bot';

/** Un comentario tal y como lo devuelve `issueComments`. */
const c = (over = {}) => ({
  id: 1,
  author: MINE,
  body: 'texto',
  url: `https://github.com/${HFS}/issues/942#issuecomment-${over.id ?? 1}`,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

test('sin comentarios no hay nada que editar', () => {
  assert.deepEqual(
    findPriorClosingComment([], { commentId: null, marker: MARK, login: MINE }),
    { comment: null, how: 'none' },
  );
});

test('el id guardado gana a la marca', () => {
  const porId = c({ id: 10, body: 'sin marca' });
  const porMarca = c({ id: 11, body: `otra cosa\n\n${MARK}` });
  const out = findPriorClosingComment([porMarca, porId], { commentId: 10, marker: MARK, login: MINE });

  assert.equal(out.how, 'id');
  assert.equal(out.comment, porId);
});

test('el id se compara como cadena: 10 y "10" son el mismo comentario', () => {
  const mio = c({ id: 10 });
  assert.equal(findPriorClosingComment([mio], { commentId: '10', marker: MARK, login: MINE }).how, 'id');
  assert.equal(findPriorClosingComment([c({ id: '10' })], { commentId: 10, marker: MARK, login: MINE }).how, 'id');
});

test('un id guardado que apunta al comentario de OTRO es dato corrupto: foreign y nada más', () => {
  const ajeno = c({ id: 10, author: 'eterceros', body: `algo\n\n${MARK}` });
  const mio = c({ id: 11, body: `lo nuestro\n\n${MARK}` });
  const out = findPriorClosingComment([ajeno, mio], { commentId: 10, marker: MARK, login: MINE });

  // No se cae hacia la marca: guardamos un id que no es nuestro, y eso hay que
  // mirarlo antes de escribir nada en público.
  assert.equal(out.how, 'foreign');
  assert.equal(out.comment, null);
});

test('un id que ya no está (lo borraron) sigue por la marca', () => {
  const mio = c({ id: 11, body: `lo nuestro\n\n${MARK}` });
  const out = findPriorClosingComment([mio], { commentId: 10, marker: MARK, login: MINE });

  assert.equal(out.how, 'marker');
  assert.equal(out.comment, mio);
});

test('«Quote reply»: una marca citada por otra persona NO bloquea el cierre', () => {
  // GitHub copia el markdown crudo al citar, marca HTML incluida. Si la marca
  // bastara para dar por nuestro ese comentario, el tablero intentaría editar
  // el comentario de un humano; si además diera por publicado el cierre, el
  // issue no se cerraría nunca.
  const cita = c({ id: 20, author: 'eterceros', body: `> Closing because…\n>\n> ${MARK}\n\nDe acuerdo.` });
  const out = findPriorClosingComment([cita], { commentId: null, marker: MARK, login: MINE });

  assert.deepEqual(out, { comment: null, how: 'none' }, 'no es nuestro, pero sí se publica uno nuevo');
});

test('entre varias marcas propias gana la más reciente', () => {
  const vieja = c({ id: 30, createdAt: '2026-09-01T00:00:00Z', body: `v1\n\n${MARK}` });
  const nueva = c({ id: 31, createdAt: '2026-09-20T00:00:00Z', body: `v2\n\n${MARK}` });
  const media = c({ id: 32, createdAt: '2026-09-10T00:00:00Z', body: `v3\n\n${MARK}` });

  const out = findPriorClosingComment([vieja, nueva, media], { commentId: null, marker: MARK, login: MINE });
  assert.equal(out.how, 'marker');
  assert.equal(out.comment, nueva);
});

test('solo se miran las marcas propias, aunque haya citas de otros por medio', () => {
  const cita = c({ id: 40, author: 'eterceros', createdAt: '2026-09-30T00:00:00Z', body: `> ${MARK}` });
  const mio = c({ id: 41, createdAt: '2026-09-02T00:00:00Z', body: `lo nuestro\n\n${MARK}` });

  const out = findPriorClosingComment([cita, mio], { commentId: null, marker: MARK, login: MINE });
  assert.equal(out.comment, mio, 'la cita es más reciente y aun así no cuenta');
});

test('la marca de OTRO issue no cuenta como nuestra', () => {
  const otro = c({ id: 50, body: `de otro issue\n\n${closingCommentMarker(943)}` });
  assert.equal(findPriorClosingComment([otro], { commentId: null, marker: MARK, login: MINE }).how, 'none');
});

test('sin login se lanza: nunca se comparan autores contra null', () => {
  for (const login of [null, undefined, '']) {
    assert.throws(
      () => findPriorClosingComment([c()], { commentId: null, marker: MARK, login }),
      /needs our own login/,
      `login=${JSON.stringify(login)}`,
    );
  }
});

test('sin marca se lanza: una marca vacía la lleva cualquier comentario', () => {
  assert.throws(
    () => findPriorClosingComment([c()], { commentId: null, marker: '', login: MINE }),
    /needs the marker/,
  );
});
