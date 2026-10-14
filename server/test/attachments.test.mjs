import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { DATA_DIR } from '../src/config.js';
import { saveAttachment, listAttachments, isAttachmentPath, acceptedAttachments } from '../src/attachments.js';

/**
 * Attachments of a task (`attachments/<project>/<issue>/`) and of a project
 * chat (`attachments/<project>/_proyecto/`), and the predicate that decides
 * which paths a chat message may carry. `isolate.mjs` gives this file its own
 * `DATA_DIR`: nothing here touches the live board.
 */

const ROOT_DIR = path.join(DATA_DIR, 'attachments');
const b64 = (s) => Buffer.from(s).toString('base64');

test('a holder key saves under attachments/<project>/_proyecto, never under the key', () => {
  const saved = saveAttachment('hfs@local', { name: '../../etc/pass wd.png', dataBase64: b64('abc') });
  assert.equal(path.dirname(saved.path), path.join(ROOT_DIR, 'hfs', '_proyecto'));
  assert.equal(saved.name, 'pass_wd.png');
  assert.equal(saved.bytes, 3);
  assert.equal(readFileSync(saved.path, 'utf8'), 'abc');
  assert.ok(!saved.path.includes('@'), 'the holder key is never a path segment');
});

test('the machine is not a directory: two holders of one project share the folder', () => {
  const a = saveAttachment('hfs@local', { name: 'a.txt', dataBase64: b64('1') });
  const b = saveAttachment('hfs@runner-1', { name: 'b.txt', dataBase64: b64('2') });
  assert.equal(path.dirname(a.path), path.dirname(b.path));
  const names = listAttachments('hfs@local').map((f) => f.name);
  assert.ok(names.includes(path.basename(a.path)) && names.includes(path.basename(b.path)));
});

test('a task still saves under its own issue directory, apart from the holder folder', () => {
  const t = saveAttachment('hfs#12', { name: 'x.png', dataBase64: b64('t') });
  assert.equal(path.dirname(t.path), path.join(ROOT_DIR, 'hfs', '12'));
  assert.ok(!listAttachments('hfs@local').some((f) => f.path === t.path));
  assert.ok(listAttachments('hfs#12').some((f) => f.path === t.path));
});

test('junk refs are refused or empty, empty files are refused', () => {
  assert.throws(() => saveAttachment('HFS@local', { name: 'a', dataBase64: b64('x') }), /attachment/);
  assert.throws(() => saveAttachment('hfs@', { name: 'a', dataBase64: b64('x') }), /attachment/);
  assert.throws(() => saveAttachment('hfs@local', { name: 'a', dataBase64: '' }), /empty/);
  assert.deepEqual(listAttachments('hfs@'), []);
});

test('isAttachmentPath: only files strictly inside the attachments folder', () => {
  assert.equal(isAttachmentPath(path.join(ROOT_DIR, 'hfs', '_proyecto', '1-a.png')), true);
  assert.equal(isAttachmentPath(path.join(ROOT_DIR, 'x.png')), true);
  assert.equal(isAttachmentPath(ROOT_DIR), false, 'the folder itself');
  assert.equal(isAttachmentPath(path.dirname(ROOT_DIR)), false, 'its parent');
  assert.equal(isAttachmentPath(path.join(ROOT_DIR, '..', 'tasks.json')), false, '.. traversal');
  assert.equal(isAttachmentPath(path.join(ROOT_DIR, 'hfs', '..', '..', 'tasks.json')), false);
  assert.equal(isAttachmentPath(`${ROOT_DIR}-x${path.sep}a.png`), false, 'a sibling that shares the prefix');
  assert.equal(isAttachmentPath(path.resolve(path.parse(ROOT_DIR).root, 'Windows', 'win.ini')), false, 'an absolute path elsewhere');
  assert.equal(isAttachmentPath('relative/a.png'), false);
  assert.equal(isAttachmentPath(path.relative(process.cwd(), path.join(ROOT_DIR, 'a.png'))), false, 'a relative path is never resolved against the cwd');
  for (const junk of [undefined, null, 12, {}, ['a'], '', `${ROOT_DIR}${path.sep}a\0.png`]) {
    assert.equal(isAttachmentPath(junk), false, JSON.stringify(junk));
  }
  if (process.platform === 'win32') {
    assert.equal(isAttachmentPath(path.join(ROOT_DIR.toUpperCase(), 'a.png')), true, 'Windows paths ignore case');
  }
});

test('acceptedAttachments keeps the original entries the board saved and drops the rest', () => {
  const task = { ...saveAttachment('hfs#12', { name: 't.png', dataBase64: b64('t') }), extra: 1 };
  const holder = saveAttachment('hfs@local', { name: 'h.png', dataBase64: b64('h') });
  const outside = { name: 'win.ini', path: path.resolve(path.parse(ROOT_DIR).root, 'Windows', 'win.ini') };
  const traversal = { name: 'x', path: path.join(ROOT_DIR, 'hfs', '..', '..', 'tasks.json') };
  const kept = acceptedAttachments([task, outside, null, 'texto', 7, traversal, holder, { name: 'sin ruta' }]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], task, 'the very object, so name and the rest survive');
  assert.equal(kept[1], holder);
  assert.equal(kept[0].name, 't.png');
  for (const bad of [undefined, null, 'x', 5, {}, { 0: task }]) assert.deepEqual(acceptedAttachments(bad), []);
});
