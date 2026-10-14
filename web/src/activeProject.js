// Which project this screen is looking at. On this device only, like
// `lastChat.js` keeps the last conversation: the board is open on a laptop and
// on a phone at once, and changing project on one must not change it on the
// other. The snapshot's `activeProject` is only the project the board OPENS
// on — the first of `projects[]` — never a stored selection.

const KEY = 'hfsmon-active-project';

/** What this device chose last, or null (never chosen, or storage blocked). */
export function readActiveProject() {
  try {
    const value = localStorage.getItem(KEY);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;   // private mode, blocked storage
  }
}

export function rememberActiveProject(id) {
  if (!id) return;
  try {
    localStorage.setItem(KEY, id);
  } catch { /* private mode */ }
}

/**
 * The project to show: this device's choice when the registry still has it,
 * otherwise what the board opens on, otherwise the first project it knows.
 * A project that was imported on another device — or removed — must not leave
 * the board looking at nothing.
 */
export function pickActiveProject(projects, opensOn, stored = readActiveProject()) {
  const ids = (projects ?? []).map((p) => p.id);
  if (stored && ids.includes(stored)) return stored;
  if (opensOn && ids.includes(opensOn)) return opensOn;
  return ids[0] ?? opensOn ?? null;
}
