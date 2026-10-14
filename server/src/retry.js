/**
 * Trying again, with what the last attempt said. A retry that repeats the
 * same call blindly only helps against luck; one that carries the failure
 * forward lets the next attempt — a session, a command — start from what went
 * wrong. `attempt(n, previous)` gets the attempt number and the failure of
 * the one before it, and returns `{ ok, failure? }` or throws.
 */

export const DEFAULT_MAX = 3;

/** Waits used between attempts at infrastructure: short, then patient. */
export const BACKOFF_MS = [10_000, 30_000, 90_000];

/**
 * Whether an error is worth trying again as it is: the world may have moved.
 * A conflict or a refusal is not; that needs a different action.
 */
export function isTransient(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  if (/conflict|conflicto|merge a medias|merge in progress|rejected .*non-fast-forward|denied|prohibido|no existe|does not exist/.test(text)) return false;
  return /eaddrinuse|puerto .*ocupado|port .*in use|econnrefused|econnreset|etimedout|timed? ?out|no responde|not responding|no response|network|red\b|502|503|504|temporarily|could not read from remote|unable to access|no arranc|did not start/.test(text);
}

/**
 * Runs `attempt` up to `max` times. `retries` counts the attempts after the
 * first — `max: 3` is one try and three retries, which is how Edson counts.
 * `onRetry(n, failure)` is where the log line goes; `wait` is injectable for
 * tests. Resolves with the last outcome; throws when the last attempt threw.
 */
export async function withRetries(attempt, {
  max = DEFAULT_MAX, backoff = null, onRetry = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  shouldRetry = () => true,
} = {}) {
  let previous = null;
  for (let n = 1; n <= max + 1; n += 1) {
    let outcome;
    try {
      outcome = await attempt(n, previous);
    } catch (e) {
      outcome = { ok: false, failure: { kind: 'error', output: String(e?.message ?? e), error: e } };
    }
    if (outcome?.ok) return { ...outcome, attempts: n };
    previous = outcome?.failure ?? { kind: 'error', output: 'no detail' };
    if (n > max || !shouldRetry(previous, n)) {
      if (previous.error) throw previous.error;
      return { ok: false, failure: previous, attempts: n };
    }
    onRetry(n, previous);
    if (backoff) await wait(backoff[Math.min(n - 1, backoff.length - 1)]);
  }
  return { ok: false, failure: previous, attempts: max + 1 };
}

/** The tail of an output, for a log line or a prompt. */
export function lastLines(text, n = 20) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
}
