// The full paths a chat itself touched (Read/Write/Edit tool rows), kept as a
// FALLBACK for bare file names. `GET /api/files/resolve` finds a bare name only
// through git (`server/src/files.js#gitSearch`), so a file written outside it
// (the session scratchpad, `~/.claude/plans`) is never found by name, but is
// found by its full path. Pure (no React) so a test can drive it.
import { parseRef } from './filerefs.js';

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit']); // i18n-ok: tool names, not UI text
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const baseOf = (p) => p.split(/[\\/]/).pop();

/**
 * `Map<basename, fullPath[]>`, most recent first, no duplicates. Walks every
 * activity message's items and their `children` at any depth, in the order the
 * tools ran (a node before its children, later nodes after earlier ones).
 */
export function collectPaths(messages) {
  const seen = [];
  const walk = (items) => {
    for (const item of items ?? []) {
      if (PATH_TOOLS.has(item?.name) && typeof item.summary === 'string') {
        const ref = parseRef(item.summary);
        if (ref && ABSOLUTE_RE.test(ref.path)) seen.push(ref.path);
      }
      if (item?.children?.length) walk(item.children);
    }
  };
  for (const m of messages ?? []) {
    if (m?.role === 'activity') walk(m.items);
  }
  const map = new Map();
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const full = seen[i];
    const key = baseOf(full);
    const list = map.get(key);
    if (!list) map.set(key, [full]);
    else if (!list.includes(full)) list.push(full);
  }
  return map;
}

/**
 * The most recent full path for a BARE name (no `/` or `\`) that the chat
 * touched, with the original `:line` / `#L` suffix kept; null otherwise.
 */
export function fallbackFor(map, ref) {
  const parsed = parseRef(ref);
  if (!parsed || /[\\/]/.test(parsed.path)) return null;
  const full = map?.get(parsed.path)?.[0];
  if (!full) return null;
  return full + ref.trim().slice(parsed.path.length);
}

/** A stable string of the map's content, to key memoization. */
export function signatureOf(map) {
  return [...map].map(([k, v]) => `${k}=${v.join('|')}`).join('\n');
}

/**
 * Looks up `bareRef`; only when it has no candidates looks up `fallbackRef`.
 * Resolves `{ ref, result }`: the ref that answered and its lookup result. A
 * failed bare lookup rejects (callers keep the bare ref / show no chips); a
 * failed fallback lookup gives `{ ref: fallbackRef, result: null }`.
 */
export async function resolveWithFallback(lookup, bareRef, fallbackRef) {
  const result = await lookup(bareRef);
  if (!fallbackRef || result?.candidates?.length > 0) return { ref: bareRef, result };
  try {
    return { ref: fallbackRef, result: await lookup(fallbackRef) };
  } catch {
    return { ref: fallbackRef, result: null };
  }
}
