/**
 * What the board remembers in this browser: the side panel's width, the
 * composer's height, the speed the QA videos play at. One copy of the three
 * lines, because every caller needs the same two guards — a key that was never
 * written, and a `localStorage` that throws (private mode, storage disabled,
 * a quota that is full).
 *
 * Values are stored as JSON, so `false` and `0` survive the round trip.
 */
export const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
};

export const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export const clear = (key) => {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
};

/* ---------- half-typed prompts, one per conversation ---------- */

const DRAFTS_KEY = 'hfsmon-chat-drafts';
// How many conversations keep a draft. Every chat ever opened would write to
// the same key forever; the ones you are actually in the middle of are few.
const DRAFT_LIMIT = 40;

/** What is stored: `{ [chatId]: { text, at } }`, however mangled. */
const storedDrafts = () => {
  const all = read(DRAFTS_KEY, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
};

/** `{ [chatId]: text }` — the shape the chat keeps in memory. */
export const readDrafts = () => {
  const out = {};
  for (const [id, entry] of Object.entries(storedDrafts())) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    if (typeof text === 'string' && text) out[id] = text;
  }
  return out;
};

/**
 * Mirrors one conversation's draft. An empty draft deletes its entry, and
 * only the most recent `DRAFT_LIMIT` survive — but the conversation being
 * written is held out of that sort and put back first, so it can never be
 * the one pruned, whatever its neighbours' stamps say (they can all share a
 * millisecond, and then the tie-break is arbitrary).
 */
export const saveDraft = (chatId, text) => {
  const all = storedDrafts();
  const mine = text ? { text, at: Date.now() } : null;
  const others = Object.entries(all)
    .filter(([id]) => id !== chatId)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, DRAFT_LIMIT - (mine ? 1 : 0));
  write(DRAFTS_KEY, Object.fromEntries(mine ? [[chatId, mine], ...others] : others));
};
