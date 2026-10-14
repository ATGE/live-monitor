// The one skill under .claude/skills/ (create-issue) is the board's own: it started as a copy of
// the hfs team skill and, since 2026-10-08, it is edited here and no longer follows hfs. This test
// does not compare it with anything outside the repo; it only guards the shape the board relies on
// (the sections an agent needs to write a complete issue, the assignment rule, the Spanish triggers).
//
// It never imports server/src and never reads config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS = path.join(REPO, '.claude', 'skills');
const NAMES = ['create-issue'];

const skill = (name) => fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

test('skill create-issue: frontmatter names it and triggers in Spanish too', () => {
  const text = skill('create-issue');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, 'SKILL.md lost its frontmatter');
  assert.match(front[1], /^name: create-issue$/m);
  assert.match(front[1], /^description: .*crea un issue/m, 'description lost the Spanish triggers');
  assert.match(front[1], /instead of calling `gh issue create` directly/);
});

test('skill create-issue: keeps the sections that make an issue complete', () => {
  const text = skill('create-issue');
  for (const heading of [
    '## Summary',
    '## Problem and evidence',
    '## Proposed approach',
    '## Scope',
    '## Out of scope',
    '## Acceptance criteria',
    '## How to verify',
    '## Open questions',
    '## Assignment',
    '## Self-check before creating',
  ]) {
    assert.ok(text.includes(`\n${heading}\n`), `SKILL.md lost the section ${heading}`);
  }
  assert.match(text, /Harvest what the conversation already knows/);
  assert.match(text, /Ground and verify every citation/);
});

test('skill create-issue: the project names the default assignee, not the skill', () => {
  const text = skill('create-issue');
  assert.match(text, /project instructions[^\n]*\n?[^\n]*name a default/);
  assert.ok(!/only if the user asked/i.test(text), 'SKILL.md went back to "assignee only if asked"');
});

// The board is a project of itself: its sessions load everything under `.claude/skills/`. Reference
// skills written for another repo (the AIDLC ones live under `.agents/reference/skills/`) must not
// sit there, or a fix session would obey rules that are false for this repo.
test('.claude/skills solo contiene las skills del tablero', () => {
  const listed = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(listed, [...NAMES].sort());
});
