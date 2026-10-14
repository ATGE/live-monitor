import { inspect } from 'node:util';

/**
 * The net under the board's process.
 *
 * This process is the only place the work in flight lives: the live Claude
 * sessions, the chats mid-turn, the plans running, the moves half done. None
 * of it is on disk while it is happening. Node's default for a promise nobody
 * handled is to kill the process — and on 2026-09-23 that is exactly what it
 * did: a `fetch` to the runner of `runner-1`, a box that had been down for
 * hours, rejected with `ECONNREFUSED` inside a `finally` that awaited it
 * outside any `try`, and every task on the board went down with it.
 *
 * A remote machine that does not answer is an ordinary condition — it reboots,
 * it loses the tailnet, someone turns it off. Losing the board costs
 * incomparably more than the error does.
 *
 * So the rule is: log it, whole and loudly — the message, the `cause` and the
 * stack, laid out exactly as `hfs-monitor.err.log` showed it before — and stay
 * up. This is a net, not a silencer. Nothing is swallowed and nothing is
 * counted as handled: a real programming bug lands in the log as visibly as it
 * did when it was fatal, it simply no longer takes twenty tasks with it.
 *
 * With one exception. Before the port is open there is no board to save and
 * nothing in flight to lose: a failure there means this process never started,
 * and it has to die loudly rather than sit half-built, listening to nothing,
 * looking alive to whoever restarted it.
 */
export function installCrashGuard({
  started = () => true,
  log = (line) => console.error(line),
  exit = (code) => process.exit(code),
  on = (event, handler) => process.on(event, handler),
  off = (event, handler) => process.off(event, handler),
} = {}) {
  const survive = (kind) => (error) => {
    // `inspect` and not `error.stack`: what killed the board printed nothing
    // but `TypeError: fetch failed`, and the reason — `ECONNREFUSED`, the
    // address, the port — was in `cause`, which a stack alone never shows.
    log(`[${kind}] ${inspect(error, { depth: 4, colors: false })}`);
    if (started()) return;
    log(`[${kind}] ocurrió antes de escuchar en el puerto: el tablero no llegó a arrancar`);
    exit(1);
  };

  const onRejection = survive('unhandledRejection');
  // Kept apart from the rejection handler on purpose: an exception that
  // unwound the stack may well have left something half-written, so this one
  // is the riskier of the two. It stays for the same reason as the other —
  // the alternative is not "a clean process", it is "no board at all" — and
  // its line says which of the two happened.
  const onException = survive('uncaughtException');

  on('unhandledRejection', onRejection);
  on('uncaughtException', onException);

  return () => {
    off('unhandledRejection', onRejection);
    off('uncaughtException', onException);
  };
}
