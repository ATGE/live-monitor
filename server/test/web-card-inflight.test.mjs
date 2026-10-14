import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The card's git/flow buttons (Listo, Pull, Push) live in CodeGroup. The rest
// of the in-flight guard (App, dialogs, the shell's `inFlight`) is pinned by
// web-inflight.test.mjs and web-card-shell.test.mjs.
const WEB = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');
const read = (f) => readFileSync(path.join(WEB, f), 'utf8').replace(/\r\n/g, '\n');

test('the buttons go disabled while their request is in flight', () => {
  const code = read('components/card/CodeGroup.jsx');
  assert.match(code, /disabled=\{inFlight\('ready'\)\}/);
  assert.match(code, /gitBusy \|\| inFlight\('merge'\)/);
  assert.match(code, /gitBusy \|\| inFlight\('push'\)/);
});
