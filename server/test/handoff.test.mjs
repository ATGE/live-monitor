import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PROCESS_RULE, processRuleFor, GITHUB_PUBLISH_RULE } from '../src/rules.js';
import { platformLabel, machineNoteFor, arrivalBlock } from '../src/handoff.js';
import { renderPrompt, validatePrompts, ALLOWED } from '../src/prompts.js';

const DIR = path.join(process.cwd(), 'server', 'prompts');

// Sentences of a rule: the bold header ends in `.**`, the rest in `.`.
const sentences = (rule) => rule.split(/(?<=\.(?:\*\*)?) /);

// ---------------------------------------------------------------------------
// The process rule, per machine
// ---------------------------------------------------------------------------

test('en local (o sin máquina) la regla de procesos es la de siempre, byte a byte', () => {
  assert.equal(processRuleFor({ kind: 'local' }), PROCESS_RULE);
  assert.equal(processRuleFor(undefined), PROCESS_RULE);
  assert.equal(processRuleFor(null), PROCESS_RULE);
});

test('en un runner la regla no habla de 8080/8090 y cambia solo esa frase', () => {
  const runner = processRuleFor({ name: 'runner-1', kind: 'runner', platform: 'linux' });
  assert.doesNotMatch(runner, /8080|8090/);
  assert.match(runner, />18000 y compruébalo antes/);
  assert.match(runner, /Los servidores que levantó el tablero/);

  const antes = sentences(PROCESS_RULE);
  const ahora = sentences(runner);
  assert.equal(ahora.length, antes.length);
  const distintas = antes.map((s, i) => i).filter((i) => antes[i] !== ahora[i]);
  assert.equal(distintas.length, 1, `frases distintas: ${distintas.map((i) => ahora[i]).join(' | ')}`);
  assert.match(antes[distintas[0]], /8080 y 8090/);
  assert.match(ahora[distintas[0]], /NEVER touch a process you did not start/);
  assert.match(ahora[distintas[0]], /no main checkout/);
});

// ---------------------------------------------------------------------------
// The machine note
// ---------------------------------------------------------------------------

test('platformLabel nombra los sistemas conocidos y deja el resto tal cual', () => {
  assert.equal(platformLabel('win32'), 'Windows');
  assert.equal(platformLabel('linux'), 'Linux');
  assert.equal(platformLabel('darwin'), 'macOS');
  assert.equal(platformLabel('freebsd'), 'freebsd');
});

test('sin otras plataformas no hay nota: la tarea nunca vivió en otro sitio', () => {
  const machine = { name: 'local', kind: 'local', platform: 'win32' };
  assert.equal(machineNoteFor({ machine, worktreePath: 'C:/wt' }), '');
  assert.equal(machineNoteFor({ machine, worktreePath: 'C:/wt', otherPlatforms: [] }), '');
});

test('en un runner Linux que vino de Windows la nota dice máquina, sistema, ruta y el otro sistema', () => {
  const note = machineNoteFor({
    machine: { name: 'runner-1', kind: 'runner', platform: 'linux' },
    worktreePath: '/home/runner/hfs-wt/issue-937',
    otherPlatforms: ['win32'],
  });
  assert.match(note, /^\[[^\n]*\]\n*$/, 'una sola línea entre corchetes');
  assert.match(note, /runner-1/);
  assert.match(note, /Linux/);
  assert.match(note, /\/home\/runner\/hfs-wt\/issue-937/);
  assert.match(note, /Windows/);
});

test('un runner Linux cuyo otro sitio también es Linux no lleva nota: las rutas son del mismo sistema', () => {
  const machine = { name: 'runner-1', kind: 'runner', platform: 'linux' };
  assert.equal(machineNoteFor({ machine, worktreePath: '/wt', otherPlatforms: ['linux'] }), '');
  assert.equal(machineNoteFor({ machine, worktreePath: '/wt', otherPlatforms: ['linux', 'linux'] }), '');
  assert.match(machineNoteFor({ machine, worktreePath: '/wt', otherPlatforms: ['linux', 'win32'] }), /paths from Windows\./);
});

// ---------------------------------------------------------------------------
// The arrival block
// ---------------------------------------------------------------------------

const where = { machineName: 'runner-1', platform: 'linux', worktreePath: '/wt/937', wip: false };
const moved = (over) => ({ from: 'local', to: 'runner-1', at: '2026-09-14T10:30:45.000Z', text: null, brief: null, resumed: false, ...over });

test('sin handoff no hay bloque', () => {
  assert.equal(arrivalBlock(null, where), '');
  assert.equal(arrivalBlock(undefined, where), '');
});

test('sesión nueva con el texto del handoff: de dónde vino, cuándo (UTC) y lo que escribió', () => {
  const b = arrivalBlock(moved({ text: 'TEXTO DEL HANDOFF' }), where);
  assert.match(b, /On 2026-09-14 10:30 UTC this task moved from local to runner-1 \(Linux\), worktree `\/wt\/937`\./);
  assert.match(b, /starts fresh/);
  assert.match(b, /What the previous session wrote before leaving:\nTEXTO DEL HANDOFF/);
  assert.doesNotMatch(b, /brief/i);
  assert.doesNotMatch(b, /wip: uncommitted work/);
});

test('sesión nueva solo con brief: se presenta como el brief de git', () => {
  const b = arrivalBlock(moved({ brief: 'BRIEF DE GIT' }), where);
  assert.match(b, /starts fresh/);
  assert.match(b, /git brief of the branch instead:\nBRIEF DE GIT/);
  assert.doesNotMatch(b, /wrote before leaving/);
});

test('con texto y brief, primero el texto y luego el brief etiquetado', () => {
  const b = arrivalBlock(moved({ text: 'TEXTO', brief: 'BRIEF' }), where);
  assert.ok(b.indexOf('TEXTO') < b.indexOf('Git brief of the branch:\nBRIEF'));
});

test('sesión reanudada: lo que pasó fuera desde cuándo, y releer lo que cambió', () => {
  const b = arrivalBlock(moved({ from: 'runner-1', to: 'local', resumed: true, text: 'LO DE ALLÍ' }), {
    machineName: 'local', platform: 'win32', worktreePath: 'C:/wt/937', wip: false,
  });
  assert.match(b, /resuming on local \(Windows\)/);
  assert.match(b, /spent time on runner-1; it came back on 2026-09-14 10:30 UTC/);
  assert.match(b, /What happened there:\nLO DE ALLÍ/);
  assert.match(b, /Re-read/);
  assert.doesNotMatch(b, /starts fresh/);
});

test('la línea del commit WIP solo aparece si lo hubo, con su asunto exacto', () => {
  assert.doesNotMatch(arrivalBlock(moved({ text: 'x' }), where), /wip: uncommitted work/);
  assert.match(arrivalBlock(moved({ text: 'x' }), { ...where, wip: true }), /`wip: uncommitted work`.*continue from it/);
  assert.match(arrivalBlock(moved({ resumed: true, brief: 'x' }), { ...where, wip: true }), /wip: uncommitted work/);
  const conWip = arrivalBlock(moved({ text: 'x' }), { ...where, wip: true });
  assert.match(conWip, /fold it into a proper commit before asking for review; never force-push a branch that has an open PR\./);
  assert.doesNotMatch(conWip, /leave history clean/, 'the WIP commit is already pushed');
});

test('todo bloque de llegada pide no mencionar la mudanza en commits ni en el PR, y lo dice al final', () => {
  const close = 'Do not mention the move, the machines or the board in commit messages or PR text.]';
  for (const b of [
    arrivalBlock(moved({ text: 'x' }), where),
    arrivalBlock(moved({ brief: 'x' }), where),
    arrivalBlock(moved({ resumed: true, text: 'x' }), where),
    arrivalBlock(moved({ text: 'x' }), { ...where, wip: true }),
  ]) {
    assert.ok(b.endsWith(close), `does not close with the rule: ${b}`);
  }
});

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

const hoy = { text: 'HOLA', siblings: '\n\n[Aviso del tablero: HERMANOS]', e2ePortEnv: 'E2E_PORT', attachments: '\n\nADJUNTOS' };
const normal = (s) => s.replace(/\s+/g, ' ').trim();

test('chat-rules con handoff y machineNote vacíos no deja rastro de ellos en el prompt', () => {
  // The same template with the two new placeholders deleted, filled in by hand.
  // `shellRule` is empty here the same way handoff/machineNote are: this chat
  // did not move, and on Linux there is no heredoc warning to give.
  // `shellRule` and `tmpRule` are empty here the same way handoff/machineNote
  // are: this chat did not move, and with no machine there is neither a
  // Windows heredoc warning nor a runner's RAM-disk `/tmp` to warn about.
  const vars = {
    ...hoy, parallel: 'x', processRule: PROCESS_RULE, shellRule: '', tmpRule: '', githubPublishRule: GITHUB_PUBLISH_RULE,
  };
  const antes = readFileSync(path.join(DIR, 'chat-rules.md'), 'utf8')
    .replace('{{handoff}}', '')
    .replace('{{machineNote}}', '')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k]));
  // `chat-rules.md` carries `{{parallel}}`: pass the same stand-in to both sides.
  const ahora = renderPrompt('chat-rules', { ...hoy, parallel: 'x' });
  assert.equal(normal(ahora), normal(antes));
  assert.equal(ahora, antes, 'ni siquiera cambia el espaciado');
});

test('chat-rules con handoff y nota de máquina los pone en su sitio y en orden', () => {
  const handoff = arrivalBlock(moved({ text: 'EL HANDOFF' }), where);
  const machineNote = machineNoteFor({
    machine: { name: 'runner-1', kind: 'runner', platform: 'linux' }, worktreePath: '/wt/937', otherPlatforms: ['win32'],
  });
  const p = renderPrompt('chat-rules', { ...hoy, handoff, machineNote, processRule: processRuleFor({ kind: 'runner' }) });
  const at = (s) => p.indexOf(s);
  assert.ok(at('HOLA') < at('HERMANOS'));
  assert.ok(at('HERMANOS') < at('EL HANDOFF'), 'el handoff va tras los hermanos');
  assert.ok(at('EL HANDOFF') < at('This session runs on runner-1'));
  assert.ok(at('This session runs on runner-1') < at('[Reglas del entorno:'), 'la nota abre las reglas del entorno');
  assert.ok(at('[Reglas del entorno:') < at('ADJUNTOS'));
  assert.doesNotMatch(p, /8080/);
});

test('validatePrompts conoce handoff, y handoff.md se renderiza sin variables', () => {
  assert.deepEqual(ALLOWED.handoff, []);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.ok(validatePrompts() >= Object.keys(ALLOWED).length);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings.filter((w) => w.includes('handoff')), []);

  const h = renderPrompt('handoff', {});
  assert.match(h, /do not run any tool or command/);
  assert.match(h, /cannot see this conversation/);
  for (const heading of ['Current state', 'Decisions', 'Pending', 'How to build, run and measure', 'Still running']) {
    assert.match(h, new RegExp(`## ${heading}`));
  }
  assert.match(h, /400 words/);
  assert.doesNotMatch(h, /\{\{/);
});
