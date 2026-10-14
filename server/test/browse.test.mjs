import './isolate.mjs';

// El navegador de carpetas, contra un disco de verdad.
//
// `browse.js` llega a `projects.js` —un escritor del directorio de datos— así
// que `./isolate.mjs` va en la primera línea, y el `projects.json` de prueba se
// escribe en el cuerpo del archivo, antes de cualquier `import('../src/…')`:
// el registro se carga una sola vez y se queda con lo que encuentre.
//
// Las raíces son las carpetas **padre** de los `repoPath` registrados más el
// home, y el home viene de `browseHooks.homeDir`, que aquí se desvía a un
// directorio temporal: ninguna prueba lista el home real de nadie.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOST_WIN = process.platform === 'win32';
const DATA_DIR = process.env.HFSMON_DATA_DIR;
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'hfsmon-browse-')));

const SRC = path.join(ROOT, 'src');             // raíz A: padre de dos repoPath
const HOME = path.join(ROOT, 'home');           // raíz B: el «home» de esta prueba
const OUTSIDE = path.join(ROOT, 'outside');     // fuera de toda raíz
const ALPHA = path.join(SRC, 'alpha');          // checkout: `.git` es carpeta
const BETA = path.join(SRC, 'beta');            // worktree: `.git` es archivo
const ZETA = path.join(SRC, 'Zeta');            // para el orden sin mayúsculas
const ESCAPE = path.join(SRC, 'escape');        // enlace a `outside`
const GONE = path.join(ROOT, 'ausente');        // raíz que no existe

const toSlash = (p) => p.replace(/\\/g, '/');
const dir = (...parts) => { const p = path.join(...parts); mkdirSync(p, { recursive: true }); return p; };

const project = (id, repoPath) => ({
  id, name: id, repoPath, worktreeRoot: `${repoPath}-wt`,
  repo: null, assignee: 'nobody', reviewer: null, overrides: {},
});

dir(ALPHA, '.git');
dir(ALPHA, 'sub');
dir(ALPHA, '.oculta');
writeFileSync(path.join(ALPHA, 'nota.txt'), 'x');
dir(BETA);
writeFileSync(path.join(BETA, '.git'), 'gitdir: ../alpha/.git/worktrees/beta\n');
dir(ZETA);
dir(SRC, '.escondida');
writeFileSync(path.join(SRC, 'suelto.txt'), 'x');
dir(HOME, 'proyectos');
dir(OUTSIDE, 'secreto');
symlinkSync(OUTSIDE, ESCAPE, 'junction');

// El cuarto proyecto cuelga del home, escrito con barras: su padre y
// `homeDir()` (que trae contrabarras en Windows) son la misma carpeta con dos
// grafías, y solo `samePath` las junta. La tercera raíz no existe: se descarta.
writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([
  project('alpha', ALPHA),
  project('beta', BETA),
  project('gone', path.join(GONE, 'repo')),
  project('encasa', `${toSlash(HOME)}/proyectos`),
], null, 2), 'utf8');

let browse;
let server;
let port;
let savedHome;

before(async () => {
  browse = await import('../src/browse.js');
  savedHome = browse.browseHooks.homeDir;
  browse.browseHooks.homeDir = () => HOME;

  const express = (await import('express')).default;
  const app = express();
  app.use(browse.browseRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
});

after(async () => {
  if (savedHome) browse.browseHooks.homeDir = savedHome;
  await new Promise((r) => server.close(r));
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

async function call(query = '', headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/browse${query}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ask = (p) => call(`?path=${encodeURIComponent(p)}`);
const names = (body) => body.entries.map((e) => e.name);

/** Corre `fn` con las llamadas al disco anotadas, sin cambiar lo que hacen. */
async function watchingDisk(fn) {
  const seen = [];
  const saved = { realpath: fsp.realpath, stat: fsp.stat, readdir: fsp.readdir };
  for (const name of Object.keys(saved)) {
    fsp[name] = (...args) => { seen.push(`${name}:${args[0]}`); return saved[name](...args); };
  }
  try {
    await fn(seen);
  } finally {
    Object.assign(fsp, saved);
  }
  return seen;
}

// --- las raíces ------------------------------------------------------------

test('sin ruta: las raíces, una sola por padre compartido, sin la que no existe', async () => {
  const r = await call();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, null);
  assert.equal(r.body.parent, null);
  assert.equal(r.body.truncated, false);
  // `src` (padre de alpha y beta, una vez) y `home` (padre de `encasa`, que es
  // el home con otra grafía). `ausente` no está.
  assert.deepEqual(names(r.body), ['home', 'src']);
  assert.deepEqual(r.body.entries.map((e) => e.path), [toSlash(HOME), toSlash(SRC)]);
  assert.deepEqual(r.body.entries.map((e) => e.isGit), [false, false]);
});

// --- loopback --------------------------------------------------------------

test('solo desde loopback directo: sin cabeceras 200, con cabeceras de proxy 403', async () => {
  assert.equal((await call()).status, 200);
  for (const headers of [
    { 'x-forwarded-for': '100.64.0.9' },
    { 'tailscale-user-login': 'user@example.com' },
    { forwarded: 'for=100.64.0.9' },
  ]) {
    const r = await call('', headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.body.error, /localhost:7420/);
  }
});

// --- la forma de la ruta, antes del disco ----------------------------------

test('una ruta relativa es 400', async () => {
  const r = await ask('src/alpha');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /must be absolute/);
});

test('`/Users/you` no se cuela: en Windows no es absoluta aquí, y nadie le pone la unidad del cwd', async () => {
  assert.equal(path.win32.isAbsolute('/Users/you'), true, 'el falso amigo sigue ahí');
  const r = await ask('/Users/you');
  // En Windows es 400 por no ser absoluta *en esta máquina*; en POSIX sí lo es,
  // y entonces la respuesta correcta es 403 por estar fuera de las raíces.
  assert.equal(r.status, HOST_WIN ? 400 : 403, JSON.stringify(r.body));
  if (HOST_WIN) assert.equal(r.body.error.includes(toSlash(ROOT)), false);
});

test('UNC y flujos alternos: 400 sin tocar el disco', { skip: !HOST_WIN }, async () => {
  const peligrosas = ['\\\\atacante\\share\\x', '//atacante/share/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', `${SRC}:oculto`];
  const seen = await watchingDisk(async () => {
    for (const p of peligrosas) {
      const r = await ask(p);
      assert.equal(r.status, 400, p);
    }
  });
  // El espía sí está puesto: las raíces se resuelven en cada petición.
  assert.ok(seen.length > 0, 'la anotación de llamadas funciona');
  for (const p of ['atacante', 'pipe', 'oculto']) {
    assert.equal(seen.some((c) => c.toLowerCase().includes(p)), false, `${p} no llegó al disco`);
  }
});

test('un segmento `.git` es 400', async () => {
  const r = await ask(path.join(ALPHA, '.git'));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /\.git/);
});

// --- contención, paso 2: sin disco -----------------------------------------

test('un `..` que se sale es 403, y el disco ni se entera de la ruta pedida', async () => {
  const fuera = path.join(SRC, '..', '..', 'no-existe-jamas-hfsmon');
  const seen = await watchingDisk(async () => {
    const r = await ask(fuera);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /Fuera de las carpetas permitidas/);
  });
  // Al disco se le preguntó algo (las raíces), pero nunca por la ruta pedida.
  assert.ok(seen.some((c) => c.includes('realpath:')), 'la anotación de llamadas funciona');
  assert.equal(seen.some((c) => c.includes('no-existe-jamas-hfsmon')), false,
    'una ruta fuera de toda raíz no se le pregunta al disco: el 404 distinguible del 403 delataría qué existe');
});

test('exista o no, fuera de las raíces dice lo mismo', async () => {
  const ausente = path.join(ROOT, 'jamas');
  const existe = await ask(OUTSIDE);
  const no = await ask(ausente);
  assert.equal(existe.status, 403);
  assert.equal(no.status, 403);
  // El mensaje solo repite la ruta que pidió quien llama; quitada esa, es
  // literalmente el mismo texto, así que no dice si la carpeta está ahí.
  const strip = (msg, p) => msg.replace(p, 'X').replace(toSlash(p), 'X');
  assert.equal(strip(existe.body.error, OUTSIDE), strip(no.body.error, ausente));
  assert.equal(strip(existe.body.error, OUTSIDE), 'Fuera de las carpetas permitidas: X');
});

// --- contención, paso 4: sobre la ruta real --------------------------------

test('un enlace dentro de una raíz que apunta fuera es 403, y no se lista', async () => {
  const r = await ask(ESCAPE);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.error, /Fuera de las carpetas permitidas/);
  const listado = await ask(SRC);
  assert.equal(listado.body.entries.some((e) => e.name === 'escape'), false);
});

// --- lo que se lista y lo que no -------------------------------------------

test('solo carpetas: ni archivos, ni ocultas, ni enlaces; orden sin distinguir mayúsculas', async () => {
  const r = await ask(SRC);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(names(r.body), ['alpha', 'beta', 'Zeta']);
  assert.equal(r.body.path, toSlash(SRC));
  assert.equal(r.body.truncated, false);
  // Cada entrada trae su ruta absoluta, en forma canónica con barras.
  assert.deepEqual(r.body.entries.map((e) => e.path), [ALPHA, BETA, ZETA].map(toSlash));
});

test('`isGit` es que `.git` sea una CARPETA: el worktree no cuenta', async () => {
  const r = await ask(SRC);
  const byName = Object.fromEntries(r.body.entries.map((e) => [e.name, e.isGit]));
  assert.deepEqual(byName, { alpha: true, beta: false, Zeta: false });
});

test('dentro de un checkout: `.git` y `.oculta` fuera, y el padre es la raíz', async () => {
  const r = await ask(ALPHA);
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body), ['sub']);
  assert.equal(r.body.parent, toSlash(SRC));
});

test('en la raíz no hay padre: por encima ya no hay nada permitido', async () => {
  const r = await ask(SRC);
  assert.equal(r.body.parent, null);
});

test('el tope corta y lo dice', async () => {
  const saved = browse.browseHooks.maxEntries;
  browse.browseHooks.maxEntries = 2;
  try {
    const r = await ask(SRC);
    assert.equal(r.body.truncated, true);
    assert.deepEqual(names(r.body), ['alpha', 'beta']);
  } finally {
    browse.browseHooks.maxEntries = saved;
  }
});

// --- el disco responde otra cosa -------------------------------------------

test('un archivo es 400, no 404', async () => {
  const r = await ask(path.join(SRC, 'suelto.txt'));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Not a folder/);
});

test('lo que no existe DENTRO de una raíz sí es 404', async () => {
  const r = await ask(path.join(SRC, 'no-esta'));
  assert.equal(r.status, 404, JSON.stringify(r.body));
});

test('una raíz que no existe se descarta, no rompe la petición', async () => {
  // `gone` sigue en el registro y `ROOT/ausente` sigue sin existir.
  assert.equal(await fsp.stat(GONE).then(() => true, () => false), false);
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(names(r.body).includes('ausente'), false);
});

// --- la raíz de la unidad ---------------------------------------------------

test('en la raíz de la unidad `parent` es null porque `dirname` ya no se mueve', async () => {
  const drive = path.parse(ROOT).root;                     // `C:\` o `/`
  const saved = browse.browseHooks.homeDir;
  browse.browseHooks.homeDir = () => drive;
  try {
    const r = await ask(drive);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.parent, null);
    assert.equal(r.body.path, toSlash(realpathSync(drive)));
  } finally {
    browse.browseHooks.homeDir = saved;
  }
});
