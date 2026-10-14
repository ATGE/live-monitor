import './isolate.mjs';   // primero: opencode.js llega a claude.js, y de ahí al directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OPENCODE_SANDBOXES, DEFAULT_SANDBOX, MAX_TASK_CHARS, MAX_OUTPUT_CHARS,
  buildOpencodeArgs, opencodePermissionConfig, parseOpencodeOutput,
  describeOpencodeFailure, truncateOutput, runOpencode,
  opencodeDelegateTool, opencodeMcpServers,
  harnessEnv, harnessTools, summarizeHarness, runOpencodeHarness,
} from '../src/opencode.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// A stand-in for `Machine` (server/src/machine.js): records every call instead
// of touching a real binary or a real disk, so this whole suite runs offline
// and needs neither `opencode` installed nor an OpenCode account.
function fakeMachine({ exec, exists = false } = {}) {
  const calls = { exec: [], fs: [] };
  return {
    calls,
    path: path.posix,
    exec: async (file, args, opts) => {
      calls.exec.push({ file, args, opts });
      if (typeof exec === 'function') return exec(opts);
      return exec ?? { ok: true, code: 0, stdout: '', stderr: '' };
    },
    zenProxyPort: async () => 4321,
    fs: {
      exists: async (p) => { calls.fs.push({ op: 'exists', p }); return exists; },
      mkdir: async (p) => { calls.fs.push({ op: 'mkdir', p }); },
      writeFile: async (p, data) => { calls.fs.push({ op: 'writeFile', p, data }); },
    },
  };
}

// ---------------------------------------------------------------------------
// buildOpencodeArgs

test('sin modelo, omite --model; el task va al final', () => {
  const r = buildOpencodeArgs({ task: 'revisa este diff' });
  assert.ok(r.ok, r.problem);
  assert.deepEqual(r.args, ['run', '--format', 'json', '--auto', '--print-logs', '--log-level', 'ERROR', 'revisa este diff']);
});

test('con modelo, --model va antes de --format/--auto', () => {
  const r = buildOpencodeArgs({ task: 'x', model: 'anthropic/claude-sonnet-5' });
  assert.deepEqual(r.args, ['run', '--model', 'anthropic/claude-sonnet-5', '--format', 'json', '--auto', '--print-logs', '--log-level', 'ERROR', 'x']);
});

test('con variante, --variant va tras --model; sin ella no aparece', () => {
  const r = buildOpencodeArgs({ task: 'x', model: 'opencode-go/muse-spark-1.3-contributor', variant: 'xhigh' });
  assert.deepEqual(r.args.slice(0, 5), ['run', '--model', 'opencode-go/muse-spark-1.3-contributor', '--variant', 'xhigh']);
  assert.equal(r.args.at(-1), 'x');
  assert.equal(buildOpencodeArgs({ task: 'x', model: 'm' }).args.includes('--variant'), false);
});

test('la variante llega desde la tool hasta los args de opencode run', async () => {
  const machine = fakeMachine({ exec: () => ({ ok: true, code: 0, stdout: JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }), stderr: '' }) });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x', model: 'm', variant: 'xhigh' });
  const res = await def.handler({ task: 'algo' }, {});
  assert.notEqual(res.isError, true);
  const { args } = machine.calls.exec[0];
  assert.equal(args[args.indexOf('--variant') + 1], 'xhigh');
});

test('pide los logs de error a stderr (única señal del límite de uso) y el task sigue al final', () => {
  const { args } = buildOpencodeArgs({ task: 'la tarea', model: 'opencode-go/grok-4.7' });
  const i = args.indexOf('--print-logs');
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i + 1, i + 3), ['--log-level', 'ERROR']);
  assert.equal(args.at(-1), 'la tarea');
});

test('una tarea vacía o demasiado larga no llega a armar args', () => {
  assert.equal(buildOpencodeArgs({ task: '' }).ok, false);
  assert.equal(buildOpencodeArgs({ task: '   ' }).ok, false);
  assert.equal(buildOpencodeArgs({ task: 'x'.repeat(MAX_TASK_CHARS + 1) }).ok, false);
});

// ---------------------------------------------------------------------------
// opencodePermissionConfig

test('read-only niega edit y bash; workspace-write los permite y sigue negando red/directorios externos', () => {
  const ro = JSON.parse(opencodePermissionConfig('read-only'));
  assert.equal(ro.permission.edit, 'deny');
  assert.equal(ro.permission.bash, 'deny');

  const ww = JSON.parse(opencodePermissionConfig('workspace-write'));
  assert.equal(ww.permission.edit, 'allow');
  assert.equal(ww.permission.bash, 'allow');
  assert.equal(ww.permission.webfetch, 'deny');
  assert.equal(ww.permission.websearch, 'deny');
  assert.equal(ww.permission.external_directory, 'deny');
});

// ---------------------------------------------------------------------------
// parseOpencodeOutput

// A real `opencode run --model opencode-go/grok-4.7 --format json --auto`
// reply, captured 2026-09-22 against CLI 1.18.31. The shape the code had
// guessed before this (`agent_message`) never occurs in practice — every
// part of every step comes as `{ type: 'text', part: { type: 'text', text } }`.
test('con una transcripción real de opencode run, saca el texto de la parte `text`', () => {
  const stdout = readFileSync(path.join(FIXTURES, 'opencode-run-real.jsonl'), 'utf8');
  assert.equal(parseOpencodeOutput(stdout).text, 'listo');
});

test('con dos partes de texto, gana la última', () => {
  const stdout = [
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'primero' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'segundo' } }),
  ].join('\n');
  assert.equal(parseOpencodeOutput(stdout).text, 'segundo');
});

test('formas más viejas/adivinadas siguen reconociéndose como respaldo', () => {
  const stdout = '{"type":"other"}\n{"type":"agent_message","message":"listo"}\n';
  assert.equal(parseOpencodeOutput(stdout).text, 'listo');
});

test('la forma envuelta {msg:{type:agent_message}} también se reconoce', () => {
  const stdout = JSON.stringify({ id: 1, msg: { type: 'agent_message', text: 'envuelto' } });
  assert.equal(parseOpencodeOutput(stdout).text, 'envuelto');
});

test('líneas basura intercaladas con JSON se ignoran, el evento manda', () => {
  const stdout = 'esto no es json\n{"type":"agent_message","message":"real"}\nni esto';
  assert.equal(parseOpencodeOutput(stdout).text, 'real');
});

test('stdout sin ningún JSON se devuelve tal cual', () => {
  assert.equal(parseOpencodeOutput('solo texto plano').text, 'solo texto plano');
});

test('entrada vacía da texto vacío y ningún evento', () => {
  const r = parseOpencodeOutput('');
  assert.equal(r.text, '');
  assert.deepEqual(r.events, []);
});

test('una línea que empieza por { pero no parsea no lanza, cae al texto plano', () => {
  assert.doesNotThrow(() => parseOpencodeOutput('{roto'));
  assert.equal(parseOpencodeOutput('{roto').text, '{roto');
});

// ---------------------------------------------------------------------------
// describeOpencodeFailure

test('cada condición conocida da un mensaje reconocible', () => {
  assert.match(describeOpencodeFailure({ bin: 'opencode', code: -1, stderr: 'spawn opencode ENOENT' }), /no está instalado/);
  assert.match(describeOpencodeFailure({ bin: 'opencode', code: -2, timeoutMs: 30 * 60_000 }), /30 minutos/);
  assert.match(describeOpencodeFailure({ bin: 'opencode', code: 1, stderr: 'Error: not logged in' }), /opencode auth login/);
  assert.match(describeOpencodeFailure({ bin: 'opencode', code: 2, stderr: 'boom' }), /código 2/);
  assert.match(describeOpencodeFailure({ bin: 'opencode', code: -3, stderr: 'cortado' }), /sin conexión/);
});

// ---------------------------------------------------------------------------
// truncateOutput

test('una respuesta larga queda por debajo del máximo, conservando la cola', () => {
  const long = 'a'.repeat(1000) + 'CONCLUSION';
  const out = truncateOutput(long, 50);
  assert.ok(out.length <= 50 + 60);
  assert.ok(out.endsWith('CONCLUSION'));
});

test('una respuesta corta no se toca', () => {
  assert.equal(truncateOutput('corto', 50), 'corto');
});

// ---------------------------------------------------------------------------
// runOpencode

test('con opencode.json ya en el worktree y sandbox read-only, no se ejecuta nada', async () => {
  const machine = fakeMachine({ exists: true });
  const r = await runOpencode({ machine, cwd: '/wt/issue-42', configDir: '/scratch/42', task: 'lee el código', sandbox: 'read-only' });
  assert.equal(r.ok, false);
  assert.match(r.error, /opencode\.json/);
  assert.equal(machine.calls.exec.length, 0);
});

test('sin opencode.json de proyecto, escribe el preset correcto y lo apunta con OPENCODE_CONFIG', async () => {
  const machine = fakeMachine({
    exists: false,
    exec: () => ({ ok: true, code: 0, stdout: JSON.stringify({ type: 'agent_message', message: 'hecho' }), stderr: '' }),
  });
  const r = await runOpencode({
    machine, cwd: '/wt/issue-42', configDir: '/scratch/42', task: 'revisa esto',
    sandbox: 'workspace-write', timeoutMs: 45_000,
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.text, 'hecho');

  const written = machine.calls.fs.find((c) => c.op === 'writeFile');
  assert.equal(written.p, '/scratch/42/opencode-workspace-write.json');
  assert.equal(JSON.parse(written.data).permission.edit, 'allow');

  const call = machine.calls.exec[0];
  assert.equal(call.file, 'opencode');
  assert.equal(call.opts.cwd, '/wt/issue-42');
  assert.equal(call.opts.timeoutMs, 45_000);
  assert.equal(call.opts.env.OPENCODE_CONFIG, '/scratch/42/opencode-workspace-write.json');
  assert.equal(call.opts.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS, '45000');
});

test('una conexión cortada con el runner (código -3) se describe como tal, con la causa', async () => {
  const machine = fakeMachine({
    exec: () => ({ ok: false, code: -3, stdout: '', stderr: 'devbox: la conexión con el runner se cortó a mitad del comando tras 306 s (UND_ERR_BODY_TIMEOUT)' }),
  });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /sin conexión/);
  assert.match(r.error, /UND_ERR_BODY_TIMEOUT/);
});

test('un fallo con código no-cero no lanza: vuelve como { ok:false }', async () => {
  const machine = fakeMachine({ exec: () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }) });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /código 1/);
});

test('si machine.exec lanza (el runner inalcanzable), tampoco lanza fuera de runOpencode', async () => {
  const machine = fakeMachine({ exec: () => { throw new Error('runner unreachable'); } });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /runner unreachable/);
});

test('salida en código 0 sin mensaje final es un fallo, no un éxito silencioso', async () => {
  const machine = fakeMachine({ exec: () => ({ ok: true, code: 0, stdout: '', stderr: '' }) });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /without saying anything/);
});

// The real stderr line from `--print-logs --log-level ERROR` (2026-09-22, OpenCode Go plan).
const LIMIT_LINE = 'timestamp=2026-09-22T13:28:46.754Z level=ERROR run=3ec61152 message="stream error" '
  + 'providerID=opencode-go modelID=grok-4.7 session.id=ses_x small=false agent=build mode=primary '
  + 'error.error="AI_APICallError: Go usage limit exceeded"';

// A fake exec that emits the limit line, then hangs like OpenCode does until the
// signal aborts — failing loudly if nobody aborts it within 2 s.
function limitExec({ reject = false } = {}) {
  return (opts) => new Promise((resolve, rejectP) => {
    const safety = setTimeout(() => rejectP(new Error('TEST: signal never aborted')), 2000);
    opts.signal.addEventListener('abort', () => {
      clearTimeout(safety);
      if (reject) {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        rejectP(e);
      } else {
        resolve({ ok: false, code: -3, stdout: '', stderr: '' });
      }
    });
    opts.onLine(LIMIT_LINE);
  });
}

test('el límite de uso en stderr aborta el comando y se describe como tal, no como conexión cortada', async () => {
  const machine = fakeMachine({ exec: limitExec() });
  const seen = [];
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo', onLine: (l) => seen.push(l) });
  assert.equal(r.ok, false);
  assert.match(r.error, /usage limit/);
  assert.doesNotMatch(r.error, /sin conexión/);
  assert.equal(r.code, -3);
  assert.equal(machine.calls.exec[0].opts.signal.aborted, true);
  assert.deepEqual(seen, [LIMIT_LINE]);
});

test('si exec rechaza con AbortError tras el límite, runOpencode devuelve el mismo mensaje sin rechazar', async () => {
  const machine = fakeMachine({ exec: limitExec({ reject: true }) });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /usage limit/);
  assert.equal(r.code, null);
});

test('la frase dentro de un evento JSON (texto de la tarea, un archivo leído) no aborta nada', async () => {
  const quoted = JSON.stringify({ type: 'text', part: { type: 'text', text: 'handles "AI_APICallError: Go usage limit exceeded" level=ERROR' } });
  const machine = fakeMachine({
    exec: (opts) => {
      opts.onLine(quoted);
      return { ok: true, code: 0, stdout: quoted, stderr: '' };
    },
  });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.ok(r.ok, r.error);
  assert.equal(machine.calls.exec[0].opts.signal.aborted, false);
});

test('una ejecución normal recibe la señal pero nunca la aborta', async () => {
  const machine = fakeMachine({
    exec: (opts) => {
      opts.onLine('{"type":"text","part":{"type":"text","text":"hola"}}');
      return { ok: true, code: 0, stdout: JSON.stringify({ type: 'text', part: { type: 'text', text: 'hola' } }), stderr: '' };
    },
  });
  const r = await runOpencode({ machine, cwd: '/wt/x', configDir: '/scratch/x', task: 'algo' });
  assert.ok(r.ok, r.error);
  const { signal } = machine.calls.exec[0].opts;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

// ---------------------------------------------------------------------------
// La tool / el servidor MCP

test('opencodeMcpServers da la clave opencode con una instancia', () => {
  const machine = fakeMachine();
  const servers = opencodeMcpServers({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  assert.ok(servers.opencode);
  assert.equal(servers.opencode.type, 'sdk');
  assert.equal(servers.opencode.name, 'opencode');
  assert.ok(servers.opencode.instance);
});

test('el esquema de entrada de la tool es exactamente task y sandbox', () => {
  const machine = fakeMachine();
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  assert.equal(def.name, 'delegate');
  assert.ok(def.description.length > 0);
  assert.deepEqual(Object.keys(def.inputSchema).sort(), ['sandbox', 'task']);
});

test('el schema de sandbox solo acepta los dos valores del enum', () => {
  const machine = fakeMachine();
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  for (const value of OPENCODE_SANDBOXES) {
    assert.equal(def.inputSchema.sandbox.parse(value), value);
  }
  assert.throws(() => def.inputSchema.sandbox.parse('danger-full-access'));
});

test('handler sin sandbox usa read-only por defecto, aunque zod no aplique el default a mano', async () => {
  const machine = fakeMachine({
    exists: false,
    exec: () => ({ ok: true, code: 0, stdout: JSON.stringify({ type: 'agent_message', message: 'ok' }), stderr: '' }),
  });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  const result = await def.handler({ task: 'algo' }, {});
  assert.notEqual(result.isError, true);
  const written = machine.calls.fs.find((c) => c.op === 'writeFile');
  assert.match(written.p, /opencode-read-only\.json$/);
  assert.equal(result.content[0].text, 'ok');
});

test('handler con una máquina que falla resuelve con isError, nunca lanza', async () => {
  const machine = fakeMachine({ exists: false, exec: () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }) });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  const result = await def.handler({ task: 'algo' }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /código 1/);
});

test('handler con una máquina que lanza también resuelve con isError, no rechaza la promesa', async () => {
  const machine = fakeMachine({ exists: false, exec: () => { throw new Error('roto'); } });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  await assert.doesNotReject(async () => {
    const result = await def.handler({ task: 'algo' }, {});
    assert.equal(result.isError, true);
  });
});

test('handler con el límite de uso devuelve isError con el mensaje del límite', async () => {
  const machine = fakeMachine({ exists: false, exec: limitExec() });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  const result = await def.handler({ task: 'algo' }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /usage limit/);
  assert.match(result.content[0].text, /do not retry/);
});

// ---------------------------------------------------------------------------
// El motor claude-harness: una sesión de Claude Code con cerebro de otro proveedor

// Un `git diff --stat` distinto en cada llamada, para distinguir el antes del después.
function diffMachine() {
  let n = 0;
  return fakeMachine({
    exec: () => {
      n += 1;
      return { ok: true, code: 0, stdout: ` src/a.rs | 1 +\n ${n} files changed, ${n} insertions(+)\n`, stderr: '' };
    },
  });
}

// Una sesión de mentira que emite la misma historia siempre: una edición, un
// comando que falla, un texto y su result.
function fakeSession({ result = { ok: true, resultText: 'hecho', toolCounts: {} }, seenArgs } = {}) {
  return async (args) => {
    if (seenArgs) seenArgs.push(args);
    args.onEvent({ kind: 'tool', id: 't1', name: 'Edit', parentId: null, args: { file_path: 'a.rs' } });
    args.onEvent({ kind: 'tool_end', id: 't1', parentId: null, ok: true });
    args.onEvent({ kind: 'tool', id: 't2', name: 'Bash', parentId: null, args: { command: 'cargo test' } });
    args.onEvent({ kind: 'tool_end', id: 't2', parentId: null, ok: false });
    args.onEvent({ kind: 'text', text: 'hola', parentId: null });
    args.onEvent({ kind: 'result', ok: true });
    return result;
  };
}

test('harnessEnv apunta al proxy de esta máquina, con el modelo en la ruta', () => {
  assert.deepEqual(harnessEnv(4321, 'qwen3.8-max'), {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321/m/qwen3.8-max',
    ANTHROPIC_API_KEY: 'zen-proxy',
  });
  assert.match(harnessEnv(1, 'a/b').ANTHROPIC_BASE_URL, /\/m\/a%2Fb$/, 'el modelo va escapado, no parte la ruta');
});

test('read-only no tiene con qué editar ni ejecutar; workspace-write tiene todo', () => {
  assert.deepEqual(harnessTools('read-only'), ['Read', 'Grep', 'Glob']);
  assert.equal(harnessTools('workspace-write'), undefined);
});

test('la sesión delegada corre contra el proxy y sus eventos cuelgan de la tool', async () => {
  const machine = diffMachine();
  const seen = [];
  const seenArgs = [];
  const r = await runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'haz algo', sandbox: 'workspace-write',
    harnessModel: 'qwen3.8-max', timeoutMs: 60_000, parentId: 'toolu_x',
    onEvent: (ev) => seen.push(ev), runClaudeFn: fakeSession({ seenArgs }),
  });

  const args = seenArgs[0];
  assert.equal(args.model, 'sonnet');
  assert.equal(args.prompt, 'haz algo');
  assert.equal(args.cwd, '/wt/x');
  assert.equal(args.permissionMode, 'bypassPermissions');
  assert.equal(args.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321/m/qwen3.8-max');
  assert.equal(args.tools, undefined, 'workspace-write no recorta herramientas');
  assert.equal(args.trackQuota, false, 'lo que diga un modelo de otro proveedor no habla de la ventana de Anthropic');

  assert.deepEqual(seen.map((ev) => ev.kind), ['tool', 'tool_end', 'tool', 'tool_end', 'text'], 'el result del delegado no sale: el turno padre tiene el suyo');
  assert.deepEqual([...new Set(seen.map((ev) => ev.parentId))], ['toolu_x']);

  assert.ok(r.ok, r.error);
  assert.equal(r.text, 'hecho');
  assert.match(r.summary, /Archivos editados: a\.rs/);
  assert.match(r.summary, /Comandos: `cargo test` → error/);
  assert.match(r.summary, /git diff --stat: 2 files changed/);
  assert.match(r.summary, /Motor: claude-harness · qwen3\.8-max/);

  assert.equal(machine.calls.exec.length, 2, 'un git diff --stat antes y otro después');
  assert.deepEqual(machine.calls.exec[0].args, ['diff', '--stat']);
  assert.equal(machine.calls.exec[0].file, 'git');
});

test('con read-only, la sesión va con las tres herramientas de lectura y nadie mira el diff', async () => {
  const machine = diffMachine();
  const seenArgs = [];
  const r = await runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'lee', sandbox: 'read-only', harnessModel: 'qwen3.8-max',
    timeoutMs: 60_000, runClaudeFn: fakeSession({ seenArgs }),
  });
  assert.deepEqual(seenArgs[0].tools, ['Read', 'Grep', 'Glob']);
  assert.equal(machine.calls.exec.length, 0, 'sin permiso de escribir no hay nada que medir en git');
  assert.doesNotMatch(r.summary, /git diff/);
});

test('un diff idéntico al de antes se dice como «sin cambios»', () => {
  const same = ' 1 file changed, 1 insertion(+)';
  assert.match(summarizeHarness({ diffBefore: same, diffAfter: same }), /git diff --stat: sin cambios/);
  assert.match(summarizeHarness({ diffBefore: null, diffAfter: null }), /Archivos editados: ninguno/);
});

test('un árbol que el delegado dejó limpio no es «sin cambios» a secas: dice qué había antes', () => {
  const s = summarizeHarness({ diffBefore: '2 files changed, 4 insertions(+)', diffAfter: '' });
  assert.match(s, /git diff --stat: sin cambios \(antes: 2 files changed, 4 insertions\(\+\)\)/);
});

/** Corre `fn` vigilando que ningún rechazo se quede sin manejar. */
async function sinRechazosSueltos(fn) {
  const sueltos = [];
  const watcher = (e) => sueltos.push(e);
  process.on('unhandledRejection', watcher);
  try {
    const value = await fn();
    // Node avisa de un rechazo sin manejar al final del turno del event loop.
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sueltos.map((e) => e?.message ?? String(e)), [], 'ningún rechazo sin manejar');
    return value;
  } finally {
    process.off('unhandledRejection', watcher);
  }
}

test('si la sesión delegada no termina a tiempo, se la cierra (no se la interrumpe) y se dice cuánto se esperó', async () => {
  const machine = diffMachine();
  let closed = 0;
  let interrupted = 0;
  let late = null;
  const seen = [];
  // `interrupt()` solo vale con entrada en streaming (sdk.d.ts) y esta sesión
  // se lanzó con un prompt de texto: si alguien lo llama, lanza.
  const never = async (args) => {
    late = args.onEvent;
    args.onQuery({
      close: () => { closed += 1; return Promise.reject(new Error('el proceso ya no estaba')); },
      interrupt: () => { interrupted += 1; throw new Error('no soportado sin streaming'); },
    });
    return new Promise(() => {});
  };

  const r = await sinRechazosSueltos(() => runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'algo', sandbox: 'read-only',
    harnessModel: 'q', timeoutMs: 50, onEvent: (ev) => seen.push(ev), runClaudeFn: never,
  }));

  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish in 0 minutes/);
  assert.equal(closed, 1, 'close() es lo documentado para terminar el proceso');
  assert.equal(interrupted, 0);

  late({ kind: 'text', text: 'llego tarde', parentId: null });
  assert.deepEqual(seen, [], 'lo que llegue tras la respuesta de la tool no entra en el chat');
});

test('la sesión abandonada tras el timeout puede rechazar después sin tumbar el proceso', async () => {
  const machine = diffMachine();
  const lateReject = async (args) => {
    args.onQuery({ close: () => {} });
    return new Promise((_, reject) => { setTimeout(() => reject(new Error('el CLI murió tarde')), 40); });
  };
  const r = await sinRechazosSueltos(() => runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'algo', sandbox: 'read-only',
    harnessModel: 'q', timeoutMs: 20, runClaudeFn: lateReject,
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish/);
});

test('solo cruzan los eventos que el chat sabe dibujar: error, warn, init, result y cuota se quedan', async () => {
  const machine = fakeMachine();
  const seen = [];
  const ruidosa = async (args) => {
    args.onEvent({ kind: 'init', sessionId: 's1', model: 'm' });
    args.onEvent({ kind: 'progress', id: 't1', name: 'Bash', parentId: null, elapsed: 3 });
    args.onEvent({ kind: 'task_started', taskId: 'k1', description: 'algo en segundo plano' });
    args.onEvent({ kind: 'warn', warning: 'ojo' });
    args.onEvent({ kind: 'error', error: 'se cayó' });
    args.onEvent({ kind: 'quota', until: null });
    args.onEvent({ kind: 'quota_warning', utilization: 0.9 });
    args.onEvent({ kind: 'result', ok: false });
    return { ok: true, resultText: 'listo' };
  };
  const r = await runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'algo', sandbox: 'read-only', harnessModel: 'q',
    timeoutMs: 60_000, parentId: 'toolu_z', onEvent: (ev) => seen.push(ev), runClaudeFn: ruidosa,
  });
  assert.ok(r.ok, r.error);
  assert.deepEqual(seen.map((ev) => ev.kind), ['progress', 'task_started'],
    'un error del delegado ya vuelve como isError de la tool; repetirlo sería un ⚠️ de más en el chat');
  assert.deepEqual([...new Set(seen.map((ev) => ev.parentId))], ['toolu_z']);
});

test('una sesión delegada cortada por cuota se nombra como tal', async () => {
  const machine = diffMachine();
  const r = await runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'algo', sandbox: 'read-only', harnessModel: 'q',
    timeoutMs: 60_000, runClaudeFn: async () => ({ ok: false, quota: true, resultText: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /quota/);
});

test('una sesión delegada que termina bien pero sin texto es un fallo', async () => {
  const machine = diffMachine();
  const r = await runOpencodeHarness({
    machine, cwd: '/wt/x', task: 'algo', sandbox: 'read-only', harnessModel: 'q',
    timeoutMs: 60_000, runClaudeFn: async () => ({ ok: true, resultText: '  ' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /without saying anything/);
});

test('si el proxy no contesta, la tool falla sola y no lanza', async () => {
  const machine = fakeMachine();
  machine.zenProxyPort = async () => { throw new Error('proxy caído'); };
  const r = await runOpencodeHarness({ machine, cwd: '/wt/x', task: 'algo', harnessModel: 'q', runClaudeFn: fakeSession() });
  assert.equal(r.ok, false);
  assert.match(r.error, /proxy caído/);
});

test('la tool con el motor harness pide su parentId y devuelve respuesta + resumen', async () => {
  const machine = diffMachine();
  const pedidos = [];
  const def = opencodeDelegateTool({
    machine, cwd: '/wt/x', configDir: '/scratch/x', engine: 'claude-harness', harnessModel: 'qwen3.8-max',
    timeoutMs: 60_000, parentIdFor: (t) => { pedidos.push(t); return 'toolu_9'; },
    runClaudeFn: fakeSession(),
  });
  const res = await def.handler({ task: 'haz algo', sandbox: 'workspace-write' }, {});
  assert.notEqual(res.isError, true);
  assert.deepEqual(pedidos, ['haz algo']);
  const { text } = res.content[0];
  assert.ok(text.startsWith('hecho'));
  assert.match(text, /--- resumen del tablero/);
  assert.match(text, /Motor: claude-harness · qwen3\.8-max$/);
  assert.match(def.description, /se ven en el chat/);
  assert.equal(machine.calls.fs.length, 0, 'el motor harness no escribe ningún opencode.json');
});

test('una respuesta larga de la tool queda truncada', async () => {
  const long = 'x'.repeat(MAX_OUTPUT_CHARS + 5000) + 'COLA';
  const machine = fakeMachine({
    exists: false,
    exec: () => ({ ok: true, code: 0, stdout: JSON.stringify({ type: 'agent_message', message: long }), stderr: '' }),
  });
  const def = opencodeDelegateTool({ machine, cwd: '/wt/x', configDir: '/scratch/x' });
  const result = await def.handler({ task: 'algo' }, {});
  assert.ok(result.content[0].text.length < long.length);
  assert.ok(result.content[0].text.endsWith('COLA'));
});

test('una sesión delegada cuyo turno final es un acuse devuelve la respuesta sellada', async () => {
  const GOOD = 'Resultado completo de la delegación.\n' + 'detalle '.repeat(40);
  const r = await runOpencodeHarness({
    machine: diffMachine(), cwd: '/wt/x', task: 'algo', sandbox: 'workspace-write', harnessModel: 'q', timeoutMs: 60_000,
    runClaudeFn: async () => ({ ok: true, resultText: 'Background agent completed: PONG received.', sealedText: GOOD }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, GOOD);
});
