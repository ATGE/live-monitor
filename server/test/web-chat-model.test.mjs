import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

// The web has no test runner: the chat panel's model wiring is read as text.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');

test('ChatPanel: «presupuesto» sends only the type, and no line carries two statements', () => {
  const src = readFileSync(path.join(WEB, 'src', 'components', 'ChatPanel.jsx'), 'utf8');
  assert.match(src, /v === 'enabled' \? \{ type: 'enabled' \} : thinkingForMode\(v\)/);
  assert.doesNotMatch(src, /chatRoleThinking\?\.budgetTokens/);
  assert.doesNotMatch(src, /\};  const phaseModel/);
});

test('ChatPanel and api: every /model request carries the model, the switch asks, effort is never cleared', () => {
  const chatSrc = readFileSync(path.join(WEB, 'src', 'components', 'ChatPanel.jsx'), 'utf8');
  const apiSrc = readFileSync(path.join(WEB, 'src', 'api.js'), 'utf8');
  assert.match(apiSrc, /setModel: \(owner, chatId, fields\) =>/);
  assert.match(chatSrc, /const body = \{ \.\.\.fields, model \}/);
  assert.match(chatSrc, /t\.chat\.panel\.modelSwitch\.text/);
  assert.equal(E('chat.panel.modelSwitch.text'), 'Cambiar de modelo relee toda la conversación sin caché. ¿Seguir?');
  assert.match(chatSrc, /modelCommandArgument\(body\)/);
  assert.doesNotMatch(chatSrc, /\['auto'\]/, 'a model switch no longer resets the effort to auto');
  assert.match(chatSrc, /fill\(t\.chat\.panel\.effortLowered, \{ effort: chatLowered \}\)/);
  assert.equal(E('chat.panel.effortLowered'), 'se usará {effort}');
});
