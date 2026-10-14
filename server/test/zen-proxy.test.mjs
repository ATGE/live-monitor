import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createZenProxy, readZenKey, upstreamRequest, classifyUpstream } from '../src/zen-proxy.js';

/**
 * A fake Zen upstream on loopback and the real proxy in front of it. What is
 * being proved is what the CLI sees: its `--model sonnet` body leaves as the
 * Go model, its placeholder key never travels, an SSE answer arrives in
 * pieces, and the two failures Zen has (a model it does not serve, a spent
 * plan) come back as a 400 the CLI will not retry twenty times.
 */
const ROOT = mkdtempSync(path.join(tmpdir(), 'hfsmon-zen-'));

let upstream;
let upstreamUrl;
let seen;

before(async () => {
  upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* left null on purpose */ }
      seen = { method: req.method, path: req.url, headers: req.headers, body };
      if (body?.model === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream request failed: Endpoint is unavailable.' } }));
        return;
      }
      if (body?.model === 'limit') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Go usage limit exceeded' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start"}\n\n');
      setTimeout(() => {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
        setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 20);
      }, 20);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  await new Promise((r) => upstream.close(r));
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

/** A proxy of its own per test, closed by the caller. */
async function withProxy(options, fn) {
  const proxy = createZenProxy({ upstream: upstreamUrl, ...options });
  const port = await proxy.listen();
  try {
    return await fn(`http://127.0.0.1:${port}`, proxy);
  } finally {
    await proxy.close();
  }
}

const ask = (base, model, body) => fetch(`${base}/m/${model}/v1/messages?beta=true`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': 'placeholder',
    'x-claude-code-session-id': 's1',
    'anthropic-beta': 'b1',
    authorization: 'Bearer nunca',
  },
  body: JSON.stringify(body),
});

test('el modelo va en la URL y sale en el cuerpo; la key de la CLI nunca viaja', async () => {
  await withProxy({ key: 'test-key' }, async (base) => {
    const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.equal(seen.method, 'POST');
    assert.equal(seen.path, '/v1/messages', 'la query de la CLI no se reenvía');
    assert.equal(seen.body.model, 'qwen3.8-max', 'el modelo de la URL sustituye al de la CLI');
    assert.equal(seen.headers['x-api-key'], 'test-key', 'la key real, no el marcador');
    assert.equal(seen.headers['x-opencode-session'], 's1');
    assert.equal(seen.headers['anthropic-beta'], 'b1');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.headers.authorization, undefined, 'la credencial de la CLI se queda aquí');

    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /message_start/);
    assert.match(text, /content_block_delta/);
    assert.match(text, /message_stop/, 'los tres trozos llegan enteros');
  });
});

test('un modelo que Zen no sirve: 400 con el nombre del modelo, no un 503 que la CLI reintenta', async () => {
  await withProxy({ key: 'test-key' }, async (base) => {
    const res = await ask(base, 'unavailable', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.type, 'invalid_request_error');
    assert.match(data.error.message, /Zen no sirve «unavailable»/);
    assert.match(data.error.message, /elige otro modelo/);
  });
});

test('el plan agotado también para en seco', async () => {
  await withProxy({ key: 'test-key' }, async (base) => {
    const res = await ask(base, 'limit', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /límite de uso/);
  });
});

test('lo que no sea POST /m/<modelo>/v1/messages es 404, incluida la sonda /api/hello de la CLI', async () => {
  await withProxy({ key: 'test-key' }, async (base) => {
    assert.equal((await fetch(`${base}/api/hello`)).status, 404);
    assert.equal((await fetch(`${base}/m/x/v1/otra`, { method: 'POST' })).status, 404);
  });
});

test('sin key en la máquina: 401, y no se llama a Zen', async () => {
  await withProxy({ keyFile: path.join(ROOT, 'no-existe.json') }, async (base) => {
    const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, 'authentication_error');
  });
});

test('la key se lee del auth.json de OpenCode, y se lee tarde: vale la escrita tras arrancar', async () => {
  const file = path.join(ROOT, 'auth.json');
  assert.equal(readZenKey(file), null, 'sin archivo, null');
  assert.equal(readZenKey(path.join(ROOT, 'roto.json')), null);

  await withProxy({ keyFile: file }, async (base) => {
    writeFileSync(file, JSON.stringify({ 'opencode-go': { type: 'api', key: 'k-tardía' }, otro: { key: 'x' } }));
    assert.equal(readZenKey(file), 'k-tardía');
    const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen.headers['x-api-key'], 'k-tardía');
  });

  writeFileSync(path.join(ROOT, 'roto.json'), '{no es json');
  assert.equal(readZenKey(path.join(ROOT, 'roto.json')), null, 'un archivo malformado tampoco lanza');
});

test('upstreamRequest: cabeceras por defecto, cuerpo no-JSON intacto', () => {
  const plain = upstreamRequest({ path: '/v1/messages', headers: {}, body: '{"model":"a"}', model: 'b', key: 'k' });
  assert.equal(plain.url, 'https://opencode.ai/zen/go/v1/messages', 'el upstream de Zen por defecto');
  assert.equal(plain.headers['anthropic-version'], '2023-06-01');
  assert.equal(plain.headers['anthropic-beta'], undefined, 'no se inventa una beta');
  assert.equal(plain.headers['x-opencode-session'], 'hfs-monitor');
  assert.equal(JSON.parse(plain.body).model, 'b');

  const raw = upstreamRequest({ path: '/v1/messages', headers: {}, body: 'no soy json', model: 'b', key: 'k' });
  assert.equal(raw.body, 'no soy json');
});

test('classifyUpstream: 2xx y 401 pasan tal cual, 503/429 se traducen', () => {
  assert.deepEqual(classifyUpstream(200, 'ok', 'm'), { status: 200, body: 'ok' });
  assert.deepEqual(classifyUpstream(401, 'Missing API key', 'm'), { status: 401, body: 'Missing API key' });
  assert.deepEqual(classifyUpstream(403, 'nope', 'm'), { status: 403, body: 'nope' });
  assert.equal(classifyUpstream(503, 'Endpoint is unavailable.', 'm').status, 400);
  assert.equal(classifyUpstream(503, 'otra cosa', 'm').status, 503, 'un 503 cualquiera no se disfraza');
  assert.equal(classifyUpstream(500, 'boom', 'm').status, 500);
});

test('si Zen no contesta, 502 y no una excepción', async () => {
  await withProxy({ key: 'k', fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) }, async (base) => {
    const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.type, 'api_error');
  });
});

/**
 * The handler is `async`: anything it throws outside its catch would be an
 * unhandled rejection, and Node would take the whole board (or the runner)
 * down with it. Each of these tests breaks the request in a different place
 * and then asks the same proxy for something else: the second answer is the
 * proof that the process is still alive.
 */

/** A misbehaving upstream of its own, closed by the caller. */
async function withUpstream(handler, fn) {
  const srv = createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

test('una URL con un escape roto es 502, no una excepción que mata el proceso', async () => {
  await withProxy({ key: 'test-key' }, async (base) => {
    // `decodeURIComponent('%E0')` lanza URIError.
    const res = await fetch(`${base}/m/%E0/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.type, 'api_error');

    const next = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
    assert.equal(next.status, 200, 'el proxy sigue en pie tras el URIError');
    await next.text();
  });
});

test('si Zen corta el stream a medias, el cliente ve un cuerpo truncado y el proxy sigue vivo', async () => {
  let calls = 0;
  await withUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => res.socket.destroy(), 10);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  }, async (upUrl) => {
    await withProxy({ key: 'k', upstream: upUrl }, async (base) => {
      const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
      assert.equal(res.status, 200);
      let cut = false;
      let text = '';
      try { text = await res.text(); } catch { cut = true; }
      assert.ok(cut || !text.includes('message_stop'), 'la respuesta llega cortada, no entera');

      const next = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
      assert.equal(next.status, 200);
      assert.equal((await next.json()).ok, true, 'el proxy sirve la siguiente petición');
    });
  });
});

test('un no-2xx cuyo cuerpo no se puede leer entero es 502, y el proxy sigue vivo', async () => {
  let calls = 0;
  await withUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      if (calls === 1) {
        // Promete 100 bytes y da 5: `await up.text()` lanza.
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': '100' });
        res.write('abcde');
        setTimeout(() => res.socket.destroy(), 10);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  }, async (upUrl) => {
    await withProxy({ key: 'k', upstream: upUrl }, async (base) => {
      const res = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.type, 'api_error');

      const next = await ask(base, 'qwen3.8-max', { model: 'claude-sonnet-5', messages: [] });
      assert.equal((await next.json()).ok, true, 'el proxy sirve la siguiente petición');
    });
  });
});

test('si el cliente se va, el proxy suelta a Zen en vez de seguir gastando el plan', async () => {
  let closed;
  const upstreamClosed = new Promise((r) => { closed = r; });
  await withUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 50);
      const stop = setTimeout(() => { clearInterval(timer); res.end(); }, 2000);
      // On the response, not on the request: `req` closes as soon as its body
      // is complete, so only `res` tells us the caller actually hung up.
      res.on('close', () => { clearInterval(timer); clearTimeout(stop); closed(Date.now()); });
    });
  }, async (upUrl) => {
    await withProxy({ key: 'k', upstream: upUrl }, async (base) => {
      const ctrl = new AbortController();
      const started = Date.now();
      const pending = fetch(`${base}/m/qwen3.8-max/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
        signal: ctrl.signal,
      }).then((r) => r.text()).catch(() => 'abortada');
      setTimeout(() => ctrl.abort(), 100);
      await pending;

      const at = await Promise.race([
        upstreamClosed,
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      assert.ok(at !== null, 'Zen tiene que enterarse de que ya nadie escucha');
      assert.ok(at - started < 1000, `tardó ${at - started}ms en soltar el stream`);
    });
  });
});
