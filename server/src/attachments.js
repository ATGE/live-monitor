import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { DEFAULT_PROJECT_ID, PROJECT_WORKTREE_DIR, coerceKey, parseKey, isHolderKey, parseHolderKey } from './keys.js';

const ROOT_DIR = path.join(DATA_DIR, 'attachments');
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Is `p` an absolute path strictly inside the attachments folder? Only those
 * may be handed to a chat turn: the websocket message carries paths, and an
 * arbitrary one would let a client make Claude read (or the board upload) any
 * file on the machine. A relative path is refused rather than resolved against
 * the board's cwd; the folder itself, `..` escapes, other drives and sibling
 * directories sharing a prefix (`attachments-x`) are out too. It checks the
 * path only, not that the file exists.
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isAttachmentPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return false;
  const rel = path.relative(ROOT_DIR, path.resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The entries of a chat message's `attachments` the board will honour: objects
 * whose `path` passes {@link isAttachmentPath}. The originals come back (so
 * `name` is kept); anything that is not an array gives `[]`.
 *
 * @param {unknown} list
 * @returns {object[]}
 */
export function acceptedAttachments(list) {
  return Array.isArray(list) ? list.filter((a) => a && typeof a === 'object' && isAttachmentPath(a.path)) : [];
}

/**
 * Where a task's attachments live: `attachments/<project>/<issue>/`.
 *
 * `ref` is a canonical key (`'hfs#12'`) or a bare issue number — the routes in
 * `index.js` hand over `keyOf(task)` — and a bare number means the default project,
 * exactly as `coerceKey` reads it. The composite key is never a path segment:
 * the two halves travel as two directories.
 *
 * A project chat's holder key (`hfs@local`) maps to `attachments/<project>/_proyecto/`:
 * the machine is not a directory (uploads always land on the board, and
 * `putAttachment` carries them to the machine), and the key is never a segment.
 *
 * @param {string|number} ref a task key, an issue number or a holder key.
 * @returns {string|null} an absolute directory, or `null` when `ref` is junk.
 */
function dirOf(ref) {
  if (isHolderKey(ref)) return path.join(ROOT_DIR, parseHolderKey(ref).project, PROJECT_WORKTREE_DIR);
  const key = coerceKey(ref);
  if (!key) return null;
  const { projectId, issue } = parseKey(key);
  return path.join(ROOT_DIR, projectId, String(issue));
}

/**
 * The pre-project location, `attachments/<issue>/`. Read only, and only for the
 * default project: what is already on disk was written there, and every message
 * that references it holds an absolute path, so nothing breaks — but a listing
 * of an old task would come back empty without this.
 *
 * @returns {string|null} the legacy directory, or `null` for any other project.
 */
function legacyDirOf(ref) {
  const key = coerceKey(ref);
  if (!key) return null;
  const { projectId, issue } = parseKey(key);
  return projectId === DEFAULT_PROJECT_ID ? path.join(ROOT_DIR, String(issue)) : null;
}

/**
 * Files the user attaches to a chat turn. They are written outside the worktree
 * — attaching a screenshot must never dirty the repo — and handed to Claude as
 * absolute paths, which its Read tool opens directly (images included).
 */
export function saveAttachment(ref, { name, dataBase64 }) {
  const raw = String(dataBase64 ?? '').replace(/^data:[^;]*;base64,/, '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) throw new Error('The file arrived empty');
  if (bytes.length > MAX_BYTES) {
    throw new Error(`The file exceeds the limit of ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  }

  // Keep the extension (Read picks the viewer from it) and drop everything
  // else: the name comes from the browser and must not steer the path.
  const safe = path.basename(String(name ?? 'archivo'))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-80) || 'archivo';

  const dir = dirOf(ref);
  if (!dir) throw new Error(`Cannot tell which task this attachment belongs to:${JSON.stringify(ref)}`);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${safe}`);
  writeFileSync(target, bytes);

  return { name: safe, path: target, bytes: bytes.length };
}

export function listAttachments(ref) {
  const read = (dir) => {
    if (!dir) return [];
    try {
      return readdirSync(dir).map((f) => {
        const full = path.join(dir, f);
        return { name: f, path: full, bytes: statSync(full).size };
      });
    } catch {
      return [];
    }
  };

  // What is on disk today first, then the current location on top of it: a name
  // written since the move wins over an older file that happens to share it.
  const byName = new Map();
  for (const file of [...read(legacyDirOf(ref)), ...read(dirOf(ref))]) byName.set(file.name, file);
  return [...byName.values()];
}
