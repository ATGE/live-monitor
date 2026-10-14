import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { store } from './store.js';
import { migrateChats, resetChatsOnBoot } from './chats.js';
import { machines, machineFor, machineViewFor } from './machine.js';
import { listProjects, projectOf, baseBranchOf } from './projects.js';
import { ensureDetachedWorktree, refreshDetachedWorktree } from './worktree.js';
import { PROJECT_WORKTREE_DIR, isHolderKey, parseHolderKey } from './keys.js';

// Pure helpers live in `keys.js` (the runner imports them and must not pull in
// this module's store); re-exported so every importer here keeps working.
export { PROJECT_WORKTREE_DIR, isHolderKey, parseHolderKey };

/**
 * The project chat: conversations that belong to a project, not to an issue.
 *
 * Their owner is a **holder** — a plain object shaped enough like a task
 * (`kind: 'project'`, `project`, `machine`, `chats`, `log`, `worktreePath`…)
 * that the chat code in `store.js`/`chats.js`/`pipeline.js` works on it
 * unchanged. A holder is never in the task store, never polled and never on
 * the board's task list; it lives in `projectchats.json` and is dispatched by
 * `store.js` on `task.kind === 'project'`.
 *
 * One holder per (project, machine). All its chats share one detached
 * worktree, `<worktreeRoot>/_proyecto`, cut from `origin/<baseBranch>` — never
 * the project's own checkout.
 */

export const HOLDER_TITLE = 'Proyecto';

const FILE_NAME = 'projectchats.json';
const FILE_VERSION = 1;
const PERSIST_DELAY_MS = 250;

const file = () => path.join(DATA_DIR, FILE_NAME);

/** key → holder. Filled by `loadProjectChats`, lazily. */
const holders = new Map();
let loaded = false;
let dirty = false;
let timer = null;
/** key → in-flight `ensureHolderWorktree`, so two chats starting at once create it once. */
const ensuring = new Map();

export const holderKey = (project, machine) => `${project}@${machine}`;

/**
 * The machines a project's chat can live on: the ones its project can stand on
 * (`machineViewFor` refuses a non-default project on a runner, deliberately).
 * Unknown project: none.
 */
export function holderMachines(projectId) {
  if (typeof projectId !== 'string' || !projectId) return [];
  return Object.keys(machines()).filter((name) => machineViewFor({ project: projectId }, name).machine);
}

function newHolder(project, machine) {
  const holder = {
    kind: 'project',
    project,
    machine,
    issue: null,
    title: HOLDER_TITLE,
    baseBranch: baseBranchOf(project),
    worktreePath: null,
    head: null,
    chats: [],
    log: [],
    updatedAt: new Date().toISOString(),
  };
  migrateChats(holder); // gives it its principal conversation
  return holder;
}

/** Reads the file once. Idempotent; a missing or unreadable file means "no holders yet". */
export function loadProjectChats() {
  if (loaded) return;
  loaded = true;
  const f = file();
  if (!existsSync(f)) return;
  let raw;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    // Keep the broken file aside rather than overwrite it with an empty one.
    console.error(`[projectchats] ${f} no se pudo leer (${e.message}); se conserva como .bad`);
    try { renameSync(f, `${f}.bad`); } catch { /* best effort */ }
    return;
  }
  for (const [key, holder] of Object.entries(raw?.holders ?? {})) {
    if (!holder || typeof holder !== 'object' || holder.kind !== 'project') continue;
    const parsed = parseHolderKey(key);
    if (!parsed) continue;
    holder.project = parsed.project;
    holder.machine = parsed.machine;
    holder.issue = null;
    holder.title = HOLDER_TITLE;
    holder.log = Array.isArray(holder.log) ? holder.log : [];
    migrateChats(holder);
    resetChatsOnBoot(holder);
    holders.set(key, holder);
  }
}

/** Test seam: forget everything in memory (the file is untouched). */
export function _resetProjectChatsForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  loaded = false;
  holders.clear();
  ensuring.clear();
}

function allowed(project, machine) {
  return Boolean(projectOf(project)) && holderMachines(project).includes(machine);
}

/** The holder of a project on a machine; created (with its principal chat) on first ask. */
export function getHolder(project, machine) {
  loadProjectChats();
  if (!allowed(project, machine)) {
    throw new Error(`No project chat for ${JSON.stringify(project)} on machine ${JSON.stringify(machine)}`);
  }
  const key = holderKey(project, machine);
  let holder = holders.get(key);
  if (!holder) {
    holder = newHolder(project, machine);
    holders.set(key, holder);
    persistHolder(holder);
  }
  // Live, not frozen: the registry may have changed the base since last time.
  holder.baseBranch = baseBranchOf(project);
  return holder;
}

/** `null` when the key is not a holder key or its holder is not allowed. */
export function getHolderByKey(key) {
  const parsed = parseHolderKey(key);
  if (!parsed) return null;
  try {
    return getHolder(parsed.project, parsed.machine);
  } catch {
    return null;
  }
}

/** Every holder of every registered project on every machine it can stand on. */
export function allHolders() {
  const out = [];
  for (const p of listProjects()) {
    for (const machine of holderMachines(p.id)) {
      const h = getHolderByKey(holderKey(p.id, machine));
      if (h) out.push(h);
    }
  }
  return out;
}

/** Writes `projectchats.json` now: tmp + rename, so a kill never leaves half a file. */
export function flushProjectChats() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty) return;
  dirty = false;
  const out = { version: FILE_VERSION, holders: Object.fromEntries(holders) };
  const f = file();
  const tmp = `${f}.tmp`;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    renameSync(tmp, f);
  } catch (e) {
    dirty = true;
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    console.error(`[projectchats] no se pudo guardar ${f}: ${e.message}`);
  }
}

/** Coalesced write, like the task store's: bursts of tool events become one write. */
export function persistHolder(holder) {
  if (holder) {
    const key = holderKey(holder.project, holder.machine);
    // A holder handed in that is not the registered one still gets saved.
    if (!holders.has(key)) holders.set(key, holder);
  }
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushProjectChats();
  }, PERSIST_DELAY_MS);
  timer.unref?.();
}

const machineOfHolder = (holder) => machineFor(holder.machine ?? 'local', holder.project);

/** The holder's detached worktree, created on first use. Resolves to its path on that machine. */
export async function ensureHolderWorktree(holder, { onLine } = {}) {
  const key = holderKey(holder.project, holder.machine);
  if (ensuring.has(key)) return ensuring.get(key);
  const job = (async () => {
    const wtPath = await ensureDetachedWorktree(
      machineOfHolder(holder), baseBranchOf(holder.project), PROJECT_WORKTREE_DIR, { onLine },
    );
    if (holder.worktreePath !== wtPath) {
      holder.worktreePath = wtPath;
      store.touch(holder);
    }
    return wtPath;
  })().finally(() => ensuring.delete(key));
  ensuring.set(key, job);
  return job;
}

/** Brings the worktree to origin/base when harmless; records what HEAD is. Resolves to `{ moved, note, head }`. */
export async function refreshHolderWorktree(holder) {
  if (!holder.worktreePath) return { moved: false, note: null, head: holder.head ?? null };
  const r = await refreshDetachedWorktree(machineOfHolder(holder), holder.worktreePath, baseBranchOf(holder.project));
  holder.head = r.head;
  store.touch(holder);
  return r;
}

// The store dispatches on `kind === 'project'` through these.
store.setHolderPersister(persistHolder);
store.setHolderFlusher(flushProjectChats);
