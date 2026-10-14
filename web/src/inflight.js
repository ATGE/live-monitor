/**
 * One request per action and task at a time. No React here, so the node tests
 * can import it.
 *
 * A button that stays live while its request runs invites a second click, and
 * the server would run the action twice (or refuse the repeat as a failure
 * after the first succeeded). `run` drops a call whose key is already in
 * flight; the key is released in a `finally`, so a failure does not lock the
 * button.
 */

/** `<action>:<project>#<issue>`, so the same issue of two projects never collides. */
export const actionKey = (action, project, issue) => `${action}:${project}#${issue}`;

/**
 * @param {(keys: Set<string>) => void} [onChange] called with a fresh copy of the
 *   in-flight keys whenever one is added or released (feeds a React state).
 */
export function createInflight(onChange) {
  const keys = new Set();
  const notify = () => { if (onChange) onChange(new Set(keys)); };
  return {
    has: (key) => keys.has(key),
    /**
     * Runs `fn` unless `key` is in flight. Resolves to `fn`'s result, or to
     * `undefined` when the call was dropped. The key is taken synchronously, so
     * two calls from the same tick cannot both pass.
     */
    run(key, fn) {
      if (keys.has(key)) return Promise.resolve(undefined);
      keys.add(key);
      notify();
      let started;
      try { started = Promise.resolve(fn()); } catch (e) { started = Promise.reject(e); }
      return started.finally(() => { keys.delete(key); notify(); });
    },
  };
}
