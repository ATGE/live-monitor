// Which machines hold a file named in a chat. Pure (no React) so a test can
// drive it without a network: the resolver and the clock are injectable.
import { resolveRef } from './fileApi.js';

export const OK_TTL_MS = 60_000;
export const FAIL_TTL_MS = 15_000;
export const MAX_CONCURRENT = 4;

/** One `{ machine, path, line }` per machine, the first in server order. */
export function groupMachines(candidates, line) {
  const seen = new Set();
  const out = [];
  for (const c of candidates ?? []) {
    if (!c?.machine || seen.has(c.machine)) continue;
    seen.add(c.machine);
    out.push({ machine: c.machine, path: c.path, line: line ?? null });
  }
  return out;
}

/**
 * A cache + queue around a resolver. Successes live `okTtl`, failures `failTtl`
 * (a runner that is down costs seconds per probe, so it is not re-probed on
 * every remount); at most `max` resolves run at once.
 */
export function createRefResolver({ resolve = resolveRef, now = Date.now, okTtl = OK_TTL_MS, failTtl = FAIL_TTL_MS, max = MAX_CONCURRENT } = {}) {
  const cache = new Map();   // key -> { promise, expires }  (expires null while in flight)
  const queue = [];
  let running = 0;

  const pump = () => {
    while (running < max && queue.length) {
      const job = queue.shift();
      running += 1;
      Promise.resolve().then(() => resolve(job.args)).then(job.resolve, job.reject).finally(() => { running -= 1; pump(); });
    }
  };

  return function lookup({ project, issue, machine, ref }) {
    const key = `${project}|${issue}|${machine}|${ref}`;
    const hit = cache.get(key);
    if (hit && (hit.expires === null || hit.expires > now())) return hit.promise;
    const entry = { expires: null, promise: null };
    entry.promise = new Promise((res, rej) => queue.push({ args: { project, issue, machine, ref }, resolve: res, reject: rej }))
      .then(
        (data) => { entry.expires = now() + okTtl; return data; },
        (err) => { entry.expires = now() + failTtl; throw err; },
      );
    cache.set(key, entry);
    pump();
    return entry.promise;
  };
}

/** The board-wide instance the chips use. */
export const lookupRef = createRefResolver();
