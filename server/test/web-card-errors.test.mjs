import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';

// The web has no test runner: the card's error area (empty repository, base
// branch change, install wait) is read as text. All of it stays in TaskCard.jsx.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');

// The text lives in the Spanish catalog: pin the value there and the use of its key in the source.
const at = (p) => p.split('.').reduce((o, k) => o?.[k], es);
const pin = (p, value) => assert.equal(at(p), value, p);
const uses = (src, suffix) => assert.ok(new RegExp(`\\.${suffix.replace(/\./g, '\\.')}\\b`).test(src), `${suffix} is read in the source`);

test('empty repository: the error area explains it, only empty_repo offers the confirmed button', () => {
  const rd = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const card = rd('components', 'TaskCard.jsx');
  pin('board.card.emptyRepo', 'El repositorio está vacío: no tiene ningún commit, y sin una rama base no se pueden crear worktrees ni abrir PRs.');
  uses(card, 'emptyRepo');
  assert.ok(card.includes("task.errorCode === 'empty_repo' && task.state === 'error'"), 'button only for empty_repo');
  pin('board.card.bootstrap', 'Crear commit inicial en {base} y subirlo');
  assert.match(card, /fill\(t\.bootstrap, \{ base: task\.errorInfo\?\.base \?\? 'main' \}\)/);
  assert.match(card, /onBootstrapRepo\(task\.issue, task\.errorInfo\?\.base/);
  // base_missing / remote_empty / no_remote show the server message and no button.
  assert.equal((card.match(/onBootstrapRepo\(/g) ?? []).length, 1);
  const app = rd('App.jsx');
  assert.match(app, /onBootstrapRepo=\{async \(issue, base\) =>/);
  pin('app.bootstrap.text', 'Se creará un commit vacío en la rama {base} y se subirá a GitHub ({repo}). ¿Continuar?');
  assert.match(app, /fill\(t\.app\.bootstrap\.text, \{ base, repo \}\)/);
  assert.match(app, /if \(go\) api\.bootstrapRepo\(activeProject, issue\)\.catch\(say\)/);
  const api = rd('api.js');
  assert.match(api, /bootstrapRepo: \(project, issue\) => send\(`\$\{T\(project, issue\)\}\/bootstrap-repo`, \{ confirm: true \}\)/);
});

test('change base branch: only empty_repo/base_missing in error offer it, through the confirm dialog', () => {
  const rd = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const card = rd('components', 'TaskCard.jsx');
  assert.ok(card.includes("['empty_repo', 'base_missing'].includes(task.errorCode) && task.state === 'error'"), 'only those two codes, only in error');
  assert.ok(!/remote_empty|no_remote/.test(card), 'remote_empty / no_remote get no control');
  pin('board.card.useBase', 'Usar «{head}»');
  assert.match(card, /fill\(t\.useBase, \{ head: h \}\)/);
  assert.ok(card.includes('errorInfo?.remoteHeads'), 'base_missing offers the remote heads');
  pin('board.card.baseAria', 'Rama base');
  pin('board.card.change', 'Cambiar');
  assert.ok(card.includes('aria-label={t.baseAria}') && card.includes('{t.change}</button>'), 'empty_repo: input plus «Cambiar»');
  assert.match(card, /useState\(current\)/, 'input prefilled with the current base');
  assert.equal((card.match(/onChangeBase\(task\.issue/g) ?? []).length, 2);
  const app = rd('App.jsx');
  assert.match(app, /onChangeBase=\{async \(issue, baseBranch\) =>/);
  pin('app.base.text', 'Cambiar la rama base de {project} a {base}: afecta a las tareas nuevas y a la base de sus PR. ¿Continuar?');
  assert.match(app, /fill\(t\.app\.base\.text, \{ project: activeProject, base: baseBranch \}\)/);
  assert.match(app, /api\.changeBaseBranch\(activeProject, \{ baseBranch, issue \}\)/);
  pin('app.base.remoteHeads', '{message} Ramas del remoto: {heads}.');
  assert.ok(app.includes('t.app.base.remoteHeads, { message: e.message, heads: heads.join'), 'base_not_on_remote shows the remote heads');
  const api = rd('api.js');
  assert.match(api, /changeBaseBranch: \(project, body\) => send\(`\/api\/projects\/\$\{encodeURIComponent\(project\)\}\/base-branch`, body\)/);
});

test('change base branch: retryError is shown and the input resyncs when the base changes', () => {
  const rd = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const app = rd('App.jsx');
  pin('app.base.retryFailed', 'Rama base cambiada a {base}, pero no se pudo reintentar: {error}');
  assert.ok(app.includes('fill(t.app.base.retryFailed, { base: baseBranch, error: r.retryError })'), 'retryError is surfaced');
  const card = rd('components', 'TaskCard.jsx');
  assert.ok(card.includes("<ChangeBaseControl key={task.errorInfo?.base ?? 'main'}"), 'the control remounts when errorInfo.base changes');
});

test('a failed triage with the install still running shows a waiting note on the card', () => {
  const card = readFileSync(path.join(WEB, 'src', 'components', 'TaskCard.jsx'), 'utf8').replace(/\r\n/g, '\n');
  pin('board.card.waitingInstall', 'esperando a que termine la instalación de dependencias');
  assert.match(card, /task\.waitingOn === 'install' && <p className="tc-line tc-line-muted"><Icon name="hourglass" \/> \{t\.waitingInstall\}<\/p>/);
  assert.equal((card.match(/waitingOn/g) ?? []).length, 1, 'read once, no local declared for it');
});
