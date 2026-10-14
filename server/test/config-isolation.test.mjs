import './isolate.mjs';
// Guard for issue #22: the suite must run on the checked-in fixture, never on the
// real config.json / config.local.json (tokens, the real runner). Run with
// HFSMON_CONFIG pointing at the real file and these tests must go red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const FIXTURE = path.join(here, 'fixtures', 'config.test.json');

const { config, CONFIG_FILE, CONFIG_IS_TEST_FIXTURE } = await import('../src/config.js');

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const TOKEN_KEY = /token|secret|password|passwd|apikey|api_key|credential/i;
const MIN_SECRET = 8;

/** Every string leaf under a token-like key, plus every `machines.*.url`. Values never leave this function's callers. */
function sensitiveValues(cfg) {
  const out = new Set();
  const walk = (node, underToken) => {
    if (typeof node === 'string') {
      if (underToken && node.length >= MIN_SECRET) out.add(node);
    } else if (Array.isArray(node)) {
      for (const v of node) walk(v, underToken);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, underToken || TOKEN_KEY.test(k));
    }
  };
  walk(cfg, false);
  for (const m of Object.values(cfg?.machines ?? {})) {
    if (typeof m?.url === 'string' && m.url) out.add(m.url);
  }
  return out;
}

test('the config in use is the checked-in fixture', () => {
  assert.equal(path.resolve(CONFIG_FILE), path.resolve(FIXTURE), 'the suite is not pointed at the fixture');
  assert.equal(CONFIG_IS_TEST_FIXTURE, true);
});

test('the fixture declares no machines, no access, no identity', () => {
  assert.equal(config.machines, undefined, 'config.machines must come only from what a test injects');
  assert.equal(config.access, undefined);
  assert.equal(config.identity, undefined);
  assert.equal(config.limits.maxGapRounds, 3, 'the fixture pins the documented default');
});

test('no overlay file sits beside the fixture', () => {
  // config.js derives the overlay as <config>.local.json; it is not gitignored.
  assert.equal(existsSync(path.join(here, 'fixtures', 'config.test.local.json')), false);
});

test('no token or machine address from the real config is visible', () => {
  const real = [readJson(path.join(ROOT, 'config.json')), readJson(path.join(ROOT, 'config.local.json'))].filter(Boolean);
  const live = JSON.stringify(config);
  // With no real file here (a CI checkout) there is nothing to compare, and that passes.
  for (const cfg of real) {
    for (const value of sensitiveValues(cfg)) {
      assert.equal(live.includes(value), false, 'a secret or machine address from the real config is in the live config');
    }
  }
});

// Tests that read the real file straight from disk, bypassing config.js, and why.
const DIRECT_READERS = new Map([
  ['effort.test.mjs', 'validates the shipped config on purpose'],
  ['models.test.mjs', 'validates the shipped config on purpose'],
  ['docs-secrets.test.mjs', 'needs the real secrets to look for them in the docs'],
  ['restart-ps1.test.mjs', 'reads a sandbox copy, not the real file'],
  ['upgrade-ps1.test.mjs', 'reads a sandbox copy, not the real file'],
]);

test('only the known tests read config.json straight from disk', () => {
  const READ = /(readFileSync|readJson)\([^\n]*config(\.local)?\.json/;
  const found = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs') && f !== 'config-isolation.test.mjs')
    .filter((f) => READ.test(readFileSync(path.join(here, f), 'utf8')));
  const unknown = found.filter((f) => !DIRECT_READERS.has(f));
  assert.deepEqual(unknown, [], 'these tests read the real config.json directly: use the live `config` or add them to DIRECT_READERS with a reason');
});
