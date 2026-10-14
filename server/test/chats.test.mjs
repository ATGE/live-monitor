import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';
import {
  migrateChats, resetChatsOnBoot, principalChat, chatById, addChatTo, removeChat,
  isChatBusy, busySiblings, titleFromPrompt, newChatId, PRINCIPAL_TITLE, makeChat, chatRunning,
} from '../src/chats.js';

// `chatHooks` lives in pipeline.js; importing it drags the store in, so the
// data directory is redirected before anything loads — same as pending.test.mjs.
process.env.HFSMON_DATA_DIR = tempDir('hfsmon-chats-');
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
before(async () => { pipeline = await import('../src/pipeline.js'); });

const viejo = (over = {}) => ({
  issue: 900,
  chat: [{ role: 'user', text: 'hola', ts: '2026-09-01T10:00:00.000Z' }],
  sessionId: 'sesion-vieja',
  chatModel: 'claude-opus-5',
  chatBusy: true,
  chatQueued: 3,
  chatActivity: 'Bash: algo que se quedó a medias',
  ...over,
});

test('la conversación de siempre pasa a ser el chat principal', () => {
  const t = migrateChats(viejo());
  assert.equal(t.chats.length, 1);
  const p = principalChat(t);
  assert.equal(p.title, PRINCIPAL_TITLE);
  assert.equal(p.sessionId, 'sesion-vieja', 'la sesión se conserva: el fix sigue reanudándola');
  assert.equal(p.model, 'claude-opus-5');
  assert.deepEqual(p.messages.map((m) => m.text), ['hola']);
});

test('los campos viejos desaparecen, para que nadie los lea a medias', () => {
  const t = migrateChats(viejo());
  for (const campo of ['chat', 'sessionId', 'chatModel', 'chatBusy', 'chatQueued', 'chatActivity']) {
    assert.equal(campo in t, false, `${campo} debería haberse ido`);
  }
});

test('el historial se copia, no se comparte', () => {
  const t = viejo();
  const original = t.chat;
  migrateChats(t);
  principalChat(t).messages.push({ role: 'user', text: 'nuevo' });
  assert.equal(original.length, 1, 'tocar el chat nuevo no puede escribir en el array viejo');
});

test('migrar es idempotente: se ejecuta en cada arranque', () => {
  const t = migrateChats(viejo());
  principalChat(t).messages.push({ role: 'assistant', text: 'respuesta' });
  const otraVez = migrateChats(t);
  assert.equal(otraVez.chats.length, 1);
  assert.equal(principalChat(otraVez).messages.length, 2, 'no re-inyecta el historial viejo');
});

test('una tarea sin nada estrena un principal vacío', () => {
  const t = migrateChats({ issue: 1 });
  assert.equal(t.chats.length, 1);
  assert.deepEqual(principalChat(t).messages, []);
  assert.equal(principalChat(t).sessionId, null);
});

test('el arranque apaga lo que quedó encendido, pero recuerda lo que cada chat vio', () => {
  const t = migrateChats(viejo());
  const otro = addChatTo(t, { title: 'contadores' });
  otro.busy = true;
  otro.activity = 'Edit: main.rs';
  otro.lastSeenSha = 'abc1234';

  resetChatsOnBoot(t);
  assert.equal(isChatBusy(t), false, 'tras un reinicio no hay nada corriendo, diga lo que diga el archivo');
  assert.equal(otro.activity, null);
  assert.equal(otro.lastSeenSha, 'abc1234', 'lo que había visto sigue siendo verdad');
});

test('se busca por id, y sin id contesta el principal', () => {
  const t = migrateChats(viejo());
  const otro = addChatTo(t, { title: 'lease' });
  assert.equal(chatById(t, otro.id).title, 'lease');
  assert.equal(chatById(t, null).title, PRINCIPAL_TITLE);
  assert.equal(chatById(t, 'no-existe'), null);
});

test('el principal no se puede borrar; los demás sólo una vez cerrados', async () => {
  const { closeChatOf } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const otro = addChatTo(t, { title: 'temporal' });
  assert.equal(removeChat(t, principalChat(t).id), false, 'el board conversa por él');
  assert.equal(removeChat(t, otro.id), false, 'abierto: borrar es irreversible y pasa por cerrar');
  assert.equal(closeChatOf(t, otro.id), null);
  assert.equal(removeChat(t, otro.id), true);
  assert.equal(removeChat(t, 'no-existe'), false);
  assert.equal(t.chats.length, 1);
});

test('cerrar conserva la conversación entera y sólo quita la pestaña', async () => {
  const { closeChatOf, reopenChatOf, openChats, closedChats } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const otro = addChatTo(t, { title: 'lease', sessionId: 'ses-2' });
  otro.messages.push({ role: 'user', text: 'algo' });

  assert.equal(closeChatOf(t, otro.id), null);
  assert.ok(otro.closedAt);
  assert.equal(otro.sessionId, 'ses-2', 'la sesión sigue: reabrir es continuar');
  assert.equal(otro.messages.length, 1);
  assert.deepEqual(openChats(t).map((c) => c.title), [PRINCIPAL_TITLE]);
  assert.deepEqual(closedChats(t).map((c) => c.title), ['lease']);
  assert.equal(chatById(t, otro.id), otro, 'sigue siendo alcanzable por id');

  assert.equal(reopenChatOf(t, otro.id), null);
  assert.equal(otro.closedAt, null);
  assert.deepEqual(openChats(t).map((c) => c.title), [PRINCIPAL_TITLE, 'lease']);
});

test('no se cierra el principal ni un chat trabajando, y dice por qué', async () => {
  const { closeChatOf } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  assert.match(closeChatOf(t, principalChat(t).id), /principal/);
  const otro = addChatTo(t, { title: 'ocupado' });
  otro.busy = true;
  assert.match(closeChatOf(t, otro.id), /deténlo/);
  assert.equal(otro.closedAt, null);
  assert.match(closeChatOf(t, 'no-existe'), /no existe/);
});

test('el historial va del más reciente al más antiguo, y los cerrados no cuentan como hermanos', async () => {
  const { closeChatOf, closedChats } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const a = addChatTo(t, { title: 'a' });
  const b = addChatTo(t, { title: 'b' });
  closeChatOf(t, a.id, new Date('2026-09-10T10:00:00Z'));
  closeChatOf(t, b.id, new Date('2026-09-10T11:00:00Z'));
  assert.deepEqual(closedChats(t).map((c) => c.title), ['b', 'a']);
  a.busy = true;   // stale flag on a closed chat must not leak into a briefing
  assert.deepEqual(busySiblings(t, principalChat(t).id), []);
});

test('ocupado es de cada chat, y los hermanos se ven entre ellos', () => {
  const t = migrateChats(viejo());
  const a = principalChat(t);
  const b = addChatTo(t, { title: 'b' });
  const c = addChatTo(t, { title: 'c' });

  assert.equal(isChatBusy(t), false);
  b.busy = true;
  c.busy = true;
  assert.equal(isChatBusy(t), true);
  assert.deepEqual(busySiblings(t, b.id).map((x) => x.title), ['c'], 'b no se cuenta a sí mismo');
  assert.deepEqual(busySiblings(t, a.id).map((x) => x.title), ['b', 'c']);
});

test('el título sale de lo primero que pediste', () => {
  assert.equal(titleFromPrompt('arregla el contador de progreso'), 'arregla el contador de progreso');
  assert.equal(titleFromPrompt('   \n\n  revisa el lease  \n más cosas'), 'revisa el lease');
  assert.equal(
    titleFromPrompt('a'.repeat(60)),
    `${'a'.repeat(37)}…`,
    'se recorta para caber en una pestaña',
  );
  assert.equal(titleFromPrompt(''), 'Untitled');
  assert.equal(titleFromPrompt('   '), 'Untitled');
});

test('los ids no se repiten ni dentro del mismo milisegundo', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newChatId()));
  assert.equal(ids.size, 500);
});

// --- lo que un chat le cuenta a los otros -------------------------------

test('sin novedades no se le mete ruido al prompt', async () => {
  const { renderSiblings } = await import('../src/chats.js');
  assert.equal(renderSiblings({}), '', 'un aviso vacío no debe ocupar sitio en el prompt');
  assert.equal(renderSiblings({ busy: [], commits: [], files: [] }), '');
});

test('el aviso nombra los archivos y pide releerlos', async () => {
  const { renderSiblings } = await import('../src/chats.js');
  const texto = renderSiblings({
    me: 'lease',
    commits: ['a1b2c3d arregla el contador'],
    files: ['crates/rest/src/config.rs'],
  });
  assert.match(texto, /1 commit/);
  assert.match(texto, /crates\/rest\/src\/config\.rs/, 'la ruta exacta es lo que sirve');
  assert.match(texto, /Read/, 'y la orden de releer, que es lo único que corrige el contexto viejo');
  assert.match(texto, /«lease»/);
});

test('el aviso recorta listas largas en vez de inundar el contexto', async () => {
  const { renderSiblings } = await import('../src/chats.js');
  const texto = renderSiblings({
    commits: Array.from({ length: 30 }, (_, i) => `sha${i} commit ${i}`),
    files: Array.from({ length: 50 }, (_, i) => `archivo-${i}.rs`),
  });
  assert.match(texto, /y 22 más/, 'commits recortados a 8');
  assert.match(texto, /y 30 más/, 'archivos recortados a 20');
});

test('dice quién está trabajando ahora mismo', async () => {
  const { renderSiblings } = await import('../src/chats.js');
  const texto = renderSiblings({ busy: [{ title: 'contadores' }, { title: 'lease' }] });
  assert.match(texto, /«contadores», «lease»/);
  assert.match(texto, /mismo worktree/);
});

test('lo que uno hace se le encola a los demás, no a sí mismo', async () => {
  const { tellSiblings, drainNews } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const a = principalChat(t);
  const b = addChatTo(t, { title: 'b' });
  const c = addChatTo(t, { title: 'c' });

  tellSiblings(t, a.id, 'a commiteó algo');
  assert.equal(drainNews(a), '', 'el autor no se cuenta a sí mismo');
  assert.equal(drainNews(b), 'a commiteó algo');
  assert.equal(drainNews(c), 'a commiteó algo');
});

test('las novedades se entregan una sola vez', async () => {
  const { tellSiblings, drainNews } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const b = addChatTo(t, { title: 'b' });

  tellSiblings(t, principalChat(t).id, 'primera');
  tellSiblings(t, principalChat(t).id, 'segunda');
  assert.equal(drainNews(b), 'primera\nsegunda', 'llegan juntas');
  assert.equal(drainNews(b), '', 'y no se repiten en la siguiente herramienta');
});

test('lo que escribes a mitad de turno espera su hueco, con el id de su burbuja', async () => {
  const { leaveNote, drainNotes } = await import('../src/chats.js');
  const t = migrateChats(viejo());
  const chat = principalChat(t);

  assert.deepEqual(drainNotes(chat), [], 'sin notas, nada');
  leaveNote(chat, '¿cómo vas?', 'm1');
  leaveNote(chat, 'mira esto', 'm2', [{ path: 'C:/x.png' }]);
  const notas = drainNotes(chat);
  assert.deepEqual(notas.map((n) => [n.text, n.messageId]), [['¿cómo vas?', 'm1'], ['mira esto', 'm2']]);
  assert.deepEqual(notas[1].attachments, [{ path: 'C:/x.png' }]);
  assert.deepEqual(drainNotes(chat), [], 'entregadas una sola vez');
});

test('el arranque conserva las notas y apaga lo que quedó girando en los árboles', () => {
  const t = migrateChats(viejo());
  const chat = principalChat(t);
  chat.notes = [{ text: 'no se pierde', messageId: 'm9' }];
  chat.messages.push({
    id: 'a1', role: 'activity', items: [
      { id: 'x', kind: 'agent', status: 'running', children: [{ id: 'y', kind: 'tool', status: 'running' }] },
      { id: 'z', kind: 'tool', status: 'done', endedAt: '2026-09-10T10:00:00.000Z' },
    ],
  });
  resetChatsOnBoot(t);
  assert.deepEqual(chat.notes, [{ text: 'no se pierde', messageId: 'm9' }], 'lo escrito para el chat sale con el siguiente prompt');
  const [agent, done] = chat.messages.at(-1).items;
  assert.equal(agent.status, 'stopped');
  assert.equal(agent.children[0].status, 'stopped');
  assert.ok(agent.endedAt);
  assert.equal(done.status, 'done', 'lo terminado no se toca');
});

// ---------------------------------------------------------------------------
// Plan mode fields, and what a restart does to a pending question or a running plan

test('un chat nace sin modo plan ni nada pendiente, y uno guardado antes recibe esos campos', () => {
  const fresh = makeChat();
  assert.deepEqual({ planMode: fresh.planMode, pending: fresh.pending, plan: fresh.plan }, { planMode: false, pending: null, plan: null });
  const t = { chats: [{ id: 'c1', title: 'Principal', messages: [] }] };
  migrateChats(t);
  assert.deepEqual({ planMode: t.chats[0].planMode, pending: t.chats[0].pending, plan: t.chats[0].plan }, { planMode: false, pending: null, plan: null });
  migrateChats(t);
  assert.equal(t.chats.length, 1, 'idempotente');
});

test('el arranque caduca la pregunta pendiente, detiene el plan que corría y conserva el modo plan', () => {
  const t = migrateChats(viejo());
  const chat = principalChat(t);
  chat.planMode = true;
  chat.pending = { id: 'q1', kind: 'question', source: 'claude', askedAt: 'x', messageId: 'mq' };
  chat.messages.push({ id: 'mq', role: 'question', status: 'pending', questions: [] });
  chat.messages.push({ id: 'mp', role: 'plan', status: 'approved', plan: '' });
  chat.plan = { status: 'running', tasks: [{ id: 't1', status: 'done' }, { id: 't2', status: 'running' }, { id: 't3', status: 'asking' }, { id: 't4', status: 'pending' }] };
  resetChatsOnBoot(t);
  assert.equal(chat.pending, null);
  assert.equal(chat.messages.find((m) => m.id === 'mq').status, 'expired');
  assert.equal(chat.messages.find((m) => m.id === 'mp').status, 'approved', 'lo ya decidido no se toca');
  assert.deepEqual(chat.plan.tasks.map((x) => x.status), ['done', 'stopped', 'stopped', 'pending']);
  assert.equal(chat.plan.status, 'stopped');
  assert.equal(chat.planMode, true, 'la preferencia sobrevive');
});

// ---------------------------------------------------------------------------
// What is moving in a chat right now

const AHORA = Date.parse('2026-09-14T12:00:00.000Z');
const cuando = (ms) => new Date(AHORA + ms).toISOString();
const subagente = (id, status, startMs, endMs = null) => ({
  id, kind: 'agent', name: 'Agent', status, children: [],
  startedAt: cuando(startMs), ...(endMs === null ? {} : { endedAt: cuando(endMs) }),
});
const fondo = (id, command, over = {}) => ({
  id, kind: 'bash', name: 'Bash', command, background: true, status: 'running',
  port: null, startedAt: cuando(-60000), ...over,
});
const arbol = (id, items) => ({ role: 'activity', id, ts: cuando(-3600000), items, dropped: 0 });

test('chatRunning no cuenta el grupo de ayer, y separa servidores de comandos', () => {
  const chat = makeChat();
  chat.messages = [
    { role: 'user', text: 'hola' },
    // Ayer: doce subagentes, todos terminados. No infla nada.
    arbol('viejo', [
      subagente('v1', 'done', -86400000, -86000000),
      subagente('v2', 'done', -86400000, -86000000),
      fondo('vb', 'cargo build', { status: 'done' }),
    ]),
    arbol('vivo', [
      subagente('a1', 'done', -600000, -300000),   // 5 min
      subagente('a2', 'running', -120000),         // lleva 2, le quedan 3
      subagente('a3', 'running', -60000),          // lleva 1, le quedan 4
      fondo('b1', 'node serve.js web/dist 18003', { port: 18003 }),
      fondo('b2', 'python -u -m http.server 18001', { port: 18001 }),
      fondo('b3', 'cargo test -p helios-rest --release'),
    ]),
  ];

  const r = chatRunning(chat, AHORA);
  assert.deepEqual(r.agents, { total: 3, done: 1, running: 2 }, 'sólo cuenta el grupo que sigue vivo');
  assert.equal(r.servers, 2);
  assert.equal(r.commands, 1, 'el cargo test es finito: lleva spinner, no botón de parada');
  assert.equal(r.estimateMs, 240000, 'lo que falta es lo del subagente más rezagado');
});

test('chatRunning devuelve null cuando no se mueve nada', () => {
  const chat = makeChat();
  assert.equal(chatRunning(chat, AHORA), null, 'un chat recién nacido');
  chat.messages = [
    { role: 'user', text: 'hola' },
    arbol('viejo', [subagente('v1', 'done', -86400000, -86000000), fondo('vb', 'cargo build', { status: 'done' })]),
  ];
  assert.equal(chatRunning(chat, AHORA), null, 'todo terminado no es nada moviéndose');
});

test('chatRunning sin subagentes terminados no promete una hora', () => {
  const chat = makeChat();
  chat.messages = [arbol('vivo', [subagente('a1', 'running', -60000), fondo('b1', 'node serve.js 18003', { port: 18003 })])];
  const r = chatRunning(chat, AHORA);
  assert.deepEqual(r, { agents: { total: 1, done: 0, running: 1 }, commands: 0, servers: 1, estimateMs: null });
});

// ---------------------------------------------------------------------------
// El id de cada delegate, visto por la hook y guardado para la tool

test('la hook aparca el tool_use_id de cada delegate, incluso dentro de un subagente', async () => {
  const chat = makeChat();
  const task = { issue: 1, chats: [chat] };
  const live = { opencodeCalls: [] };
  const hook = pipeline.chatHooks(task, chat, live).PreToolUse[0].hooks[0];

  assert.deepEqual(await hook({ tool_name: 'mcp__opencode__delegate', tool_use_id: 'toolu_1', tool_input: { task: 'x' } }), {});
  assert.deepEqual(live.opencodeCalls, [{ id: 'toolu_1', task: 'x' }]);

  // Un delegate lanzado desde un subagente no recibe avisos, pero su id hace
  // igual de falta: es lo único que cuelga sus eventos del sitio correcto.
  await hook({ tool_name: 'mcp__opencode__delegate', tool_use_id: 'toolu_2', tool_input: { task: 'y' }, agent_id: 'a1' });
  assert.deepEqual(live.opencodeCalls.map((c) => c.id), ['toolu_1', 'toolu_2']);

  await hook({ tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: {} });
  assert.equal(live.opencodeCalls.length, 2, 'cualquier otra herramienta no aparca nada');
});

// Un id aparcado cuyo handler nunca corrió (el esquema rechazó los argumentos,
// el turno se cortó) lo reclamaría el siguiente delegate con el mismo texto, y
// sus eventos colgarían de una tool de otro turno.
test('al terminar el turno no queda ningún id de delegate aparcado', () => {
  const live = { opencodeCalls: [{ id: 'toolu_1', task: 'x' }, { id: 'toolu_2', task: 'x' }] };
  pipeline.forgetOpencodeCalls(live);
  assert.deepEqual(live.opencodeCalls, []);
  assert.doesNotThrow(() => pipeline.forgetOpencodeCalls({}), 'un live sin la lista tampoco rompe');
});

test('chatRunning cuenta también lo que cuelga de un subagente, y lo que se está deteniendo', () => {
  const chat = makeChat();
  chat.messages = [arbol('vivo', [
    { ...subagente('a1', 'running', -60000), children: [fondo('b1', 'node serve.js 18003', { port: 18003 })] },
    fondo('b2', 'cargo build', { status: 'stopping' }),
  ])];
  const r = chatRunning(chat, AHORA);
  assert.equal(r.servers, 1, 'el servidor que arrancó un subagente sigue siendo un servidor');
  assert.equal(r.commands, 1, 'pedirle que pare no es que haya parado');
});
