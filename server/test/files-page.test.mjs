// `GET /api/files/page`: an `.html` served as a page for the viewer's sandboxed
// iframe. Same roots and denylist as `/api/files/content`; only `.html`, checked
// on the requested name and again on the real path behind a link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-page-data-'));
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'hfsmon-page-')));
const REPO = path.join(ROOT, 'repo');
const OUTSIDE = path.join(ROOT, 'outside');
const PAGE = '<!doctype html><title>t</title><h1>Hola</h1>\n';
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox; frame-ancestors 'self'";

const write = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
};

let files;
let machines;
let config;
let savedMachines;
let server;
let base;

before(async () => {
  ({ config } = await import('../src/config.js'));
  files = await import('../src/files.js');
  ({ machines } = await import('../src/machine.js'));
  const express = (await import('express')).default;
  write(path.join(REPO, 'docs', 'informe.html'), PAGE);
  write(path.join(REPO, 'docs', 'app.js'), 'export const x = 1;\n');
  write(path.join(REPO, 'docs', 'secrets.report.html'), PAGE);
  write(path.join(REPO, '.git', 'x.html'), PAGE);
  write(path.join(REPO, 'docs', 'vieja.htm'), PAGE);
  write(path.join(OUTSIDE, 'fuera.html'), PAGE);
  savedMachines = config.machines;
  config.machines = { local: { kind: 'local', repoPath: REPO, worktreeRoot: path.join(ROOT, 'wt') } };
  files.filesHooks.homeOf = async () => path.join(ROOT, 'home');
  files.filesHooks.uidOf = async () => null;
  files.filesHooks.boardRoot = () => null;
  files.filesHooks.tmpRoots = () => [path.join(ROOT, 'tmp', 'claude')];
  const app = express();
  app.use(files.filesRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  config.machines = savedMachines;
  if (savedMachines === undefined) delete config.machines;
  await new Promise((r) => server.close(r));
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const page = (p, headers = {}) => fetch(`${base}/api/files/page?${new URLSearchParams({ machine: 'local', path: p })}`, { headers });

test('un .html permitido se sirve como página, con su CSP, nosniff y sin referrer', async () => {
  const res = await page(path.join(REPO, 'docs', 'informe.html'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('cache-control'), /private/);
  assert.equal(await res.text(), PAGE);
  const etag = res.headers.get('etag');
  assert.match(etag, /^"sha1:[0-9a-f]{40}"$/);
  const again = await page(path.join(REPO, 'docs', 'informe.html'), { 'if-none-match': etag });
  assert.equal(again.status, 304);
});

test('un archivo que no es .html → 400, también .htm', async () => {
  assert.equal((await page(path.join(REPO, 'docs', 'app.js'))).status, 400);
  assert.equal((await page(path.join(REPO, 'docs', 'vieja.htm'))).status, 400);
});

test('un .html fuera de las raíces → 403', async () => {
  assert.equal((await page(path.join(OUTSIDE, 'fuera.html'))).status, 403);
});

test('la lista de nombres vedados rige también aquí: secrets.* y .git → 403', async () => {
  assert.equal((await page(path.join(REPO, 'docs', 'secrets.report.html'))).status, 403);
  assert.equal((await page(path.join(REPO, '.git', 'x.html'))).status, 403);
});

test('un enlace .html que apunta a un .js → 400', async () => {
  const link = path.join(REPO, 'docs', 'enlace.html');
  const target = path.join(REPO, 'docs', 'app.js');
  let real = true;
  try {
    symlinkSync(target, link, 'file');
  } catch {
    // File symlinks on Windows need Developer Mode or an elevated shell; then
    // the link is simulated where it matters, in what realpath answers (the
    // same device `files.test.mjs` uses). Only a real link proves the disk side.
    real = false;
  }
  const local = machines().local;
  const origRealpath = local.fs.realpath.bind(local.fs);
  const had = Object.prototype.hasOwnProperty.call(local.fs, 'realpath');
  if (!real) local.fs.realpath = async (p, o) => (p === link ? origRealpath(target, o) : origRealpath(p, o));
  try {
    const res = await page(link);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  } finally {
    if (!real && !had) delete local.fs.realpath;
  }
});
