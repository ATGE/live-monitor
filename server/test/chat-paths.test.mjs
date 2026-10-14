// The chat's own full paths as a FALLBACK for bare file names: collection from
// the activity trees, the lookup of a bare name, and the order of resolution.
// Pure web modules, injected lookup: no network.

import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPaths, fallbackFor, resolveWithFallback, signatureOf } from '../../web/src/viewer/chatPaths.js';

const row = (name, summary, children) => ({ id: `${name}-${summary}`, name, summary, ...(children ? { children } : {}) });
const activity = (...items) => ({ id: 'm', role: 'activity', items });

test('collectPaths: reads Read/Write/Edit rows at any depth of children', () => {
  const map = collectPaths([
    { id: 'u', role: 'user', text: 'hi' },
    activity(
      row('Task', 'agent', [
        row('Bash', 'C:\\x\\ignored.md'),
        row('Task', 'inner', [row('Write', 'C:\\scratch\\notes.md')]),
      ]),
      row('Read', '/home/e/.claude/plans/plan.md'),
    ),
  ]);
  assert.deepEqual(map.get('notes.md'), ['C:\\scratch\\notes.md']);
  assert.deepEqual(map.get('plan.md'), ['/home/e/.claude/plans/plan.md']);
  assert.equal(map.has('ignored.md'), false, 'Bash is never read');
});

test('collectPaths: relative and spaced summaries are ignored, a :line suffix is stripped', () => {
  const map = collectPaths([activity(
    row('Read', 'src/a.md'),
    row('Read', 'a.md'),
    row('Read', 'C:\\My Files\\b.md'),
    row('Read', '/tmp/c.md:12'),
  )]);
  assert.deepEqual([...map.keys()], ['c.md']);
  assert.deepEqual(map.get('c.md'), ['/tmp/c.md']);
});

test('collectPaths: duplicates collapse and the most recent occurrence goes first', () => {
  const map = collectPaths([
    activity(row('Read', '/a/n.md'), row('Write', '/b/n.md')),
    activity(row('Edit', '/a/n.md')),
  ]);
  assert.deepEqual(map.get('n.md'), ['/a/n.md', '/b/n.md']);
});

test('collectPaths: the same basename in Windows and POSIX form keeps both, latest first', () => {
  const map = collectPaths([activity(row('Read', 'C:\\w\\n.md'), row('Read', '/p/n.md'))]);
  assert.deepEqual(map.get('n.md'), ['/p/n.md', 'C:\\w\\n.md']);
});

test('fallbackFor: a bare name gives the latest full path and keeps :line / #L', () => {
  const map = collectPaths([activity(row('Read', '/p/n.md'))]);
  assert.equal(fallbackFor(map, 'n.md'), '/p/n.md');
  assert.equal(fallbackFor(map, 'n.md:12'), '/p/n.md:12');
  assert.equal(fallbackFor(map, 'n.md#L3-L9'), '/p/n.md#L3-L9');
});

test('fallbackFor: a miss, a ref that is already a path, or a non-ref give null', () => {
  const map = collectPaths([activity(row('Read', '/p/n.md'))]);
  assert.equal(fallbackFor(map, 'other.md'), null);
  assert.equal(fallbackFor(map, 'docs/n.md'), null);
  assert.equal(fallbackFor(map, '/p/n.md'), null);
  assert.equal(fallbackFor(map, 'C:\\p\\n.md'), null);
  assert.equal(fallbackFor(map, 'not a ref'), null);
});

test('signatureOf: stable for the same content, different otherwise', () => {
  const a = collectPaths([activity(row('Read', '/p/n.md'), row('Read', '/q/m.md'))]);
  const b = collectPaths([activity(row('Read', '/p/n.md'), row('Read', '/q/m.md'))]);
  const c = collectPaths([activity(row('Read', '/p/n.md'), row('Read', '/r/m.md'))]);
  assert.equal(signatureOf(a), signatureOf(b));
  assert.notEqual(signatureOf(a), signatureOf(c));
  assert.equal(signatureOf(new Map()), '');
});

const found = { candidates: [{ machine: 'mi-equipo', path: 'C:/x' }] };
const none = { candidates: [] };
const spy = (table) => {
  const calls = [];
  const lookup = async (ref) => {
    calls.push(ref);
    const v = table[ref];
    if (v instanceof Error) throw v;
    return v ?? none;
  };
  return { lookup, calls };
};

test('resolveWithFallback: a bare name that git finds is NOT overridden', async () => {
  const { lookup, calls } = spy({ 'n.md': found, '/p/n.md': found });
  const r = await resolveWithFallback(lookup, 'n.md', '/p/n.md');
  assert.equal(r.ref, 'n.md');
  assert.deepEqual(calls, ['n.md']);
});

test('resolveWithFallback: the fallback is used only on 0 candidates', async () => {
  const { lookup, calls } = spy({ 'n.md': none, '/p/n.md': found });
  const r = await resolveWithFallback(lookup, 'n.md', '/p/n.md');
  assert.equal(r.ref, '/p/n.md');
  assert.equal(r.result, found);
  assert.deepEqual(calls, ['n.md', '/p/n.md']);
  // Without a fallback there is no second lookup.
  const s = spy({ 'n.md': none });
  assert.equal((await resolveWithFallback(s.lookup, 'n.md', null)).ref, 'n.md');
  assert.deepEqual(s.calls, ['n.md']);
});

test('resolveWithFallback: a failed bare lookup rejects (callers keep the bare ref, no chips)', async () => {
  const { lookup, calls } = spy({ 'n.md': new Error('down'), '/p/n.md': found });
  await assert.rejects(resolveWithFallback(lookup, 'n.md', '/p/n.md'), /down/);
  assert.deepEqual(calls, ['n.md']);
});

test('resolveWithFallback: a failed fallback lookup still names the fallback, with no result', async () => {
  const { lookup } = spy({ 'n.md': none, '/p/n.md': new Error('down') });
  assert.deepEqual(await resolveWithFallback(lookup, 'n.md', '/p/n.md'), { ref: '/p/n.md', result: null });
});
