// The base branch belongs to the project (`baseBranchOf`), not to the code. A
// literal `origin/main` in `server/src` is a project-specific assumption that
// breaks any repository whose trunk is called something else.
//
// This lists the files still allowed to carry it. The list only ever shrinks:
// an entry with no occurrence left must be removed, so it cannot go stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// `upgrade.js` is the board upgrading itself: its own trunk really is main.
const ALLOWLIST = ['upgrade.js'];

const NEEDLE = 'origin/main';

function* jsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

/** Source with `//` and block comments removed; string and template contents stay. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c; out += c; i += 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c; i += 1;
    }
  }
  return out;
}

const counts = new Map();
for (const file of jsFiles(SRC)) {
  const n = stripComments(readFileSync(file, 'utf8')).split(NEEDLE).length - 1;
  if (n > 0) counts.set(path.relative(SRC, file).replaceAll('\\', '/'), n);
}

test('stripComments drops comments and keeps strings', () => {
  const src = "// origin/main\n/* origin/main */ const a = 'origin/main'; // origin/main\nconst u = 'http://x'; `${'origin/main'}`";
  const out = stripComments(src);
  assert.equal(out.split(NEEDLE).length - 1, 2);
  assert.match(out, /http:\/\/x/);
});

test('no file outside the allowlist hardcodes origin/main', () => {
  const offenders = [...counts.keys()].filter((f) => !ALLOWLIST.includes(f));
  assert.deepEqual(offenders, [], `use baseBranchOf(project) / a base option instead of a literal origin/main in: ${offenders.join(', ')}`);
});

test('every allowlist entry still has an occurrence (shrink the list, never pad it)', () => {
  const stale = ALLOWLIST.filter((f) => !counts.has(f));
  assert.deepEqual(stale, [], `remove from ALLOWLIST: ${stale.join(', ')}`);
});
