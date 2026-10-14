// Qué repositorio recibe cada llamada a GitHub.
//
// `github.js` ESCRIBE en GitHub: abre PRs, los marca listos, pide revisiones y
// comenta. Un `-R` equivocado no es un test en rojo, es un error público en el
// repositorio de otro equipo. Hasta ahora nada comprobaba de dónde salía ese
// `-R`: `repo()` cacheaba un único valor para todo el proceso y ninguna prueba
// lo miraba fuera de `repo-identity.test.mjs`, que solo conocía un proyecto.
//
// Aquí no hay red y no hay `gh`: todo lo que se comprueba —la resolución del
// repositorio, la caché por proyecto y la clave de la caché de ramas— ocurre
// antes de que se construya una sola línea de comando.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repo, forgetRepoCache, prBranchCacheKey, addReviewer } from '../src/github.js';
import { saveProjects } from '../src/projects.js';
import { config } from '../src/config.js';
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];

/** Un repo git de usar y tirar, con `origin` si se le da una URL. */
function initRepo(originUrl) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-ghrepo-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (originUrl) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

/** Una entrada de registro completa; solo se escribe lo que la prueba mira. */
const entry = (id, over = {}) => ({
  id,
  name: id,
  repoPath: over.repoPath ?? path.join(tmpdir(), `hfsmon-ghrepo-${id}`),
  worktreeRoot: path.join(tmpdir(), `hfsmon-ghrepo-${id}-wt`),
  repo: null,
  assignee: 'eterceros',
  reviewer: 'eterceros',
  overrides: {},
  ...over,
});

const BETA = 'eterceros/app-b';
const HFS = 'HeliosSoftware/hfs';

/**
 * Deja el registro y la caché de `repo()` en un estado conocido. El registro
 * es un módulo con caché propia y `repo()` cachea de por vida, así que sin
 * esto el orden de las pruebas decidiría el resultado.
 */
function registry(list) {
  saveProjects(list);
  forgetRepoCache();
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Un repositorio por proyecto

test('repo(id): cada proyecto responde con SU repositorio, no con el del tablero', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  registry([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: BETA })]);

  assert.equal(repo('app-b'), BETA);
  assert.equal(repo(DEFAULT_PROJECT_ID), HFS);
  assert.notEqual(repo('app-b'), repo(DEFAULT_PROJECT_ID));

  // Sin argumento ya NO es el proyecto de siempre: lanza, en vez de apuntar a hfs.
  assert.throws(() => repo(), /missing project/);
});

test('repo(id): el proyecto por defecto lee `config` en vivo; los demás, su entrada del registro', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  // El registro dice una cosa del proyecto por defecto y `config` otra. Gana
  // `config`: el registro congela su semilla en la primera carga mientras
  // `config.json` se recarga en caliente, y `repo-identity.test.mjs` depende
  // de esa lectura viva. Es la misma excepción que `machineFor` en keys.js.
  config.github.repo = 'Config/Wins';
  registry([entry(DEFAULT_PROJECT_ID, { repo: 'Registro/Pierde' }), entry('app-b', { repo: BETA })]);

  assert.equal(repo(DEFAULT_PROJECT_ID), 'Config/Wins');
  assert.equal(repo('app-b'), BETA, 'el otro proyecto no lee `config` en absoluto');
});

test('repo(id): sin `repo` en la entrada, se detecta desde el origin de ESE checkout', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  const checkout = initRepo('git@github.com:eterceros/app-b.git');
  registry([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: null, repoPath: checkout })]);

  assert.equal(repo('app-b'), BETA, 'el origin del checkout del proyecto, no el del tablero');
});

// ---------------------------------------------------------------------------
// La caché es por id

test('repo(id): la caché es por proyecto — un repositorio irresoluble no contamina a los demás', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  const sinOrigin = initRepo(null);
  registry([
    entry(DEFAULT_PROJECT_ID),
    entry('app-b', { repo: BETA }),
    entry('roto', { repo: null, repoPath: sinOrigin }),
  ]);

  assert.throws(() => repo('roto'), /could not determine the GitHub repository/);
  // Y el fallo se cachea como Error, igual que antes: un origin roto no vuelve
  // a llamar a `git` en cada acción.
  let first;
  let second;
  try { repo('roto'); } catch (e) { first = e; }
  try { repo('roto'); } catch (e) { second = e; }
  assert.equal(first, second, 'el mismo Error vuelve: el fallo se cachea, no se reintenta');

  // Lo que la caché única rompía: el fallo de uno era el fallo de todos.
  assert.equal(repo('app-b'), BETA);
  assert.equal(repo(DEFAULT_PROJECT_ID), HFS);
});

test('repo(id): cada id guarda su propia entrada — cambiar uno no mueve al otro', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  registry([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: BETA })]);

  assert.equal(repo('app-b'), BETA);
  assert.equal(repo(DEFAULT_PROJECT_ID), HFS);

  // El registro cambia bajo los pies. Lo ya resuelto sigue cacheado —de por
  // vida, como siempre— y olvidar un id no toca al otro.
  saveProjects([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: 'eterceros/otro' })]);
  assert.equal(repo('app-b'), BETA, 'lo resuelto se queda resuelto');
  forgetRepoCache('app-b');
  assert.equal(repo('app-b'), 'eterceros/otro', 'y solo ese id se vuelve a leer');
  assert.equal(repo(DEFAULT_PROJECT_ID), HFS, 'el otro id no se enteró');
});

// ---------------------------------------------------------------------------
// Un proyecto que el registro no conoce

test('repo(id): un proyecto desconocido lanza — nunca contesta con el repositorio del tablero', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  registry([entry(DEFAULT_PROJECT_ID)]);

  // Contestar HFS aquí sería exactamente el error público que esta prueba
  // existe para impedir: un `gh pr create` del proyecto equivocado.
  assert.throws(() => repo('fantasma'), /no project registered/);

  // Y no se cachea: el registro puede ganar ese proyecto sin reiniciar.
  saveProjects([entry(DEFAULT_PROJECT_ID), entry('fantasma', { repo: 'eterceros/fantasma' })]);
  assert.equal(repo('fantasma'), 'eterceros/fantasma');
});

// ---------------------------------------------------------------------------
// Los puntos de escritura, antes de tocar la red

test('addReviewer: sin revisor en la entrada del proyecto, falla aquí y no en GitHub', async (t) => {
  const saved = config.github.reviewer;
  t.after(() => { config.github.reviewer = saved; forgetRepoCache(); });
  // El tablero sí tiene revisor: si `addReviewer` siguiera leyendo `config`,
  // pediría la revisión a la persona equivocada en el repositorio de otro.
  config.github.reviewer = 'eterceros';
  registry([
    entry(DEFAULT_PROJECT_ID, { repo: HFS }),
    entry('app-b', { repo: BETA, reviewer: null }),
  ]);

  await assert.rejects(
    () => addReviewer(7, 'app-b'),
    /no declara un revisor/,
    'se para antes de construir el `gh pr edit`, así que nunca llega un --add-reviewer vacío',
  );
});

// ---------------------------------------------------------------------------
// La caché de ramas

test('prBranchCacheKey: la misma rama en dos repositorios son dos claves', (t) => {
  const saved = config.github.repo;
  t.after(() => { config.github.repo = saved; forgetRepoCache(); });
  config.github.repo = HFS;
  registry([entry(DEFAULT_PROJECT_ID), entry('app-b', { repo: BETA })]);

  const branch = 'fix/12-algo';
  const deHfs = prBranchCacheKey(branch, DEFAULT_PROJECT_ID);
  const deBeta = prBranchCacheKey(branch, 'app-b');

  assert.notEqual(deHfs, deBeta, 'un nombre de rama por sí solo colisiona entre repositorios');
  assert.ok(deHfs.startsWith(`${HFS}:`), deHfs);
  assert.ok(deBeta.startsWith(`${BETA}:`), deBeta);
  assert.ok(deHfs.endsWith(branch) && deBeta.endsWith(branch));

  // `origin/` no hace una rama distinta: la clave es la rama pelada.
  assert.equal(prBranchCacheKey(`origin/${branch}`, 'app-b'), deBeta);
  // Y sin proyecto, lanza: nunca la clave de hfs.
  assert.throws(() => prBranchCacheKey(branch), /missing project/);
});

test('prsForBranch usa esa clave y no una compuesta a mano', () => {
  // No se puede llamar a `prsForBranch` sin `gh`, y la caché es privada del
  // módulo: lo que se puede comprobar sin red es que la función no vuelva a
  // construir su clave por su cuenta, que es como se separarían.
  // Normalizado a LF antes de buscar: en Windows el árbol se saca con CRLF
  // (`server/src` no está fijado en `.gitattributes`), y entonces `\n}\n` no
  // casa, el corte sale vacío y el test pasaba a fallar por dónde se clonó el
  // repositorio en vez de por lo que dice el código.
  const source = readFileSync(path.join(HERE, '..', 'src', 'github.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('export async function prsForBranch'));
  const upToEnd = body.slice(0, body.indexOf('\n}\n') + 1);

  assert.match(upToEnd, /prBranchCacheKey\(/, 'la clave sale del constructor exportado');
  assert.ok(
    !/prBranchCache\.(get|set)\(`/.test(upToEnd),
    'ninguna plantilla de cadena vuelve a componer la clave dentro de la función',
  );
});
