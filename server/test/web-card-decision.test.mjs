// The card's «Decisión pendiente» group and the closed card's main action.
// The web has no browser runner: the test reads the component as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

// DECISION_GROUP_FILE lets a run point at an older copy to see the test red.
const file = process.env.DECISION_GROUP_FILE
  ?? fileURLToPath(new URL('../../web/src/components/card/DecisionGroup.jsx', import.meta.url));
const src = readFileSync(file, 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../web/src/styles/card-decision.css', import.meta.url)), 'utf8');

// The footer branch: from its `if` to the expanded branch's first comment.
const footer = src.slice(src.indexOf("if (variant === 'footer')"), src.indexOf('// A failure is its own red block'));

test('the stretched card shows a CardSection titled «Decisión pendiente»', () => {
  assert.match(src, /import CardSection from '\.\/CardSection\.jsx'/);
  pin('card.decision.title', 'Decisión pendiente');
  pin('card.decision.failed', 'Falló');
  pin('card.decision.failedAt', 'Falló en {phase}');
  assert.match(src, /<CardSection title=\{t\.card\.decision\.title\} tone="warn" count=\{count\}>/);
  assert.match(src, /title=\{failedAt \? fill\(t\.card\.decision\.failedAt, \{ phase: failedAt \}\) : t\.card\.decision\.failed\} tone="danger"/);
});

test('Responder is the solid amber button', () => {
  pin('card.decision.answer', 'Responder');
  assert.match(src, /className="btn btn-amber btn-block tcd-main"[^>]*[\s\S]{0,300}?t\.card\.decision\.answer\}/);
});

test('the conditions that decide each button stay literal', () => {
  assert.ok(src.includes("pending?.kind === 'question' && !park"));
  assert.ok(src.includes("task.state === 'error' && !rerunning"));
  assert.ok(src.includes("task.state === 'error' && !rerunning && task.hasWorktree"));
});

test('the closed card carries only the main action, never «Seguir desde tests»', () => {
  assert.ok(footer.length > 200, 'footer branch found');
  pin('card.decision.continueFromTests', 'Seguir desde tests');
  assert.ok(!footer.includes('continueFromTests'));
  assert.ok(!footer.includes('onAcceptFix'));
  pin('card.decision.retryMove', 'Reintentar mudanza');
  pin('card.decision.reviewPlan', 'Revisar plan');
  pin('card.decision.publishPr', 'Publicar PR');
  assert.match(footer, /t\.card\.decision\.retryMove\}/);
  assert.match(footer, /t\.card\.decision\.reviewPlan\}/);
  assert.match(footer, /t\.card\.decision\.publishPr\}/);
});

test('the failed-move block keeps «Reintentar mudanza» and drops the old grid classes', () => {
  pin('card.decision.discard', 'Descartar');
  assert.match(src, /t\.card\.decision\.retryMove\}/);
  assert.match(src, /t\.card\.decision\.discard\}/);
  assert.doesNotMatch(src, /className="[^"]*(?<![\w-])(actions|c1|c2|span-2|ctl-group|primary|warn)(?![\w-])/);
  assert.doesNotMatch(src, /\bbtn-secondary\b/);
});

test('mobile makes the buttons 32 high', () => {
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*height: 32px/);
  assert.doesNotMatch(css, /!important/);
});
