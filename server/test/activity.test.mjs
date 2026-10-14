import './isolate.mjs';   // primero: `claude.js` llega al directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeToolInput } from '../src/claude.js';
import {
  newActivity, applyEvent, summarize, activityLabel, findItem, tail, setOutput, closeAll,
  listeningPort, isServerLike, markStopping, groupProgress,
  MAX_OUTPUT, MAX_ITEMS, SERVER_QUIET_MS, artifactLinks,
} from '../src/activity.js';

// Shapes copied from a real session (session-smoke, 2026-09-10), trimmed.
const tool = (id, name, args = {}, parentId = null) => ({
  kind: 'tool', id, name, parentId, input: args.description ?? args.file_path ?? '', args,
});
const end = (id, over = {}) => ({ kind: 'tool_end', id, parentId: null, ok: true, output: '', structured: null, ...over });

test('una herramienta normal: empieza corriendo y termina con su salida', () => {
  const a = newActivity('t');
  applyEvent(a, tool('r1', 'Read', { file_path: 'x.rs' }));
  assert.equal(a.items[0].status, 'running');
  applyEvent(a, end('r1', { output: 'contenido' }));
  assert.equal(a.items[0].status, 'done');
  assert.equal(a.items[0].output, 'contenido');
  assert.ok(a.items[0].endedAt);
});

test('Bash guarda el comando y separa stderr en la consola', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'echo hi && echo warn 1>&2', description: 'Echo' }));
  assert.equal(a.items[0].kind, 'bash');
  assert.equal(a.items[0].command, 'echo hi && echo warn 1>&2');
  applyEvent(a, end('b1', { output: 'hi\nwarn', structured: { stdout: 'hi\n', stderr: 'warn\n', interrupted: false } }));
  assert.equal(a.items[0].output, 'hi\n[stderr]\nwarn');
  assert.equal(a.items[0].status, 'done');
});

test('un Bash fallido queda en error', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'false' }));
  applyEvent(a, end('b1', { ok: false, output: 'Exit code 1', structured: 'no es un objeto' }));
  assert.equal(a.items[0].status, 'error');
  assert.equal(a.items[0].output, 'Exit code 1');
});

test('Bash en segundo plano: sigue corriendo hasta que su tarea avisa, y se sabe su archivo', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'cargo build', run_in_background: true }));
  applyEvent(a, { kind: 'task_started', taskId: 'bg1', toolUseId: 'b1', description: 'cargo build', background: true, taskType: 'local_bash' });
  applyEvent(a, end('b1', {
    output: 'Command running in background with ID: bg1. Output is being written to: C:\\tmp\\bg1.output',
    structured: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' },
  }));
  const item = a.items[0];
  assert.equal(item.status, 'running', 'el tool_end sólo dice que se lanzó');
  assert.equal(item.background, true);
  assert.equal(item.taskId, 'bg1');
  assert.equal(item.outputFile, 'C:\\tmp\\bg1.output');

  applyEvent(a, { kind: 'task_progress', taskId: 'bg1', description: 'Running cargo build', lastTool: 'Bash' });
  assert.equal(item.progress, 'Running cargo build');
  setOutput(a, 'b1', 'Compiling…\n');
  assert.equal(item.output, 'Compiling…\n');

  applyEvent(a, { kind: 'task_done', taskId: 'bg1', toolUseId: 'b1', status: 'completed', summary: 'done (exit 0)', outputFile: 'C:\\tmp\\bg1.output' });
  assert.equal(item.status, 'done');
  assert.equal(item.progress, null);
  assert.equal(item.output, 'Compiling…\n', 'la consola no se pisa con el resumen');
});

test('un subagente: sus llamadas cuelgan de él, su texto se acumula y el informe llega con task_done', () => {
  const a = newActivity('t');
  applyEvent(a, tool('ag1', 'Agent', { subagent_type: 'Explore', description: 'Read alpha.txt' }));
  applyEvent(a, { kind: 'task_started', taskId: 'a7f', toolUseId: 'ag1', description: 'Read alpha.txt', background: true, taskType: 'local_agent' });
  applyEvent(a, end('ag1', { output: 'Async agent launched successfully.', structured: { isAsync: true, status: 'async_launched', agentId: 'a7f', outputFile: 'C:\\tmp\\a7f.output' } }));
  const agent = a.items[0];
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.subagentType, 'Explore');
  assert.equal(agent.status, 'running', 'lanzado no es terminado');
  assert.equal(agent.output, undefined, 'el texto de lanzamiento no se muestra');

  applyEvent(a, tool('r1', 'Read', { file_path: 'alpha.txt' }, 'ag1'));
  applyEvent(a, { kind: 'text', text: 'Leyendo el archivo.', parentId: 'ag1' });
  applyEvent(a, end('r1', { parentId: 'ag1', output: '1\talpha says 41' }));
  assert.equal(agent.children.length, 1);
  assert.equal(agent.children[0].status, 'done');
  assert.equal(agent.text, 'Leyendo el archivo.');
  assert.equal(a.items.length, 1, 'la llamada del subagente no aparece arriba');

  applyEvent(a, { kind: 'task_done', taskId: 'a7f', toolUseId: 'ag1', status: 'completed', summary: 'alpha.txt says 41' });
  assert.equal(agent.status, 'done');
  assert.equal(agent.output, 'alpha.txt says 41');
});

test('un subagente síncrono (SDK antiguo) termina con el tool_end y su contenido', () => {
  const a = newActivity('t');
  applyEvent(a, tool('ag1', 'Task', { subagent_type: 'Explore', description: 'x' }));
  applyEvent(a, end('ag1', { structured: { content: [{ type: 'text', text: 'informe' }], totalToolUseCount: 3 } }));
  assert.equal(a.items[0].status, 'done');
  assert.equal(a.items[0].output, 'informe');
});

test('el delegate de opencode es un subagente más: anida, acumula texto y se cierra', () => {
  const a = newActivity('t');
  applyEvent(a, { kind: 'tool', id: 'toolu_d', name: 'mcp__opencode__delegate', parentId: null, input: 'opencode: escribe un test', args: { task: 'escribe un test' } });
  const delegate = a.items[0];
  assert.equal(delegate.kind, 'agent');
  assert.equal(delegate.subagentType, 'opencode', 'no dice subagent_type: el nombre de la herramienta lo dice');
  assert.deepEqual(delegate.children, []);

  applyEvent(a, tool('toolu_e', 'Edit', { file_path: 'x.test.js' }, 'toolu_d'));
  assert.equal(a.items.length, 1, 'lo que hace la sesión delegada cuelga de ella');
  assert.equal(delegate.children[0].id, 'toolu_e');

  applyEvent(a, { kind: 'text', text: 'listo', parentId: 'toolu_d' });
  assert.equal(delegate.text, 'listo');

  applyEvent(a, end('toolu_d', { output: 'test escrito' }));
  assert.equal(delegate.status, 'done');
  assert.equal(delegate.output, 'test escrito');
});

test('el resumen del delegate se corta a 100 caracteres de tarea', () => {
  const s = summarizeToolInput({ name: 'mcp__opencode__delegate', input: { task: 'x'.repeat(200) } });
  assert.equal(s, `opencode: ${'x'.repeat(100)}`);
  assert.equal(s.length - 'opencode: '.length, 100);
});

test('una llamada cuyo padre no se vio nunca cae arriba, no al vacío', () => {
  const a = newActivity('t');
  applyEvent(a, tool('r1', 'Grep', { pattern: 'x' }, 'padre-desconocido'));
  assert.equal(a.items.length, 1);
});

test('el texto del hilo principal no entra en el árbol', () => {
  const a = newActivity('t');
  assert.equal(applyEvent(a, { kind: 'text', text: 'hola', parentId: null }), null);
  assert.equal(a.items.length, 0);
});

test('lo que cambia es lo que se devuelve, con el id del padre para colocarlo', () => {
  const a = newActivity('t');
  applyEvent(a, tool('ag1', 'Agent', { subagent_type: 'Explore', description: 'x' }));
  const r = applyEvent(a, tool('r1', 'Read', { file_path: 'f' }, 'ag1'));
  assert.equal(r.item.id, 'r1');
  assert.equal(r.parentId, 'ag1');
  const r2 = applyEvent(a, { kind: 'progress', id: 'r1', elapsed: 12 });
  assert.equal(r2.item.elapsed, 12);
  assert.equal(r2.parentId, 'ag1');
  assert.equal(applyEvent(a, { kind: 'progress', id: 'no-existe', elapsed: 1 }), null);
});

test('las salidas se recortan por el final, que es donde está lo que importa', () => {
  const big = `${'x'.repeat(MAX_OUTPUT)}FINAL`;
  const t = tail(big);
  assert.equal(t.length, MAX_OUTPUT);
  assert.ok(t.endsWith('FINAL'));
  assert.ok(t.startsWith('…'));
  assert.equal(tail('corto'), 'corto');
});

test('hay tope de ítems y se cuenta lo que no cupo', () => {
  const a = newActivity('t');
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) applyEvent(a, tool(`t${i}`, 'Read', { file_path: `${i}` }));
  assert.equal(a.items.length, MAX_ITEMS);
  assert.equal(a.dropped, 5);
  assert.equal(summarize(a).dropped, 5);
});

test('el resumen cuenta subagentes, en curso, y nombra lo más interno que corre', () => {
  const a = newActivity('t');
  applyEvent(a, tool('ag1', 'Agent', { subagent_type: 'Explore', description: 'uno' }));
  applyEvent(a, tool('ag2', 'Agent', { subagent_type: 'Explore', description: 'dos' }));
  applyEvent(a, tool('r1', 'Read', { file_path: 'x.rs' }, 'ag2'));
  applyEvent(a, { kind: 'task_started', taskId: 'k1', toolUseId: 'ag1', background: true });
  applyEvent(a, { kind: 'task_done', taskId: 'k1', status: 'completed', summary: 'ok' });
  const s = summarize(a);
  assert.equal(s.tools, 3);
  assert.deepEqual(s.agents, { total: 2, running: 1, done: 1 });
  assert.equal(s.current.id, 'r1');
  assert.match(activityLabel(a), /🤖 2 subagentes \(1 en curso\)/);
  assert.match(activityLabel(a), /Read: x\.rs/);
});

test('al morir la sesión, lo que corría se marca, no se queda girando', () => {
  const a = newActivity('t');
  applyEvent(a, tool('ag1', 'Agent', { subagent_type: 'Explore', description: 'x' }));
  applyEvent(a, tool('r1', 'Read', { file_path: 'f' }, 'ag1'));
  applyEvent(a, tool('r2', 'Read', { file_path: 'g' }));
  applyEvent(a, end('r2'));
  const changed = closeAll(a, 'stopped');
  assert.deepEqual(changed.map((i) => i.id), ['ag1', 'r1']);
  assert.equal(findItem(a.items, (i) => i.id === 'r2').status, 'done');
});

test('una tarea de fondo sin herramienta conocida se muestra igualmente', () => {
  const a = newActivity('t');
  applyEvent(a, { kind: 'task_started', taskId: 'w1', toolUseId: null, description: 'workflow spec', background: true, taskType: 'local_workflow' });
  assert.equal(a.items[0].kind, 'background');
  applyEvent(a, { kind: 'task_done', taskId: 'w1', status: 'failed', summary: 'boom' });
  assert.equal(a.items[0].status, 'error');
  assert.equal(a.items[0].output, 'boom');
});

// ---------------------------------------------------------------------------
// Servers, stopping, and how long a wave of subagents still has

test('el puerto se saca del comando: bandera, número suelto de algo que sirve, o URL', () => {
  assert.equal(listeningPort('node serve.js web/dist 18003'), 18003);
  assert.equal(listeningPort('python -u -m http.server 18001'), 18001);
  assert.equal(listeningPort('cargo run --bin hfs -- --port 8080'), 8080);
  assert.equal(listeningPort('curl -s http://127.0.0.1:18002/health'), 18002, 'el número está: quién lo usa lo decide isServerLike');
  assert.equal(listeningPort('node scripts/build.js dist'), null);
  assert.equal(listeningPort('cargo build --release'), null);
  assert.equal(listeningPort('node serve.js dist 80'), null, 'fuera del rango no es un puerto que sigamos');
  assert.equal(listeningPort(null), null);
});

const bg = (command, over = {}) => ({
  id: 'b1', kind: 'bash', background: true, status: 'running', command,
  port: listeningPort(command), startedAt: new Date().toISOString(), ...over,
});

test('es servidor por patrón, y un curl al mismo puerto no lo es', () => {
  assert.equal(isServerLike(bg('node serve.js web/dist 18003')), true);
  assert.equal(isServerLike(bg('python -u -m http.server 18001')), true);
  assert.equal(isServerLike(bg('while true; do sleep 5; done')), true);
  assert.equal(isServerLike(bg('cargo run --bin hfs -- --port 8080')), true);
  assert.equal(isServerLike(bg('curl -s http://127.0.0.1:18002/health')), false, 'pedirle a un puerto no es abrirlo');
  assert.equal(isServerLike(bg('cargo build --release')), false);
  assert.equal(isServerLike(bg('cargo build', { background: false })), false, 'en primer plano nunca');
  assert.equal(isServerLike(bg('node serve.js 18003', { status: 'done' })), false, 'lo terminado tampoco');
  assert.equal(isServerLike(bg('node serve.js 18003', { status: 'stopping' })), true, 'mientras se detiene sigue siéndolo');
});

test('once minutos sin escribir nada es un servidor; dos minutos compilando no', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  const hace = (min) => new Date(now - min * 60000).toISOString();

  const quieto = bg('cargo test -p helios-rest', { startedAt: hace(30), outputChangedAt: hace(11) });
  assert.equal(isServerLike(quieto, now), true);

  const compilando = bg('cargo build --release', { startedAt: hace(9), outputChangedAt: hace(2) });
  assert.equal(isServerLike(compilando, now), false);

  // Sin salida todavía, lo que cuenta es desde que arrancó.
  assert.equal(isServerLike(bg('cargo build', { startedAt: hace(2) }), now), false);
  assert.equal(isServerLike(bg('cargo build', { startedAt: hace(11) }), now), true);
  assert.equal(SERVER_QUIET_MS, 10 * 60 * 1000);

  // Y el curl colgado acaba contando como servidor: es lo honesto de un curl
  // que lleva once minutos sin volver.
  assert.equal(isServerLike(bg('curl http://127.0.0.1:18002/health', { startedAt: hace(11) }), now), true);
});

test('setOutput sólo marca la hora cuando el texto cambió de verdad', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'node serve.js 18003', run_in_background: true }));
  const item = a.items[0];
  assert.equal(item.port, 18003, 'el puerto se guarda al crear el ítem de fondo');

  setOutput(a, 'b1', 'escuchando\n', 1000);
  assert.equal(item.outputChangedAt, new Date(1000).toISOString());
  setOutput(a, 'b1', 'escuchando\n', 99000);
  assert.equal(item.outputChangedAt, new Date(1000).toISOString(), 'releer lo mismo no es un cambio');
  setOutput(a, 'b1', 'escuchando\nGET /\n', 99000);
  assert.equal(item.outputChangedAt, new Date(99000).toISOString());
});

test('markStopping marca la petición, y el final de siempre lo cierra', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'node serve.js 18003', run_in_background: true }));
  applyEvent(a, { kind: 'task_started', taskId: 'bg1', toolUseId: 'b1', background: true });
  const item = markStopping(a, 'b1', 5000);
  assert.equal(item.status, 'stopping');
  assert.equal(item.stopRequestedAt, new Date(5000).toISOString());
  assert.equal(markStopping(a, 'no-existe'), null);

  applyEvent(a, { kind: 'task_done', taskId: 'bg1', toolUseId: 'b1', status: 'stopped', summary: 'terminado' });
  assert.equal(item.status, 'stopped');
  assert.ok(item.endedAt);
  assert.equal(isServerLike(item), false, 'ya no corre');
});

test('un stopping que nadie cerró se cierra al morir la sesión', () => {
  const a = newActivity('t');
  applyEvent(a, tool('b1', 'Bash', { command: 'node serve.js 18003', run_in_background: true }));
  markStopping(a, 'b1');
  assert.deepEqual(closeAll(a, 'stopped').map((i) => i.id), ['b1']);
  assert.equal(a.items[0].status, 'stopped');
});

const T0 = Date.parse('2026-09-14T12:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const agent = (id, status, startMs, endMs = null) => ({
  id, kind: 'agent', name: 'Agent', status, children: [],
  startedAt: at(startMs), ...(endMs === null ? {} : { endedAt: at(endMs) }),
});
const treeOf = (...items) => ({ role: 'activity', id: 'a', items, dropped: 0 });

test('groupProgress: sin ninguno terminado no hay estimación', () => {
  const g = groupProgress(treeOf(agent('a1', 'running', 0), agent('a2', 'running', 0)), T0 + 60000);
  assert.deepEqual(g, { total: 2, done: 0, running: 2, meanMs: null, remainingMs: null });
});

test('groupProgress: con uno terminado la media ya dice cuánto falta al rezagado', () => {
  const tree = treeOf(
    agent('a1', 'done', 0, 600000),              // 10 min
    agent('a2', 'running', 0),                   // lleva 6, le quedarían 4
    agent('a3', 'running', 300000),              // lleva 1, le quedarían 9
  );
  const g = groupProgress(tree, T0 + 360000);
  assert.deepEqual({ total: g.total, done: g.done, running: g.running }, { total: 3, done: 1, running: 2 });
  assert.equal(g.meanMs, 600000);
  assert.equal(g.remainingMs, 540000, 'corren en paralelo: lo que falta es lo del más rezagado, no la suma');
});

test('groupProgress: varios terminados promedian, y nunca se promete menos de un minuto', () => {
  const tree = treeOf(
    agent('a1', 'done', 0, 600000),
    agent('a2', 'error', 0, 1200000),
    agent('a3', 'stopped', 0, 600000),
    agent('a4', 'running', 0),
  );
  const g = groupProgress(tree, T0 + 300000);
  assert.deepEqual({ total: g.total, done: g.done, running: g.running }, { total: 4, done: 3, running: 1 });
  assert.equal(g.meanMs, 800000, 'done, error y stopped cuentan como terminados');
  assert.equal(g.remainingMs, 500000);
  assert.equal(groupProgress(tree, T0 + 3600000).remainingMs, 60000, 'el suelo es un minuto');
});

test('groupProgress: terminado todo el grupo, no queda nada que estimar', () => {
  const tree = treeOf(agent('a1', 'done', 0, 600000), agent('a2', 'done', 0, 400000));
  const g = groupProgress(tree, T0 + 700000);
  assert.deepEqual(g, { total: 2, done: 2, running: 0, meanMs: 500000, remainingMs: null });
  assert.deepEqual(groupProgress(newActivity('t')), { total: 0, done: 0, running: 0, meanMs: null, remainingMs: null });
});

test('Artifact: el resumen lleva la acción y el título o la ruta', () => {
  assert.equal(summarizeToolInput({ name: 'Artifact', input: { action: 'list', scope: 'mine' } }), 'list');
  assert.equal(summarizeToolInput({ name: 'Artifact', input: { file_path: 'a/b.html', title: 'Mi lienzo' } }), 'publish: Mi lienzo');
  assert.equal(summarizeToolInput({ name: 'Artifact', input: { action: 'publish', file_path: 'a/b.html' } }), 'publish: a/b.html');
  assert.equal(summarizeToolInput({ name: 'ArtifactData', input: { action: 'read' } }), 'read');
});

test('artifactLinks: solo https de claude.ai, sin repetir, con tope y sin puntuación final', () => {
  const text = 'ok https://claude.ai/artifacts/a1. y (https://x.claude.ai/p/2) http://claude.ai/no https://evil.com/x https://claude.ai/artifacts/a1';
  assert.deepEqual(artifactLinks(text), ['https://claude.ai/artifacts/a1', 'https://x.claude.ai/p/2']);
  assert.deepEqual(artifactLinks('https://notclaude.ai/x https://claude.ai.evil.com/x'), []);
  const many = Array.from({ length: 50 }, (_, i) => `https://claude.ai/a/${i}`).join(' ');
  assert.equal(artifactLinks(many).length, 10);
  assert.deepEqual(artifactLinks(null), []);
});

test('Artifact: tool_end guarda item.links sacados de la salida completa, antes del recorte', () => {
  const a = newActivity('t');
  applyEvent(a, tool('x1', 'Artifact', { action: 'publish' }));
  const long = `publicado https://claude.ai/artifacts/z9
${'x'.repeat(MAX_OUTPUT + 100)}`;
  applyEvent(a, end('x1', { output: long }));
  assert.deepEqual(a.items[0].links, ['https://claude.ai/artifacts/z9']);
  assert.ok(!a.items[0].output.includes('artifacts/z9'), 'el recorte pierde la URL; los enlaces no');
  applyEvent(a, tool('r1', 'Read', { file_path: 'x' }));
  applyEvent(a, end('r1', { output: 'https://claude.ai/a/1' }));
  assert.equal('links' in a.items[1], false);
  applyEvent(a, tool('x2', 'Artifact', { action: 'list' }));
  applyEvent(a, end('x2', { output: 'nada' }));
  assert.equal('links' in a.items[2], false);
});
