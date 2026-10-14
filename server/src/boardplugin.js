// Where a board-owned plugin (`plugins/<name>/` in the board's checkout) lives
// on the machine a session's CLI runs on.
//
// The SDK always runs on the board's machine; to a runner it only forwards the
// CLI's argv, cwd and env. A `--plugin-dir` path built here therefore has to be
// the runner's own path by the time the options are built, and `sessionOptions`
// is synchronous. So the runner's paths are looked up ahead of time
// (`warmBoardPlugins`) and read from a cache here.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from './config.js';
import { machines } from './machine.js';

const MANIFEST = ['.claude-plugin', 'plugin.json'];
const INFO_TIMEOUT_MS = 8_000;

/** Seam: tests point `root` at a scratch checkout. */
export const boardPluginHooks = { root: ROOT };

/** `<machine name>\0<plugin name>` -> absolute plugin directory on that machine. */
const remote = new Map();
const keyOf = (machineName, name) => `${machineName}\0${name}`;

/** Remembers the directory of a plugin on a runner. */
export function noteBoardPlugin(machineName, name, dir) {
  remote.set(keyOf(machineName, name), dir);
}

/** Forgets every remembered runner path. */
export function forgetBoardPlugins() {
  remote.clear();
}

/**
 * The directory of the board plugin `name` on `machine`, or `null` when it is
 * not there to be loaded: not on disk locally, or not known on a runner yet
 * (cold cache, an old runner that publishes no directory, a checkout that has
 * not pulled the plugin).
 *
 * @param {{kind?: string, name?: string}|null|undefined} machine
 * @param {string} name
 * @returns {string|null}
 */
export function boardPluginPath(machine, name) {
  if (machine && machine.kind !== 'local') return remote.get(keyOf(machine.name, name)) ?? null;
  const dir = path.join(boardPluginHooks.root, 'plugins', name);
  return existsSync(path.join(dir, ...MANIFEST)) ? dir : null;
}

/**
 * The plugin's directory on a runner when its manifest is there, else `null`.
 * The path is built with the RUNNER's `path`: the board's own `path.join` would
 * put a backslash in it on a Windows laptop, and on Linux that is not a separator.
 */
export async function findBoardPlugin(m, monitorDir, name) {
  const dir = m.path.join(monitorDir, 'plugins', name);
  return (await m.fs.exists(m.path.join(dir, ...MANIFEST))) ? dir : null;
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), ms).unref?.(); }),
]);

/**
 * Looks up, on every runner, where the given plugins are, and remembers the
 * ones whose manifest exists there. Never throws: a runner that is down or
 * old simply has nothing cached, and its sessions start without the plugin.
 *
 * @param {string[]} [names]
 * @returns {Promise<void>}
 */
export async function warmBoardPlugins(names = ['hfs-ux']) {
  await Promise.all(Object.values(machines()).filter((m) => m.kind !== 'local').map(async (m) => {
    try {
      const info = await withTimeout(m.info(), INFO_TIMEOUT_MS);
      if (!info?.monitorDir) return;
      for (const name of names) {
        const dir = await findBoardPlugin(m, info.monitorDir, name);
        if (dir) noteBoardPlugin(m.name, name, dir);
        else remote.delete(keyOf(m.name, name));
      }
    } catch { /* offline or old: nothing cached */ }
  }));
}
