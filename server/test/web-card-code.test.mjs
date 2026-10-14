import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// There is no web test runner: the card's «Código y PR» group (the Listo
// button, Pull/Push, Revisor, the change-request stack) is pinned by reading
// the sources as text.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const code = read('components/card/CodeGroup.jsx');
const cr = read('components/ChangeRequestCard.jsx');
// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

test('las etiquetas nuevas: Listo', () => {
  pin('card.code.ready', 'Listo');
  assert.match(code, />\s*<Icon name="check-circle" \/> \{t\.card\.code\.ready\}\s*</);
});

test('Listo: solo con el PR en borrador, deshabilitado mientras la petición vuela', () => {
  assert.match(code, /task\.state === 'pr_draft' && task\.prNumber/);
  assert.match(code, /className="btn btn-warn btn-sm tcc-ready" disabled=\{inFlight\('ready'\)\}/);
});

test('el grupo exporta ReadyButton y PrLink (la shell los usa en el pie y en la cerrada)', () => {
  assert.match(code, /export function ReadyButton\(/);
  assert.match(code, /export function PrLink\(\{ task, m, h, size = 'md' \}\)/);
  pin('card.code.title', 'Código y PR');
  assert.match(code, /<CardSection title=\{t\.card\.code\.title\}/);
});

test('sin alias viejos, sin rejilla vieja y sin interruptores', () => {
  for (const [name, src] of [['CodeGroup', code], ['ChangeRequestCard', cr]]) {
    assert.doesNotMatch(src, /span-2|className="[^"]*\b(c1|c2)\b/, `${name}: sin clases de rejilla`);
    assert.doesNotMatch(src, /className="btn btn-\w+ btn-\w+ (primary|warn|danger|ghost)\b/, `${name}: sin alias suelto`);
    assert.doesNotMatch(src, /role="switch"|class(Name)?="[^"]*\bswitch\b/, `${name}: sin interruptor`);
  }
});

test('el change request activo es un botón de estado, no un interruptor', () => {
  assert.match(cr, /<StateButton on=\{active\}/);
  assert.match(cr, /export default function ChangeRequestCard\(/);
});
