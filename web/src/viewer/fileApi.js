import { authHeaders, withToken } from '../token.js';

/**
 * The file viewer's calls to `server/src/files.js`. Kept apart from `api.js`
 * so the viewer owns its whole surface.
 */

function httpError(status, data) {
  const err = new Error(data?.error || `HTTP ${status}`);
  err.status = status;
  err.data = data ?? {};
  return err;
}

async function jsonOf(res) {
  try { return await res.json(); } catch { return {}; }
}

const contentPath = ({ machine, path }) => `/api/files/content?${new URLSearchParams({ machine, path })}`;

/**
 * `{ line, candidates, unreachable, tried }` for a mention as it appeared in
 * the chat. The task it resolves against travels as its two halves, `project`
 * and `issue` — never as the composite key, which cannot go in a URL.
 */
export async function resolveRef({ project, issue, machine, ref }) {
  const q = new URLSearchParams();
  if (project != null && project !== '') q.set('project', String(project));
  if (issue != null && issue !== '') q.set('issue', String(issue));
  // A project chat has no issue: the machine tells the server which holder worktree to search.
  if (machine != null && machine !== '') q.set('machine', String(machine));
  q.set('ref', String(ref));
  let res;
  try {
    res = await fetch(`/api/files/resolve?${q}`, { headers: authHeaders(), cache: 'no-store' });
  } catch (e) {
    throw httpError(0, { error: e.message });
  }
  const data = await jsonOf(res);
  if (!res.ok) throw httpError(res.status, data);
  return data;
}

/**
 * `{ status: 304 }` when `etag` still matches, else `{ status: 200, ...json }`.
 * The response's `ETag` header travels as `headerEtag`, so the next call can
 * send back exactly what the server issued (quoted or not).
 */
export async function fetchContent({ machine, path, etag = null }) {
  const headers = { ...authHeaders() };
  if (etag) headers['If-None-Match'] = etag;
  let res;
  try {
    // no-store: the browser must not answer a revalidation from its own cache.
    res = await fetch(contentPath({ machine, path }), { headers, cache: 'no-store' });
  } catch (e) {
    throw httpError(0, { error: e.message });
  }
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw httpError(res.status, await jsonOf(res));
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // Bytes: the server decided it is an image.
    return { status: 200, kind: 'image', machine, path, etag: res.headers.get('etag'), headerEtag: res.headers.get('etag') };
  }
  const data = await jsonOf(res);
  return { status: 200, ...data, headerEtag: res.headers.get('etag') };
}

/** Served bytes, for `<img src>`. */
export const contentUrl = ({ machine, path }) => withToken(contentPath({ machine, path }));

/**
 * The standalone page for a file, for «abrir en pestaña nueva». No token in
 * the URL: the new tab is same-origin and token.js reads it from localStorage.
 */
export const viewUrl = ({ machine, path, line }) =>
  `/?view=${encodeURIComponent(`${machine}:${path}`)}${line ? `&line=${line}` : ''}`;

/**
 * An `.html` served as a page, for the viewer's sandboxed `<iframe src>`.
 * Same query as `contentUrl`; the server answers 400 for anything but `.html`.
 */
export const pageUrl = ({ machine, path }) => withToken(`/api/files/page?${new URLSearchParams({ machine, path })}`);
