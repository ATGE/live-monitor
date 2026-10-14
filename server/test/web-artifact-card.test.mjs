import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// No web test runner: the card's design setting is pinned by reading the
// sources as text, like web-card-settings.test.mjs does.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const card = read('components/TaskCard.jsx');
const settings = read('components/card/SettingsGroup.jsx');

test('the card has «Lienzos de diseño» that sends a real boolean', () => {
  assert.match(card, /onSetDesign,?/);
  assert.equal(es.card.settings.design, 'Lienzos de diseño');
  assert.match(settings, /icon="palette" name=\{t\.card\.settings\.design\} effective=\{task\.design === true\}/);
  assert.match(settings, /onSetDesign\(task\.issue, task\.design !== true\)/);
});

test('«🎨 Diseño» is gone from the card sources', () => {
  const dir = path.join(WEB, 'components/card');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsx')).map((f) => path.join(dir, f));
  files.push(path.join(WEB, 'components/TaskCard.jsx'));
  for (const f of files) assert.equal(fs.readFileSync(f, 'utf8').includes('🎨 Diseño'), false, f);
});
