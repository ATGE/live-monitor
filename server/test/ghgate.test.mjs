import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ghPublishIntent, ghPublishProblems, ghGateMessage, callsGh, stateChangeProblem, PR_BODY_MAX } from '../src/ghgate.js';
import { PR_TITLE_MAX } from '../src/prtitle.js';
import { GITHUB_PUBLISH_RULE } from '../src/rules.js';

/**
 * The incident this guards against is PR #1445: a session ran `gh pr comment`
 * with a Spanish body and it was public before anyone read the log. So both
 * directions matter — a command that does not publish must sail through, and a
 * body the gate cannot read must not be waved past as if it were empty.
 */

const noFiles = { readFile: async () => null };
const files = (map) => ({ readFile: async (p) => (p in map ? map[p] : null) });

const SPANISH = 'Listo, ya cambié el clamp a 1 y eliminé la constante, porque no aporta nada.';
const ENGLISH = 'Done — the cap is now 1 and the constant is gone.';
const LONG_ENGLISH = 'The parser now rejects an unterminated fence. '.repeat(440);

// Títulos: uno como los que se escriben de verdad —prefijo convencional,
// nombre de crate, ruta y número de issue— y uno en español.
const TITLE_EN = 'fix(persistence): tenant-scope crates/persistence/src/search/registry.rs lookups (#1445)';
const TITLE_ES = 'fix: el filtro ahora usa el tenant, porque la consulta no lo hacia';

const spanish = (problems) => problems.some((p) => /español|acentuadas/.test(p));
const about = (problems, what) => problems.filter((p) => p.startsWith(`${what}: `));

// ---------------------------------------------------------------------------
// Qué es publicar y qué no

test('lo que no publica no se mira', async () => {
  for (const command of [
    'cargo test -p helios-rest',
    'gh pr view 1445 --json body',
    'gh pr list --state open',
    'gh issue view 1069',
    'gh pr comment 1445',                       // abre el editor, no publica nada
    'gh pr review 1445 --approve',              // un visto bueno sin texto
    'gh pr edit 1445 --add-label ready',        // ni --body ni --body-file
    'gh api repos/o/r/issues/1/comments',       // GET: sin campos no escribe
    'gh api -X POST repos/o/r/issues/1/labels -f name=bug',  // no lleva prosa
    'gh api -X DELETE repos/o/r/issues/comments/123',
    'echo "hola que tal" > /tmp/nota.md',
  ]) {
    assert.equal(ghPublishIntent(command), null, command);
    assert.deepEqual(await ghPublishProblems(command, noFiles), [], command);
  }
});

test('`gh pr comment` con el cuerpo en español se rechaza', async () => {
  const problems = await ghPublishProblems(`gh pr comment 1445 --body "${SPANISH}"`, noFiles);
  assert.ok(spanish(problems), problems.join(' | '));
});

test('el mismo comentario en inglés pasa', async () => {
  assert.deepEqual(await ghPublishProblems(`gh pr comment 1445 --body '${ENGLISH}'`, noFiles), []);
});

test('el fichero de `--body-file` se lee con el readFile que le inyectan', async () => {
  const command = 'gh pr comment 1445 --body-file /tmp/reply.md';
  assert.equal(ghPublishIntent(command).bodyFile, '/tmp/reply.md');

  assert.deepEqual(await ghPublishProblems(command, files({ '/tmp/reply.md': ENGLISH })), []);
  assert.ok(spanish(await ghPublishProblems(command, files({ '/tmp/reply.md': SPANISH }))));

  const gone = await ghPublishProblems(command, noFiles);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /no ha podido leerlo/);
});

// ---------------------------------------------------------------------------
// (1) `gh api` publica sin `-X`: el método por defecto lo decide el campo

test('`gh api` con un campo hace POST aunque no lo diga', async () => {
  const command = `gh api repos/o/r/issues/1445/comments -f body='${SPANISH}'`;
  const intent = ghPublishIntent(command);
  assert.ok(intent, 'sin -X, gh hace POST en cuanto hay un campo');
  assert.equal(intent.kind, 'api');
  assert.ok(spanish(await ghPublishProblems(command, noFiles)));
});

// ---------------------------------------------------------------------------
// (2) Ninguna lista blanca de rutas: cualquier escritura con `body` se mira

test('cualquier POST/PATCH/PUT con un campo `body` se gatea, sea cual sea la ruta', async () => {
  const routes = [
    ['-X PATCH', 'repos/o/r/pulls/1445'],                  // el cuerpo del PR
    ['-X PATCH', 'repos/o/r/issues/1445'],                 // el cuerpo de la issue
    ['-X POST', 'repos/o/r/pulls/1445/reviews/9/events'],  // enviar un review
    ['-X PUT', 'repos/o/r/pulls/1445/reviews/9'],          // editarlo
    ['-X POST', 'repos/o/r/issues'],                       // abrir una issue
    ['-X POST', 'repos/o/r/pulls'],                        // abrir un PR
    ['-X POST', 'repos/o/r/pulls/comments/123/replies'],
  ];
  for (const [method, route] of routes) {
    const command = `gh api ${method} ${route} -f body='${SPANISH}'`;
    assert.ok(ghPublishIntent(command), route);
    assert.ok(spanish(await ghPublishProblems(command, noFiles)), route);
  }
});

// ---------------------------------------------------------------------------
// (3) Los verbos que faltaban, cada uno con el flag que usa de verdad

test('publicar tiene más nombres que `--body`', async () => {
  const cases = [
    [`gh issue create --title x --body "${SPANISH}"`, 'issue create', 'issue-create'],
    [`gh issue edit 1069 --body "${SPANISH}"`, 'issue edit', 'issue-edit'],
    [`gh pr merge 1445 --squash --body "${SPANISH}"`, 'pr merge', 'merge'],
    [`gh pr close 1445 --comment "${SPANISH}"`, 'pr close', 'comment'],
    [`gh issue close 1069 -c "${SPANISH}"`, 'issue close', 'comment'],
    [`gh release create v1.2.0 --notes "${SPANISH}"`, 'release create', 'release-notes'],
  ];
  for (const [command, verb, kind] of cases) {
    const intent = ghPublishIntent(command);
    assert.ok(intent, command);
    assert.equal(intent.verb, verb, command);
    assert.equal(intent.kind, kind, command);
    assert.ok(spanish(await ghPublishProblems(command, noFiles)), command);
  }
  // Y el fichero de cada uno se llama como se llama.
  const notes = ghPublishIntent('gh release create v1 --notes-file notes.md');
  assert.equal(notes.bodyFile, 'notes.md');
});

// ---------------------------------------------------------------------------
// (4) graphql: el patrón que el propio tablero usa

test('`gh api graphql` con una mutación pasa la mutación entera por el filtro', async () => {
  const mutation = 'mutation { addComment(input: {subjectId: "PR_1", body: "Listo, ya está cambiado."})'
    + ' { clientMutationId } }';
  const command = `gh api graphql -f query='${mutation}'`;
  const intent = ghPublishIntent(command);
  assert.equal(intent.kind, 'graphql');
  assert.ok(spanish(await ghPublishProblems(command, noFiles)), 'el español dentro de la mutación se ve');

  const reply = 'mutation { addPullRequestReviewThreadReply(input: {body: "Done, the cap is 1 now."}) { comment { id } } }';
  assert.deepEqual(await ghPublishProblems(`gh api graphql -f query='${reply}'`, noFiles), []);

  // Una consulta de lectura no publica nada.
  assert.equal(ghPublishIntent("gh api graphql -f query='query { viewer { login } }'"), null);
});

// ---------------------------------------------------------------------------
// (5) Envoltorios, y la red de seguridad

test('los prefijos transparentes no esconden el `gh`', async () => {
  for (const command of [
    `timeout 60 gh pr comment 1445 --body "${SPANISH}"`,
    `timeout -k 5 60 gh pr comment 1445 --body "${SPANISH}"`,
    `env GH_TOKEN=x gh pr comment 1445 --body "${SPANISH}"`,
    `nohup gh pr comment 1445 --body "${SPANISH}"`,
    `nice -n 10 gh pr comment 1445 --body "${SPANISH}"`,
    `command gh pr comment 1445 --body "${SPANISH}"`,
    `sh -c 'gh pr comment 1445 --body "${SPANISH}"'`,
    `bash -lc 'gh pr comment 1445 --body "${SPANISH}"'`,
    `eval gh pr comment 1445 --body "${SPANISH}"`,
  ]) {
    assert.ok(spanish(await ghPublishProblems(command, noFiles)), command);
  }
});

test('una línea que llama a `gh` y no se deja leer se deniega igual', async () => {
  const problems = await ghPublishProblems('echo x | xargs -I{} gh pr comment 1445 --body {}', noFiles);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no ha sabido leerla/);

  // Pero un `gh` que sí se leyó y no publica no cae en la red.
  assert.deepEqual(await ghPublishProblems('gh pr view 1445', noFiles), []);
});

// ---------------------------------------------------------------------------
// (6) Todos los `gh` de la línea, no sólo el primero

test('el segundo comentario de la línea también se mira', async () => {
  const command = `gh pr comment 1 --body "${ENGLISH}" && gh pr comment 2 --body "${SPANISH}"`;
  const problems = await ghPublishProblems(command, noFiles);
  assert.ok(spanish(problems), problems.join(' | '));
  assert.ok(problems.every((p) => p.startsWith('`gh pr comment`:')), 'con varias llamadas se dice de cuál es cada fallo');
});

// ---------------------------------------------------------------------------
// (7) Los flags de grupo van entre el grupo y el verbo

test('`gh pr -R owner/repo comment` sigue siendo un comentario', async () => {
  const command = `gh pr -R HeliosSoftware/hfs comment 1445 --body "${SPANISH}"`;
  assert.equal(ghPublishIntent(command).verb, 'pr comment');
  assert.ok(spanish(await ghPublishProblems(command, noFiles)));
  assert.equal(ghPublishIntent('gh pr --repo=o/r comment 1445 --body x').verb, 'pr comment');
});

// ---------------------------------------------------------------------------
// (8) `--fill` publica los mensajes de commit

test('`gh pr create --fill` publica un cuerpo que no está en la línea', async () => {
  const intent = ghPublishIntent('gh pr create --fill --base main');
  assert.equal(intent.kind, 'pr-create');
  assert.equal(intent.source, 'fill');
  const problems = await ghPublishProblems('gh pr create --fill --base main', noFiles);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mensajes de commit/);
});

// ---------------------------------------------------------------------------
// (9) El JSON de `--input` lleva los textos dentro

test('`--input` con un review por lotes: se mira cada `body`', async () => {
  const command = 'gh api -X POST repos/o/r/pulls/1445/reviews --input review.json';
  const payload = JSON.stringify({
    event: 'COMMENT',
    body: 'Overall this looks right.',
    comments: [{ path: 'a.rs', line: 3, body: SPANISH }],
  });
  const problems = await ghPublishProblems(command, files({ 'review.json': payload }));
  assert.ok(spanish(problems), problems.join(' | '));

  // Y parsear el JSON deshace los escapes: `é` es una `é`.
  const escaped = '{"comments":[{"body":"Ya est\\u00e1 listo, revis\\u00e9 el c\\u00f3digo."}]}';
  assert.ok((await ghPublishProblems(command, files({ 'review.json': escaped }))).length, 'un acento escapado sigue siendo un acento');

  assert.deepEqual(
    await ghPublishProblems(command, files({ 'review.json': JSON.stringify({ body: ENGLISH, comments: [] }) })),
    [],
  );
});

// ---------------------------------------------------------------------------
// (10) Escribir y publicar en la misma línea

test('un fichero que la línea reescribe antes de publicarlo no se puede comprobar', async () => {
  const command = `printf '%s' "${SPANISH}" > b.md && gh pr comment 1445 --body-file b.md`;
  const problems = await ghPublishProblems(command, files({ 'b.md': ENGLISH }));
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /escribe ese fichero antes/);

  const heredoc = 'cat > b.md <<EOF\nhola\nEOF\ngh pr comment 1445 --body-file b.md';
  assert.match((await ghPublishProblems(heredoc, files({ 'b.md': ENGLISH })))[0], /escribe ese fichero antes/);
});

// ---------------------------------------------------------------------------
// (11) Un `cd` cambia contra qué se resuelve la ruta

test('la ruta relativa se resuelve contra el `cd` de la misma línea', async () => {
  const command = 'cd crates/ui && gh pr comment 1445 --body-file notes.md';
  assert.equal(ghPublishIntent(command).cwd, 'crates/ui');
  assert.deepEqual(await ghPublishProblems(command, files({ 'crates/ui/notes.md': ENGLISH })), []);
  assert.ok(spanish(await ghPublishProblems(command, files({ 'crates/ui/notes.md': SPANISH }))));

  // Una ruta absoluta no depende del cd.
  assert.deepEqual(
    await ghPublishProblems('cd crates/ui && gh pr comment 1 --body-file /tmp/x.md', files({ '/tmp/x.md': ENGLISH })),
    [],
  );

  // Y si el cd va a un sitio que sólo sabe el shell, no se adivina.
  const unknown = await ghPublishProblems('cd "$WT" && gh pr comment 1 --body-file notes.md', files({ 'notes.md': ENGLISH }));
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /sólo sabe el shell/);
});

// ---------------------------------------------------------------------------
// (12) El tope sale de lo que se publica, no del verbo

test('el tope de caracteres sigue a lo que se publica', async () => {
  assert.ok(LONG_ENGLISH.length > 20_000 && LONG_ENGLISH.length < PR_BODY_MAX, `${LONG_ENGLISH.length}`);

  const create = 'gh pr create --title "fix: reject unterminated fences" --body-file body.md';
  assert.equal(ghPublishIntent(create).maxChars, PR_BODY_MAX);
  assert.deepEqual(await ghPublishProblems(create, files({ 'body.md': LONG_ENGLISH })), []);

  // El cuerpo de un PR escrito por la API es igual de largo y también pasa.
  const api = 'gh api -X PATCH repos/o/r/pulls/1445 -F body=@body.md';
  assert.equal(ghPublishIntent(api).maxChars, PR_BODY_MAX);
  assert.deepEqual(await ghPublishProblems(api, files({ 'body.md': LONG_ENGLISH })), []);

  // Un comentario, en cambio, tiene el tope corto de siempre.
  const comment = await ghPublishProblems('gh pr comment 1445 --body-file body.md', files({ 'body.md': LONG_ENGLISH }));
  assert.ok(comment.some((p) => /supera 4000 caracteres/.test(p)), comment.join(' | '));
  const apiComment = await ghPublishProblems('gh api -X POST repos/o/r/issues/1/comments -F body=@body.md', files({ 'body.md': LONG_ENGLISH }));
  assert.ok(apiComment.some((p) => /supera 4000 caracteres/.test(p)), apiComment.join(' | '));
});

// ---------------------------------------------------------------------------
// (13) Los alias de la entrada estándar no son ficheros

test('`/dev/stdin` y compañía son la entrada estándar, no una ruta que leer', async () => {
  for (const path of ['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']) {
    const command = `gh pr comment 1445 --body-file ${path}`;
    const intent = ghPublishIntent(command);
    assert.equal(intent.source, 'stdin', path);
    const problems = await ghPublishProblems(command, { readFile: async () => { throw new Error('no se lee la entrada estándar'); } });
    assert.equal(problems.length, 1, path);
    assert.match(problems[0], /entrada estándar/, path);
  }
});

// ---------------------------------------------------------------------------
// (14) Un `$` suelto no es una variable

test('un `$` literal no convierte el cuerpo en incomprobable', async () => {
  const intent = ghPublishIntent('gh pr comment 1445 --body "The plan costs 20 USD$, not 30$"');
  assert.equal(intent.source, 'inline');
  assert.equal(intent.body, 'The plan costs 20 USD$, not 30$');
  assert.deepEqual(await ghPublishProblems('gh pr comment 1445 --body "The plan costs 20 USD$"', noFiles), []);
});

// ---------------------------------------------------------------------------
// (15) El aviso no promete lo que no mira

test('el aviso dice qué falla, que se publica en inglés y por dónde salir', () => {
  const message = ghGateMessage(['parece español: que, para']);
  assert.match(message, /parece español/);
  assert.match(message, /inglés/);
  assert.match(message, /--body-file/);
  assert.match(message, /-F body=@/);
  assert.match(message, /Write/);
  assert.match(message, /títulos/, 'los títulos sí se comprueban: el aviso lo dice');
});

// ---------------------------------------------------------------------------
// (16) `2>/dev/null` no deja un descriptor suelto donde va la ruta

test('una redirección de errores no esconde la ruta de la API', async () => {
  const command = `gh api 2>/dev/null -X POST repos/o/r/issues/1/comments -f body='${SPANISH}'`;
  assert.ok(ghPublishIntent(command), 'el `2` es de la redirección, no un argumento');
  assert.ok(spanish(await ghPublishProblems(command, noFiles)));
  assert.ok(spanish(await ghPublishProblems(`gh pr comment 1445 --body "${SPANISH}" 2>&1`, noFiles)));
});

// ---------------------------------------------------------------------------
// `gh api`: los mismos flags no significan lo mismo

test('`gh api -F body=@fichero` lee el fichero y `-f body=texto` es literal', async () => {
  const file = 'gh api -X PATCH repos/o/r/issues/comments/123 -F body=@x.md';
  assert.equal(ghPublishIntent(file).bodyFile, 'x.md');
  assert.deepEqual(await ghPublishProblems(file, files({ 'x.md': ENGLISH })), []);
  assert.ok((await ghPublishProblems(file, files({ 'x.md': SPANISH }))).length);

  const literal = `gh api -X PATCH repos/o/r/pulls/comments/123 -f body='${SPANISH}'`;
  const intent = ghPublishIntent(literal);
  assert.equal(intent.body, SPANISH);
  assert.equal(intent.bodyFile, null, '-f no lee ficheros');
  assert.ok((await ghPublishProblems(literal, noFiles)).length);
});

// ---------------------------------------------------------------------------
// Lo que el tablero no puede ver, lo dice

test('un heredoc publica un cuerpo que no se puede comprobar', async () => {
  const command = "gh pr comment 1445 --body-file - <<'EOF'\nListo, ya está cambiado.\nEOF";
  const intent = ghPublishIntent(command);
  assert.equal(intent.kind, 'comment');
  assert.equal(intent.source, 'heredoc');
  const problems = await ghPublishProblems(command, noFiles);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /heredoc/);
  assert.match(problems[0], /no se puede comprobar/);
});

test('una tubería, una variable y una sustitución tampoco se pueden comprobar', async () => {
  const cases = [
    ['cat reply.md | gh pr comment 1445 --body-file -', /entrada estándar/],
    ['gh pr comment 1445 --body "$BODY"', /variable o de una sustitución/],
    ['gh pr comment 1445 --body "$(cat reply.md)"', /variable o de una sustitución/],
    ['gh api -X POST repos/o/r/issues/1/comments -f body="$REPLY"', /variable o de una sustitución/],
  ];
  for (const [command, why] of cases) {
    const problems = await ghPublishProblems(command, noFiles);
    assert.equal(problems.length, 1, `${command} → ${problems.join(' | ')}`);
    assert.match(problems[0], why, command);
  }
});

test('el `gh` que va detrás de otro comando no se escapa', async () => {
  assert.ok((await ghPublishProblems(`cd /tmp/wt && gh pr comment 1445 --body "${SPANISH}"`, noFiles)).length);
});

test('las comillas simples se respetan: dentro no se expande nada', () => {
  const intent = ghPublishIntent("gh pr comment 1445 --body 'Costs $5 and `ticks` stay'");
  assert.equal(intent.body, 'Costs $5 and `ticks` stay');
  assert.equal(intent.source, 'inline');
});

// ---------------------------------------------------------------------------
// Los títulos: el hueco que el propio módulo admitía
//
// `github.js` filtra el título del PR que abre el tablero. El agujero era el
// agente abriendo el PR por su cuenta: `gh pr create --title "<español>"`
// pasaba limpio porque aquí sólo se miraban los cuerpos.

test('un título en español se rechaza, y el problema dice que es el título', async () => {
  const command = `gh pr create --title '${TITLE_ES}' --body '${ENGLISH}'`;
  const intent = ghPublishIntent(command);
  assert.equal(intent.title, TITLE_ES);
  assert.equal(intent.titleSource, 'inline');

  const problems = await ghPublishProblems(command, noFiles);
  assert.ok(spanish(problems), problems.join(' | '));
  // El agente tiene que saber cuál de los dos reescribir.
  assert.equal(about(problems, 'el título').length, problems.length, problems.join(' | '));
});

test('un título de PR de verdad pasa: prefijo, crate, ruta y número de issue', async () => {
  // El coste caro es el falso positivo: un título legítimo denegado le cuesta
  // un turno al agente. Estos son los que escribe el pipeline todos los días.
  for (const title of [
    TITLE_EN,
    'fix: reject an unterminated fence in ViewDefinition.select[].column',
    'feat(ui): refresh the Bulk Import Submission Log without a reload',
    'chore(deps): bump chumsky to 0.10 and drop the pinned helios-serde patch',
  ]) {
    assert.deepEqual(await ghPublishProblems(`gh pr create --title '${title}' --body '${ENGLISH}'`, noFiles), [], title);
  }
  assert.ok(TITLE_EN.length < PR_TITLE_MAX);
});

test('si fallan el título y el cuerpo se devuelven los dos, cada uno con su nombre', async () => {
  const problems = await ghPublishProblems(`gh pr create --title '${TITLE_ES}' --body "${SPANISH}"`, noFiles);
  assert.ok(about(problems, 'el título').length, problems.join(' | '));
  assert.ok(about(problems, 'el cuerpo').length, problems.join(' | '));
});

test('`-t` es `--title` en cada verbo que lo lleva', async () => {
  const cases = [
    [`gh pr create -t '${TITLE_ES}'`, 'pr create'],
    [`gh pr edit 1445 -t '${TITLE_ES}'`, 'pr edit'],
    [`gh issue create -t '${TITLE_ES}'`, 'issue create'],
    [`gh issue edit 1069 --title '${TITLE_ES}'`, 'issue edit'],
    [`gh release create v1.2.0 -t '${TITLE_ES}'`, 'release create'],
    [`gh release edit v1.2.0 --title '${TITLE_ES}'`, 'release edit'],
  ];
  for (const [command, verb] of cases) {
    const intent = ghPublishIntent(command);
    assert.ok(intent, command);
    assert.equal(intent.verb, verb, command);
    assert.equal(intent.title, TITLE_ES, command);
    assert.ok(spanish(await ghPublishProblems(command, noFiles)), command);
  }

  // Y `-T` es `--template`, que no es un título: no se lee como tal.
  assert.equal(ghPublishIntent('gh pr create -T .github/PULL_REQUEST_TEMPLATE.md'), null);
});

test('`gh api` publica títulos con las mismas formas que los cuerpos', async () => {
  const inline = `gh api -X POST repos/o/r/issues -f title='${TITLE_ES}' -f body='${ENGLISH}'`;
  assert.equal(ghPublishIntent(inline).title, TITLE_ES);
  assert.ok(spanish(await ghPublishProblems(inline, noFiles)));
  assert.deepEqual(await ghPublishProblems(`gh api -X POST repos/o/r/issues -f title='${TITLE_EN}' -f body='${ENGLISH}'`, noFiles), []);

  // Un título solo, sin cuerpo, también escribe: `gh api` hace POST en cuanto
  // lleva un campo.
  assert.ok(spanish(await ghPublishProblems(`gh api -X PATCH repos/o/r/pulls/1445 -f title='${TITLE_ES}'`, noFiles)));

  // `-F title=@fichero` lee el fichero entero, igual que `-F body=@`.
  const file = 'gh api -X PATCH repos/o/r/pulls/1445 -F title=@t.txt';
  assert.equal(ghPublishIntent(file).titleFile, 't.txt');
  assert.deepEqual(await ghPublishProblems(file, files({ 't.txt': TITLE_EN })), []);
  assert.ok(spanish(await ghPublishProblems(file, files({ 't.txt': TITLE_ES }))));

  // Y dentro de `--input` el título es la clave `title`, no el documento.
  const input = 'gh api -X POST repos/o/r/pulls --input pr.json';
  const payload = (title) => JSON.stringify({ title, body: ENGLISH, base: 'main' });
  assert.deepEqual(await ghPublishProblems(input, files({ 'pr.json': payload(TITLE_EN) })), []);
  assert.ok(spanish(await ghPublishProblems(input, files({ 'pr.json': payload(TITLE_ES) }))));
});

test('un título sin cuerpo ya es publicar; el editor interactivo sigue sin serlo', async () => {
  const create = `gh issue create --title '${TITLE_ES}'`;
  const intent = ghPublishIntent(create);
  assert.ok(intent, 'crear una issue con título publica ese título aunque el cuerpo lo pida el editor');
  assert.equal(intent.source, null, 'no hay cuerpo que mirar');
  assert.equal(intent.titleSource, 'inline');
  assert.ok(spanish(await ghPublishProblems(create, noFiles)));
  assert.deepEqual(await ghPublishProblems(`gh issue create --title '${TITLE_EN}'`, noFiles), []);

  // Lo que no cambia: sin ninguna bandera se abre un editor y no hay nada que
  // comprobar, así que no se estorba.
  for (const command of ['gh pr comment 1445', 'gh issue comment 1069', 'gh pr create --draft --base main']) {
    assert.equal(ghPublishIntent(command), null, command);
    assert.deepEqual(await ghPublishProblems(command, noFiles), [], command);
  }
});

test('el título tiene el tope de un título, no el de un cuerpo', async () => {
  const long = `fix: ${'reject the unterminated fence '.repeat(40)}`;
  assert.ok(long.length > PR_TITLE_MAX && long.length < 4000);
  const problems = await ghPublishProblems(`gh pr create --title '${long}'`, noFiles);
  assert.ok(problems.some((p) => p.includes(`supera ${PR_TITLE_MAX} caracteres`)), problems.join(' | '));
});

// ---------------------------------------------------------------------------
// `callsGh`: la otra pregunta
//
// Todo lo de arriba gatea por la prosa. Para una fase que no puede publicar
// NADA la pregunta no es qué publica la línea, sino si llama a `gh`.

test('`gh issue close 1274` llama a `gh` aunque no lleve prosa que mirar', async () => {
  assert.equal(callsGh('gh issue close 1274'), true);

  // Éste es el caso que motiva la función: cerrar una issue escribe en GitHub,
  // pero sin `--comment` no hay texto que filtrar, así que hoy el gate de
  // publicación lo deja pasar limpio.
  assert.equal(ghPublishIntent('gh issue close 1274'), null);
  assert.deepEqual(await ghPublishProblems('gh issue close 1274', noFiles), []);
});

test('los verbos que la red de `ghPublishProblems` no cubre también cuentan', () => {
  for (const command of [
    'gh label list -R HeliosSoftware/hfs',   // `LOOKS_LIKE_GH` sólo mira pr|issue|api|release
    'gh repo view',
    'gh auth status',
    'gh api user',
    'gh.exe pr list',
    'env FOO=1 gh issue close 1',            // los envoltorios que `scan` ya deshace
    'timeout 60 gh label create ready',
    'cd /tmp/wt && gh pr view 1445',
    // Las dos sustituciones de comandos. Las dos ejecutan `gh` de verdad, y
    // `lex` tira el interior de las dos por ilegible, así que de ambas sólo
    // responde la red sobre la línea cruda: si la backtick no estuviera en su
    // clase de caracteres, la de abajo diría `true` y la de arriba `false`.
    'echo `gh issue close 1`',
    'echo "$(gh issue close 1)"',
  ]) {
    assert.equal(callsGh(command), true, command);
  }
});

test('lo que no llama a `gh` no lo llama', () => {
  for (const command of [
    'cargo test -p helios-rest',
    'git status',
    'git log --oneline -5',                  // `git` no es `gh`, y `--oneline` tampoco
    '',
    '   ',
  ]) {
    assert.equal(callsGh(command), false, JSON.stringify(command));
  }
});

test('un `gh` dentro de una cadena que no se ejecuta cuenta igual: falso positivo asumido', () => {
  // `echo` no llama a nada, pero la red de reserva mira la línea cruda y ve la
  // palabra. Se deja así a propósito: en una fase que no puede publicar nada,
  // un `echo` denegado de más cuesta un turno, y un `gh` colado cuesta una
  // escritura pública que nadie pidió.
  assert.equal(callsGh('echo "use gh pr create"'), true);
  assert.equal(callsGh('echo "primero mira gh --help"'), true);
});

test('lo que se le escapa: la garantía no es esta función', () => {
  // Ninguna de éstas se ve desde la línea de comando, y todas pueden acabar
  // llamando a `gh`. Lo que de verdad lo impide es no darle Bash a esa sesión
  // (`runClaude` acepta `tools`); esto es el cinturón, no los tirantes.
  for (const command of [
    "echo 'gh issue close 1' | sh",
    'bash publicar.sh',
    'node -e "require(\'child_process\').execSync(\'g\' + \'h issue close 1\')"',
    'sh -c "$CMD"',
  ]) {
    assert.equal(callsGh(command), false, command);
  }
});

// ---------------------------------------------------------------------------
// `stateChangeProblem`: lo que la línea HACE, no lo que publica
//
// La compuerta de arriba juzga prosa. Cerrar un issue no publica prosa, así que
// no había nada que juzgar y nada que denegar. Ésta pregunta lo otro, y sólo se
// le pregunta a una FASE: un chat es Edson con el tablero delante viendo cada
// llamada —pedirlo ya es la confirmación— y una fase corre sola. Que el chat
// quede fuera se prueba en `ghgate-wiring.test.mjs`, que es donde vive el
// enganche.
//
// Es una lista blanca: lo que no está, se deniega. Por eso los tres grupos de
// abajo —lo que pasa, lo que no, y lo que no se puede leer— valen más juntos
// que por separado.

const denied = (command) => {
  const problem = stateChangeProblem(command);
  assert.equal(typeof problem, 'string', `debería denegarse: ${command}`);
  return problem;
};
const allowed = (command) => assert.equal(stateChangeProblem(command), null, `debería pasar: ${command}`);

test('an apostrophe in a heredoc inside $( ) does not hide the gh call after it', () => {
  denied("git commit -m \"$(cat <<'EOF'\nIt's done\nEOF\n)\" && gh issue close 5");
  allowed("git commit -m \"$(cat <<'EOF'\nIt's done\nEOF\n)\"");
});

test('`gh issue close 1274` se deniega — y por eso hacía falta', async () => {
  denied('gh issue close 1274');

  // El mismo test enseña el agujero que tapa: para la compuerta de prosa esta
  // línea no publica nada, así que la deja pasar limpia.
  assert.deepEqual(await ghPublishProblems('gh issue close 1274', noFiles), []);
  assert.equal(ghPublishIntent('gh issue close 1274'), null);
});

test('cambiar estado o etiquetas se deniega, se escriba como se escriba', () => {
  for (const command of [
    'gh issue close 1274',
    'gh issue close 1274 --reason not_planned',
    'gh issue reopen 12',
    'gh issue delete 12 --yes',
    'gh issue transfer 12 HeliosSoftware/otro',
    'gh pr close 7',
    'gh pr reopen 7',
    'gh pr merge 7 --squash',                      // cierra el issue por el «Closes #»
    'gh issue edit 12 --add-label wontfix',
    'gh issue edit 12 --remove-label ready',
    'gh pr edit 7 --add-label ready',
    'gh issue edit 12 --add-label=wontfix',        // un solo token: lo parte `takeFlag`
    'gh.exe issue close 1274',
    'gh issue -R HeliosSoftware/hfs close 1274',
    // El flag ANTES del grupo: `verbOf` devuelve `{group:null}` aquí, y `gh`
    // acepta la forma. Con una lista negra se colaba; con una blanca, no.
    'gh -R HeliosSoftware/hfs issue close 1274',
    'env FOO=1 timeout 60 gh issue close 1274',
    'gh alias set zap "issue close"',              // el rodeo por un alias
  ]) {
    denied(command);
  }
});

test('un flag delante del grupo no esconde el `gh` que va dentro de otro comando', () => {
  // Los dos agujeros ya tapados por separado —el flag antes del grupo, que lee
  // `callOf`, y el `gh` que no empieza ningún comando, que lee `GH_GROUPS`— se
  // abrían combinados: la comprobación miraba SOLO la palabra siguiente a `gh`,
  // así que con un `-R` delante del grupo la llamada no se reconocía como tal.
  // Los tres pasaban, medidos.
  for (const command of [
    'gh issue list --json number -q ".[].number" | xargs -I{} gh -R HeliosSoftware/hfs issue close {}',
    'xargs -I{} gh --repo o/r issue close {} < nums.txt',
    'find . -name x -exec gh -R o/r issue close 1 \\;',
  ]) {
    denied(command);
  }

  // Y no al precio de las lecturas: el mismo rodeo con un verbo de lectura pasa.
  allowed('gh issue list --json number -q ".[].number" | xargs -I{} gh -R HeliosSoftware/hfs issue view {}');
  // `gh` como argumento de otro sigue sin ser una llamada aunque lleve flags.
  allowed('grep -n gh --include=*.md notas.md');
});

test('`edit` publica un título y un cuerpo; lo demás que cambia no es publicar', () => {
  // El comentario decía que `--add-label` era «el único verbo que publica y
  // además cambia estado», y era falso: estos cuatro pasaban, medidos. Asignar
  // a alguien manda una notificación, y `release create` corta un tag público
  // —efecto mayor que cerrar el issue que esta mitad existe para no cerrar.
  for (const command of [
    'gh issue edit 12 --add-assignee x',
    'gh issue edit 12 --remove-assignee x',
    'gh issue edit 12 --milestone v2',
    'gh issue edit 12 --add-project Roadmap',
    'gh pr edit 7 --add-reviewer x',
    'gh pr edit 7 --remove-reviewer x',
    'gh pr edit 7 --base develop',
    'gh release create v9.9.9 --notes "Release notes."',
    'gh release edit v9.9.9 --draft=false',
  ]) {
    denied(command);
  }

  // Lo que `edit` sí puede seguir haciendo es publicar prosa, que la juzga la
  // otra compuerta.
  allowed('gh issue edit 12 --title "fix: rename"');
  allowed('gh pr edit 7 --body-file cuerpo.md');
  // Y leer un release sigue siendo leer.
  allowed('gh release view v9.9.9');
  allowed('gh release list');
});

test('`edit` y `create` pasan sólo mientras cada flag sea prosa', () => {
  // La lista de flags de estado era una lista NEGRA dentro de un verbo
  // permitido, es decir permitir-por-defecto en el único sitio donde este
  // fichero decía que nunca lo sería. Las doce de abajo pasaban, medidas: dos
  // son los cortos de flags que la lista SÍ llevaba por su nombre largo, siete
  // son grafías que nadie pensó, y las cuatro últimas son las que la lista no
  // cubría en absoluto porque miraba sólo a `edit`.
  for (const command of [
    'gh issue edit 1274 -m v2',                 // corto de --milestone
    'gh pr edit 7 -B release',                  // corto de --base
    'gh issue edit 1274 --remove-milestone',
    'gh issue edit 1274 --type Bug',
    'gh issue edit 1274 --remove-type',
    'gh issue edit 1274 --add-blocked-by 99',
    'gh issue edit 1274 --add-sub-issue 99',
    'gh issue edit 1274 --parent 99',
    'gh issue edit 1274 --remove-parent',
    'gh pr edit 7 --remove-milestone',
    'gh issue create --title "x" --assignee eterceros',
    'gh issue create --title "x" --label wontfix',
    'gh issue create --title "x" --milestone v2',
    'gh pr create --title "x" --body "y" --reviewer eterceros',
  ]) {
    denied(command);
  }

  // Y lo que cierra de paso: un flag que `gh` saque el año que viene tampoco
  // es prosa, así que tampoco pasa. Sin tocar la lista.
  denied('gh issue edit 1274 --flag-que-no-existe-todavia x');
  denied('gh pr edit 7 --title "fix: x" --add-label ready');   // uno solo basta

  // La otra dirección, que es la que lo mantiene honesto: lo que estos verbos
  // están en la lista blanca para hacer —un título, un cuerpo, y decir en qué
  // repositorio— sigue pasando, en largo y en corto.
  for (const command of [
    'gh issue edit 12 --title "fix: rename"',
    'gh issue edit 12 -t "fix: rename"',
    'gh pr edit 7 --body-file cuerpo.md',
    'gh pr edit 7 -F cuerpo.md',
    'gh pr edit 7 -b "Done."',
    'gh pr edit 7 --body="Done."',
    'gh pr create --title "fix: x" --body "y"',
    'gh issue create -R HeliosSoftware/hfs --title "fix: x" --body "y"',
    'gh -R HeliosSoftware/hfs issue edit 12 --title "fix: rename"',
  ]) {
    allowed(command);
  }
});

test('la ruta de respuesta a un hilo es la que existe, no la que se escribió', () => {
  // `pulls/comments/<n>/replies` no es una ruta de la API de GitHub: la entrada
  // no permitía nada y la real se denegaba. Impacto práctico nulo —el tablero
  // responde hilos por GraphQL desde Node— pero una lista cuya única defensa es
  // ser exacta no se queda con una línea equivocada dentro.
  allowed('gh api -X POST repos/o/r/pulls/7/comments/123/replies -f body=hi');
  denied('gh api -X POST repos/o/r/pulls/comments/123/replies -f body=hi');
});

test('`gh api`: la ruta del issue no es la del comentario, y ahí está la diferencia', () => {
  for (const command of [
    'gh api -X PATCH repos/o/r/issues/12 -f state=closed',
    'gh api --method PATCH repos/o/r/issues/12 -f state=closed -f state_reason=not_planned',
    'gh api -X PATCH /repos/o/r/issues/12 -f state=closed',
    'gh api -X PATCH https://api.github.com/repos/o/r/issues/12 -f state=closed',
    'gh api -XPATCH repos/o/r/pulls/7 -f state=closed',
    // El caso medido: el `state` va dentro del fichero, no en la línea.
    'gh api -X PATCH repos/o/r/issues/12 --input cierre.json',
    'gh api -X POST repos/o/r/issues/12/labels -f labels[]=wontfix',
    'gh api repos/o/r/issues/12/labels -f labels[]=wontfix',   // sin -X: `gh` hace POST igual
    'gh api -X DELETE repos/o/r/issues/12/labels/ready',
    'gh api -X PUT repos/o/r/issues/12/labels -f labels[]=ready',
    'gh api -X POST repos/o/r/issues/12/lock -f lock_reason=resolved',
  ]) {
    denied(command);
  }
});

test('en las rutas de publicar, el método decide antes que la ruta', () => {
  // Medido: los tres pasaban. `apiAllowed` decidía una escritura SOLO por la
  // ruta, y la compuerta de prosa no los veía tampoco —`DELETE` no está en
  // `WRITE_METHODS`, así que `apiIntent` devuelve null y no hay texto que
  // juzgar—. Una fase sin nadie delante podía borrar cualquier comentario de
  // un issue o de un PR, por el camino obvio: «lo borro y lo repongo».
  for (const command of [
    'gh api -X DELETE repos/o/r/issues/comments/123',
    'gh api --method delete repos/o/r/pulls/comments/123',
    'gh api -X DELETE repos/o/r/pulls/7/reviews/9',
    'gh api -XDELETE repos/o/r/pulls/7/comments/123/replies',
    'gh api --method=DELETE repos/o/r/issues/12/comments',
  ]) {
    denied(command);
    assert.equal(ghPublishIntent(command), null, `y la compuerta de prosa sigue sin ver nada: ${command}`);
  }

  // Y las escrituras que sí publican prosa por esas mismas rutas no se tocan:
  // son la razón de que la lista exista.
  allowed('gh api -X POST repos/o/r/issues/12/comments -F body=@f.md');
  allowed('gh api -X PATCH repos/o/r/issues/comments/123 -F body=@f.md');
  allowed('gh api -X POST repos/o/r/pulls/7/reviews -F body=@f.md');
  allowed('gh api -X PUT repos/o/r/pulls/7/reviews/9 -F body=@f.md');
});

test('`gh api graphql`: sin mutación visible no se ejecuta', () => {
  for (const command of [
    `gh api graphql -f query='mutation { closeIssue(input: {issueId: "I_1"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { reopenIssue(input: {issueId: "I_1"}) { issue { number } } }'`,
    `gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: "I_1"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { removeLabelsFromLabelable(input: {labelableId: "I_1"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { deleteIssue(input: {issueId: "I_1"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { transferIssue(input: {issueId: "I_1"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { closePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'`,
    // Y el caso medido: la mutación en un fichero, invisible desde la línea.
    'gh api graphql -F query=@mutacion.gql',
    'gh api graphql --input mutacion.json',
    'gh api graphql -f query="$MUTATION"',
  ]) {
    denied(command);
  }
});

test('las lecturas siguen pasando: romperlas sería peor que el agujero', () => {
  for (const command of [
    'gh issue view 12',
    'gh issue view 12 --json title,body,labels,state',
    'gh issue list --state open',
    'gh issue list --label ready --state closed',    // `--state` no cambia nada: filtra
    'gh issue status',
    'gh pr view 7 --json state',
    'gh pr list --state merged',
    'gh pr diff 7',
    'gh pr checks 7',
    'gh pr status',
    'gh search issues "tenant in:title" --repo HeliosSoftware/hfs',
    'gh run list --limit 5',
    'gh repo view --json defaultBranchRef',
    'gh label list -R HeliosSoftware/hfs',
    'gh auth status',
    'gh --version',
    'gh api repos/o/r/issues/12',
    'gh api repos/o/r/issues/12/comments',
    'gh api repos/o/r/issues/12/labels',            // leer las etiquetas es leer
    'gh api repos/o/r/pulls/7 --jq .state',
    'gh api user --jq .login',
    `gh api graphql -f query='query { repository(owner: "o", name: "r") { issue(number: 12) { state } } }'`,
    'cd /tmp/wt && gh pr view 1445',
    'grep gh notas.md',                             // `gh` como argumento de otro, no una llamada
    'cargo test -p helios-rest',
    '',
    '   ',
  ]) {
    allowed(command);
  }
});

test('publicar prosa sigue siendo asunto de la otra compuerta, no de ésta', () => {
  for (const command of [
    'gh issue comment 12 --body "Done."',
    'gh pr comment 7 --body "Done."',
    'gh pr review 7 --approve --body "Looks right."',
    'gh pr create --title "fix: x" --body "y"',
    'gh issue edit 12 --title "fix: rename"',
    'gh pr edit 7 --body-file cuerpo.md',
    'gh api repos/o/r/issues/12/comments -f body=hi',
    'gh api -X POST repos/o/r/pulls/7/reviews -F body=@review.md',
    `gh api graphql -f query='mutation { addComment(input: {subjectId: "PR_1", body: "Done."}) { clientMutationId } }'`,
  ]) {
    allowed(command);
  }
});

test('el camino que el tablero documenta para corregir un comentario sigue abierto', () => {
  // `GITHUB_PUBLISH_RULE` se le imprime al chat y sólo al chat —`prompts.js`
  // dice por qué—, así que esto no prueba que una fase lo lea: prueba que la
  // ruta que el tablero documenta y la que esta lista permite son la misma. La
  // receta sale del módulo, no de una copia: si alguien cambia la ruta ahí,
  // este test la sigue. Los marcadores `<owner>`,
  // `<repo>`, `<id>` y `<fichero>` se rellenan porque `<` y `>` son
  // redirecciones del shell: la línea con marcadores no es un comando.
  const real = (line) => line
    .replace('<owner>', 'HeliosSoftware').replace('<repo>', 'hfs')
    .replace('<id>', '2312').replace('<fichero>', 'respuesta.md');

  const commands = [...GITHUB_PUBLISH_RULE.matchAll(/`(gh [^`]+)`/g)].map((m) => real(m[1]));
  // Tres: leer el autor del comentario, leer tu propia cuenta, y editarlo.
  assert.ok(commands.length >= 3, `la regla ya no imprime comandos gh: ${commands.join(' | ')}`);
  assert.ok(commands.some((c) => /-X PATCH/.test(c)), commands.join(' | '));
  for (const command of commands) allowed(command);
});

test('el mensaje dice qué hacer, y no enseña dónde no mira la compuerta', () => {
  const problem = denied('gh issue close 1274');
  assert.match(problem, /respuesta final/);
  assert.match(problem, /ventana de confirmación/);

  // Ni la receta para esquivarla ni el mapa de por dónde miró: nombrar el
  // campo, el flag, la ruta o la forma denegada es decirle por dónde probar.
  for (const leak of ['--input', '@', 'graphql', '-X', 'state', '--add-label', 'labels']) {
    assert.ok(!problem.includes(leak), `el mensaje no debe contener «${leak}»: ${problem}`);
  }
  for (const mutation of ['closeIssue', 'addLabelsToLabelable', 'removeLabelsFromLabelable', 'deleteIssue']) {
    assert.ok(!problem.includes(mutation), mutation);
  }
});

test('los rodeos que `parse` ya entiende cuentan igual', () => {
  denied('cd /tmp && gh issue close 1');
  denied('git status && gh issue close 1 && echo listo');
  denied('sh -c "gh issue close 1"');
  // Y el que no empieza ningún comando: la llamada va dentro de los argumentos
  // de otro. `gh issue list` es una lectura, así que la línea sólo se deniega
  // si se lee de verdad el `gh` del final.
  denied('gh issue list --json number -q ".[].number" | xargs -I{} gh issue close {}');
});

test('una línea que no se puede leer se deniega; una que no se puede ver, no', () => {
  // Lo desconocido se deniega igual que el verbo desconocido.
  for (const command of [
    'gh issue $ACTION 1274',
    'gh issue "$ACTION" 1274',
    'gh $CMD 1274',
    'gh api -X PATCH $ROUTE -f state=closed',
  ]) {
    denied(command);
  }

  // Pero lo que ni siquiera se ve no se puede denegar, y denegar cualquier
  // mención de `gh` se llevaría por delante las lecturas. Ese hueco es el mismo
  // que documenta `callsGh`, y se cierra igual: no dando Bash —que es lo que
  // hace ya `draftIssueClosing`.
  for (const command of [
    "echo 'gh issue close 1' | sh",
    'bash cerrar.sh',
    'sh -c "$CMD"',
    'echo "para cerrarlo: gh issue close 1274"',
    // El pariente menor de los rodeos de arriba, y se queda como hueco a
    // sabiendas: el programa sale de una variable, así que no hay ningún `gh`
    // que leer en la línea. Lo tapa lo mismo que a los otros tres: no dar Bash.
    '$GH issue close 1274',
  ]) {
    allowed(command);
  }
});

// ---------------------------------------------------------------------------
// Dónde está la persona: qué fases pasan por esta compuerta y cuáles no
//
// Vive aquí y no en `ghgate-wiring.test.mjs` porque lo que se prueba es el
// criterio, no el enganche: `ghGateHooks` es lo único que sabe de fases, así
// que el pipeline se carga en perezoso para preguntárselo.

test('la compuerta de estado se le pregunta a quien corre solo, no a quien tiene a alguien delante', async () => {
  process.env.HFSMON_NO_AUTOSTART = '1';
  const pipeline = await import('../src/pipeline.js');
  const { store } = await import('../src/store.js');
  const task = store.addTask({ number: 9711, title: 't', labels: [], url: 'https://x/9711', closed: false }, 'hfs');

  const decide = async (phase) => {
    const fn = pipeline.ghGateHooks(task, phase).PreToolUse[0].hooks[0];
    const out = await fn({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh issue close 1274' } });
    return out?.hookSpecificOutput?.permissionDecision ?? 'allow';
  };

  // El chat es Edson viendo cada llamada; una tarea de un plan que él escribió,
  // aprobó y está viendo correr en ese mismo chat es el mismo turno más tarde.
  assert.equal(await decide('chat'), 'allow');
  assert.equal(await decide('plan:t1'), 'allow');

  // Y las gobernadas, la tabla entera. `'plan'` a secas es la que faltaba, y es
  // justo la que el criterio presume comprobada: `attended` es
  // `phase.startsWith('plan:')`, y la fase de plan AUTOMÁTICA del pipeline
  // (`planFix`, `const stage = 'plan'`) se llama así. Quitarle los dos puntos a
  // ese prefijo —un carácter— dejaría esa fase exenta sin que ninguna otra
  // aserción se pusiera roja. El fix corre solo y sus tareas se llaman
  // `fix:<id>`: el prefijo `plan:` no choca con ninguna fase automática.
  for (const phase of ['plan', 'triage', 'advisor', 'fix', 'fix:t1', 'qa', 'pr', 'demo', 'cr', 'close']) {
    assert.equal(await decide(phase), 'deny', phase);
  }
});

// ---------------------------------------------------------------------------
// `--body-file` de `issue create` y `pr create`: se lee y se comprueba

test('`gh issue create --body-file` se valida leyendo el fichero, no se rechaza por ilegible', async () => {
  const command = 'gh issue create --title "fix: the filter ignores the tenant" --body-file /tmp/issue.md';
  assert.equal(ghPublishIntent(command).bodyFile, '/tmp/issue.md');
  assert.deepEqual(await ghPublishProblems(command, files({ '/tmp/issue.md': ENGLISH })), []);
  assert.ok(spanish(await ghPublishProblems(command, files({ '/tmp/issue.md': SPANISH }))));
});

test('`gh pr create --body-file` se valida leyendo el fichero, no se rechaza por ilegible', async () => {
  const command = 'gh pr create --title "fix: reject unterminated fences" --body-file body.md';
  assert.deepEqual(await ghPublishProblems(command, files({ 'body.md': ENGLISH })), []);
  assert.ok(spanish(await ghPublishProblems(command, files({ 'body.md': SPANISH }))));
  const gone = await ghPublishProblems(command, noFiles);
  assert.match(gone.join(' '), /no ha podido leerlo/);
});

test('an English body with quoted Spanish UI strings passes through `--body-file`', async () => {
  const command = 'gh pr create --title "fix: rename the start button" --body-file body.md';
  const body = 'The start button now reads "Iniciar app" and its tooltip "Levantar la app de este proyecto".';
  assert.deepEqual(await ghPublishProblems(command, files({ 'body.md': body })), []);
});

// Issue #39, Part B: the reader peels the keywords that open a compound command
// and keeps what the install gate needs (`subs`, `heredocBody`, `pipedIn`).

test('las palabras clave de shell no esconden el `gh` de su pieza', () => {
  for (const command of [
    'if true; then gh issue close 1274; fi',
    'for n in 1 2; do gh issue close 1274; done',
    '{ gh issue close 1274; }',
    '! gh issue close 1274',
    'while true; do gh issue close 1274; done',
    'time gh issue close 1274',
    'time -p gh issue close 1274',
  ]) {
    assert.equal(callsGh(command), true, `llama a gh: ${command}`);
    denied(command);
  }
  allowed('if true; then echo hola; fi');
  allowed('for d in web; do ls "$d"; done');
});

test('una palabra clave sin una orden detrás no inventa ninguna', async () => {
  const problems = await ghPublishProblems('if true; then gh pr comment 1445 --body "Fixed in the last commit"; fi', noFiles);
  assert.deepEqual(problems, []);
});

test('`parse` guarda lo de dentro de `$(…)` y de las comillas invertidas, y sigue marcándolas inseguras', async () => {
  const { parse } = await import('../src/ghgate.js');
  const [echo] = parse('echo $(npm ci) `npm ls` "$(git status)" "`pwd`"');
  assert.deepEqual(echo.subs, ['npm ci', 'npm ls', 'git status', 'pwd']);
  assert.equal(echo.words.slice(1).every((w) => w.unsafe), true);
  const [assign] = parse('x=$(npm ci)');
  assert.deepEqual(assign.words, [], 'la asignación se pela, pero lo de dentro queda en subs');
  assert.deepEqual(assign.subs, ['npm ci']);
  assert.deepEqual(parse('echo hola')[0].subs, []);
});

test('`parse` guarda el cuerpo del heredoc, el de una here-string y si hay una tubería delante', async () => {
  const { parse } = await import('../src/ghgate.js');
  const [cat, sh] = parse('cat <<EOF | sh\nnpm ci\nEOF');
  assert.equal(cat.heredocBody, 'npm ci');
  assert.equal(sh.pipedIn, true);
  assert.equal(cat.pipedIn, false);
  assert.equal(parse('bash <<<"npm ci"')[0].heredocBody, 'npm ci');
  assert.equal(parse('echo hola')[0].heredocBody, null);
});

test('una barra invertida seguida de CRLF continúa la línea, igual que con LF', async () => {
  const { parse } = await import('../src/ghgate.js');
  assert.deepEqual(parse('npm \\\r\nci')[0].words.map((w) => w.value), ['npm', 'ci']);
  assert.deepEqual(parse('npm \\\nci')[0].words.map((w) => w.value), ['npm', 'ci']);
});

// Escaped backticks inside a backtick span: bash does not end the span there,
// so a later backtick must not start a new span that swallows a real `gh`.
{
  const BT = String.fromCharCode(96);
  const BS = String.fromCharCode(92);
  const tail = `echo "${BT}echo ${BS}${BT}x${BS}${BT}${BT}"`;
  const refused = [
    `${tail} ; gh -R o/r issue close 1`,
    `${tail} ; gh --repo o/r pr merge 5 --squash`,
    'gh issue close 1',
  ];
  for (const command of refused) {
    test(`escaped backticks do not hide a gh call: ${command}`, () => {
      assert.equal(callsGh(command), true, command);
      assert.ok(stateChangeProblem(command), `debería rechazarse: ${command}`);
    });
  }
  const benign = [
    `echo "${BS}${BT}not a command${BS}${BT}"`,
    `echo "${BT}echo ${BS}${BT}x${BS}${BT}${BT}" ; echo done`,
    `echo ${BT}echo hi${BT}`,
  ];
  for (const command of benign) {
    test(`escaped backticks without gh are not refused: ${command}`, () => {
      assert.equal(stateChangeProblem(command), null, command);
    });
  }
  test('an unterminated backtick behaves as before', () => {
    assert.equal(stateChangeProblem(`echo ${BT}echo hi`), null);
    assert.equal(stateChangeProblem(`echo "${BT}echo hi`), null);
  });
  test('the nested command inside backticks has its escapes removed', async () => {
    const { parse } = await import('../src/ghgate.js');
    const [cmd] = parse(`echo ${BT}echo ${BS}${BT}x${BS}${BT} ${BS}${BS} ${BS}$HOME${BT}`);
    assert.deepEqual(cmd.words[1].subs, [`echo ${BT}x${BT} ${BS} $HOME`]);
  });
}

{
  const BT = String.fromCharCode(96);
  const BS = String.fromCharCode(92);
  const words = (c) => c.words.map((w) => w.value);

  test('exec -a NAME: the name is the value of -a, the program is what follows', async () => {
    const { parse } = await import('../src/ghgate.js');
    assert.deepEqual(parse('exec -a x npm ci').map(words), [['npm', 'ci']]);
    assert.deepEqual(parse('exec -c -l -a x npm ci').map(words), [['npm', 'ci']]);
    assert.deepEqual(parse('exec -c ls').map(words), [['ls']]);
    assert.deepEqual(parse('exec npm ci').map(words), [['npm', 'ci']]);
  });

  for (const command of [
    'exec -a x gh issue close 1',
    'exec -a x gh -R o/r pr merge 5',
    'exec gh issue close 1',
    'exec -l -a x gh issue close 1',
  ]) {
    test(`exec with a name does not hide gh: ${command}`, () => {
      assert.ok(stateChangeProblem(command), `debería rechazarse: ${command}`);
    });
  }

  test('exec -c ls style commands are unchanged', () => {
    assert.equal(stateChangeProblem('exec -c ls'), null);
    assert.equal(stateChangeProblem('exec -a x ls'), null);
  });

  test('a heredoc body backtick span with an escaped nested backtick yields the inner command', async () => {
    const { parse } = await import('../src/ghgate.js');
    const body = `${BT}echo ${BS}${BT}npm ci${BS}${BT}${BT}`;
    const [cmd] = parse(`cat <<EOF\n${body}\nEOF`);
    assert.deepEqual(cmd.subs, [`echo ${BT}npm ci${BT}`]);
    const [inner] = parse(cmd.subs[0]);
    assert.deepEqual(inner.subs, ['npm ci']);
  });

  test('a quoted heredoc delimiter still means no expansion', async () => {
    const { parse } = await import('../src/ghgate.js');
    const [cmd] = parse(`cat <<'EOF'\n${BT}echo ${BS}${BT}npm ci${BS}${BT}${BT}\nEOF`);
    assert.deepEqual(cmd.subs, []);
  });

  test('a heredoc backtick span running gh is not less strict with an escaped backtick', () => {
    const plain = `cat <<EOF\n${BT}gh issue close 1${BT}\nEOF`;
    const escaped = `cat <<EOF\n${BT}echo ${BS}${BT}x${BS}${BT} ; gh issue close 1${BT}\nEOF`;
    assert.equal(callsGh(plain), true);
    assert.equal(callsGh(escaped), true);
    assert.equal(Boolean(stateChangeProblem(escaped)), Boolean(stateChangeProblem(plain)));
  });
}

// ---------------------------------------------------------------------------
// Issue 42, parts A, C and D: the gate reads what is nested, both readings of a
// backslash before a CRLF, and a pathological line costs little.

{
  const BT = '`';
  const nesting = (n, inner) => 'echo $('.repeat(n) + inner + ')'.repeat(n);

  const nestedState = [
    'echo $(gh issue close 1)',
    'x=$(gh issue close 1)',
    `echo ${BT}gh issue close 1${BT}`,
    `x=${BT}gh issue close 1${BT}`,
    'echo "$(gh issue close 1)"',
    'echo $(gh -R o/r issue close 1)',
    'echo $(gh --repo o/r pr merge 5 --squash)',
    'echo "$(gh -R o/r issue close 1)"',
    `echo ${BT}gh -R o/r issue close 1${BT}`,
    `echo "${BT}gh --repo o/r pr merge 5 --squash${BT}"`,
    'echo $(echo $(gh issue close 1))',
    'echo "$(echo "$(gh --repo o/r pr merge 5 --squash)")"',
    `echo $(echo ${BT}gh -R o/r issue close 1${BT})`,
    'cat <<EOF\n$(gh -R o/r issue close 1)\nEOF',
    'bash <<EOF\ngh -R o/r issue close 1\nEOF',
    'bash <<EOF\ngh issue close 1\nEOF',
    "bash -c 'echo $(gh issue close 1)'",
    "bash -c 'echo $(gh -R o/r issue close 1)'",
    'bash -c true "$(gh issue close 1)"',
    'X=$(gh -R o/r issue close 1) bash -c true',
    'printf x\\\r\ngh issue close 1',
    nesting(4, 'gh issue close 1'),
    nesting(5, 'gh issue close 1'),
    nesting(8, 'gh -R o/r issue close 1'),
  ];
  for (const command of nestedState) {
    test(`a state change nested in a substitution is refused: ${JSON.stringify(command)}`, () => {
      assert.equal(typeof stateChangeProblem(command), 'string');
    });
  }

  const nestedReads = [
    'echo $(gh issue list)',
    'x=$(gh pr view 5 --json title)',
    `echo ${BT}gh issue view 3${BT}`,
    'echo "$(gh -R o/r issue list)"',
    'echo "$(date)"',
    'echo $(echo $(date))',
    'bash <<EOF\necho hello\nEOF',
    "bash -c 'echo $(date)'",
    'printf x\\\ngh issue list',
  ];
  for (const command of nestedReads) {
    test(`a read nested in a substitution stays allowed: ${JSON.stringify(command)}`, () => {
      assert.equal(stateChangeProblem(command), null);
    });
  }

  test('callsGh and ghPublishIntent see a gh call inside a substitution', () => {
    for (const command of ['echo $(gh pr comment 5 --body hello)', `echo ${BT}gh pr comment 5 --body hello${BT}`,
      'echo "$(gh pr comment 5 --body hello)"', 'bash <<EOF\ngh pr comment 5 --body hello\nEOF',
      'bash -c true "$(gh pr comment 5 --body hello)"']) {
      assert.equal(callsGh(command), true, command);
      assert.equal(ghPublishIntent(command)?.kind, 'comment', command);
    }
    assert.equal(ghPublishIntent('echo "$(date)"'), null);
  });

  test('a nested publication is judged as the same command at the top level', async () => {
    const top = await ghPublishProblems(`gh pr comment 5 --body "${SPANISH}"`, noFiles);
    assert.ok(spanish(top));
    for (const command of [`echo $(gh pr comment 5 --body "${SPANISH}")`,
      `echo "$(echo "$(gh pr comment 5 --body "${SPANISH}")")"`, `bash <<EOF\ngh pr comment 5 --body "${SPANISH}"\nEOF`]) {
      assert.ok(spanish(await ghPublishProblems(command, noFiles)), command);
    }
    // A call that only exists inside a substitution keeps the refusal it always had, English or not.
    const buried = await ghPublishProblems(`echo $(gh pr comment 5 --body "${ENGLISH}")`, noFiles);
    assert.equal(buried.length, 1);
    assert.match(buried[0], /no ha sabido leerla/);
  });

  test('parse keeps the words before the wrappers were peeled', async () => {
    const { parse } = await import('../src/ghgate.js');
    const [cmd] = parse('nohup env -iC web npm ci');
    assert.deepEqual(cmd.rawWords.map((w) => w.value), ['nohup', 'env', '-iC', 'web', 'npm', 'ci']);
    assert.notDeepEqual(cmd.words.map((w) => w.value), cmd.rawWords.map((w) => w.value));
    assert.deepEqual(parse('plain words')[0].rawWords.map((w) => w.value), ['plain', 'words']);
  });

  test('a shell spliced by -c keeps the substitutions, heredoc and pipe of the command it replaced', async () => {
    const { parse } = await import('../src/ghgate.js');
    const subs = parse('bash -c true "$(gh issue close 1)"').flatMap((c) => c.subs);
    assert.deepEqual(subs, ['gh issue close 1']);
    const body = parse("bash -c cat <<'EOF'\ntext\nEOF").map((c) => c.heredocBody);
    assert.ok(body.includes('text'));
    assert.ok(parse('echo hi | bash -c true').some((c) => c.pipedIn));
    const evalSubs = parse("eval 'true' \"$(gh issue close 1)\"").flatMap((c) => c.subs);
    assert.ok(evalSubs.includes('gh issue close 1'));
  });

  test('lineReadings gives two readings only when a backslash precedes a CRLF', async () => {
    const { lineReadings } = await import('../src/ghgate.js');
    assert.equal(lineReadings('a b').length, 1);
    assert.equal(lineReadings('a \\\nb').length, 1);
    assert.equal(lineReadings('a \\\r\nb').length, 2);
  });

  test('a backslash before a CRLF is judged as a continuation and as a literal, the stricter wins', () => {
    // Joined, the word is `xgh`; on a Linux shell the CR is escaped and the LF ends the command.
    assert.equal(typeof stateChangeProblem('printf x\\\r\ngh issue close 1'), 'string');
    assert.equal(ghPublishIntent('printf x\\\r\ngh pr comment 5 --body hello')?.kind, 'comment');
    // The same with a bare LF is a continuation in every shell.
    assert.equal(stateChangeProblem('printf x\\\ngh issue close 1'), null);
    assert.equal(ghPublishIntent('printf x\\\ngh pr comment 5 --body hello'), null);
  });

  test('a 10 KB line of unterminated substitutions is read in well under 50 ms', async () => {
    const lines = ['echo "' + '$(")'.repeat(3300) + '"', 'echo "' + '$('.repeat(5000) + '"',
      'echo "' + '$("'.repeat(5000) + '"', 'echo ' + '"$('.repeat(2500) + 'x' + ')"'.repeat(2500)];
    for (const line of lines) {
      // Best of three: a quadratic scan stays far over 50 ms every time, while a loaded
      // machine only slows some of the runs.
      let ms = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        stateChangeProblem(line);
        callsGh(line);
        await ghPublishProblems(line, noFiles);
        ms = Math.min(ms, performance.now() - t0);
      }
      assert.ok(ms < 50, `${line.slice(0, 12)}… took ${ms.toFixed(1)} ms`);
    }
  });

  test('a very deep nesting does not overflow the stack in any entry point', async () => {
    const line = 'echo ' + '"$('.repeat(20000) + 'x' + ')"'.repeat(20000);
    assert.doesNotThrow(() => stateChangeProblem(line));
    assert.doesNotThrow(() => callsGh(line));
    await assert.doesNotReject(() => ghPublishProblems(line, noFiles));
    const { parse } = await import('../src/ghgate.js');
    assert.doesNotThrow(() => parse(line));
  });
}

// A line nested past the reading limit must not hide a `gh` written at the top
// level in any quoting form: main refused these, so must the gate.
{
  const nest = (n) => 'echo $('.repeat(n) + 'echo x' + ')'.repeat(n);
  const D = nest(6);
  const BS = String.fromCharCode(92);
  const spellings = ['"gh"', "'gh'", `${BS}gh`, 'g""h', 'command "gh"'];
  const orders = [['deep first', (c) => `${D}; ${c}`], ['deep last', (c) => `${c}; ${D}`]];

  for (const gh of spellings) {
    for (const [where, wrap] of orders) {
      for (const verb of ['issue close 1', 'pr merge 5 --squash']) {
        const line = wrap(`${gh} ${verb}`);
        test(`deep part + ${gh} ${verb} is refused (${where})`, () => {
          assert.ok(stateChangeProblem(line));
          assert.equal(callsGh(line), true);
        });
      }
      const publish = wrap(`${gh} pr comment 5 --body 'Listo, ya cambié el clamp a 1 y eliminé la constante.'`);
      test(`deep part + ${gh} pr comment with a Spanish body is refused (${where})`, async () => {
        assert.ok((await ghPublishProblems(publish, noFiles)).length > 0);
        assert.equal(callsGh(publish), true);
      });
    }
  }

  test('a deep part that mentions gh is refused as unread', () => {
    assert.ok(stateChangeProblem(nest(6).replace('echo x', 'gh issue close 1')));
  });

  test('controls: a deep part beside a plain read or no gh is not refused', () => {
    assert.equal(stateChangeProblem(`${D}; ls`), null);
    assert.equal(stateChangeProblem(`${D}; gh pr view 1`), null);
  });
}
