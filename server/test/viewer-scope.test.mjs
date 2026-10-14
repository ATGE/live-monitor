// Source-text guard for the file viewer's scope.
//
// A mention in a project chat has no issue, so the server can only find the
// holder worktree (`<worktreeRoot>/_proyecto`) if the web says which machine
// the chat lives on. The scope therefore carries `machine`, and `resolveRef`
// sends it as `?machine=`. If any place that publishes a scope, or the request
// builder, drops it, a relative mention in a project chat silently goes back to
// being searched only in the main checkout.

import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const read = (rel) => readFileSync(path.join(WEB, rel), 'utf8');

test('every useFileViewerScope call names machine', () => {
  const src = read('App.jsx');
  const calls = [...src.matchAll(/useFileViewerScope\(([^;]*)\);/g)];
  assert.ok(calls.length >= 1, 'App.jsx no longer publishes a viewer scope: update this guard');
  for (const [, arg] of calls) assert.match(arg, /\bmachine\b/, `scope without machine: ${arg}`);
});

test('the ActivityGroup override carries the owner machine', () => {
  assert.match(read('components/ActivityGroup.jsx'), /machine:\s*owner\.machine/);
});

test('resolveRef sends machine in the query', () => {
  const src = read('viewer/fileApi.js');
  assert.match(src, /export async function resolveRef\(\{[^}]*\bmachine\b[^}]*\}\)/);
  assert.match(src, /q\.set\('machine'/);
});

test('FileViewer keeps machine through scope, openFile and resolve', () => {
  const src = read('viewer/FileViewer.jsx');
  assert.match(src, /machine: next\?\.machine \?\? null/);
  assert.match(src, /ownerMachine: machine/);
  assert.match(src, /resolveRef\(\{ project, issue, machine, ref \}\)/);
  const calls = src.match(/resolve\(target\.project, target\.issue, refText\(target\.ref\)[^)]*\)/g) ?? [];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /ownerMachine/);
});
