import './isolate.mjs';   // first: isolates the data directory
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED, renderPrompt, e2eRuleFor, NO_QA_NOTE, validatePrompts, setProjectResolver } from '../src/prompts.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// What no shared template may say about one particular stack.
const HFS_ONLY = ['cargo', 'Cargo.toml', 'R6', 'HeliosSoftware', 'FHIR', 'HFS_', 'CodeSystem', 'tsc --noEmit'];

const FIX = {
  issueNumber: 7, issueTitle: 't', branch: 'b', issueBody: 'body', planSection: '',
  extraContext: '', workPlanSection: '', e2ePortEnv: '',
};
const PR = {
  issueNumber: 7, issueTitle: 't', issueBody: 'body', branch: 'b', diffSection: 'diff',
};
const DEMO = { issueNumber: 7, issueTitle: 't', branch: 'b', diffSection: 'diff', serversSection: 'srv', baseBranch: 'main' };
const QA = {
  issueNumber: 7, issueTitle: 't', branch: 'b', servers: 's', qaDir: '/qa', e2eDir: '/e2e', plan: '- q1',
};
const TRIAGE = { issueNumber: 7, issueTitle: 't', issueLabels: 'bug', issueBody: 'body' };

// A project that is not hfs: the context is handed in, so nothing is read from disk.
const other = (vars) => ({ ...vars, projectId: 'other', projectContext: '' });

test('fix, pr-body, demo, qa-run and triage render with no hfs or Rust vocabulary for another project', () => {
  const renders = {
    fix: renderPrompt('fix', other(FIX)),
    'pr-body': renderPrompt('pr-body', other(PR)),
    demo: renderPrompt('demo', other(DEMO)),
    'qa-run': renderPrompt('qa-run', other(QA)),
    triage: renderPrompt('triage', other(TRIAGE)),
  };
  for (const [name, text] of Object.entries(renders)) {
    for (const word of HFS_ONLY) {
      assert.ok(!text.includes(word), `${name}.md: «${word}» should not be in a shared template`);
    }
  }
});

test('hfs still gets its rules, through the invariants', () => {
  const text = renderPrompt('fix', { ...FIX, projectId: 'hfs', projectContext: '' });
  assert.match(text, /cargo fmt -p/);
  assert.match(text, /NUNCA `cargo fmt --all`/);
  assert.match(text, /> nul/);
});

test('the e2e port sentence renders whole or not at all', () => {
  const without = renderPrompt('fix', other(FIX));
    assert.ok(!without.includes('CI=1'));
  assert.ok(!without.includes('<puerto libre>'));

  const withPort = renderPrompt('fix', other({ ...FIX, e2ePortEnv: 'E2E_PORT' }));
  assert.match(withPort, /`E2E_PORT=<puerto libre>` junto con `CI=1`, que es como la lanza el orquestador\./);
  assert.equal(e2eRuleFor('  '), '');
  assert.equal(e2eRuleFor(undefined), '');
});

test('triage only proposes Browser QA when the project has it', () => {
  const normal = renderPrompt('triage', other(TRIAGE));
  assert.ok(!normal.includes(NO_QA_NOTE.trim()));
  const noQa = renderPrompt('triage', other({ ...TRIAGE, qaAvailable: false }));
  assert.ok(noQa.includes(NO_QA_NOTE.trim()));
  assert.ok(ALLOWED.triage.includes('qaAvailable'));
});

test('triage asks for TRIAGE_RESULT as the first line of the final answer', () => {
  const text = renderPrompt('triage', other(TRIAGE));
  assert.match(text, /la primera línea de tu respuesta final/);
  assert.match(text, /prefijo exacto/);
});

test('an unregistered project never borrows the default project\'s checkout', async () => {
  // The resolver is what projects.js registers at load; import it here so the
  // real registry answers, instead of the no-resolver fallback.
  await import('../src/projects.js');
  assert.throws(
    () => renderPrompt('fix', { ...FIX, projectId: 'no-such-project-xyz' }),
    /Proyecto desconocido/,
  );
});

test('setProjectResolver: without a resolver any project id uses the configured path; with one it is authoritative', () => {
  const vars = { ...FIX, projectId: 'late-bound-xyz' };
  // No resolver (projects.js not loaded): pre-project behaviour, no throw.
  setProjectResolver(null);
  assert.doesNotThrow(() => renderPrompt('fix', vars));
  // Registered: a known id resolves, an unknown one throws.
  const seen = [];
  setProjectResolver((id) => { seen.push(id); return id === 'late-bound-xyz' ? { repoPath: process.cwd() } : null; });
  try {
    assert.doesNotThrow(() => renderPrompt('fix', vars));
    assert.ok(seen.includes('late-bound-xyz'));
    assert.throws(() => renderPrompt('fix', { ...FIX, projectId: 'other-unknown' }), /Proyecto desconocido/);
  } finally {
    setProjectResolver(null);
  }
});

test('fix-gaps is declared with exactly its variables', () => {
  assert.deepEqual(ALLOWED['fix-gaps'], [
    'issueNumber', 'issueTitle', 'issueBody', 'baseBranch', 'round', 'maxRounds', 'gapsContract', 'parallel', 'processRule', 'shellRule',
  ]);
});

// The parallel block itself opens with a line break: a blank line before the
// marker renders as two blank lines in a row.
test('no template leaves a blank line right before {{parallel}}', () => {
  const doubled = [];
  for (const name of Object.keys(ALLOWED)) {
    const file = path.join(DIR, `${name}.md`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes('{{parallel}}'));
    if (at > 0 && lines[at - 1].trim() === '') doubled.push(`${name}.md:${at + 1}`);
  }
  assert.deepEqual(doubled, []);
});

test('validatePrompts passes once fix-gaps.md exists', { skip: !existsSync(path.join(DIR, 'fix-gaps.md')) && 'fix-gaps.md (package I) has not landed' }, () => {
  assert.equal(validatePrompts(), Object.keys(ALLOWED).length);
});
