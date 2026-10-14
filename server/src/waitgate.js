/**
 * The gate against waiting by stacking background timers.
 *
 * Measured on #1390. To wait for a test suite it had launched, the session
 * fired `sleep` after `sleep` into the background, answering each one as it
 * came back. It delivered its final report at 04:20:17 — and then the timers
 * it had queued kept expiring, so it kept politely answering them: 68 messages
 * between 04:20:21 and 04:24:00, saying nothing. Of that chat's 182 messages,
 * 109 were waiting noise, each one a model turn with its tokens and its share
 * of the account's quota.
 *
 * Nothing was broken — the board re-fired no turn and rendered exactly what the
 * model emitted. That is the point: the loop is invisible to every check the
 * board has, because each piece of it is legitimate.
 *
 * What is refused is narrow on purpose: a background command that does nothing
 * but pass time. `sleep 30 && cargo test` starts a real job and goes through;
 * `sleep 30`, `sleep 5; echo listo`, `while true; do sleep 2; done` do not. The
 * cost of being wrong is one turn and a sentence explaining the alternative,
 * and the alternative is what the model wanted anyway: wait in the foreground,
 * where one call returns when the work is done, or read the job once with
 * BashOutput instead of setting an alarm to remind itself to read it.
 */

/** Segments of a command line: what `;`, `&&`, `||` and `|` separate. */
const SEGMENTS = /\s*(?:&&|\|\||[;|])\s*/;

/** A segment that only passes time or says something. */
const IDLE = [
  /^sleep\s+[\d.]+[smhd]?$/i,
  /^echo\b/i,
  /^printf\b/i,
  /^:$/,
  /^true$/i,
  /^false$/i,
  /^wait$/i,
  /^date\b/i,
];

/** A loop whose whole body is idle: `while true; do sleep 2; done` and kin. */
const LOOP = /^(?:while|until|for)\b/i;

const strip = (s) => String(s ?? '').trim().replace(/^[({\s]+|[)}\s]+$/g, '');

/**
 * Whether a command line does nothing but pass time. A line with no `sleep` at
 * all is never idle: `echo hola` in the background is pointless but harmless,
 * and refusing it would only cost a turn.
 */
export function isIdleWait(command) {
  const line = strip(command);
  if (!line) return false;
  if (!/\bsleep\s+[\d.]/i.test(line)) return false;

  // A loop is idle only when BOTH halves are. The condition is the half that
  // matters: `while ! curl -sf localhost:8080; do sleep 2; done` sleeps in its
  // body but is waiting for something real to happen, and refusing it would
  // take away the one correct way to wait for a server to come up.
  if (LOOP.test(line)) {
    const parts = line.match(/^(?:while|until|for)\b(.*?)\bdo\b(.*?)\bdone\b/is);
    if (!parts) return false;
    return allIdle(parts[1]) && allIdle(parts[2]);
  }
  return allIdle(line);
}

const idle = (segment) => IDLE.some((re) => re.test(segment));

/** Every command in a fragment does nothing but pass time. */
function allIdle(fragment) {
  const parts = String(fragment).split(SEGMENTS).map(strip).filter(Boolean);
  return parts.length > 0 && parts.every(idle);
}

/**
 * The reason to refuse a Bash call, or null. Only background calls: the same
 * `sleep` in the foreground blocks that one turn and ends, which is noisy but
 * finite — it cannot pile up behind a session that has already moved on.
 */
export function idleWaitProblem(input) {
  if (!input || typeof input !== 'object') return null;
  const background = input.run_in_background === true;
  if (!background) return null;
  if (!isIdleWait(input.command)) return null;
  return 'Esperar en segundo plano con `sleep` no es esperar: cada temporizador que vence te interrumpe, '
    + 'y los que dejes encolados te seguirán interrumpiendo cuando ya hayas terminado '
    + '(en #1390 fueron 68 mensajes seguidos sin contenido). '
    + 'Si lo que esperas es un comando tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado. '
    + 'Si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`: '
    + 'una sola llamada que vuelve cuando el trabajo acabó, sin despertarte por el camino.';
}
