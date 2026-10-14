import { readFileSync, watchFile } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

// HFSMON_DATA_DIR isolates a second instance's state from the live one.
export const DATA_DIR = process.env.HFSMON_DATA_DIR ?? path.join(ROOT, 'server', 'data');

// HFSMON_CONFIG points the server at an alternative config file — used to
// exercise the board against a controlled set of tasks.
//
// Under test, with no explicit HFSMON_CONFIG, the checked-in fixture is used
// instead of the real file (which holds tokens and the real machines), and it is
// not watched: a reload would wipe what tests inject into `config`. The node
// test runner marks its children with NODE_TEST_CONTEXT; a file run directly
// (`node --test x.test.mjs` or `node x.test.mjs`) is recognised by argv[1].
// With `--test-isolation=none` there is no NODE_TEST_CONTEXT and argv[1] arrives
// as typed (relative), so it is resolved before matching. The guard stays outside
// `path.resolve`, which throws on undefined (`node -e`).
const TEST_FIXTURE = path.join(ROOT, 'server', 'test', 'fixtures', 'config.test.json');
const entryScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
const underTest = Boolean(process.env.NODE_TEST_CONTEXT)
  || /[\\/]server[\\/]test[\\/][^\\/]+\.test\.mjs$/.test(entryScript);
export const CONFIG_IS_TEST_FIXTURE = !process.env.HFSMON_CONFIG && underTest;
export const CONFIG_FILE = process.env.HFSMON_CONFIG
  ?? (CONFIG_IS_TEST_FIXTURE ? TEST_FIXTURE : path.join(ROOT, 'config.json'));

// Secrets and per-machine values live next to the tracked file, gitignored, and
// are merged over it at load time: `config.local.json` beside `config.json`.
// Objects merge recursively so `access.token` can be overridden on its own;
// arrays and scalars replace. A missing local file is the normal case.
export const LOCAL_FILE = CONFIG_FILE.replace(/\.json$/, '.local.json');

/**
 * Deep-merges `extra` over `base` and returns `base`. **Mutates its first
 * argument** — it is how the local overlay is folded into the loaded config
 * above, and `projects.js` reuses it to apply a project's overrides, which is
 * why that caller hands it a `structuredClone` of `config` rather than `config`.
 *
 * Objects merge recursively; arrays and scalars replace wholesale.
 */
export function mergeInto(base, extra) {
  for (const [key, value] of Object.entries(extra)) {
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isObject(value) && isObject(base[key])) mergeInto(base[key], value);
    else base[key] = value;
  }
  return base;
}

function readLocal() {
  try {
    return JSON.parse(readFileSync(LOCAL_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

const load = () => mergeInto(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), readLocal());

/**
 * The live configuration. Always the SAME object: reloading replaces its
 * contents in place, so every module that did `import { config }` keeps seeing
 * current values without re-importing. Read fields at the point of use (not
 * into a module-level constant) for that to hold.
 */
export const config = load();

export const configEvents = new EventEmitter();

/** Values baked in before any reload can reach them. */
const RESTART_REQUIRED = ['port'];

function reload() {
  let next;
  try {
    next = load();
  } catch (e) {
    // A half-written file (editors truncate then write) or a typo: keep the
    // configuration we already have rather than running on a broken one.
    configEvents.emit('invalid', e);
    return;
  }

  const stale = RESTART_REQUIRED.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(config[k]));
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
  configEvents.emit('change', { config, needsRestart: stale });
}

// watchFile polls the mtime instead of watching an inode, so it survives the
// save-by-replace that most editors do.
const onChange = (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) reload();
};
if (!CONFIG_IS_TEST_FIXTURE) {
  const watcher = watchFile(CONFIG_FILE, { interval: 2000 }, onChange);
  // The local overlay is watched too: editing a token or a machine path must
  // take effect on the next phase, exactly like the tracked file does.
  const localWatcher = watchFile(LOCAL_FILE, { interval: 2000 }, onChange);
  // Don't hold the event loop open on this alone: the server stays alive through
  // its own handles, while a one-off script that imports the config still exits.
  watcher.unref?.();
  localWatcher.unref?.();
}
