import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (p) => { const v = p.split('.').reduce((o, k) => o?.[k], es); assert.equal(typeof v, 'string', `missing es key ${p}`); return v; };

// No web test runner: the design toggle's wiring and the Artifact links are
// pinned by reading the sources as text, like web-card-settings.test.mjs does.
// The toggle on the card itself is pinned by web-artifact-card.test.mjs.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const api = read('api.js');
const app = read('App.jsx');
const activity = read('components/ActivityGroup.jsx');
const css = read('styles/activity.css');
const publishQuestion = read('publishQuestion.js');

test('api.setDesign posts {on} to the design route of the task', () => {
  assert.match(api, /setDesign: \(project, issue, on\) => send\(`\$\{T\(project, issue\)\}\/design`, \{ on \}\)/);
});

test('App wires onSetDesign to api.setDesign for the active project', () => {
  assert.match(app, /onSetDesign=\{\(issue, on\) => api\.setDesign\(activeProject, issue, on\)\.catch\(say\)\}/);
});

test('Artifact links render as canvas cards outside the row button, visible without opening', () => {
  assert.match(activity, /item\.links/);
  assert.match(activity, /<a key=\{url\} className="ac-canvas" href=\{url\} target="_blank" rel="noreferrer"/);
  assert.match(activity, /aria-label=\{PUBLISH_COPY\.canvasAria\(title\)\}/);
  assert.match(activity, /import \{ PUBLISH_COPY \} from '\.\.\/publishQuestion\.js'/);
  assert.match(publishQuestion, /canvasAria: \(title\) => fill\(strings\(\)\.shared\.publish\.canvasAria, \{ title \}\)/);
  assert.equal(E('shared.publish.canvasAria'), '{title} (lienzo de Claude Design; se abre en una pestaña nueva)');
  assert.match(activity, /<Icon name="palette" \/>/);
  assert.match(activity, /<Icon name="external" /);
  // The raw URL is never the visible text of the card.
  assert.doesNotMatch(activity, /<a [^>]*>\{url\}<\/a>/);
  const linksAt = activity.indexOf('className="ac-canvases"');
  const lineAt = activity.indexOf('className="ac-line"');
  const detailAt = activity.indexOf('className="ac-detail"');
  assert.ok(lineAt > -1 && linksAt > lineAt, 'cards come after the row');
  assert.ok(detailAt > linksAt, 'cards sit before the folded detail, so they show closed');
  const row = activity.slice(lineAt, activity.indexOf('</button>', lineAt));
  assert.doesNotMatch(row, /ac-canvas/, 'a card is never inside the row button');
  assert.match(css, /\.ac-canvas \{/);
});

test('a canvas title comes from the call summary, never from a path or a URL', () => {
  assert.match(activity, /export function canvasTitle\(item\)/);
  // The pure part, evaluated without React: the very text of the component.
  const from = activity.indexOf('export const CANVAS_FALLBACK');
  const to = activity.indexOf('/**', activity.indexOf('export function canvasTitle'));
  const body = activity.slice(from, to).replaceAll('export ', '');
  assert.match(body, /CANVAS_FALLBACK = \(\) => strings\(\)\.chat\.activity\.canvasFallback/);
  assert.equal(E('chat.activity.canvasFallback'), 'Lienzo de Claude Design');
  const { canvasTitle, CANVAS_FALLBACK: fallbackOf } = new Function('strings', `${body}; return { canvasTitle, CANVAS_FALLBACK };`)(() => es);
  const CANVAS_FALLBACK = fallbackOf();
  assert.equal(CANVAS_FALLBACK, 'Lienzo de Claude Design');
  assert.equal(canvasTitle({ summary: 'publish: sql-export — nombres de descarga' }), 'sql-export — nombres de descarga');
  assert.equal(canvasTitle({ summary: 'publish: C:\\tmp\\scratch\\page.html' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({ summary: 'publish: /tmp/page.html' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({ summary: 'publish: https://claude.ai/artifact/abc' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({ summary: 'publish: Antes/después' }), 'Antes/después');
  assert.equal(canvasTitle({ summary: 'publish: ~/page' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({ summary: 'publish: scratch/page.html' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({ summary: 'publish' }), CANVAS_FALLBACK);
  assert.equal(canvasTitle({}), CANVAS_FALLBACK);
});

test('only a held Artifact call or a question waits for the person; reads pass', () => {
  assert.match(activity, /const READS = new Set\(\['list', 'read', 'quickstart', 'get', 'query'\]\)/);
  const from = activity.indexOf('const READS');
  const to = activity.indexOf('function walk');
  const { isWaiting } = new Function(`${activity.slice(from, to).replace(/const STATUS_ICON[^]*/, '')}; return { isWaiting };`)();
  const run = (name, summary) => isWaiting({ status: 'running', name, summary });
  assert.equal(run('Artifact', 'publish: x'), true);
  assert.equal(run('Artifact', 'update'), true);
  assert.equal(run('ArtifactData', 'list'), false);
  assert.equal(run('ArtifactComments', 'read'), false);
  assert.equal(run('AskUserQuestion', 'pregunta: ¿?'), true);
  assert.equal(isWaiting({ status: 'done', name: 'Artifact', summary: 'publish: x' }), false);
  // The icon is silent; the row's own screen-reader text says it once.
  assert.doesNotMatch(activity, /title="Espera tu respuesta"/);
  assert.doesNotMatch(activity, /title=\{t\.chat\.activity\.waitingSr\}/);
  assert.match(activity, /t\.chat\.activity\.waitingSr/);
  assert.equal(E('chat.activity.waitingSr'), ', espera tu respuesta');
});

test('the activity group states status by icon and keeps the hooks the file viewer needs', () => {
  assert.match(activity, /name="hourglass"/);
  assert.match(activity, /<LiveDot /);
  assert.match(activity, /x-circle/);
  assert.match(activity, /className="row-toggle"/);
  assert.match(activity, /className="file-ref"/);
  assert.doesNotMatch(activity, /className="(?:activity|spinner)/);
});
