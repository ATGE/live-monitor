import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TABS, normalizeTabs, openTab, closeTab, pruneTabs, sealTabs } from '../src/chattabs.js';

const issues = (tabs) => tabs.map((t) => t.issue);
const task = (issue, project = 'hfs') => ({ project, issue });

test('abrir añade la pestaña al final con su proyecto y su momento de uso', () => {
  let tabs = openTab([], task(937), 100);
  tabs = openTab(tabs, task(1078), 200);
  assert.deepEqual(tabs, [
    { project: 'hfs', issue: 937, usedAt: 100 },
    { project: 'hfs', issue: 1078, usedAt: 200 },
  ]);
});

test('el mismo número en dos proyectos son dos pestañas', () => {
  let tabs = openTab([], task(12, 'hfs'), 1);
  tabs = openTab(tabs, task(12, 'app-b'), 2);
  assert.equal(tabs.length, 2);
  assert.deepEqual(closeTab(tabs, task(12, 'hfs')), [{ project: 'app-b', issue: 12, usedAt: 2 }]);
  tabs = openTab(tabs, task(12, 'hfs'), 9);
  assert.equal(tabs.length, 2, 'reabrir una no crea otra');
  assert.equal(tabs[0].usedAt, 9);
});

test('reabrir una pestaña conserva su sitio y solo actualiza cuándo se usó', () => {
  let tabs = openTab([], task(937), 100);
  tabs = openTab(tabs, task(1078), 200);
  tabs = openTab(tabs, task(969), 300);
  tabs = openTab(tabs, task(937), 400);
  assert.deepEqual(issues(tabs), [937, 1078, 969], 'no se mueve al final, como en VS Code');
  assert.equal(tabs[0].usedAt, 400);
});

test('la undécima expulsa la usada hace más tiempo, esté donde esté', () => {
  let tabs = [];
  for (let i = 1; i <= MAX_TABS; i += 1) tabs = openTab(tabs, task(i), i * 10);
  tabs = openTab(tabs, task(1), 1000);        // la primera vuelve a usarse
  tabs = openTab(tabs, task(99), 2000);       // y entra una nueva
  assert.equal(tabs.length, MAX_TABS);
  assert.ok(!issues(tabs).includes(2), 'se va la 2: la de uso más antiguo');
  assert.ok(issues(tabs).includes(1), 'la 1 se queda: se usó hace poco');
  assert.equal(issues(tabs).at(-1), 99);
});

test('la pestaña que se abre nunca es la expulsada, aunque su reloj vaya atrasado', () => {
  let tabs = [];
  for (let i = 1; i <= MAX_TABS; i += 1) tabs = openTab(tabs, task(i), 1000 + i);
  tabs = openTab(tabs, task(99), 0);
  assert.ok(issues(tabs).includes(99));
  assert.ok(!issues(tabs).includes(1), 'se va la más antigua de las demás');
});

test('cerrar quita solo esa pestaña', () => {
  let tabs = openTab([], task(937), 1);
  tabs = openTab(tabs, task(1078), 2);
  tabs = openTab(tabs, task(969), 3);
  assert.deepEqual(issues(closeTab(tabs, task(1078))), [937, 969]);
  assert.deepEqual(issues(closeTab(tabs, task(12345))), [937, 1078, 969], 'cerrar una que no está no rompe nada');
});

test('podar recibe la entrada entera y quita las tareas que el tablero ya no tiene', () => {
  const tabs = [
    { project: 'hfs', issue: 937, usedAt: 1 },
    { project: 'app-b', issue: 551, usedAt: 2 },
    { project: 'hfs', issue: 551, usedAt: 3 },
  ];
  const seen = [];
  const kept = pruneTabs(tabs, (t) => { seen.push(t); return !(t.project === 'hfs' && t.issue === 551); });
  assert.deepEqual(kept.map((t) => `${t.project}#${t.issue}`), ['hfs#937', 'app-b#551']);
  assert.deepEqual(seen[0], tabs[0], 'la entrada completa, no solo el número');
});

test('un objetivo que no es una tarea con proyecto ni un chat de proyecto se rechaza', () => {
  for (const bad of ['937', 937, 0, null, undefined, NaN, {}, { issue: 0, project: 'hfs' }, { issue: 1.5, project: 'hfs' }, { issue: '7', project: 'hfs' }]) {
    assert.throws(() => openTab([], bad), /positive integer/, `abrir ${JSON.stringify(bad)}`);
    assert.throws(() => closeTab([], bad), /positive integer/, `cerrar ${JSON.stringify(bad)}`);
  }
  for (const bad of [{ issue: 5 }, { issue: 5, project: 'Mal Id' }, { issue: 5, project: null }]) {
    assert.throws(() => openTab([], bad), /project/, `sin proyecto válido: ${JSON.stringify(bad)}`);
  }
});

test('lo que venga raro del archivo se limpia, y una pestaña sin proyecto se conserva', () => {
  assert.deepEqual(normalizeTabs(null), []);
  assert.deepEqual(normalizeTabs('x'), []);
  assert.deepEqual(
    normalizeTabs([{ issue: 937, usedAt: 5 }, { issue: '937', usedAt: 9 }, { issue: 'x' }, null, { issue: 12 }]),
    [{ issue: 937, usedAt: 5 }, { issue: 12, usedAt: 0 }],
    'duplicados sobre el primero, basura fuera, usedAt ausente a 0; sin proyecto no se tira',
  );
  assert.deepEqual(
    normalizeTabs([{ project: 'a', issue: 7, usedAt: 1 }, { project: 'b', issue: 7, usedAt: 2 }, { project: 'a', issue: 7, usedAt: 3 }]),
    [{ project: 'a', issue: 7, usedAt: 1 }, { project: 'b', issue: 7, usedAt: 2 }],
  );
});

test('sellar da su proyecto a las pestañas viejas, y una segunda pasada no cambia nada', () => {
  const old = [{ issue: 937, usedAt: 1 }, { project: 'app-b', issue: 937, usedAt: 2 }, { issue: 'p:hfs@local', usedAt: 3 }, { issue: 12, usedAt: 4 }];
  const sealed = sealTabs(old, 'hfs');
  assert.deepEqual(sealed, [
    { project: 'hfs', issue: 937, usedAt: 1 },
    { project: 'app-b', issue: 937, usedAt: 2 },
    { issue: 'p:hfs@local', usedAt: 3 },
    { project: 'hfs', issue: 12, usedAt: 4 },
  ]);
  assert.deepEqual(sealTabs(sealed, 'otro'), sealed);
  assert.deepEqual(sealTabs(old, 'Mal Id'), normalizeTabs(old), 'sin un proyecto válido no se inventa uno');
  assert.deepEqual(
    sealTabs([{ project: 'hfs', issue: 5, usedAt: 9 }, { issue: 5, usedAt: 1 }], 'hfs'),
    [{ project: 'hfs', issue: 5, usedAt: 9 }],
    'al sellar, la vieja que ya existe con proyecto se colapsa sobre la primera',
  );
});
