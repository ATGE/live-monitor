/**
 * The environment a stack service is launched with: its configured env, any
 * per-launch extras (the seeded HTS database), and the port it was handed.
 *
 * HFS also gets its own base URL. HFS advertises that URL in every absolute
 * link and calls itself through it — the UI's Bulk Import posts `$bulk-submit`
 * there. Unset, it defaults to `http://localhost:8080`, which is some other
 * server or none at all, so an import from a task's HFS failed or landed on the
 * wrong one. Only the port picked at launch can say which, hence it lives here
 * and not in `config.json`. A configured `HFS_BASE_URL` still wins.
 *
 * A service that declares no `portEnv` gets no port variable at all. Written as
 * one computed key it produced a variable named literally `undefined`, because
 * that is what an object key stringifies to — junk in the launched process's
 * environment, and a missing setting hidden instead of visible. The port is
 * still applied last, so a stale one in the configured env never wins.
 */
export function serviceEnv(name, spec, port, extra) {
  // `{port}` in a value is the port the board allocated (command services).
  const env = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    env[k] = typeof v === 'string' ? v.replaceAll('{port}', String(port)) : v;
  }
  Object.assign(env, extra ?? {});
  if (spec.portEnv) env[spec.portEnv] = String(port);
  if (name === 'hfs' && !env.HFS_BASE_URL) env.HFS_BASE_URL = `http://127.0.0.1:${port}`;
  return env;
}
