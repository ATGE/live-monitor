import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|jsx|mjs)$/.test(name)) yield p;
  }
}

// Comment-only lines (// and block comment bodies) are not user-visible.
const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

test('no user-visible «Iniciar HFS» string is left (the button is «Iniciar app»)', () => {
  const hits = [];
  for (const root of ['web/src', 'server/src']) {
    for (const file of walk(path.join(ROOT, root))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('Iniciar HFS') && !isComment(line)) hits.push(`${file}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
