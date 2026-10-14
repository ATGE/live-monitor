import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROFILES, PROFILE_IDS, isProfileId, overridesOf, detectProfile, detectTestScript, detectDefaultBranch,
} from '../src/profiles.js';

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'profiles-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('los seis perfiles existen y cada uno tiene etiqueta en español', () => {
  assert.deepEqual(PROFILE_IDS, ['node-web', 'python', 'cli-lib', 'docs-research', 'aidlc', 'blank']);
  for (const p of Object.values(PROFILES)) assert.ok(p.label.length > 3);
  assert.equal(isProfileId('blank'), true);
  assert.equal(isProfileId('toString'), false);
});

test('docs-research y blank ponen e2e, stack y qa a null; node-web solo instala', () => {
  for (const id of ['docs-research', 'blank']) {
    assert.deepEqual(overridesOf(id), { e2e: null, stack: null, qa: null });
  }
  const web = overridesOf('node-web');
  assert.deepEqual(web.e2e, { installCommand: 'npm install' });
  assert.equal(web.stack, null);
  web.e2e.installCommand = 'x';
  assert.equal(PROFILES['node-web'].overrides.e2e.installCommand, 'npm install', 'devuelve una copia');
  assert.throws(() => overridesOf('nope'), /perfil desconocido/);
});

test('detectProfile lee manifiestos', () => {
  const cases = [
    [{}, 'blank'],
    [{ 'package.json': '{"dependencies":{"react":"1"}}' }, 'node-web'],
    [{ 'package.json': '{"bin":"x.js"}' }, 'cli-lib'],
    [{ 'pyproject.toml': '' }, 'python'],
    [{ 'requirements-dev.txt': '' }, 'python'],
    [{ 'Cargo.toml': '' }, 'cli-lib'],
    [{ 'go.mod': '' }, 'cli-lib'],
    [{ 'README.md': '# x', 'notes/a.md': 'a' }, 'docs-research'],
  ];
  for (const [files, want] of cases) {
    const dir = repo(files);
    try {
      assert.equal(detectProfile(dir), want, JSON.stringify(Object.keys(files)));
    } finally {
      cleanup(dir);
    }
  }
  assert.equal(detectProfile(path.join(tmpdir(), 'no-existe-xyz')), 'blank');
});

test('aidlc: no instala ni inventa nada, y overridesOf devuelve una copia', () => {
  assert.equal(isProfileId('aidlc'), true);
  assert.ok(PROFILES.aidlc.label.length > 3);
  assert.deepEqual(overridesOf('aidlc'), { e2e: {}, stack: null, qa: null });
  const copy = overridesOf('aidlc');
  copy.e2e.installCommand = 'x';
  assert.deepEqual(PROFILES.aidlc.overrides.e2e, {}, 'devuelve una copia profunda');
  assert.notEqual(overridesOf('aidlc'), overridesOf('aidlc'));
});

test('detectProfile reconoce el estado propio del marco AIDLC antes que los manifiestos', () => {
  const cases = [
    [{ 'aidlc-docs/aidlc-state.md': '# s' }, 'aidlc'],
    [{ '.aws-aidlc-rule-details/common/x.md': 'r' }, 'aidlc'],
    [{ 'docs/ai-sdlc/state/workflow-state.md': '# s' }, 'aidlc'],
    [{ 'package.json': '{"dependencies":{"react":"1"}}', 'aidlc-docs/aidlc-state.md': '#' }, 'aidlc'],
    [{ 'package.json': '{"bin":"x.js"}', 'docs/ai-sdlc/state/workflow-state.md': '#' }, 'aidlc'],
    [{ 'Cargo.toml': '', 'aidlc-docs/aidlc-state.md': '#' }, 'aidlc'],
    [{ 'pyproject.toml': '', 'aidlc-docs/aidlc-state.md': '#' }, 'aidlc'],
    [{ 'pnpm-workspace.yaml': '', '.aws-aidlc-rule-details/a.md': 'r' }, 'aidlc'],
    // A marker of the wrong kind (a directory where a file is expected, or the reverse) does not count.
    [{ 'aidlc-docs/aidlc-state.md/x': '' , 'package.json': '{}' }, 'node-web'],
    [{ '.aws-aidlc-rule-details': 'file', 'package.json': '{}' }, 'node-web'],
    [{ 'aidlc-docs/notes.md': '#', 'package.json': '{}' }, 'node-web'],
    [{ 'package.json': '{"dependencies":{"react":"1"}}' }, 'node-web'],
  ];
  for (const [files, want] of cases) {
    const dir = repo(files);
    try {
      assert.equal(detectProfile(dir), want, JSON.stringify(Object.keys(files)));
    } finally {
      cleanup(dir);
    }
  }
});

test('detectTestScript no inventa: solo un script test real', () => {
  const real = repo({ 'package.json': '{"scripts":{"test":"vitest run"}}' });
  const fake = repo({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' });
  const none = repo({ 'package.json': '{}' });
  try {
    assert.equal(detectTestScript(real), 'npm test');
    assert.equal(detectTestScript(fake), null);
    assert.equal(detectTestScript(none), null);
    assert.equal(detectTestScript(path.join(tmpdir(), 'no-existe-xyz')), null);
  } finally {
    [real, fake, none].forEach(cleanup);
  }
});

test('detectDefaultBranch: rama actual sin origin, null sin repo', () => {
  const dir = repo({ 'a.txt': 'a' });
  try {
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'trunk']);
    assert.equal(detectDefaultBranch(dir), 'trunk');
    assert.equal(detectDefaultBranch(path.join(tmpdir(), 'no-existe-xyz')), null);
  } finally {
    cleanup(dir);
  }
});
