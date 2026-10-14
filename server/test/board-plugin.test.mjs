// Shape guard for the board's own UX plugin (plugins/hfs-ux/). It checks only what the board relies
// on: a manifest that names the plugin, six skills each with a name and a description, the license
// texts of the third-party material, and the absence of copies we must not ship (dataviz has no
// findable license; frontend-design is installed from the official marketplace, never copied).
//
// It never imports server/src and never reads config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'hfs-ux');
const SKILLS = path.join(PLUGIN, 'skills');
const NAMES = [
  'design-canvas', 'heuristic-review', 'accessibility-audit',
  'ux-accessibility', 'ux-information-architecture', 'ux-navigation',
];

const read = (...p) => fs.readFileSync(path.join(PLUGIN, ...p), 'utf8').replace(/\r\n/g, '\n');

test('the manifest is valid JSON and names the plugin hfs-ux', () => {
  const manifest = JSON.parse(read('.claude-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'hfs-ux');
});

test('the six skills exist, each with a name matching its folder and a description', () => {
  for (const name of NAMES) {
    const text = read('skills', name, 'SKILL.md');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${name}: SKILL.md has no frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${name}$`, 'm'), `${name}: name does not match its folder`);
    assert.match(front[1], /^description:/m, `${name}: no description`);
  }
});

test('the plugin carries no other skill folder than the six', () => {
  assert.deepEqual(fs.readdirSync(SKILLS).sort(), [...NAMES].sort());
});

test('THIRD_PARTY_LICENSES holds the MIT and Apache-2.0 texts and the sources', () => {
  const text = read('THIRD_PARTY_LICENSES');
  assert.match(text, /MIT License/);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(text, /https:\/\/github\.com\/parhamb\/design-skills/);
  assert.match(text, /4efb28359824c562c7268dea5bb87488a607d4bd/);
  assert.match(text, /https:\/\/github\.com\/anthropics\/claude-plugins-official/);
});

test('no dataviz and no frontend-design copy ship in the plugin', () => {
  assert.equal(fs.existsSync(path.join(SKILLS, 'dataviz')), false);
  assert.equal(fs.existsSync(path.join(SKILLS, 'frontend-design')), false);
});

test('.gitattributes pins LF under plugins/', () => {
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  assert.match(attrs, /^plugins\/\*\* text eol=lf$/m);
});
