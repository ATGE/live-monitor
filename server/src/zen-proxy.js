import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * A loopback proxy that lets the Claude Code harness — Read/Edit/Bash, hooks,
 * transcripts and all — run on an OpenCode Go model through Zen's
 * Anthropic-compatible endpoint.
 *
 * Why a proxy at all, when `ANTHROPIC_BASE_URL` alone would point the CLI
 * anywhere: the CLI rejects a non-Claude `--model` client-side, so the name
 * never reaches the network. The CLI is therefore started with `--model
 * sonnet` and the model it really talks to is encoded in the base URL
 * (`http://127.0.0.1:<port>/m/<model>`); this proxy rewrites the request
 * body's `model` on the way out. It also swaps the placeholder
 * `ANTHROPIC_API_KEY` the CLI sends for the machine's real Go key (Zen wants
 * `x-api-key`, a `Bearer` token gets "Missing API key"), and turns Zen's
 * "Endpoint is unavailable" 503 into a 400, because the CLI retries a 503
 * about twenty times over three minutes and a model Zen does not serve in
 * this format will never start working mid-turn.
 *
 * It must run on the machine the `claude` process runs on: in the board
 * process for local tasks, in the runner process for the dev box.
 */

const DEFAULT_UPSTREAM = 'https://opencode.ai/zen/go';
const defaultAuthFile = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

/** The Go key from OpenCode's own store, or null. Never throws: no key is an answer. */
export function readZenKey(authFile = defaultAuthFile()) {
  try {
    const key = JSON.parse(readFileSync(authFile, 'utf8'))?.['opencode-go']?.key;
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

/**
 * What to send upstream for one CLI request. Pure, so the rewriting is
 * testable without a socket. The CLI's own `authorization`/`x-api-key` never
 * travel: they are a placeholder, and forwarding them would be the one way a
 * real Anthropic credential could leak to Zen.
 */
export function upstreamRequest({ path: reqPath, headers = {}, body, model, key, upstream = DEFAULT_UPSTREAM }) {
  const withoutQuery = String(reqPath ?? '').split('?')[0];
  let outBody = body;
  try {
    const parsed = JSON.parse(body);
    outBody = JSON.stringify({ ...parsed, model });
  } catch {
    // Not JSON: forward it byte for byte rather than guess.
  }
  return {
    url: upstream + withoutQuery,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': headers['anthropic-version'] ?? '2023-06-01',
      ...(headers['anthropic-beta'] ? { 'anthropic-beta': headers['anthropic-beta'] } : {}),
      'x-api-key': key,
      'x-opencode-session': headers['x-claude-code-session-id'] ?? headers['x-opencode-session'] ?? 'hfs-monitor',
      'user-agent': 'hfs-monitor/1.0',
    },
    body: outBody,
  };
}

/**
 * What the CLI is told about a non-2xx from Zen. The two cases worth
 * translating are the ones the CLI would otherwise hammer: a 503 for a model
 * Zen does not serve in this format, and an exhausted plan. Both become 400,
 * the one status the CLI does not retry.
 */
export function classifyUpstream(status, text, model) {
  const invalid = (message) => ({
    status: 400,
    body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  });
  if (status >= 200 && status < 300) return { status, body: text };
  if (status === 503 && String(text).includes('Endpoint is unavailable')) {
    return invalid(`Zen no sirve «${model}» en formato Anthropic (503 Endpoint is unavailable); elige otro modelo`);
  }
  if (status === 429 || String(text).includes('usage limit')) {
    return invalid('El plan de OpenCode alcanzó su límite de uso; no reintentes hasta que se renueve');
  }
  return { status, body: text };
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/** The whole body of a request, as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createZenProxy({ key = null, upstream = DEFAULT_UPSTREAM, fetchImpl = fetch, keyFile } = {}) {
  let port = 0;

  const server = http.createServer(async (req, res) => {
    // This handler is `async`, so anything it throws becomes an unhandled
    // rejection and Node ends the whole process — the board, or the runner.
    // Everything below therefore lives inside the one try, and the catch is
    // the only exit for a failure.
    const aborter = new AbortController();
    // A vanished client (the CLI was closed, or timed out) must not leave us
    // draining Zen: the Go model keeps generating, on the plan's budget, for
    // an answer nobody will read.
    res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
    // A client that disappears mid-write surfaces as an 'error' on `res`, and
    // an unhandled one is the very crash this handler is guarding against.
    res.on('error', () => {});

    try {
      const url = new URL(req.url, 'http://zen-proxy');
      const segments = url.pathname.split('/');
      const rest = `/${segments.slice(3).join('/')}`;
      if (req.method !== 'POST' || segments[1] !== 'm' || !segments[2] || rest !== '/v1/messages') {
        // The CLI also probes `/api/hello`; a 404 there is fine and expected.
        return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'solo POST /m/<modelo>/v1/messages' } });
      }

      // Inside the try: a malformed escape (`/m/%E0/...`) throws URIError.
      const model = decodeURIComponent(segments[2]);
      // Read lazily: the key may be written after this proxy started listening.
      const zenKey = key ?? readZenKey(keyFile);
      if (!zenKey) {
        return json(res, 401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'no hay key de OpenCode Go en auth.json de esta máquina' },
        });
      }

      const body = await readBody(req);
      const outbound = upstreamRequest({ path: rest + url.search, headers: req.headers, body, model, key: zenKey, upstream });
      const up = await fetchImpl(outbound.url, {
        method: 'POST',
        headers: outbound.headers,
        body: outbound.body,
        signal: aborter.signal,
      });

      if (up.status >= 200 && up.status < 300) {
        // Chunk by chunk: Claude Code reads the SSE stream as it arrives, and
        // buffering it whole would make every turn look frozen until it ended.
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
        // `res.write`'s answer is ignored on purpose: SSE frames are a few KB,
        // far under the socket's buffer, so waiting for 'drain' would only add
        // latency to a stream the CLI is reading live.
        if (up.body) for await (const chunk of up.body) res.write(chunk);
        return res.end();
      }

      const answer = classifyUpstream(up.status, await up.text(), model);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      return res.end(answer.body);
    } catch (e) {
      // Never log `e` with the request: the key rides in those headers.
      // Once the status line is out the only honest answer left is to cut the
      // connection; a client that already left gets the same treatment.
      if (aborter.signal.aborted || res.headersSent || res.writableEnded) return res.destroy();
      return json(res, 502, { type: 'error', error: { type: 'api_error', message: `proxy: ${e.message}` } });
    }
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
    get port() { return port; },
  };
}
