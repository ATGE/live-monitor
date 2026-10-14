// The decision extractor, exercised against a hand-written mini transcript.
//
// Nothing here may reach the real files -- neither the real `sessions.json` nor
// `decisions.md`, `docs/decisions/` or `docs/history/` -- so every test builds
// its own workspace under a temp directory and points both the sessions file
// and the extractor's config at it. `core.mjs` reads its sessions path when it
// loads, so the environment is set before the dynamic import below.
//
// Imports nothing from `server/src`: the extractor lives outside the server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const EXTRACT = path.join(REPO_ROOT, 'tools', 'decisions', 'extract.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfsmon-decisions-'));
process.env.HFSMON_DECISIONS_SESSIONS = path.join(TMP, 'sessions.json');
fs.writeFileSync(
  process.env.HFSMON_DECISIONS_SESSIONS,
  `${JSON.stringify({ sessions: [], roots: [TMP] }, null, 2)}\n`,
  'utf8',
);

const extract = await import('../../tools/decisions/extract.mjs');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a temp dir that refuses to go away invalidates nothing */
  }
});

// --------------------------------------------------------------------------
// The synthetic transcript
// --------------------------------------------------------------------------

const SESSION = '11111111-2222-3333-4444-555555555555';
const LOCAL_SESSION = '99999999-8888-7777-6666-555555555555';
const T0 = Date.parse('2026-01-02T10:00:00.000Z');
const ts = (min) => new Date(T0 + min * 60_000).toISOString();
const CUTOFF = ts(25);
const DAY = '2026-01-02'; // America/La_Paz is UTC-4: 10:00Z is 06:00 the same day

const PREVIEW = ['┌──────────────┐', '│ ```` raro    │', '└──────────────┘'].join('\n');
const PASTE = `## Volcado\n${'salida de la máquina; '.repeat(40)}`;

// A question that quotes the log's own structure at us: a decision marker and a
// day heading, inside the question body. This is the whole reason the parsers
// walk fences instead of scanning raw lines.
const QUOTED = [
  'El día que se generó salió así, ¿lo dejamos?',
  '',
  '## 2026-09-13',
  '',
  '<!-- decision id="toolu_falso" q="1/1" hash="000000000000" at="2026-09-13T00:00:00.000Z" kind="elegida" -->',
].join('\n');

const Q_PARALELO = {
  question: '¿Cuántos chats pueden trabajar a la vez?',
  header: 'Paralelo',
  multiSelect: true,
  options: [
    { label: 'Sí, siempre', description: 'Uno por tarea,\nsin límite.' },
    { label: 'No', description: 'Solo uno cada vez.' },
    { label: 'Con aviso', description: 'Avisa a los demás chats <remota> incluida.', preview: PREVIEW },
  ],
};
const Q_ZONA = {
  question: '¿Qué zona horaria muestro en el tablero?',
  header: 'Zona',
  multiSelect: false,
  options: [
    { label: 'UTC', description: 'Siempre UTC.' },
    { label: 'Local', description: 'La del tablero.' },
  ],
};
const Q_DATOS = {
  question: '¿Me pasas el volcado de la máquina?',
  header: 'Datos',
  multiSelect: false,
  options: [{ label: 'Sí', description: 'Pégalo aquí.' }],
};
const Q_CAMBIO = {
  question: '¿Aplico el cambio en el arranque?',
  header: 'Cambio',
  multiSelect: false,
  options: [
    { label: 'Sí', description: 'Se aplica ya.' },
    { label: 'No', description: 'Se queda como está.' },
  ],
};
const Q_SIN = {
  question: '¿Sigo con la siguiente tarea?',
  header: 'Sin',
  multiSelect: false,
  options: [{ label: 'X', description: 'Da igual.' }],
};
const Q_DETALLE = {
  question: '¿Prefieres P o Q?',
  header: 'Detalle',
  multiSelect: false,
  options: [
    { label: 'P', description: 'La primera.' },
    { label: 'Q', description: 'La segunda.' },
  ],
};
const Q_DETALLE_2 = {
  question: '¿Prefieres P o Q? (ahora con el contexto completo)',
  header: 'Detalle',
  multiSelect: false,
  options: [
    { label: 'P', description: 'La primera, que hace esto.' },
    { label: 'Q', description: 'La segunda, que hace lo otro.' },
  ],
};
const Q_CITA = {
  question: QUOTED,
  header: 'Cita',
  multiSelect: false,
  options: [
    { label: 'Se queda', description: 'Tal cual.' },
    { label: 'Se cambia', description: 'Otro formato.' },
  ],
};
const Q_TARDE = {
  question: '¿Pregunto antes del corte y me contestas después?',
  header: 'Tarde',
  multiSelect: false,
  options: [
    { label: 'Sí, claro', description: 'La respuesta llega igual.' },
    { label: 'No', description: 'Se queda sin respuesta.' },
  ],
};
const Q_FUTURO = {
  question: 'ESTA PREGUNTA ES POSTERIOR AL CORTE',
  header: 'Futuro',
  multiSelect: false,
  options: [{ label: 'Z', description: 'Nunca se renderiza.' }],
};
const Q_LOCAL = {
  question: 'PREGUNTA SOLO DE LA SESIÓN LOCAL',
  header: 'Local',
  multiSelect: false,
  options: [{ label: 'L', description: 'Solo en esta máquina.' }],
};

const PLAN_OK = '# Plan aprobado\n\nHacer algo.\n\n```js\nconst x = 1;\n```';
const PLAN_NO = '# Plan rechazado\n\nTocar | cosas que no tocaba.';

function human(min, text, session = SESSION) {
  return {
    type: 'user',
    origin: { kind: 'human' },
    promptId: `p-${session.slice(0, 4)}-${min}`,
    sessionId: session,
    timestamp: ts(min),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function askLine(min, id, questions, session = SESSION) {
  return {
    type: 'assistant',
    sessionId: session,
    timestamp: ts(min),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }],
    },
  };
}

function answerLine(min, id, questions, answers, session = SESSION) {
  return {
    type: 'user',
    sessionId: session,
    timestamp: ts(min),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' },
      ],
    },
    toolUseResult: { questions, answers },
  };
}

function planLine(min, id, plan, planFilePath) {
  return {
    type: 'assistant',
    sessionId: SESSION,
    timestamp: ts(min),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan, planFilePath } }],
    },
  };
}

function resultLine(min, id, content, toolUseResult) {
  return {
    type: 'user',
    sessionId: SESSION,
    timestamp: ts(min),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    toolUseResult,
  };
}

const TRANSCRIPT = [
  human(1, 'arranquemos con esto'),
  askLine(2, 'tu-a1', [Q_PARALELO, Q_ZONA]),
  answerLine(3, 'tu-a1', [Q_PARALELO, Q_ZONA], {
    // The first label contains ", " itself: splitting on the separator shreds it.
    [Q_PARALELO.question]: 'Sí, siempre, No',
    [Q_ZONA.question]: 'ninguna de las dos, quiero la del navegador',
  }),
  askLine(4, 'tu-a2', [Q_DATOS]),
  answerLine(5, 'tu-a2', [Q_DATOS], { [Q_DATOS.question]: PASTE }),
  askLine(6, 'tu-a3', [Q_CAMBIO]),
  answerLine(7, 'tu-a3', [Q_CAMBIO], { [Q_CAMBIO.question]: 'ya no quiero el cambio' }),
  askLine(8, 'tu-a4', [Q_SIN]), // never answered
  askLine(9, 'tu-a5', [Q_DETALLE]),
  answerLine(10, 'tu-a5', [Q_DETALLE], {
    [Q_DETALLE.question]: 'no entiendo, necesito más detalle y que me vuelvas a preguntar',
  }),
  askLine(11, 'tu-a6', [Q_DETALLE_2]),
  answerLine(12, 'tu-a6', [Q_DETALLE_2], { [Q_DETALLE_2.question]: 'P' }),
  human(13, 'sigue con los planes'),
  planLine(14, 'tu-p1', PLAN_OK, '/tmp/plan-a.md'),
  resultLine(15, 'tu-p1', 'Plan approved', {
    plan: PLAN_OK,
    isAgent: false,
    filePath: '/tmp/plan-a.md',
  }),
  planLine(16, 'tu-p2', PLAN_NO, ''),
  resultLine(
    17,
    'tu-p2',
    "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    'User rejected tool use',
  ),
  human(18, 'no me gusta | esto\nen dos líneas'),
  planLine(19, 'tu-p3', '# Plan fuera de modo plan', ''),
  resultLine(
    20,
    'tu-p3',
    '<tool_use_error>You are not in plan mode.</tool_use_error>',
    'Error: You are not in plan mode.',
  ),
  askLine(21, 'tu-a8', [Q_CITA]),
  answerLine(22, 'tu-a8', [Q_CITA], { [Q_CITA.question]: 'Se queda' }),
  askLine(24, 'tu-a9', [Q_TARDE]), // straddles the cutoff: asked under it...
  answerLine(26, 'tu-a9', [Q_TARDE], { [Q_TARDE.question]: 'Sí, claro' }), // ...answered over it
  human(28, 'seguimos mañana'), // the cutoff is closed: Edson already typed after it
  askLine(30, 'tu-a7', [Q_FUTURO]), // after the cutoff
  answerLine(31, 'tu-a7', [Q_FUTURO], { [Q_FUTURO.question]: 'Z' }),
];

const LOCAL_TRANSCRIPT = [
  human(5.4, 'esto solo pasó en esta máquina', LOCAL_SESSION),
  askLine(5.5, 'tu-local', [Q_LOCAL], LOCAL_SESSION),
  answerLine(5.6, 'tu-local', [Q_LOCAL], { [Q_LOCAL.question]: 'L' }, LOCAL_SESSION),
  human(29, 'y aquí también sigo', LOCAL_SESSION),
];

let workspaces = 0;

/** An isolated workspace: transcript, sessions list, config and output dirs. */
function makeWorkspace({
  sessions = true,
  lines = TRANSCRIPT,
  local = false,
  cutoff = CUTOFF,
  adrMap = {},
} = {}) {
  workspaces += 1;
  const dir = path.join(TMP, `ws-${workspaces}`);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  const write = (file, rows) =>
    fs.writeFileSync(file, `${rows.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  write(transcript, lines);

  const sessionsPath = path.join(dir, 'sessions.json');
  fs.writeFileSync(
    sessionsPath,
    `${JSON.stringify(
      {
        sessions: sessions ? [{ id: SESSION, label: 'sesión de prueba', transcript }] : [],
        roots: [dir],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (local) {
    // Gitignored on a real machine: listed by hand, never committed.
    const localTranscript = path.join(dir, `${LOCAL_SESSION}.jsonl`);
    write(localTranscript, LOCAL_TRANSCRIPT);
    fs.writeFileSync(
      path.join(dir, 'sessions.local.json'),
      `${JSON.stringify(
        {
          sessions: [
            {
              id: LOCAL_SESSION,
              label: 'sesión local de esta máquina',
              transcript: localTranscript,
              enrolled: ts(0),
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const indexPath = path.join(dir, 'decisions.md');
  const daysDir = path.join(dir, 'docs', 'decisions');
  const historyDir = path.join(dir, 'docs', 'history');
  // `adr.md` sits next to `decisions.md`, at the workspace root -- same
  // layout as the real repo, where it lives beside `decisions.md` and not
  // under `docs/decisions/`.
  const adrIndexPath = path.join(dir, 'adr.md');
  const adrDir = path.join(dir, 'docs', 'adr');
  // A workspace-local adr-map.json, never the repo's real one: the real map's
  // D-nnnn keys would otherwise collide with this synthetic transcript, which
  // numbers its own decisions D-0001, D-0002... the same way.
  const adrMapPath = path.join(dir, 'adr-map.json');
  fs.mkdirSync(adrDir, { recursive: true });
  fs.writeFileSync(adrMapPath, `${JSON.stringify(adrMap, null, 2)}\n`, 'utf8');
  const configPath = path.join(dir, 'decisions.config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        cutoff,
        output: {
          index: indexPath,
          days: daysDir,
          history: historyDir,
          adrIndex: adrIndexPath,
          adrDir,
          adrMap: adrMapPath,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    dir,
    transcript,
    sessionsPath,
    configPath,
    indexPath,
    daysDir,
    historyDir,
    adrIndexPath,
    adrDir,
    adrMapPath,
    dayFile: path.join(daysDir, `${DAY}.md`),
  };
}

/** A minimal ADR skeleton, the shape C3 hand-writes for every real one. */
function writeAdrFile(ws, number, slug, { contexto = [], tail = null } = {}) {
  const lines = [
    `# ADR-${number} · Título de prueba`,
    '',
    '**Estado.** Aceptada',
    '',
    '**Fecha.** 2026-01-02',
    '',
    '**Rastro.** —',
    '',
    '**Afecta a.** —',
    '',
    '## Contexto',
    '',
    ...(contexto.length ? [...contexto, ''] : []),
    '## Decisión',
    '',
    '## Consecuencias',
    '',
    '## Por qué no las alternativas',
    '',
    ...(tail ?? ['<!-- adr:generated -->', '<!-- /adr:generated -->']),
    '',
  ];
  const file = path.join(ws.adrDir, `${number}-${slug}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function runCli(ws, args = []) {
  return spawnSync(process.execPath, [EXTRACT, '--config', ws.configPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HFSMON_DECISIONS_SESSIONS: ws.sessionsPath },
  });
}

/** Every file on disk under the workspace, with its bytes, for "nothing moved". */
function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.set(full, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('numera, clasifica, empareja y respeta el corte', async () => {
  const ws = makeWorkspace();
  const { files, report, model } = await extract.build({
    configPath: ws.configPath,
    sessionsPath: ws.sessionsPath,
    adrMap: { 'D-0001': ['ADR-0014'] },
  });

  // Numbering runs over every question of every dialog, in stream order.
  assert.deepEqual(
    model.decisions.map((d) => d.number),
    ['D-0001', 'D-0002', 'D-0003', 'D-0004', 'D-0005', 'D-0006', 'D-0007', 'D-0008', 'D-0009'],
  );
  assert.deepEqual(
    model.decisions.map((d) => d.kind),
    [
      'elegida', // multiSelect, both labels matched
      'libre', // free text
      'dato', // a paste over 500 characters
      'abandonada', // "ya no quiero el cambio"
      'sin respuesta', // the dialog never got a result
      'repreguntada', // asked again right afterwards
      'elegida',
      'elegida', // the question that quotes a marker at us
      'elegida', // asked under the cutoff, answered over it
    ],
  );

  // A label that contains ", " survives the join.
  assert.deepEqual(model.decisions[0].chosen, ['Sí, siempre', 'No']);
  assert.equal(model.decisions[0].freeText, '');
  assert.equal(model.decisions[1].chosen.length, 0);
  assert.match(model.decisions[1].freeText, /quiero la del navegador/);
  assert.equal(report.questions, 9);
  assert.equal(report.dialogs, 8); // the ninth dialog is after the cutoff
  assert.equal(report.unanswered, 1);
  assert.equal(report.pairs, 1);
  assert.equal(report.plansApproved, 1);
  assert.equal(report.plansRejected, 1);
  assert.equal(report.plansError, 1);
  assert.equal(report.closingRule.held, true);

  const day = files.get(ws.dayFile);
  assert.ok(day, 'el día se renderiza');
  const index = files.get(ws.indexPath);
  assert.ok(index, 'el índice se renderiza');

  // The cutoff excludes the whole record, question text included. A dialog that
  // straddles it (asked under, answered over) is kept, answer and all.
  for (const content of files.values()) {
    assert.ok(!content.includes('POSTERIOR AL CORTE'), 'nada posterior al corte se filtra');
  }
  assert.match(day, /\*\*Respuesta\.\*\* Sí, claro/);
  assert.equal(model.decisions[8].kind, 'elegida');

  // Pair links, in both directions.
  assert.match(day, /\*\*Reformulada en\.\*\* \[D-0007\]\(#d-0007\)/);
  assert.match(day, /\*\*Reformula a\.\*\* \[D-0006\]\(#d-0006\)/);

  // ADR back-links, present and absent. `adr.md` sits at the workspace
  // root, two levels above a day file under `docs/decisions/`: a bare
  // `adr.md#adr-0014` here would resolve to `docs/decisions/adr.md`, which
  // does not exist.
  assert.match(day, /\*\*Recogida en\.\*\* \[ADR-0014\]\(\.\.\/\.\.\/adr\.md#adr-0014\)/);
  assert.match(day, /\*\*Recogida en\.\*\* — \(sin ADR todavía\)/);

  // Rejected options are kept, with their descriptions, and marked unchosen.
  assert.match(day, /- \[x\] \*\*Sí, siempre\*\* — Uno por tarea, sin límite\./);
  assert.match(day, /- \[ \] \*\*Con aviso\*\* — Avisa a los demás chats &lt;remota&gt; incluida\./);
  assert.match(day, /\*\*Respuesta\.\*\* Sí, siempre · No/);
  assert.match(day, /\*\*Respuesta\.\*\* — sin respuesta —/);

  // The preview lives in its own fence at column 0, wide enough for its own
  // backticks (the preview holds a run of four, so the fence needs five).
  const lines = day.split('\n');
  const open = lines.findIndex((l) => l === '`````text');
  assert.ok(open > 0, 'la vista previa abre una cerca de cinco tildes en la columna 0');
  assert.equal(lines[open + 1], '┌──────────────┐');
  assert.equal(lines[open + 4], '`````');
  assert.ok(lines.some((l) => l === '```text'), 'las preguntas usan una cerca de tres');

  // Anchors are unique inside the day file.
  const anchors = [...day.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
  assert.equal(anchors.length, 9);
  assert.equal(new Set(anchors).size, anchors.length);

  // Every link of the index resolves to a file we generated and to an anchor
  // that really exists in it.
  const links = [...index.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 10);
  for (const link of links) {
    const [target, anchor] = link.split('#');
    const full = path.resolve(path.dirname(ws.indexPath), target);
    const content = files.get(full);
    assert.ok(content, `el índice apunta a ${link}, que existe`);
    if (anchor) assert.ok(content.includes(`<a id="${anchor}"></a>`), `${link} tiene ancla`);
  }
  assert.match(index, /- \[2026-01-02\]\([^)]+\) — 9 decisiones/);
  assert.match(index, /- \[D-0001\]\([^)]+#d-0001\) · Paralelo · ¿Cuántos chats/);

  // Plans: one file each, the plan verbatim inside a markdown fence wide enough
  // for the fence the plan itself contains.
  const approved = files.get(path.join(ws.historyDir, `plan-001-aprobado-${DAY}.md`));
  const rejected = files.get(path.join(ws.historyDir, `plan-002-rechazado-${DAY}.md`));
  const readme = files.get(path.join(ws.historyDir, 'README.md'));
  assert.ok(approved && rejected && readme);
  assert.ok(approved.includes('````markdown'), 'el plan va en una cerca de cuatro');
  assert.ok(approved.includes('```js'), 'la cerca interna del plan se conserva');
  assert.match(approved, /`planFilePath`: `\/tmp\/plan-a\.md`/);
  assert.match(rejected, /\*\*Motivo \(siguiente prompt de Edson\)\.\*\*/);
  assert.ok(rejected.includes('no me gusta | esto'), 'el motivo va literal en su cerca');
  // The table cell is one line, with the pipe escaped.
  assert.match(readme, /\| 002 \| 2026-01-02 [\d:]+ \| rechazado \| \[plan-002[^\]]+\]\([^)]+\) \| no me gusta \\\| esto en dos líneas \|/);
  assert.ok(!readme.includes('```'), 'la tabla no contiene cercas');

  // The renderer round-trips: every marker's hash is the hash of its question.
  const back = extract.parseDayFile(day, 'memoria');
  assert.equal(back.length, 9);
  assert.equal(back[0].question, Q_PARALELO.question);
  assert.deepEqual(
    back.map((b) => b.kind),
    model.decisions.map((d) => d.kind),
  );
});

test('un marcador citado dentro de una pregunta no es estructura', async () => {
  const ws = makeWorkspace();
  const { files } = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  const day = files.get(ws.dayFile);

  // The fake marker and the fake day heading are in the file, verbatim...
  assert.ok(day.includes('<!-- decision id="toolu_falso"'), 'la cita se conserva tal cual');
  assert.ok(day.includes('\n## 2026-09-13\n'), 'el encabezado citado también');
  // ...but only the nine real markers are structure, and the quoted one is not
  // among them.
  const back = extract.parseDayFile(day, 'memoria');
  assert.equal(back.length, 9);
  assert.ok(!back.some((b) => b.id === 'toolu_falso'), 'el marcador citado no cuenta');
  assert.equal(back[7].question, QUOTED, 'la pregunta se recupera entera, con su cita');
});

test('build es idempotente', async () => {
  const ws = makeWorkspace();
  const first = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  const second = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  assert.deepEqual([...first.files.keys()], [...second.files.keys()]);
  for (const [file, content] of first.files) {
    assert.equal(second.files.get(file), content, `${path.basename(file)} idéntico`);
  }
});

test('las sesiones locales quedan fuera salvo que se pidan', async () => {
  const ws = makeWorkspace({ local: true });

  const plain = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  assert.equal(plain.report.sessions, 1);
  assert.deepEqual(
    plain.report.sessionsUsed.map((s) => s.tracked),
    [true],
  );
  assert.equal(plain.report.sessionsSkipped.length, 1);
  assert.equal(plain.report.questions, 9);
  for (const content of plain.files.values()) {
    assert.ok(!content.includes('SOLO DE LA SESIÓN LOCAL'), 'lo local no entra en el corpus');
  }

  const withLocal = await extract.build({
    configPath: ws.configPath,
    sessionsPath: ws.sessionsPath,
    includeLocal: true,
  });
  assert.equal(withLocal.report.sessions, 2);
  assert.equal(withLocal.report.sessionsSkipped.length, 0);
  assert.equal(withLocal.report.questions, 10);
  assert.ok(
    [...withLocal.files.values()].some((c) => c.includes('SOLO DE LA SESIÓN LOCAL')),
    'con --include-local sí entra',
  );
  // And this is exactly why it is off by default: a local-only session shifts
  // the numbering of everything that came after it.
  assert.equal(
    withLocal.model.decisions.find((d) => d.header === 'Local').number,
    'D-0004',
  );
  assert.equal(withLocal.model.decisions[9].number, 'D-0010');

  // Through the CLI, the report names both.
  const cli = runCli(ws);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Sesiones locales omitidas: 1/);
  assert.match(cli.stdout, /usa --include-local/);
  assert.ok(!fs.readFileSync(ws.dayFile, 'utf8').includes('SOLO DE LA SESIÓN LOCAL'));
});

test('un corte en el borde vivo de la transcripción se rechaza', () => {
  // The last human prompt is at minute 29; a cutoff at minute 40 would render
  // answers and rejection reasons that have not been typed yet.
  const ws = makeWorkspace({ cutoff: ts(40) });
  const run = runCli(ws);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Regla de cierre/);
  assert.match(run.stderr, /posterior al último prompt de Edson/);
  assert.ok(!fs.existsSync(ws.indexPath), 'no se escribe nada');
  assert.ok(!fs.existsSync(ws.daysDir));
});

test('matchAnswer es voraz y la etiqueta más larga gana', () => {
  const labels = ['Sí, siempre', 'Sí', 'No'];
  assert.deepEqual(extract.matchAnswer('Sí, siempre, No', labels), {
    chosen: ['Sí, siempre', 'No'],
    leftover: '',
  });
  assert.deepEqual(extract.matchAnswer('Sí', labels), { chosen: ['Sí'], leftover: '' });
  const free = extract.matchAnswer('otra cosa', labels);
  assert.deepEqual(free.chosen, []);
  assert.equal(free.leftover, 'otra cosa');
});

test('los recortes nunca parten un emoji por la mitad', () => {
  // The high surrogate would land exactly on the cut.
  const question = `${'a'.repeat(78)}🙂${'b'.repeat(20)}`;
  const cut = extract.excerpt(question);
  assert.equal(cut, `${'a'.repeat(78)}…`);
  assert.ok(!cut.includes('�'), 'ningún carácter de reemplazo');
  assert.equal(cut, cut.toWellFormed(), 'la cadena está bien formada');

  const long = `${'x'.repeat(298)}🙂${'y'.repeat(20)}`;
  const cell = extract.tableCell(long);
  assert.equal(cell, `${'x'.repeat(298)}…`);
  assert.equal(cell, cell.toWellFormed());

  // Nothing is cut when it fits, emoji included.
  assert.equal(extract.excerpt('corta 🙂'), 'corta 🙂');
});

test('la CLI escribe, luego no ve cambios, y detecta una diferencia', () => {
  const ws = makeWorkspace();

  const build = runCli(ws);
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /Preguntas: 9/);
  assert.match(build.stdout, /Planes: 1 aprobados, 1 rechazados, 1 con error de herramienta/);
  assert.match(build.stdout, /Regla de cierre .*se cumple/);
  assert.ok(fs.existsSync(ws.dayFile));
  assert.ok(fs.existsSync(ws.indexPath));
  assert.ok(fs.readFileSync(ws.dayFile, 'utf8').endsWith('\n'));
  assert.ok(!fs.readFileSync(ws.dayFile, 'utf8').includes('\r'), 'se escribe con LF');

  const check = runCli(ws, ['--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /sin cambios/);

  // A second build writes nothing new.
  const again = runCli(ws);
  assert.equal(again.status, 0);
  assert.ok(!/escrito:/.test(again.stdout), 'la segunda pasada no reescribe nada');

  // A deliberate change to a generated file is reported and fails --check.
  fs.appendFileSync(ws.indexPath, 'línea de más\n', 'utf8');
  const dirty = runCli(ws, ['--check']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /Cambiarían 1 archivo/);
  assert.match(dirty.stdout, /decisions\.md/);
  assert.ok(fs.readFileSync(ws.indexPath, 'utf8').includes('línea de más'), '--check no escribe');

  // A generated file deleted by hand is a difference too.
  const dayBytes = fs.readFileSync(ws.dayFile, 'utf8');
  fs.rmSync(ws.dayFile);
  const gone = runCli(ws, ['--check']);
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /2026-01-02\.md/);
  assert.ok(!fs.existsSync(ws.dayFile), '--check tampoco lo repone');
  assert.equal(runCli(ws).status, 0);
  assert.equal(fs.readFileSync(ws.dayFile, 'utf8'), dayBytes, 'la pasada normal lo repone igual');

  // An orphan left behind is reported, never deleted.
  const orphan = path.join(ws.daysDir, '1999-01-01.md');
  fs.writeFileSync(orphan, '# día huérfano\n', 'utf8');
  const withOrphan = runCli(ws);
  assert.equal(withOrphan.status, 0);
  assert.match(withOrphan.stdout, /1 huérfanos/);
  assert.ok(fs.existsSync(orphan), 'el huérfano sigue ahí');
});

test('una pregunta editada a mano aborta la pasada sin escribir', () => {
  const ws = makeWorkspace();
  assert.equal(runCli(ws).status, 0);

  const original = fs.readFileSync(ws.dayFile, 'utf8');
  fs.writeFileSync(
    ws.dayFile,
    original.replace('¿Cuántos chats pueden trabajar a la vez?', '¿Cuántos chats, editado?'),
    'utf8',
  );
  const before = snapshot(ws.dir);

  const run = runCli(ws);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ya no coincide con su resumen/);

  const after = snapshot(ws.dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, content] of before) {
    assert.equal(after.get(file), content, `${path.basename(file)} intacto`);
  }
});

test('una respuesta editada a mano se sobrescribe sin ruido', () => {
  // Only the question body is hash-guarded; the header of every file promises
  // that everything else is regenerated. This pins that promise.
  const ws = makeWorkspace();
  assert.equal(runCli(ws).status, 0);

  const original = fs.readFileSync(ws.dayFile, 'utf8');
  fs.writeFileSync(
    ws.dayFile,
    original.replace('**Respuesta.** — sin respuesta —', '**Respuesta.** lo que a mí me parece'),
    'utf8',
  );

  const run = runCli(ws);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /escrito:/);
  assert.equal(fs.readFileSync(ws.dayFile, 'utf8'), original, 'vuelve a lo que dice la transcripción');
});

test('un ADR sin D-nnnn detrás queda con el bloque vacío, sin error', async () => {
  const ws = makeWorkspace({ adrMap: {} });
  const adrFile = writeAdrFile(ws, '0001', 'sin-decision');

  const built = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  const rendered = built.files.get(adrFile);
  assert.ok(rendered, 'el ADR entra en el barrido aunque adr-map.json no lo cite');
  assert.match(rendered, /<!-- adr:generated -->\n<!-- \/adr:generated -->/, 'el bloque queda vacío, pegado');

  const { changed } = extract.compareFiles(built.files, built.config);
  assert.ok(!changed.includes(adrFile), 'un bloque vacío contra un archivo ya vacío no es un cambio');
});

test('un ADR con el Contexto editado a mano no aparece en `changed`, y `--check` sale verde', async () => {
  const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba');

  // First pass: the generated block picks up D-0001 (the "Paralelo" dialog).
  const build = runCli(ws);
  assert.equal(build.status, 0, build.stderr);
  const generated = fs.readFileSync(adrFile, 'utf8');
  assert.match(generated, /### D-0001 · Paralelo/);
  assert.match(generated, /\*\*Alternativas descartadas\.\*\*/);
  assert.match(generated, /- \*\*Con aviso\*\* — Avisa a los demás chats &lt;remota&gt; incluida\./);

  // A human fills in Contexto, strictly outside the markers.
  const handEdited = generated.replace(
    '## Contexto\n\n## Decisión',
    '## Contexto\n\nEsto lo escribió una persona, no el generador.\n\n## Decisión',
  );
  assert.notEqual(handEdited, generated, 'el reemplazo de verdad tocó el archivo');
  fs.writeFileSync(adrFile, handEdited, 'utf8');

  const check = runCli(ws, ['--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /sin cambios/);
  assert.ok(
    fs.readFileSync(adrFile, 'utf8').includes('Esto lo escribió una persona'),
    '--check nunca toca el archivo',
  );
});

test('una línea añadida dentro de los marcadores sí aparece en `changed`, y `--check` sale rojo', async () => {
  const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba');

  const build = runCli(ws);
  assert.equal(build.status, 0, build.stderr);
  const generated = fs.readFileSync(adrFile, 'utf8');

  // Simulate a generated block that fell out of date: a stray line pasted
  // right after the opening marker, still inside `adr:generated`.
  const stale = generated.replace(
    '<!-- adr:generated -->\n',
    '<!-- adr:generated -->\nlínea que ya no viene del corpus\n',
  );
  assert.notEqual(stale, generated);
  fs.writeFileSync(adrFile, stale, 'utf8');

  const check = runCli(ws, ['--check']);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Cambiarían 1 archivo/);
  assert.match(check.stdout, /0002-de-prueba\.md/);
  assert.ok(
    fs.readFileSync(adrFile, 'utf8').includes('línea que ya no viene del corpus'),
    '--check no reescribe nada',
  );

  // A real build repairs it, and only the generated fragment moves: the rest
  // of the file (title, Estado, Fecha, Rastro, Afecta a, the four sections)
  // is untouched because it was never different from what render produced.
  const fixed = runCli(ws);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fs.readFileSync(adrFile, 'utf8'), generated, 'vuelve exactamente al bloque generado');
});

// --------------------------------------------------------------------------
// The `adr:generated` markers: only a whole line, outside a fence, exactly once
// --------------------------------------------------------------------------

const MARK_A = '<!-- adr:generated -->';
const MARK_Z = '<!-- /adr:generated -->';

/** The build must refuse, name the file, and leave every byte where it was. */
function assertBuildRefuses(ws, adrFile, messageRe) {
  const before = snapshot(ws.dir);
  const run = runCli(ws);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /No se pudo extraer/);
  assert.match(run.stderr, messageRe);
  assert.ok(run.stderr.includes(path.basename(adrFile)), 'el error nombra el archivo');
  const after = snapshot(ws.dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no aparece ningún archivo');
  for (const [file, content] of before) {
    assert.equal(after.get(file), content, `${path.basename(file)} intacto`);
  }
  assert.ok(!fs.existsSync(ws.indexPath), 'ni siquiera el índice');
}

test('un par de marcadores duplicado para el build sin escribir nada', () => {
  const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba', {
    tail: [MARK_A, MARK_Z, '', 'basura pegada dos veces', MARK_A, MARK_Z],
  });
  assertBuildRefuses(ws, adrFile, /un solo par/);
  assert.equal(runCli(ws, ['--check']).status, 1, '--check tampoco lo da por bueno');
});

test('marcadores ausentes, sueltos o al revés paran el build sin escribir nada', () => {
  const cases = [
    ['ninguno', [], /faltan los marcadores/],
    ['solo la apertura', [MARK_A], /un solo par/],
    ['solo el cierre', [MARK_Z], /un solo par/],
    ['cierre antes que apertura', [MARK_Z, MARK_A], /un solo par/],
    ['dos aperturas y un cierre', [MARK_A, MARK_A, MARK_Z], /un solo par/],
    ['anidados', [MARK_A, MARK_A, MARK_Z, MARK_Z], /un solo par/],
    ['sólo en mitad de una línea', [`texto ${MARK_A} y ${MARK_Z} otra vez`], /faltan los marcadores/],
  ];
  for (const [name, tail, re] of cases) {
    const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
    const adrFile = writeAdrFile(ws, '0002', 'de-prueba', { tail });
    try {
      assertBuildRefuses(ws, adrFile, re);
    } catch (err) {
      err.message = `${name}: ${err.message}`;
      throw err;
    }
  }
});

test('una cadena de marcador citada en prosa no cuenta: el bloque real se actualiza y la prosa no se toca', () => {
  const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
  const prose = `El generador escribe entre \`${MARK_A}\` y \`${MARK_Z}\`, y nada más.`;
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba', { contexto: [prose] });
  const original = fs.readFileSync(adrFile, 'utf8');
  const realStart = original.lastIndexOf(`\n${MARK_A}\n`) + 1;

  const build = runCli(ws);
  assert.equal(build.status, 0, build.stderr);
  const generated = fs.readFileSync(adrFile, 'utf8');
  assert.ok(generated.startsWith(original.slice(0, realStart)), 'todo lo anterior al bloque, byte a byte');
  assert.ok(generated.includes(prose), 'la frase sigue entera');
  assert.match(generated, /### D-0001 · Paralelo/, 'el bloque real sí se rellena');
  assert.equal(
    generated.indexOf('### D-0001'),
    generated.lastIndexOf(`\n${MARK_A}\n`) + MARK_A.length + 2,
    'y va detrás del par real, no dentro de la frase',
  );

  // And it stays put: a second pass and `--check` see nothing to do.
  const again = runCli(ws);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!/escrito:/.test(again.stdout), 'la segunda pasada no escribe nada');
  const check = runCli(ws, ['--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('un marcador dentro de una valla del texto humano se ignora', () => {
  const ws = makeWorkspace({ adrMap: { 'D-0001': ['ADR-0002'] } });
  const contexto = ['Así se ve el bloque:', '', '```text', MARK_A, MARK_Z, '```'];
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba', { contexto });
  const original = fs.readFileSync(adrFile, 'utf8');
  const realStart = original.lastIndexOf(`\n${MARK_A}\n`) + 1;

  const build = runCli(ws);
  assert.equal(build.status, 0, build.stderr);
  const generated = fs.readFileSync(adrFile, 'utf8');
  assert.ok(generated.startsWith(original.slice(0, realStart)), 'la valla queda como estaba');
  assert.match(generated, /### D-0001 · Paralelo/);
  assert.equal(runCli(ws, ['--check']).status, 0);
});

test('una pregunta o una respuesta del corpus con la cadena del cierre converge', () => {
  // The closing marker, on a line of its own, inside a question AND inside a
  // free-text answer: both are fenced in the block, and neither may be read
  // back as structure on the next pass.
  const Q_CIERRE = {
    question: `¿Dejamos esto?\n${MARK_Z}\n${MARK_A}\nfin`,
    header: 'Cierre',
    multiSelect: false,
    options: [
      { label: 'Sí', description: `Cita ${MARK_Z} en mitad de línea.` },
      { label: 'No', description: 'Nada.' },
    ],
  };
  const lines = [
    human(1, 'empezamos'),
    askLine(2, 'tu-c1', [Q_CIERRE]),
    answerLine(3, 'tu-c1', [Q_CIERRE], { [Q_CIERRE.question]: `otra cosa\n${MARK_Z}\nfin` }),
    human(28, 'seguimos mañana'),
  ];
  const ws = makeWorkspace({ lines, adrMap: { 'D-0001': ['ADR-0002'] } });
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba');

  const first = runCli(ws);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = snapshot(ws.dir);
  const text = fs.readFileSync(adrFile, 'utf8');
  assert.ok(text.includes(`\n${MARK_Z}\nfin`), 'la cita viaja literal dentro de su valla');

  const second = runCli(ws);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!/escrito:/.test(second.stdout), 'la segunda pasada escribe 0 archivos');
  const afterSecond = snapshot(ws.dir);
  for (const [file, content] of afterFirst) {
    assert.equal(afterSecond.get(file), content, `${path.basename(file)} sin cambios`);
  }
  assert.equal(runCli(ws, ['--check']).status, 0);
});

test('spliceAdrBlock no deja pasar un bloque que parezca un marcador fuera de valla', () => {
  const raw = ['# ADR', '', MARK_A, MARK_Z, ''].join('\n');
  for (const bad of [[MARK_Z], [`  ${MARK_A}  `], ['texto', MARK_Z, 'más']]) {
    assert.throws(
      () => extract.spliceAdrBlock(raw, bad, 'docs/adr/0002-x.md'),
      /docs\/adr\/0002-x\.md.*marcador/s,
    );
  }
  // The same string inside a fence, or as part of a longer line, is fine.
  const ok = extract.spliceAdrBlock(raw, ['```text', MARK_Z, '```', `x ${MARK_A}`], 'docs/adr/0002-x.md');
  assert.ok(ok.includes(`\`\`\`text\n${MARK_Z}\n\`\`\`\nx ${MARK_A}\n${MARK_Z}\n`));
});

test('adr-map.json que cita un D-nnnn inexistente dice qué ADR lo cita', () => {
  const ws = makeWorkspace({ adrMap: { 'D-9999': ['ADR-0002'] } });
  const adrFile = writeAdrFile(ws, '0002', 'de-prueba');
  const run = runCli(ws);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-9999/);
  assert.match(run.stderr, /ADR-0002/, 'nombra el ADR que lo cita');
  assert.equal(fs.readFileSync(adrFile, 'utf8').includes('### D-9999'), false);
});

test('un archivo del barrido de ADR que no se puede leer no tumba el build', async () => {
  const ws = makeWorkspace({ adrMap: {} });
  writeAdrFile(ws, '0002', 'de-prueba');
  // A dangling link with an ADR name: `statSync` throws ENOENT on it.
  const dangling = path.join(ws.adrDir, '0003-colgado.md');
  try {
    fs.symlinkSync(path.join(ws.dir, 'no-existe.md'), dangling);
  } catch {
    return; // no symlink privilege on this machine: nothing to exercise
  }
  const built = await extract.build({ configPath: ws.configPath, sessionsPath: ws.sessionsPath });
  assert.ok(!built.files.has(dangling), 'el enlace roto se salta');
  assert.ok([...built.files.keys()].some((f) => f.endsWith('0002-de-prueba.md')));
});

test('sin sesiones no toca el disco', () => {
  const ws = makeWorkspace({ sessions: false });
  for (const args of [[], ['--check']]) {
    const run = runCli(ws, args);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /nada que extraer en esta máquina/);
    assert.ok(!fs.existsSync(ws.indexPath));
    assert.ok(!fs.existsSync(ws.daysDir));
    assert.ok(!fs.existsSync(ws.historyDir));
  }
});
