import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config, mergeInto, ROOT, DATA_DIR } from '../src/config.js';
import { resolveModel, selectableModels } from '../src/models.js';
import { EFFORT_LEVELS, CAPABILITIES } from '../src/effort.js';

/**
 * Guard: nothing in the board may use the Fable model (the maintainer's rule; wherever
 * something asked for it, it is Opus now). It reads the MERGED `config` — the
 * one the server runs on, `config.local.json` overrides included — and the
 * merged config of EVERY registered project (`configFor(id)`), so neither an
 * override on some machine nor a per-project override in `projects.json` slips
 * past it.
 *
 * What counts as "a place a model is named", deliberately wide so a new one
 * does not need the guard edited:
 *   - every value under ANY key that matches /model/i, in any top-level
 *     section (`chat.model`, `retry.fallbackModel`, `modelOverride`, ...);
 *   - the keys `available`, `advisor` and `fallback`, which name models
 *     without containing "model" (listed in EXTRA_MODEL_KEYS);
 *   - under such a key, a string, an array of strings, an object or an array of
 *     those: EVERY string leaf counts (`id`, `label`, `hint`, ...), so Fable in
 *     any field of an `available` entry is caught, not only id/label.
 *
 * Values are only checked for Fable, never forced to be an Anthropic family:
 * `opencode.model` / `opencode.harnessModel` name other vendors' models.
 */
const RULE = 'ninguna parte del tablero usa Fable; si algo lo pide, cámbialo por Opus';

const EXTRA_MODEL_KEYS = /^(available|advisor|fallback|tuning)$/i;
const isModelKey = (key) => /model/i.test(key) || EXTRA_MODEL_KEYS.test(key);

// The family the resolver would map to Fable. The regex is the floor (it
// catches `fable`, `Fable 5`, `claude-fable-5-1`, `x-fable`); the resolver
// adds whatever spelling `/model` itself would have accepted as Fable.
const FABLE_FAMILY = [{ id: 'fable', label: 'Fable' }];
const isFable = (value) => /fable/i.test(String(value ?? '')) || resolveModel(FABLE_FAMILY, value).match?.id === 'fable';

/**
 * Every model-naming value in a config: `[where, value]` pairs. Walks every
 * top-level section; below a model key every string leaf counts, whatever the
 * nesting (string, array of strings, `{ id }`, `[{ id, hint }]`).
 */
function modelValues(cfg) {
  const out = [];
  const leaves = (node, where) => {
    if (typeof node === 'string') out.push([where, node]);
    else if (Array.isArray(node)) node.forEach((v, i) => leaves(v, `${where}[${i}]`));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) leaves(v, `${where}.${k}`);
  };
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = where ? `${where}.${key}` : key;
      if (isModelKey(key)) leaves(value, here);
      else walk(value, here);
    }
  };
  walk(cfg, '');
  return out;
}

/** Human-readable violations; empty when the config is clean. */
const violations = (cfg) => modelValues(cfg)
  .filter(([, value]) => isFable(value))
  .map(([where, value]) => `${where} = ${JSON.stringify(value)}`);

/**
 * The global config plus each registered project's merged config. `projects.js`
 * reads `<DATA_DIR>/projects.json`, and the isolated data dir starts empty (the
 * registry would seed itself with the default project only), so the real
 * registry is copied in first: a read of the live file, a write only to the
 * throwaway directory. `tag` forces a fresh evaluation of the module.
 */
async function configsToCheck(tag) {
  const { listProjects, configFor } = await import(`../src/projects.js?guard=${tag}`);
  return [['global', config], ...listProjects().map((p) => [`proyecto ${p.id}`, configFor(p.id)])];
}

const REAL_REGISTRY = path.join(ROOT, 'server', 'data', 'projects.json');
if (existsSync(REAL_REGISTRY)) copyFileSync(REAL_REGISTRY, path.join(DATA_DIR, 'projects.json'));

test('ningún modelo configurado resuelve a Fable, en el config global ni en el de cada proyecto', async () => {
  const all = await configsToCheck('real');
  assert.equal(all[0][0], 'global');
  if (existsSync(REAL_REGISTRY)) {
    // The registry the guard saw is the real one, not the seeded default.
    const ids = JSON.parse(readFileSync(REAL_REGISTRY, 'utf8')).map((p) => p.id);
    assert.deepEqual(all.slice(1).map(([name]) => name), ids.map((id) => `proyecto ${id}`), 'la guardia no ve el registro de proyectos');
  }
  for (const [name, cfg] of all) {
    const found = modelValues(cfg);
    // Floor: 8 claude roles + 2 qa + 2 opencode + `available` entries (3 fields
    // each) is well above this today; it fails only when the guard sees ~nothing.
    assert.ok(found.length >= 16, `la guardia no ve los modelos de «${name}» (${found.length} valores): revisa modelValues`);
    const bad = violations(cfg);
    assert.deepEqual(bad, [], `${RULE}. En «${name}» lo piden: ${bad.join('; ')}`);
  }
});

// The guard has to be able to fail, or it protects nothing. Each mutation is
// applied to an in-memory clone of the merged config, never to a file.
const mutated = (change) => { const c = structuredClone(config); change(c); return c; };

test('la guardia salta si un rol pide «fable»', () => {
  const bad = violations(mutated((c) => { c.qa.planModel = 'fable'; }));
  assert.deepEqual(bad, ['qa.planModel = "fable"']);
});

test('la guardia salta si un rol pide un id concreto de Fable', () => {
  const bad = violations(mutated((c) => { c.claude.fixModel = 'claude-fable-5-1'; }));
  assert.deepEqual(bad, ['claude.fixModel = "claude-fable-5-1"']);
});

test('la guardia salta si «available» ofrece Fable', () => {
  const bad = violations(mutated((c) => { c.claude.available.push({ id: 'fable', label: 'Fable' }); }));
  assert.equal(bad.length, 2, 'el id y la etiqueta');
  assert.ok(bad.every((b) => b.startsWith('claude.available[')));
});

test('la guardia salta si un modelo con Fable cuelga de un objeto anidado', () => {
  const bad = violations(mutated((c) => { c.qa.extra = { replyModel: 'Fable 5' }; }));
  assert.deepEqual(bad, ['qa.extra.replyModel = "Fable 5"']);
});

test('la guardia salta con FABLE en mayúsculas', () => {
  const bad = violations(mutated((c) => { c.claude.chatModel = 'FABLE'; }));
  assert.deepEqual(bad, ['claude.chatModel = "FABLE"']);
});

// Evasion 1: sections other than `claude` and `qa`.
for (const [section, key] of [
  ['chat', 'model'], ['plan', 'model'], ['ask', 'model'], ['retry', 'fallbackModel'],
  ['e2e', 'model'], ['opencode', 'model'], ['opencode', 'harnessModel'],
]) {
  test(`la guardia salta si «${section}.${key}» pide Fable (sección fuera de claude/qa)`, () => {
    const bad = violations(mutated((c) => { c[section] = { ...c[section], [key]: 'fable' }; }));
    assert.deepEqual(bad, [`${section}.${key} = "fable"`]);
  });
}

test('las claves de opencode, de otro proveedor, no se fuerzan a opus/sonnet/haiku', () => {
  // False-positive check: the real values are not Anthropic families and pass.
  const oc = modelValues(config).filter(([where]) => where.startsWith('opencode.'));
  assert.ok(oc.length >= 2, 'la guardia sí ve las claves de opencode');
  assert.deepEqual(violations(mutated((c) => { c.opencode.model = 'opencode-go/qwen3.8-max'; })), []);
  assert.deepEqual(violations(mutated((c) => { c.opencode.model = 'acme/fable-lite'; })), ['opencode.model = "acme/fable-lite"']);
});

// Evasion 2: keys that are not `model` / `*Model`.
test('la guardia salta si la clave solo contiene «model» (modelOverride)', () => {
  const bad = violations(mutated((c) => { c.claude.modelOverride = 'fable'; }));
  assert.deepEqual(bad, ['claude.modelOverride = "fable"']);
});

test('la guardia salta si «claude.advisor» pide Fable', () => {
  const bad = violations(mutated((c) => { c.claude.advisor = 'fable'; }));
  assert.deepEqual(bad, ['claude.advisor = "fable"']);
});

// Evasion 3: an array of strings under `models`.
test('la guardia salta si un array de cadenas bajo «models» trae Fable', () => {
  const bad = violations(mutated((c) => { c.claude.models = ['opus', 'fable']; }));
  assert.deepEqual(bad, ['claude.models[1] = "fable"']);
});

// Evasion 4: other fields of an `available` entry.
test('la guardia salta si Fable está solo en otro campo de «available» (hint)', () => {
  const bad = violations(mutated((c) => { c.claude.available[0].hint = 'el mismo que Fable 5'; }));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^claude\.available\[0\]\.hint = /);
});

// Evasion 5: a model given as an object.
test('la guardia salta si un modelo es un objeto { id: "fable" }', () => {
  const bad = violations(mutated((c) => { c.plan = { ...c.plan, model: { id: 'fable' } }; }));
  assert.deepEqual(bad, ['plan.model.id = "fable"']);
});

test('la guardia salta si un modelo es un array de objetos con label Fable', () => {
  const bad = violations(mutated((c) => { c.ask = { models: [{ id: 'x', label: 'Fable' }] }; }));
  assert.deepEqual(bad, ['ask.models[0].label = "Fable"']);
});

// Evasion 6: per-project overrides. A registry written into the throwaway data
// dir with a poisoned project, read through the same `configFor` path the real
// check uses.
test('la guardia salta si el override de un proyecto pide Fable', async () => {
  writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([
    { id: 'hfs', name: 'hfs', repoPath: '/x', worktreeRoot: '/x-wt', assignee: 'a', overrides: {} },
    { id: 'malo', name: 'Malo', repoPath: '/y', worktreeRoot: '/y-wt', assignee: 'a', overrides: { claude: { fixModel: 'fable' }, retry: { fallbackModel: 'Fable 5' } } },
  ]));
  const all = await configsToCheck('evil');
  assert.deepEqual(all.map(([n]) => n), ['global', 'proyecto hfs', 'proyecto malo']);
  const bad = all.flatMap(([name, cfg]) => violations(cfg).map((v) => `${name}: ${v}`));
  assert.deepEqual(bad, ['proyecto malo: claude.fixModel = "fable"', 'proyecto malo: retry.fallbackModel = "Fable 5"']);
});

test('un override fusionado con mergeInto también lo ve la guardia', () => {
  const merged = mergeInto(structuredClone(config), { qa: { model: 'fable' } });
  assert.deepEqual(violations(merged), ['qa.model = "fable"']);
});

// The tuning block names no model, but every value in it is scanned too: a
// model smuggled in as an «effort» must not pass.
test('los valores de claude.tuning se escanean, y los reales no traen Fable', () => {
  const tuning = modelValues(config).filter(([where]) => where.startsWith('claude.tuning.'));
  assert.ok(tuning.length >= 9, `la guardia no ve claude.tuning (${tuning.length} valores)`);
  assert.deepEqual(violations(config), []);
  const bad = violations(mutated((c) => { c.claude.tuning.fixEffort = 'fable'; }));
  assert.deepEqual(bad, ['claude.tuning.fixEffort = "fable"']);
});

test('ninguna entrada de «available» trae Fable, en ningún campo', () => {
  const entries = modelValues(config).filter(([where]) => where.startsWith('claude.available['));
  assert.ok(entries.length >= 9);
  assert.deepEqual(entries.filter(([, v]) => isFable(v)), []);
});

test('las listas de modelos y esfuerzos que expone el código no contienen Fable', () => {
  assert.ok(!/fable/i.test(JSON.stringify(selectableModels(config.claude.available))));
  assert.ok(!/fable/i.test(JSON.stringify({ EFFORT_LEVELS, CAPABILITIES })));
  assert.deepEqual(Object.keys(CAPABILITIES).filter(isFable), []);
});
