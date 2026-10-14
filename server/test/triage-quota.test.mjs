// triagePhase is not exported and calls runClaude directly, so there is no seam
// to feed it a quota death. The source is read instead, like ghgate-wiring does:
// the check must exist, and it must come BEFORE the generic failure throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');

test('el triage que muere por cuota se aparca en «triage», no cae a error', () => {
  const from = src.indexOf('async function triagePhase(');
  assert.ok(from > 0, 'triagePhase no encontrada');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  const line = body.split('\n').find((l) => l.includes('Triage failed'));
  assert.ok(line, 'ya no existe el throw de «Triage failed»');
  assert.match(line, /triage\.quota \? new QuotaExhausted\('triage'\)/, 'el fallo de triage no distingue la cuota');
});
