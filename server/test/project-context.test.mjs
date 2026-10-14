// El descriptor del proyecto vigilado: de dónde sale, y cuándo se relee.
//
// Todo ocurre en directorios temporales. Leer el checkout de hfs desde aquí
// ataría la prueba a un archivo que edita el equipo de hfs, y se pondría roja
// sola el día que alguien de allí guardara un párrafo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { projectContextFor, DESCRIPTOR_PATHS } from '../src/project-context.js';

/** Un checkout de mentira, borrado al terminar la prueba que lo pidió. */
function fakeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-projctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Escribe `<repo>/<rel>`, creando el directorio que haga falta. */
function writeDescriptor(repo, rel, text) {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('sin descriptor la respuesta es la cadena vacía', (t) => {
  const repo = fakeRepo(t);
  assert.equal(projectContextFor({ repoPath: repo }), '');
});

test('sin repoPath la respuesta es la cadena vacía, sin tocar el disco', () => {
  assert.equal(projectContextFor({}), '');
  assert.equal(projectContextFor({ repoPath: '' }), '');
  assert.equal(projectContextFor({ repoPath: undefined }), '');
  assert.equal(projectContextFor(), '');
});

test('`.hfs-monitor/project.md` sirve cuando es el único que hay', (t) => {
  const repo = fakeRepo(t);
  writeDescriptor(repo, path.join('.hfs-monitor', 'project.md'), 'el viejo nombre\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'el viejo nombre\n');
});

test('`.board/project.md` gana sobre `.hfs-monitor/project.md`', (t) => {
  const repo = fakeRepo(t);
  writeDescriptor(repo, path.join('.hfs-monitor', 'project.md'), 'el viejo nombre\n');
  writeDescriptor(repo, path.join('.board', 'project.md'), 'el nombre nuevo\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'el nombre nuevo\n');
});

test('el orden de preferencia es el que declara el módulo', () => {
  assert.deepEqual(DESCRIPTOR_PATHS, [
    path.join('.board', 'project.md'),
    path.join('.hfs-monitor', 'project.md'),
  ]);
});

test('el texto vuelve verbatim, con su salto final', (t) => {
  const repo = fakeRepo(t);
  const text = '# Proyecto\n\nDos párrafos.\n\nY un cierre.\n';
  writeDescriptor(repo, path.join('.board', 'project.md'), text);
  assert.equal(projectContextFor({ repoPath: repo }), text);
});

// Segundos enteros a propósito. El mtime de un archivo recién escrito tiene
// precisión de sub-milisegundo, y devolvérselo a `utimesSync` como `Date` la
// pierde: el mtime «restaurado» no es el de antes y la caché se invalidaría
// por el redondeo, no por lo que la prueba quiere comprobar.
const STAMP = 1_700_000_000;
const stamp = (file, seconds) => utimesSync(file, seconds, seconds);

test('la caché sirve la copia guardada mientras el mtime no se mueva', (t) => {
  const repo = fakeRepo(t);
  const file = writeDescriptor(repo, path.join('.board', 'project.md'), 'primera versión\n');
  stamp(file, STAMP);
  assert.equal(projectContextFor({ repoPath: repo }), 'primera versión\n');

  // Mismo mtime, contenido distinto: es exactamente lo que la caché ignora.
  writeFileSync(file, 'escrita a escondidas\n');
  stamp(file, STAMP);
  assert.equal(statSync(file).mtimeMs, STAMP * 1000, 'el mtime no se restauró igual');

  assert.equal(projectContextFor({ repoPath: repo }), 'primera versión\n');
});

test('cambiar el mtime invalida la caché: recarga en caliente', (t) => {
  const repo = fakeRepo(t);
  const file = writeDescriptor(repo, path.join('.board', 'project.md'), 'primera versión\n');
  stamp(file, STAMP);
  assert.equal(projectContextFor({ repoPath: repo }), 'primera versión\n');

  writeFileSync(file, 'segunda versión\n');
  stamp(file, STAMP + 60);

  assert.equal(projectContextFor({ repoPath: repo }), 'segunda versión\n');
});

test('un `.board/project.md` que aparece después desplaza al `.hfs-monitor`', (t) => {
  const repo = fakeRepo(t);
  writeDescriptor(repo, path.join('.hfs-monitor', 'project.md'), 'el viejo nombre\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'el viejo nombre\n');

  writeDescriptor(repo, path.join('.board', 'project.md'), 'el nombre nuevo\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'el nombre nuevo\n');
});

test('borrar el descriptor vuelve a la cadena vacía, no a la copia en caché', (t) => {
  const repo = fakeRepo(t);
  const file = writeDescriptor(repo, path.join('.board', 'project.md'), 'existió\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'existió\n');

  rmSync(file);
  assert.equal(projectContextFor({ repoPath: repo }), '');
});

test('un directorio llamado project.md no es un descriptor', (t) => {
  const repo = fakeRepo(t);
  mkdirSync(path.join(repo, '.board', 'project.md'), { recursive: true });
  writeDescriptor(repo, path.join('.hfs-monitor', 'project.md'), 'el fallback\n');
  assert.equal(projectContextFor({ repoPath: repo }), 'el fallback\n');
});
