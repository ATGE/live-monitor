import './isolate.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRunner } from '../src/runner/app.js';
import { RunnerMachine } from '../src/runner-client.js';

/**
 * The runner in this very process, the client against it over real HTTP and
 * WebSockets on loopback. What is being proved is the contract: whatever
 * `LocalMachine` answers, `RunnerMachine` answers the same through the wire —
 * lines while a command runs, the tail of a file, a daemon's exit, and a
 * `claude` whose stdin and stdout are the SDK's.
 */
const ROOT = mkdtempSync(path.join(tmpdir(), 'hfsmon-runner-'));
const TOKEN = 'secreto-de-prueba';

// Stands in for `claude`: echoes each stdin line back prefixed, exits on EOF.
const FAKE_CLAUDE = path.join(ROOT, 'fake-claude.mjs');
writeFileSync(FAKE_CLAUDE, [
  "import { createInterface } from 'node:readline';",
  "process.stdout.write(JSON.stringify({ hello: process.argv.slice(2), cwd: process.cwd(), env: process.env.CLAUDE_CODE_PROBE ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null, token: process.env.ANTHROPIC_AUTH_TOKEN ?? null }) + '\\n');",
  'const rl = createInterface({ input: process.stdin });',
  "rl.on('line', (l) => process.stdout.write(`echo:${l}\\n`));",
  "rl.on('close', () => process.exit(7));",
].join('\n'));

let runner;
let m;
before(async () => {
  runner = createRunner({
    token: TOKEN,
    repoPath: path.join(ROOT, 'repo'),
    worktreeRoot: path.join(ROOT, 'wt'),
    attachmentsDir: path.join(ROOT, 'attachments'),
    // `node fake-claude.mjs …` via a wrapper: the runner spawns one command.
    claudeCommand: process.execPath,
  });
  const addr = await runner.listen(0, '127.0.0.1');
  m = new RunnerMachine('devbox', {
    url: `http://127.0.0.1:${addr.port}`, token: TOKEN,
    repoPath: path.join(ROOT, 'repo'), worktreeRoot: path.join(ROOT, 'wt'),
  });
});
after(async () => {
  const { closeZenProxy } = await import('../src/machine.js');
  await closeZenProxy();   // the runner starts it in this very process
  await runner.close();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

test('sin token no hay nada', async () => {
  const res = await fetch(`${m.url}/info`);
  assert.equal(res.status, 401);
});

test('info dice qué hay al otro lado', async () => {
  const info = await m.info();
  assert.equal(info.node, process.version);
  assert.equal(info.repoPath, path.join(ROOT, 'repo'));
  assert.ok(typeof info.home === 'string');
  assert.equal(info.uid, process.getuid?.() ?? null, 'y como quién corre');
});

test('info dice desde qué carpeta y qué commit corre el runner: monitorDir es la raíz real del checkout', async () => {
  const info = await m.info();
  assert.ok(path.isAbsolute(info.monitorDir), 'una ruta absoluta');
  assert.equal(existsSync(path.join(info.monitorDir, 'server', 'runner.js')), true, 'la carpeta que contiene server/runner.js');
  assert.ok('commit' in info && 'diskCommit' in info, 'y los dos commits, aunque sean null');
});

test('info con monitorDir apuntando a otro repo: commit fijo al arrancar, diskCommit sigue al disco; null fuera de git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

  const checkout = path.join(ROOT, 'monitor-checkout');
  mkdirSync(checkout, { recursive: true });
  git(['init', '-b', 'main', '.'], checkout);
  git(['config', 'user.email', 't@e.com'], checkout);
  git(['config', 'user.name', 'T'], checkout);
  writeFileSync(path.join(checkout, 'a.txt'), 'uno\n');
  git(['add', '.'], checkout);
  git(['commit', '-m', 'uno'], checkout);
  const first = git(['rev-parse', 'HEAD'], checkout);

  const notGit = path.join(ROOT, 'no-es-git');
  mkdirSync(notGit, { recursive: true });

  const infoOf = async (r) => {
    const addr = await r.listen(0, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${addr.port}/info`, { headers: { 'x-hfsmon-token': TOKEN } });
    assert.equal(res.status, 200);
    return { json: await res.json(), port: addr.port };
  };

  const r1 = createRunner({ token: TOKEN, repoPath: ROOT, worktreeRoot: ROOT, attachmentsDir: path.join(ROOT, 'attachments'), monitorDir: checkout });
  const r2 = createRunner({ token: TOKEN, repoPath: ROOT, worktreeRoot: ROOT, attachmentsDir: path.join(ROOT, 'attachments'), monitorDir: notGit });
  try {
    const { json: before, port } = await infoOf(r1);
    assert.equal(before.monitorDir, checkout, 'la carpeta indicada, no la del módulo');
    assert.equal(before.commit, first, 'commit es el HEAD al arrancar');
    assert.equal(before.diskCommit, first);

    writeFileSync(path.join(checkout, 'a.txt'), 'dos\n');
    git(['commit', '-am', 'dos'], checkout);
    const second = git(['rev-parse', 'HEAD'], checkout);
    assert.notEqual(second, first);

    const after = await (await fetch(`http://127.0.0.1:${port}/info`, { headers: { 'x-hfsmon-token': TOKEN } })).json();
    assert.equal(after.diskCommit, second, 'diskCommit ve el commit nuevo');
    assert.equal(after.commit, first, 'commit sigue siendo el del arranque');

    const { json: plain } = await infoOf(r2);
    assert.equal(plain.monitorDir, notGit);
    assert.equal(plain.commit, null, 'sin git no hay commit');
    assert.equal(plain.diskCommit, null);
  } finally {
    await r1.close();
    await r2.close();
  }
});

test('exec: resultado y líneas en streaming, igual que en local', async () => {
  const lines = [];
  const r = await m.exec('git', ['--version'], { onLine: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /git version/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /git version/);

  const bad = await m.exec('git', ['no-existe'], {});
  assert.equal(bad.ok, false);
  assert.ok(bad.code !== 0);
});

test('shell: con cwd y env sumado al de la máquina', async () => {
  const dir = path.join(ROOT, 'cwd-probe');
  await m.fs.mkdir(dir);
  // The runner is POSIX in real life; this test runs wherever the suite does,
  // and the shell's own syntax for a variable is not what is being tested.
  const echo = process.platform === 'win32' ? 'echo %HFSMON_X% && cd' : 'echo $HFSMON_X && pwd';
  const r = await m.shell(echo, { cwd: dir, env: { HFSMON_X: 'valor' } });
  assert.match(r.stdout, /valor/);
  assert.match(r.stdout.replace(/\\/g, '/'), new RegExp(dir.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&')), 'y el cwd se respeta');
});

test('fs por el cable: existe, escribe, lee, tail, lista, copia, borra', async () => {
  const f = path.join(ROOT, 'remoto.txt');
  assert.equal(await m.fs.exists(f), false);
  await m.fs.writeFile(f, `${'x'.repeat(50)}FIN`);
  assert.equal(await m.fs.exists(f), true);
  assert.equal(await m.fs.readFile(f), `${'x'.repeat(50)}FIN`);
  assert.equal(await m.fs.tail(f, 5), '…xxFIN');
  await m.fs.copy(f, path.join(ROOT, 'copia.txt'));
  assert.ok((await m.fs.readdir(ROOT)).includes('copia.txt'));
  await m.fs.rm(path.join(ROOT, 'copia.txt'));
  assert.equal(existsSync(path.join(ROOT, 'copia.txt')), false);
  await assert.rejects(() => m.fs.readFile(path.join(ROOT, 'no-existe')), /ENOENT|no such/i);
});

test('un adjunto sube y vuelve como ruta de la otra máquina', async () => {
  const local = path.join(ROOT, 'captura.png');
  writeFileSync(local, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const remote = await m.putAttachment(942, local, 'captura.png');
  assert.ok(remote.startsWith(path.join(ROOT, 'attachments', '942')));
  assert.ok(remote.endsWith('-captura.png'));
  assert.deepEqual([...readFileSync(remote)], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
});

test('un adjunto de un chat de proyecto sube a _proyecto', async () => {
  const local = path.join(ROOT, 'captura2.png');
  writeFileSync(local, Buffer.from([1, 2, 3]));
  const remote = await m.putAttachment('_proyecto', local, 'captura2.png');
  assert.ok(remote.startsWith(path.join(ROOT, 'attachments', '_proyecto')));
  assert.deepEqual([...readFileSync(remote)], [1, 2, 3]);
});

test('el runner solo acepta un número de issue o _proyecto como directorio del adjunto', async () => {
  const local = path.join(ROOT, 'captura3.png');
  writeFileSync(local, Buffer.from([4, 5, 6]));
  for (const hostile of ['../x', '_proyecto/..', '_proyecto1', '12abc', '012', '0', '', '..', '_PROYECTO']) {
    await assert.rejects(() => m.putAttachment(hostile, local, 'x.png'), /400|issue y cuerpo/, JSON.stringify(hostile));
  }
  const res = await fetch(`${m.url}/fs/upload?name=x.png`, {
    method: 'PUT', headers: { 'x-hfsmon-token': TOKEN, 'content-type': 'application/octet-stream' }, body: Buffer.from([1]),
  });
  assert.equal(res.status, 400, 'no issue at all');
  assert.equal(existsSync(path.join(ROOT, 'x')), false, 'nothing escaped the attachments directory');
});

test('puertos: se pregunta a la otra máquina', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const { port } = srv.address();
  try {
    assert.equal(await m.portFree(port), false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.equal(await m.portFree(port), true);
});

test('el proxy de Zen del runner: un puerto suyo, el mismo en cada llamada', async () => {
  const port = await m.zenProxyPort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 0);
  assert.equal(await m.zenProxyPort(), port, 'la ruta es idempotente: no arranca uno por petición');
});

test('un demonio remoto: pid, líneas y salida por el socket', async () => {
  const script = path.join(ROOT, 'daemon.mjs');
  writeFileSync(script, "console.log('arrancado'); setTimeout(() => { console.log('adiós'); process.exit(3); }, 200);");
  const lines = [];
  const handle = m.daemon.spawn(process.execPath, { cwd: ROOT, env: {}, args: [script] });
  const code = await new Promise((resolve) => {
    handle.on('line', (l) => lines.push(l));
    handle.on('exit', resolve);
  });
  assert.equal(code, 3);
  assert.deepEqual(lines, ['arrancado', 'adiós']);
  assert.ok(handle.pid > 0);
});

test('claude remoto: el SpawnedProcess que ve el SDK habla con el proceso de allí', async () => {
  const spawn = m.spawnClaude;
  const proc = spawn({
    command: '/this/is/the/local/cli/and/must/be/ignored',
    args: [FAKE_CLAUDE, '--output-format', 'stream-json'],
    cwd: ROOT,
    env: { CLAUDE_CODE_PROBE: 'llega', ANTHROPIC_API_KEY: 'NUNCA', PATH: 'NUNCA', HOME: 'NUNCA' },
    signal: new AbortController().signal,
  });

  const out = [];
  proc.stdout.on('data', (b) => out.push(b.toString('utf8')));
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));

  proc.stdin.write('{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 400));
  proc.stdin.end();
  const code = await exited;

  const text = out.join('');
  const hello = JSON.parse(text.split('\n')[0]);
  assert.deepEqual(hello.hello, ['--output-format', 'stream-json'], 'los args del SDK llegan tal cual');
  assert.equal(hello.cwd, ROOT, 'y el cwd');
  assert.equal(hello.env, 'llega', 'las variables CLAUDE_* viajan');
  assert.notEqual(hello.key, 'NUNCA', 'la key de esta máquina no viaja: allí manda el login de allí');
  assert.match(text, /echo:\{"type":"user"\}/, 'lo que el SDK escribe llega al stdin de allí');
  assert.equal(code, 7, 'y el código de salida vuelve');
  assert.equal(proc.exitCode, 7);
});

/** Starts the fake claude over the wire with `env` and returns what it saw. */
async function claudeEnv(env) {
  const proc = m.spawnClaude({ command: 'x', args: [FAKE_CLAUDE], cwd: ROOT, env, signal: new AbortController().signal });
  const out = [];
  proc.stdout.on('data', (b) => out.push(b.toString('utf8')));
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  await new Promise((r) => setTimeout(r, 300));
  proc.stdin.end();
  await exited;
  return JSON.parse(out.join('').split('\n')[0]);
}

test('la ANTHROPIC_API_KEY solo viaja cuando apunta al proxy local del runner', async () => {
  const toProxy = await claudeEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555', ANTHROPIC_API_KEY: 'zen-proxy' });
  assert.equal(toProxy.base, 'http://127.0.0.1:5555');
  assert.equal(toProxy.key, 'zen-proxy', 'el marcador que el proxy sustituye por la key de Zen');

  const toAnthropic = await claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'zen-proxy' });
  assert.equal(toAnthropic.base, 'https://api.anthropic.com');
  assert.notEqual(toAnthropic.key, 'zen-proxy', 'hacia Anthropic la única credencial sigue siendo el login');

  const token = await claudeEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555', ANTHROPIC_AUTH_TOKEN: 'jamás' });
  assert.notEqual(token.token, 'jamás', 'el AUTH_TOKEN no viaja ni siquiera al proxy');
});

test('una URL que solo parece loopback (userinfo 127.0.0.1@evil.com) no se lleva la key', async () => {
  const disfrazado = await claudeEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1@evil.com/x', ANTHROPIC_API_KEY: 'zen-proxy' });
  assert.equal(disfrazado.base, 'http://127.0.0.1:1@evil.com/x', 'la URL sí viaja: sola no es una credencial');
  assert.notEqual(disfrazado.key, 'zen-proxy', 'el host de verdad es evil.com');
});

test('kill llega al proceso remoto', async () => {
  const proc = m.spawnClaude({ command: 'x', args: [FAKE_CLAUDE], cwd: ROOT, env: {}, signal: new AbortController().signal });
  const exited = new Promise((resolve) => proc.once('exit', (code, sig) => resolve([code, sig])));
  await new Promise((r) => setTimeout(r, 300));
  proc.kill('SIGTERM');
  const [code] = await exited;
  assert.ok(code !== 7, 'no terminó por EOF sino por la señal');
  assert.equal(proc.killed, true);
});

test('un worktree creado en la otra máquina, con las funciones de worktree.js tal cual', async () => {
  const { execFileSync } = await import('node:child_process');
  const { createWorktree, isProjectWorktree, hasCommits, removeWorktree } = await import('../src/worktree.js');
  const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });

  // A repo with an `origin/main`, because createWorktree cuts branches from it.
  const origin = path.join(ROOT, 'origin.git');
  const repo = path.join(ROOT, 'repo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(origin, { recursive: true });
  git(['init', '--bare', '-b', 'main', '.'], origin);
  git(['clone', origin, repo], ROOT);
  git(['config', 'user.email', 't@e.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'hola\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  git(['push', '-u', 'origin', 'main'], repo);

  const lines = [];
  const wt = await createWorktree(m, 'feat/9-remoto', { onLine: (l) => lines.push(l) });
  assert.ok(wt.includes('feat-9-remoto'));
  assert.equal(await isProjectWorktree(m, wt), true, 'git en la otra máquina lo reconoce como worktree del proyecto');
  assert.equal(await hasCommits(m, wt), false);
  assert.equal(existsSync(path.join(wt, 'a.txt')), true, 'el checkout existe de verdad allí');

  await removeWorktree(m, wt);
  assert.equal(existsSync(wt), false);
});

test('descarga binaria y listado profundo: lo que el panel de QA necesita de la otra máquina', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = path.join(ROOT, 'qa-evidence', 'results', 'q1');
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3, 255]);   // a webm header, more or less
  writeFileSync(path.join(dir, 'video.webm'), bytes);
  writeFileSync(path.join(ROOT, 'qa-evidence', 'results', 'q1.png'), Buffer.from([0x89, 0x50]));

  const got = await m.fs.readBinary(path.join(dir, 'video.webm'));
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual([...got], [...bytes], 'los bytes llegan intactos, no como texto');

  const listed = await m.fs.readdirDeep(path.join(ROOT, 'qa-evidence'));
  assert.deepEqual(listed, ['results/q1.png', 'results/q1/video.webm'], 'rutas relativas con / venga de donde venga');
  await assert.rejects(() => m.fs.readBinary(path.join(ROOT, 'no-existe.webm')), /ENOENT|no such/i);
});

test('fs/realpath: ruta real, tamaño y tipo a través de un enlace; ENOENT si no existe; NO_ROUTE con un runner viejo', async () => {
  const { mkdirSync, symlinkSync, realpathSync, statSync } = await import('node:fs');
  const target = path.join(ROOT, 'realpath-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'doc.md'), '# doc\n');
  const link = path.join(ROOT, 'realpath-link');
  symlinkSync(target, link, 'junction');
  const real = realpathSync(path.join(target, 'doc.md'));
  const st = statSync(real);
  assert.deepEqual(await m.fs.realpath(path.join(link, 'doc.md')), {
    path: real, size: 6, isFile: true, uid: process.platform === 'win32' ? null : st.uid, mtimeMs: st.mtimeMs, nlink: 1,
  });
  assert.equal((await m.fs.realpath(link)).isFile, false, 'una carpeta no es un archivo');

  const missing = path.join(ROOT, 'no-existe.md');
  const res = await fetch(`${m.url}/fs/realpath`, {
    method: 'POST', headers: { 'x-hfsmon-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ path: missing }),
  });
  assert.equal(res.status, 400, 'como las demás rutas /fs/*');
  assert.equal((await res.json()).code, 'ENOENT');
  await assert.rejects(() => m.fs.realpath(missing), (e) => e.code === 'ENOENT');

  // A runner from before this route: express's own 404, no ENOENT flag.
  const { createServer } = await import('node:http');
  const old = createServer((_req, reply) => { reply.statusCode = 404; reply.end('Cannot POST /fs/realpath'); });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  try {
    const oldM = new RunnerMachine('viejo', { url: `http://127.0.0.1:${old.address().port}`, token: TOKEN });
    await assert.rejects(() => oldM.fs.realpath(path.join(target, 'doc.md')), (e) => e.code === 'NO_ROUTE');
  } finally {
    await new Promise((r) => old.close(r));
  }
});

test('sin token el cuerpo ni se lee: 401 antes que el parser, también para una subida de 25 MB', async () => {
  // A body that would fail to parse: 400 means the parser ran first, 401
  // means the token was checked before anything was read.
  const broken = await fetch(`${m.url}/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{roto' });
  assert.equal(broken.status, 401);
  const upload = await fetch(`${m.url}/fs/upload?path=/tmp/x`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(24 * 1024 * 1024),
  });
  assert.equal(upload.status, 401);
  // With the token, the same broken body does reach the parser.
  const withToken = await fetch(`${m.url}/exec`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hfsmon-token': TOKEN }, body: '{roto' });
  assert.equal(withToken.status, 400);
});

const execBody = (file, args) => ({
  method: 'POST',
  headers: { 'x-hfsmon-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ file, args }),
});

test('un comando callado recibe latidos {hb}: el cuerpo no se queda en silencio, y quien llama no los ve', async () => {
  const r = createRunner({
    token: TOKEN, repoPath: ROOT, worktreeRoot: ROOT, attachmentsDir: path.join(ROOT, 'attachments'), heartbeatMs: 20,
  });
  const addr = await r.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${addr.port}`;
  const args = ['-e', "setTimeout(() => console.log('done'), 300)"];
  try {
    const res = await fetch(`${url}/exec`, execBody(process.execPath, args));
    assert.equal(res.status, 200);
    const frames = (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.ok(frames.filter((f) => f.hb === true).length >= 3, 'al menos tres latidos en 300 ms a 20 ms cada uno');
    const results = frames.filter((f) => f.result);
    assert.equal(results.length, 1, 'un solo resultado');
    assert.equal(results[0].result.ok, true);

    const rm = new RunnerMachine('latidos', { url, token: TOKEN });
    const lines = [];
    const out = await rm.exec(process.execPath, args, { onLine: (l) => lines.push(l) });
    assert.equal(out.ok, true);
    assert.equal(out.stdout.replace(/\r\n/g, '\n'), 'done\n');
    assert.deepEqual(lines, ['done'], 'los latidos no llegan a onLine');
  } finally {
    await r.close();
  }
});

test('si el tablero se va a mitad del comando, el runner mata el proceso', async () => {
  const pidFile = path.join(ROOT, `pid-${Date.now()}.txt`);
  const code = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)";
  const controller = new AbortController();
  const res = await fetch(`${m.url}/exec`, { ...execBody(process.execPath, ['-e', code, pidFile]), signal: controller.signal });
  assert.equal(res.status, 200);
  const reading = (async () => { for await (const _ of res.body) { /* drain */ } })().catch(() => {});

  let pid;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8')) {
      assert.ok(Date.now() < deadline, 'el hijo escribió su pid');
      await new Promise((r) => setTimeout(r, 10));
    }
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
  } finally {
    // Also on failure: a request left open would hold `after`'s close for the child's 60 s.
    controller.abort();
    await reading;
  }

  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ceiling = Date.now() + 5_000;
  while (alive() && Date.now() < ceiling) await new Promise((r) => setTimeout(r, 20));
  const still = alive();
  if (still) { try { process.kill(pid); } catch { /* gone */ } }
  assert.equal(still, false, 'el proceso murió al irse el cliente');
});

test('exec con signal: abortar resuelve code -3 y el runner mata el proceso', async () => {
  const pidFile = path.join(ROOT, `pid-signal-${Date.now()}.txt`);
  const code = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)";
  const controller = new AbortController();
  const pending = m.exec(process.execPath, ['-e', code, pidFile], { signal: controller.signal });
  const settled = pending.then((r) => ({ r }), (e) => ({ e }));

  let pid;
  let out;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8')) {
      assert.ok(Date.now() < deadline, 'el hijo escribió su pid');
      await new Promise((r) => setTimeout(r, 10));
    }
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
  } finally {
    // Also on failure: a request left open would hold `after`'s close for the child's 60 s.
    controller.abort();
    out = await settled;
  }

  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ceiling = Date.now() + 5_000;
  while (alive() && Date.now() < ceiling) await new Promise((r) => setTimeout(r, 20));
  const still = alive();
  if (still) { try { process.kill(pid); } catch { /* gone */ } }

  assert.equal(out.e, undefined, 'no rechaza');
  assert.equal(out.r.ok, false);
  assert.equal(out.r.code, -3);
  assert.match(out.r.stderr, /aborted by the caller/);
  assert.equal(still, false, 'el proceso murió al abortar');
});

test('exec con una signal ya abortada: resuelve code -3 enseguida, sin rechazar', async () => {
  const started = Date.now();
  const r = await m.exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: AbortSignal.abort() });
  assert.equal(r.ok, false);
  assert.equal(r.code, -3);
  assert.match(r.stderr, /devbox: \[aborted by the caller\]/);
  assert.ok(Date.now() - started < 2_000, 'sin esperar al comando');
});

test('cuerpo cortado a mitad: resuelve ok:false code -3; los fallos de la petición siguen rechazando', async () => {
  const { createServer } = await import('node:http');
  const listen = async (handler) => {
    const s = createServer(handler);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return s;
  };
  const closeServer = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

  const cut = await listen((_req, reply) => {
    reply.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    reply.write('{"line":"uno"}\n');
    setTimeout(() => reply.socket?.destroy(), 20);
  });
  const failing = await listen((_req, reply) => {
    reply.writeHead(500, { 'Content-Type': 'application/json' });
    reply.end('{"error":"x"}');
  });
  const gone = await listen(() => {});
  const gonePort = gone.address().port;
  await closeServer(gone);
  try {
    const lines = [];
    const cm = new RunnerMachine('cortado', { url: `http://127.0.0.1:${cut.address().port}`, token: 'x' });
    const r = await cm.exec('x', [], { onLine: (l) => lines.push(l) });
    assert.equal(r.ok, false);
    assert.equal(r.code, -3);
    assert.match(r.stderr, /cortado: la conexión con el runner se cortó a mitad del comando/);
    assert.deepEqual(lines, ['uno']);

    const fm = new RunnerMachine('falla', { url: `http://127.0.0.1:${failing.address().port}`, token: 'x' });
    await assert.rejects(() => fm.exec('x', []), /→ x/);

    const gm = new RunnerMachine('cerrado', { url: `http://127.0.0.1:${gonePort}`, token: 'x' });
    await assert.rejects(() => gm.exec('x', []));
  } finally {
    await closeServer(cut);
    await closeServer(failing);
  }
});
