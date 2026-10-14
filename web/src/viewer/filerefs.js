/**
 * Recognises file references in chat text — `tmp/user/docs/937-plan.md`,
 * `crates/hfs/README.md:352`, `C:\Users\…\x.md`, `README-corrida.md` — so the
 * chat can open them in the file viewer.
 *
 * Deliberately permissive: any single token with an allowed extension counts.
 * The viewer says so when it finds nothing, so a false positive is cheap and a
 * missed reference is not. The position suffixes and the extension rule follow
 * `parseRef`/`kindOf` in `server/src/files.js`.
 */

// Mirror of `FILE_KINDS` in `server/src/files.js`. Keep the two lists identical:
// a ref the web accepts but the server rejects opens an empty viewer, and one
// the server serves but the web rejects is never clickable.
export const FILE_KINDS = {
  md: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
  text: ['txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'rs', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'ps1', 'css', 'html', 'xml', 'sql', 'csv', 'ini', 'cfg', 'conf', 'lock', 'diff', 'patch'],
};

const KIND_BY_EXT = new Map(
  Object.entries(FILE_KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])),
);

const MAX_REF_LENGTH = 400;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DRIVE_RE = /^[a-z]:[\\/]/i;
const FORBIDDEN_RE = /[\s*?<>|"{}]/;
// GitHub's `#L12` / `#L12-L20`, then `:N`, `:N:M` or `:N-M`; a range keeps its first line.
const ANCHOR_RE = /^(.+?)#L(\d+)(?:-L?\d+)?$/;
const SUFFIX_RE = /^(.+?):(\d+)(?:([:-])(\d+))?$/;

/**
 * `'md' | 'image' | 'text' | null`, from the extension of `path` (case-insensitive).
 * Note: the server's `kindOf` returns `{ kind, lang, ext }` instead of a string.
 */
export function kindOf(path) {
  const name = String(path ?? '').split(/[\\/]/).pop();
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? KIND_BY_EXT.get(m[1].toLowerCase()) ?? null : null;
}

/** `{ path, line, col }` for a file reference, or null. `line`/`col` are null when absent. */
export function parseRef(text) {
  if (typeof text !== 'string') return null;
  const ref = text.trim();
  if (!ref || ref.length > MAX_REF_LENGTH || FORBIDDEN_RE.test(ref)) return null;
  // A URL, except a Windows drive however it is written (`C:\`, `C:/`, `C://`).
  if (URL_RE.test(ref) && !DRIVE_RE.test(ref)) return null;
  // `-x.md` is a command-line flag far more often than a file.
  if (ref.startsWith('-')) return null;

  let path = ref;
  let line = null;
  let col = null;
  const anchor = ANCHOR_RE.exec(ref);
  const suffix = anchor ? null : SUFFIX_RE.exec(ref);
  if (anchor) {
    path = anchor[1];
    line = Number(anchor[2]);
  } else if (suffix) {
    path = suffix[1];
    line = Number(suffix[2]);
    if (suffix[3] === ':') col = Number(suffix[4]);
  }

  const name = path.split(/[\\/]/).pop();
  // `.md` or `.ps1` on its own is an extension being talked about, not a file.
  if (!name || /^\.[a-z0-9]+$/i.test(name)) return null;
  if (!kindOf(path)) return null;
  return { path, line, col };
}

export function isFileRef(text) {
  return parseRef(text) !== null;
}
