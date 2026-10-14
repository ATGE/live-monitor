import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import es from '../../web/src/i18n/strings/es.js';

const jsx = readFileSync(new URL('../../web/src/components/card/EnvGroup.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../web/src/styles/card-env.css', import.meta.url), 'utf8');

// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

test('EnvGroup is a CardSection titled Entorno and exports PlacesList', () => {
  pin('card.env.title', 'Entorno');
  assert.match(jsx, /<CardSection title=\{t\.card\.env\.title\}/);
  assert.match(jsx, /export function PlacesList\(/);
  assert.match(jsx, /export default function EnvGroup\(/);
});

test('worktree creation and moving keep their conditions', () => {
  assert.match(jsx, /!task\.hasWorktree && !busy/);
  assert.match(jsx, /canMove &&/);
  pin('card.env.createWorktree', 'Crear worktree');
  assert.match(jsx, /\{t\.card\.env\.createWorktree\}/);
  assert.match(jsx, /task\.hasWorktree && !stack && task\.hasStack !== false/);
});

test('service links open safely in a new tab', () => {
  assert.match(jsx, /target="_blank" rel="noreferrer"/);
});

test('the places delete button is a labelled, lockable icon button', () => {
  pin('card.env.deletePlaceAria', 'Borrar el worktree de {machine}');
  assert.match(jsx, /aria-label=\{fill\(t\.card\.env\.deletePlaceAria, \{ machine: p\.machine \}\)\}/);
  assert.match(jsx, /disabled=\{placesLocked\}/);
  assert.match(jsx, /btn btn-icon btn-danger/);
});

test('a stack that is stopping says so and offers no stop button meanwhile', () => {
  pin('card.env.stackStopping', 'parando los servidores…');
  assert.match(jsx, /stack\.status === 'stopping' && .*\{t\.card\.env\.stackStopping\}/);
  assert.match(jsx, /stack\.status !== 'starting' && stack\.status !== 'stopping' &&/);
});

test('no legacy grid aliases and no reuse of the old .stack class', () => {
  assert.doesNotMatch(jsx, /\b(c1|c2|span-2)\b/);
  assert.doesNotMatch(jsx, /className=\{?[`"]stack\b/);
  assert.match(css, /\.tce-stack\s*\{/);
  assert.doesNotMatch(css, /!important/);
});

test('places render whenever the group renders, whatever compact says', () => {
  assert.match(jsx, /const hasPlaces = parked\.length > 0;/);
  assert.doesNotMatch(jsx, /!compact && parked/);
});

test('the machine select has an accessible name', () => {
  pin('card.env.machineAria', 'Máquina');
  assert.match(jsx, /<select aria-label=\{t\.card\.env\.machineAria\}/);
});
