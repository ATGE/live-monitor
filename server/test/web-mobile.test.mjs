import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

/**
 * The web has no test runner and no Playwright dependency, so what can be
 * checked without a browser is checked statically: the viewport meta says
 * what a phone needs, and `status.js` — pure JS, no React — agrees with the
 * phases the server has. The layout, dialog, tab and card rules that used to be
 * read here live in `web-layout-dvh`, `web-modal-mobile`, `web-chat-tabs`,
 * `web-task-tabs`, `web-card-errors` and the other `web-*` tests of their owner.
 */
const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');

test('the viewport meta covers the notch and resizes with the keyboard', () => {
  const meta = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
  assert.match(meta, /viewport-fit=cover/);
  assert.match(meta, /interactive-widget=resizes-content/);
  assert.match(meta, /width=device-width/);
});

test('status.js: fix_gaps is a busy state with a column, and no state is orphaned', async () => {
  const s = await import(pathToFileURL(path.join(WEB, 'src', 'status.js')).href);
  assert.ok(s.BUSY_STATES.includes('fix_gaps'));
  assert.ok(s.COLUMNS.some((c) => c.states.includes('fix_gaps')));
  assert.deepEqual(s.orphanStates(), []);
  assert.equal(s.meta('fix_gaps').tone, 'busy');
  assert.ok(s.phaseLabel('fix_gaps'));
});

test('Board.jsx: uses BUSY_STATES from status.js, no local busy list', () => {
  const board = readFileSync(path.join(WEB, 'src', 'components', 'Board.jsx'), 'utf8');
  assert.match(board, /import \{[^}]*\bBUSY_STATES\b[^}]*\} from '\.\.\/status\.js'/);
  assert.doesNotMatch(board, /const BUSY\s*=/);
  assert.match(board, /BUSY_STATES\.includes\(task\.state\)/);
});

test('the fix_gaps column renders only when a task is in that state', async () => {
  const s = await import(pathToFileURL(path.join(WEB, 'src', 'status.js')).href);
  const board = readFileSync(path.join(WEB, 'src', 'components', 'Board.jsx'), 'utf8');
  assert.match(board, /HIDE_WHEN_EMPTY\.includes\(key\)/, 'Board hides empty columns from the shared list');
  assert.ok(s.HIDE_WHEN_EMPTY.includes('fix_gaps'));
  // Mirror of Board's per-column rule: items for the column, dropped when empty and listed.
  const rendered = (tasks) => s.COLUMNS.filter(({ key, states }) => {
    const n = tasks.filter((t) => states.includes(t.state)).length;
    return !(s.HIDE_WHEN_EMPTY.includes(key) && n === 0);
  }).map((c) => c.key);
  assert.ok(!rendered([{ state: 'assigned' }, { state: 'fixing' }]).includes('fix_gaps'));
  assert.ok(rendered([{ state: 'fix_gaps' }]).includes('fix_gaps'));
});

test('ModelsDialog: a model switch clears only a reasoning the new model lacks, never the effort', () => {
  const src = readFileSync(path.join(WEB, 'src', 'components', 'ModelsDialog.jsx'), 'utf8');
  assert.match(src, /thinkingFits\(cur\.thinking, thinkingModesOfModel\(snap, model\)\)/);
  assert.match(src, /\{ model, thinking: null \}/);
  assert.doesNotMatch(src, /effort: null \}\s*:\s*\{ model \}/, 'the switch no longer sends effort: null');
  assert.match(src, /\{ model: null, effort: null, thinking: null \}/, 'the per-role reset clears thinking too');
  assert.doesNotMatch(src, /contextWindow|context1m|anyContext/, 'the context window control is gone');
});

test('status.js: the latest phase model,as «modelo · esfuerzo»', async () => {
  const s = await import(pathToFileURL(path.join(WEB, 'src', 'status.js')).href);
  assert.equal(s.latestPhaseModel({}), null);
  assert.equal(s.latestPhaseModel({ phaseModels: {} }), null);
  const t = { phaseModels: { triage: { model: 'opus', effort: 'high' }, fix: { model: 'sonnet', effort: null } } };
  assert.equal(s.latestPhaseModel(t).label, 'sonnet · auto');
  assert.equal(s.latestPhaseModel(t).phase, 'fix');
  assert.equal(s.modelEffortLabel('opus', 'max'), 'opus · max');
  assert.equal(s.modelEffortLabel('opus', 'auto'), 'opus · auto');
});

test('the phase names the server knows are the ones the board labels', async () => {
  const s = await import(pathToFileURL(path.join(WEB, 'src', 'status.js')).href);
  const phases = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'phases.js')).href);
  for (const phase of Object.keys(phases.PHASE_LABEL)) {
    assert.ok(s.phaseLabel(phase), `status.js has no label for the phase ${phase}`);
  }
});

const RULES = pathToFileURL(path.join(WEB, 'src', 'modelRules.js')).href;

test('modelRules: thinking options per family and the budget clamp', async () => {
  const r = await import(RULES);
  assert.deepEqual(r.thinkingOptions(['adaptive']), [['auto', 'auto'], ['adaptive', 'adaptativo']]);
  assert.deepEqual(r.thinkingOptions(['enabled', 'disabled']), [['auto', 'auto'], ['enabled', 'presupuesto'], ['disabled', 'apagado']]);
  assert.deepEqual(r.thinkingOptions(['between_tools']), [['auto', 'auto']], 'between_tools is not offered');
  assert.equal(r.clampBudget(10), 1024);
  assert.equal(r.clampBudget(99999), 32000);
  assert.equal(r.clampBudget('abc'), 1024);
  assert.equal(r.thinkingForMode('auto'), null);
  assert.deepEqual(r.thinkingForMode('adaptive'), { type: 'adaptive' });
  assert.deepEqual(r.thinkingForMode('enabled', 2000), { type: 'enabled', budgetTokens: 2000 });
  assert.equal(r.thinkingFits({ type: 'enabled', budgetTokens: 1024 }, ['adaptive']), false);
  assert.equal(r.thinkingFits({ type: 'adaptive' }, ['adaptive']), true);
  assert.equal(r.thinkingFits(null, []), true);
  assert.equal(r.thinkingFits('auto', []), true);
});

test('modelRules: fast mode note says why, and unknown disables too', async () => {
  const r = await import(RULES);
  assert.equal(r.fastModeNote(null), 'estado de la cuenta aún desconocido');
  assert.equal(r.fastModeNote({ available: null, reason: null }), 'estado de la cuenta aún desconocido');
  assert.equal(r.fastModeNote({ available: false, reason: 'extra_usage_disabled' }), 'tu cuenta no tiene uso extra habilitado');
  assert.equal(r.fastModeNote({ available: false, reason: 'other_code' }), 'other_code');
  assert.equal(r.fastModeNote({ available: true, reason: null }), null);
  assert.equal(r.fastModeNote({ available: true, reason: 'cooldown' }), 'en pausa temporal, vuelve solo');
  assert.equal(r.fastModeNote({ available: false, reason: 'cooldown' }), 'cooldown');
});

test('modelRules: the cache is warm while busy or under 5 minutes after the last turn', async () => {
  const r = await import(RULES);
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(r.cacheIsWarm({ busy: true }, now), true);
  assert.equal(r.cacheIsWarm({ lastTurnAt: '2026-10-01T11:56:00Z' }, now), true);
  assert.equal(r.cacheIsWarm({ lastTurnAt: '2026-10-01T11:54:59Z' }, now), false);
  assert.equal(r.cacheIsWarm({}, now), false);
  assert.equal(r.cacheIsWarm(null, now), false);
});

test('modelRules: a typed /model resolves like the server and asks only when it lands elsewhere', async () => {
  const r = await import(RULES);
  const { resolveModel } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'models.js')).href);
  const list = [
    { id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }, { id: 'haiku', label: 'Haiku 4.5' },
  ];
  for (const name of ['opus', 'Sonnet', 'haiku 4.5', 'claude-opus-4-1', 'zzz', 'o']) {
    assert.deepEqual(r.resolveModelName(list, name), resolveModel(list, name), `same answer as the server for ${name}`);
  }
  assert.equal(r.resolveModelName(list, 'sonnet').match.id, 'sonnet');
  assert.equal(r.modelCommandArgument('/model opus'), 'opus');
  assert.equal(r.modelCommandArgument('  /MODEL   haiku '), 'haiku');
  assert.equal(r.modelCommandArgument('/model'), null);
  assert.equal(r.modelCommandArgument('/models x'), null);
  assert.equal(r.modelCommandArgument('hola /model x'), null);
});

test('ModelsDialog: fast mode disabled with its reason, new models dismissible, no context control', () => {
  const src = readFileSync(path.join(WEB, 'src', 'components', 'ModelsDialog.jsx'), 'utf8');
  // On needs available === true; off is always allowed once it is on.
  assert.match(src, /disabled=\{saving \|\| \(snap\.fastMode !== true && snap\.fastModeStatus\?\.available !== true\)\}/);
  assert.equal(E('dialogs.models.newModel'), 'Hay un modelo nuevo en el CLI: {name} ({id})');
  assert.match(src, /fill\(d\.newModel, \{ name: m\.displayName, id: m\.resolvedModel \}\)/);
  assert.match(src, /dismissModel: m\.resolvedModel/);
  assert.equal(E('dialogs.models.lowered'), '{label}: se usará {lowered} (el modelo no admite {effort}).');
  assert.match(src, /fill\(d\.lowered, \{ label, lowered, effort: cur\.effort \}\)/);
  assert.doesNotMatch(src, /se usará/, 'no Spanish literal left in the dialog');
  assert.match(src, /min=\{THINKING_BUDGET\.min\} max=\{THINKING_BUDGET\.max\}/);
});

test('reviewerRules: the author is annotated not hidden, the status names who can be asked, the checkbox covers «Sin revisor»', async () => {
  const r = await import(pathToFileURL(path.join(WEB, 'src', 'reviewerRules.js')).href);
  assert.equal(r.isAuthorOf({ login: 'Eterceros' }, 'eterceros'), true);
  assert.equal(r.isAuthorOf({ login: 'x', isAuthor: true }, null), true);
  assert.equal(r.isAuthorOf({ login: 'x' }, 'eterceros'), false);
  const known = Array.from({ length: 10 }, (_, i) => ({ login: `u${i}` }));
  assert.equal(r.statusLine({ error: null, busy: false, shown: [{ login: 'a' }], known }), '');
  assert.equal(r.statusLine({ error: null, busy: true, shown: [], known }), 'Buscando…');
  assert.equal(r.statusLine({ error: 'boom', busy: false, shown: [], known }), 'No se pudo buscar: boom');
  assert.equal(
    r.statusLine({ error: null, busy: false, shown: [], known }),
    'Nadie coincide. Solo se puede pedir revisión a quienes tienen acceso al repositorio: u0, u1, u2, u3, u4, u5, u6, u7',
  );
  assert.equal(r.statusLine({ error: null, busy: false, shown: [], known: [] }), 'Nadie coincide.');
  assert.deepEqual(r.readyPick('ana', true), { reviewer: 'ana', always: true });
  assert.deepEqual(r.readyPick('ana', false), { reviewer: 'ana', always: false });
  assert.deepEqual(r.readyPick(null, true), { noReviewer: true, always: true });
  assert.deepEqual(r.readyPick(null, false), { noReviewer: true });
  assert.deepEqual(r.settingsPick('ana'), { reviewer: 'ana' });
  assert.deepEqual(r.settingsPick(null), { noReviewer: true });
  assert.deepEqual(r.ASK_EVERY_TIME, { reviewer: null, noReviewer: false });
  assert.equal(r.currentState({ reviewer: 'ana', noReviewer: true }), 'Revisor: ana');
  assert.equal(r.currentState({ noReviewer: true }), 'Sin revisor');
  assert.equal(r.currentState({}), 'Pregunta cada vez');
});
