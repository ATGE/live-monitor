// The chat last looked at in each task, on this device: going back to a task's
// tab lands there, the way an editor tab keeps its place. Per device on
// purpose — the tab list is shared, what each screen is looking at is not.
//
// Keyed by the composite key `<project>#<issue>` (`taskKey.js`): issue #12 of
// two repositories are two tasks, and they used to share this entry. A project
// chat's holder is keyed `<project>@<machine>`.

const KEY = 'hfsmon-last-chat';

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};   // private mode, blocked storage, or a mangled value
  }
}

/** @param {string} key `<project>#<issue>`, or `<project>@<machine>` for a holder. */
export function lastChatOf(key) {
  return readAll()[key] ?? null;
}

/** @param {string} key `<project>#<issue>`, or `<project>@<machine>` for a holder. */
export function rememberChat(key, chatId) {
  if (!key || !chatId) return;
  const all = readAll();
  if (all[key] === chatId) return;
  all[key] = chatId;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}
