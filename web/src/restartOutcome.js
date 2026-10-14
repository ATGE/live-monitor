// Pure helpers for RestartControl: did the restart happen? No React, no JSX.
import { fill, strings } from './i18n/index.js';

/**
 * What a poll that got an answer says about a restart in progress.
 *  - `before` / `now`: GET /api/restart bodies, the last one seen before the
 *    restart and the one just received (either may lack `startedAt`).
 *  - `sawDown`: an earlier poll failed (the board stopped answering).
 *  - `elapsedMs` / `fallbackMs`: only used when `startedAt` cannot be compared.
 * Returns 'restarted' (a new process answers), 'failed' (the same process says
 * the restart did not happen), 'not-restarting' (the same process, past the gate,
 * reports waiting/idle with no failure: none was launched) or 'pending' (keep polling).
 */
export function restartOutcome({ before, now, sawDown, elapsedMs, fallbackMs }) {
  const was = before?.startedAt;
  const is = now?.startedAt;
  if (was && is) {
    if (was !== is) return 'restarted';
    if (now.lastFailure) return 'failed';
    // The control can enter «restarting» on a mere fetch error while the server never
    // restarted (a blip during a wait). Past the gate the server would long since say
    // 'restarting'; before it, 'idle' is normal (sessions are closing).
    if (now.state && now.state !== 'restarting' && elapsedMs >= fallbackMs) return 'not-restarting';
    return 'pending';
  }
  if (now?.lastFailure) return 'failed';
  // No process start to compare (a board that predates the field): the old rule.
  return sawDown || elapsedMs >= fallbackMs ? 'restarted' : 'pending';
}

/** The line the control shows for a restart that did not happen, in the language in use. */
export function failureMessage(lastFailure) {
  const t = strings().ops.restart;
  if (lastFailure?.reason === 'error') {
    return fill(t.failureError, { message: lastFailure.message ?? t.unknownError });
  }
  return t.failureSame;
}
