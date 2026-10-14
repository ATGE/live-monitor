import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';

// The web has no test runner: the reviewer settings flow is read as text.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');

test('ReviewerDialog, App, CodeGroup and api: the settings flow is wired and the author is no longer hidden', () => {
  const read = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8');
  const dialog = read('components', 'ReviewerDialog.jsx');
  const app = read('App.jsx');
  const code = read('components', 'card', 'CodeGroup.jsx');
  const api = read('api.js');
  assert.doesNotMatch(dialog, /results\.filter|const hide =/, 'the author is not filtered out');
  assert.equal(es.dialogs.reviewer.settingsTitle, 'Revisor del proyecto');
  assert.equal(es.dialogs.reviewer.searchPlaceholder, 'Buscar por login…');
  assert.equal(es.dialogs.reviewer.clear, 'Preguntar cada vez');
  assert.match(dialog, /d\.settingsTitle/);
  assert.match(dialog, /d\.searchPlaceholder/);
  assert.match(dialog, /\{d\.clear\}/);
  assert.match(api, /setProjectReviewer: \(project, body\) => send\(`\/api\/projects\/\$\{encodeURIComponent\(project\)\}\/reviewer`, body\)/);
  assert.match(app, /readyPick\(login, remember\)/);
  assert.equal(es.app.reviewer.removeText, '¿Quitar a {login} como revisor de {project}?');
  assert.match(app, /fill\(t\.app\.reviewer\.removeText, \{ login: current,/);
  assert.equal(app.split('t.app.reviewer.removeText').length - 1, 2, '«Preguntar cada vez» and «Sin revisor» both confirm');
  assert.match(app, /onPick=\{\(login\) => pickProjectReviewer\(reviewerSettings, login\)\}/);
  assert.match(app, /if \(pick\.always\) api\.projects\(\)\.then\(\(f\) => Array\.isArray\(f\?\.projects\) && setProjects\(f\.projects\)\)/);
  assert.match(app, /onReviewer=\{\(\) => setReviewerSettings\(activeProject\)\}/);
  assert.equal(es.card.code.reviewer, 'Revisor');
  assert.match(code, /<Icon name="user" \/> \{t\.card\.code\.reviewer\}/);
});
