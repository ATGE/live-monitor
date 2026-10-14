import './isolate.mjs';
// La migración de arranque del store y el modelo Fable.
//
// Regla del mantenedor: nada del tablero usa Fable. Un chat cuyo `model` guardado sea
// Fable (llegado de una mudanza o del almacén del runner) seguiría pidiéndolo en
// silencio, porque `familyOf` ya no lo reconoce y la migración lo dejaba pasar.
// Aquí se comprueba que vuelve al modelo por defecto, y que NADA más se toca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './isolate.mjs';

const chat = (id, model) => ({
  id, title: `chat ${id}`, sessionId: null, messages: [], createdAt: '2026-01-01T00:00:00.000Z',
  ...(model === undefined ? {} : { model }),
});
const MODELOS = {
  fable: 'fable',
  version: 'claude-fable-5-1',
  etiqueta: 'Fable 5',
  opus: 'opus',
  opusVersion: 'claude-opus-5-5',
  sinModelo: undefined,
  ajeno: 'gpt-x',
};
const VIEJO = {
  9: {
    issue: 9, title: 'con chats de todo tipo', labels: [], url: 'x', state: 'pr_draft', log: [],
    chats: Object.keys(MODELOS).map((k) => chat(k, MODELOS[k])),
  },
};
writeFileSync(path.join(DATA_DIR, 'tasks.json'), JSON.stringify(VIEJO, null, 2), 'utf8');

const { store, migrateChatModels } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const available = config.claude?.available ?? [];
const task = store.get(9);
const de = (id) => task.chats.find((c) => c.id === id);

test('la configuración de la prueba no ofrece Fable (premisa)', () => {
  assert.ok(!available.some((m) => /fable/i.test(m.id)), 'si Fable estuviera configurado, la prueba no diría nada');
  assert.ok(available.some((m) => m.id === 'opus'), 'y opus sí, para probar el paso a familia');
});

test('un chat con model «fable» vuelve al modelo por defecto', () => {
  assert.equal(de('fable').model ?? null, null, 'null es lo que todo consumidor lee como config.claude.chatModel');
});

test('un chat con «claude-fable-5-1» vuelve al modelo por defecto', () => {
  assert.equal(de('version').model ?? null, null, 'el id de versión de Fable también se limpia');
});

test('un chat con la etiqueta «Fable 5» vuelve al modelo por defecto', () => {
  assert.equal(de('etiqueta').model ?? null, null, 'la forma de etiqueta también se limpia');
});

test('un chat en «opus» se queda exactamente como estaba', () => {
  assert.equal(de('opus').model, 'opus', 'un modelo válido no se toca');
});

test('un chat en «claude-opus-5-5» pasa a su familia, como antes', () => {
  assert.equal(de('opusVersion').model, 'opus', 'la migración de versión a familia sigue funcionando');
});

test('un chat sin modelo no gana ningún campo', () => {
  assert.ok(!('model' in de('sinModelo')), 'sin model sigue sin model: la forma no cambia');
});

test('un chat con un id desconocido que no es Fable («gpt-x») no se toca', () => {
  assert.equal(de('ajeno').model, 'gpt-x', 'la regla es sobre Fable, no sobre «todo lo que no esté en available»');
});

test('el log de la tarea nombra cada chat reseteado, en inglés, y solo esos', () => {
  const lineas = task.log.filter((l) => /used Fable/.test(l.line)).map((l) => l.line);
  assert.deepEqual(lineas.sort(), [
    'chat «chat etiqueta» used Fable, which the board no longer uses: it goes back to the default model',
    'chat «chat fable» used Fable, which the board no longer uses: it goes back to the default model',
    'chat «chat version» used Fable, which the board no longer uses: it goes back to the default model',
  ], 'una línea por chat de Fable y ninguna por los demás');
});

test('correr la migración otra vez no cambia nada ni escribe más log', () => {
  const antes = JSON.stringify(task);
  migrateChatModels(task, available, (l) => task.log.push({ line: l }));
  assert.equal(JSON.stringify(task), antes, 'idempotente: el segundo pase no encuentra nada que hacer');
});

test('un Fable que llega después del arranque se limpia en la siguiente pasada', () => {
  const t = { chats: [chat('x', 'claude-fable-5-1'), chat('y', 'gpt-x')] };
  const lineas = [];
  migrateChatModels(t, available, (l) => lineas.push(l));
  assert.equal(t.chats[0].model, null, 'el Fable se limpia');
  assert.equal(t.chats[1].model, 'gpt-x', 'el desconocido no');
  assert.equal(lineas.length, 1, 'y solo se avisa del primero');
});

test('si Fable volviera a estar configurado, el chat no se limpia', () => {
  const t = { chats: [chat('x', 'claude-fable-5-1')] };
  migrateChatModels(t, [...available, { id: 'fable', label: 'Fable' }], () => {});
  assert.equal(t.chats[0].model, 'fable', 'entonces es una familia del tablero y pasa a ella, como cualquier otra');
});
