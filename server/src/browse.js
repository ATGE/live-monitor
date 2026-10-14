import express from 'express';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { machines } from './machine.js';
import { listProjects } from './projects.js';
import { rootPlace, dangerousOnWindows } from './files.js';
import { isDirectLoopback } from './access.js';

/**
 * The folder browser behind the "import a project" dialog.
 *
 * The dialog used to ask for `repoPath` and `worktreeRoot` typed by hand. The
 * browser's own file picker cannot replace that: it never hands a page an
 * absolute path, and from a phone it would browse the phone. So the board
 * lists its own disk — but as narrowly as a browser can be:
 *
 * - **names only, never contents.** No bytes are ever read here. What comes
 *   back is the names of directories, and whether each one looks like a git
 *   checkout;
 * - **declared roots only**, see {@link browseRoots};
 * - **from this machine only**: the route answers `isDirectLoopback` and
 *   nothing else.
 *
 * ### Why the loopback rule has a visible side effect
 *
 * Opened by its MagicDNS name (`<host>.<tailnet>.ts.net`), the board is served
 * through `tailscale serve`, which forwards from loopback *with* proxy headers
 * — exactly what `isDirectLoopback` refuses. So on the board's own machine, in
 * a tab opened by that name, the browse button will not work and the 403 is
 * the only explanation anyone gets: it has to say "open it on
 * http://localhost:7420". That is deliberate. The alternative, trusting the
 * socket address alone, would hand the whole home directory's folder names to
 * anyone on the tailnet.
 *
 * ### Why `node:fs` directly and not `machine.fs`
 *
 * The loopback rule means the disk being browsed is this process's disk, by
 * construction: no runner is ever browsed. And the abstraction would buy
 * nothing here — `LocalFs.readdir` (`machine.js:166`) returns bare names with
 * no entry type, and `realpath` does not say whether it landed on a directory
 * — while widening it is somebody else's file. From `machines().local` this
 * module takes only `path` (the machine's path arithmetic) and `samePath`.
 */

const OUTSIDE = 'Fuera de las carpetas permitidas';

const isWin = (m) => m.platform === 'win32';
const toSlash = (p) => String(p).replace(/\\/g, '/');
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Seams for tests: a test must not list the real home, and proving the cap
 * works should not cost two thousand `mkdir`s.
 */
export const browseHooks = {
  homeDir: () => os.homedir(),
  // A `node_modules` under the home has tens of thousands of subfolders.
  maxEntries: 2000,
};

/**
 * The folders this machine will browse: the **parent** of every registered
 * project's `repoPath`, plus the home directory, resolved through `realpath`
 * and deduplicated.
 *
 * **Not `allowedRoots` (`files.js`), and never to be merged with it.** They
 * are different notions on both axes. `allowedRoots` says where the viewer may
 * serve *bytes* from, and it is narrow on purpose: worktrees, checkouts, the
 * plans folder, the scratchpad. These say where *names of folders* may be
 * listed, and they are far wider — the whole home directory is one of them,
 * because that is where a checkout someone wants to import usually lives.
 * Unify them and one of two things breaks: either the viewer starts serving
 * the bytes of everything under `~`, or this browser loses the home and stops
 * being able to find anything.
 *
 * Resolved on every request, never cached: a folder created a second ago has
 * to show up without restarting the board.
 *
 * @returns {Promise<string[]>} absolute, symlink-resolved, in the machine's
 *   own spelling (comparison form, not the wire form).
 */
export async function browseRoots() {
  const m = machines().local;
  const wanted = [];
  // `samePath`, not a `Set`: the home arrives from `os.homedir()` with
  // backslashes (`C:\Users\you`) and the registry's paths with forward ones
  // (`C:/Users/you/src/...`). Two spellings of one folder, which string
  // equality would keep apart.
  const add = (dir) => {
    if (typeof dir !== 'string' || !dir) return;
    if (!wanted.some((w) => m.samePath(w, dir))) wanted.push(dir);
  };
  for (const p of listProjects()) add(m.path.dirname(p.repoPath));
  add(browseHooks.homeDir());

  const real = [];
  for (const dir of wanted) {
    let resolved;
    try {
      resolved = await fsp.realpath(dir);
    } catch {
      // A root that is not there is not a root (`files.js:338-341`): the
      // registry may still name a `repoPath` deleted since, and that is not a
      // reason to answer 500 for every other folder on the disk.
      continue;
    }
    // The roots are resolved because the containment check on the real path
    // (step 4) compares against real paths: a `hfs-wt` that is a junction
    // would otherwise match nothing at all.
    if (!real.some((r) => m.samePath(r, resolved))) real.push(resolved);
  }
  return real;
}

/**
 * `p` is one of the roots, or inside one. Pure path arithmetic — the disk is
 * not asked.
 *
 * `rootPlace` (`files.js`) does the Windows case folding and the POSIX
 * backslash defence, and is reused rather than reimplemented. Its `isInside`
 * excludes `rel === ''`, i.e. a root is not "inside" itself, so the root has
 * to be matched on its own with `samePath`.
 */
function inRoots(m, roots, p) {
  return roots.some((r) => m.samePath(r, p)) || rootPlace(m, { main: roots }, p) === 'main';
}

/**
 * Absolute *on this machine*, strictly. `path.win32.isAbsolute('/Users/you')`
 * answers true and `resolve` then silently staples the cwd's drive letter onto
 * it, which would turn a POSIX-looking path into a real Windows one behind the
 * caller's back. On Windows only a drive-rooted path counts; a UNC name is
 * absolute too and is refused before this, by shape.
 */
const absoluteHere = (m, p) => (isWin(m) ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/'));

/** A path through a `.git` folder: its config holds remotes, and those hold tokens. */
const hasGitSegment = (p) => String(p).split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git');

/** Case-insensitive, with the exact spelling as the tiebreak so the order is total. */
function byName(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Whether a folder is a checkout someone could import: `.git` has to be a
 * **directory**. Every worktree under `hfs-wt/` has a `.git`, and it is a
 * *file* pointing back at the real repository — with a mere existence check
 * the browser would offer every worktree as importable.
 */
const isGitRepo = (m, dir) => fsp.stat(m.path.join(dir, '.git')).then((st) => st.isDirectory(), () => false);

/** What a disk error about `p` means to a caller. */
function fsError(e, p) {
  if (e?.status) return e;
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return httpError(404, `Not found: ${p}`);
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return httpError(403, `No permission to read: ${p}`);
  return httpError(500, `Could not read ${p}: ${e?.message}`);
}

/**
 * One listing.
 *
 * With no path it is the roots themselves, which is why every entry carries
 * its own absolute `path`: the client navigates by that string and never
 * concatenates anything, so the roots are just another listing and no Windows
 * path arithmetic ever happens in a browser.
 *
 * Paths go out in canonical forward-slash form (as `files.js:539` does) —
 * they end up in `projects.json`, and from there in prompts and in the
 * pipeline's bash command lines, where two spellings would be a problem
 * waiting to happen. Only the *comparison* uses `path.win32`.
 *
 * @param {string|null} requested
 * @returns {Promise<{path: string|null, parent: string|null,
 *   entries: Array<{name: string, path: string, isGit: boolean}>,
 *   truncated: boolean}>}
 */
export async function browse(requested) {
  const m = machines().local;
  const roots = await browseRoots();

  if (requested === null || requested === undefined || requested === '') {
    const entries = await mapLimit(roots, 16, async (dir) => ({
      // A drive root (`C:\`) has no basename; it is its own name.
      name: m.path.basename(dir) || toSlash(dir),
      path: toSlash(dir),
      isGit: await isGitRepo(m, dir),
    }));
    entries.sort((a, b) => byName(a.name, b.name));
    return { path: null, parent: null, entries, truncated: false };
  }

  const p = String(requested);

  // 1. By shape, before the disk is touched at all. On Windows a UNC name
  //    makes the system open an SMB connection — handing over the user's NTLM
  //    hash — just to resolve it, and `realpath` is one of the calls that does
  //    it. Reused from `files.js`, never copied: a second security regex is a
  //    second thing to drift. Only the *requested* path is judged this way,
  //    never what `realpath` answers: a root on a network drive legitimately
  //    resolves to a UNC path.
  if (dangerousOnWindows(m, p)) throw httpError(400, `Path not allowed: ${p}`);
  if (!absoluteHere(m, p)) throw httpError(400, `The path must be absolute: ${p}`);
  if (hasGitSegment(p)) throw httpError(400, `The browser does not enter .git: ${p}`);

  // 2. Containment on the normalised path, still with no disk call. The order
  //    matters: asking the disk first would answer 404 for a folder that is
  //    not there and 403 for one that is, and that difference alone tells
  //    anyone whether `C:\Users\otro\secreto` exists.
  if (!inRoots(m, roots, p)) throw httpError(403, `${OUTSIDE}: ${p}`);

  // 3. Now the disk.
  let real;
  try {
    real = await fsp.realpath(p);
  } catch (e) {
    throw fsError(e, p);
  }

  // 4. And containment again, where it really landed: a link inside a root
  //    that points outside it is outside. The message is the one from step 2,
  //    word for word and naming the requested path, so a refusal never says
  //    whether the folder exists nor where a link pointed.
  if (!inRoots(m, roots, real)) throw httpError(403, `${OUTSIDE}: ${p}`);

  let st;
  try {
    // `realpath` does not say what it found (`machine.js:140-147` returns
    // `isFile`, and `!isFile` is not "directory"), so this is asked explicitly.
    st = await fsp.stat(real);
  } catch (e) {
    throw fsError(e, p);
  }
  if (!st.isDirectory()) throw httpError(400, `Not a folder: ${p}`);

  let dirents;
  try {
    dirents = await fsp.readdir(real, { withFileTypes: true });
  } catch (e) {
    throw fsError(e, p);
  }

  // Directories only, and symlinks and junctions are not directories here:
  // `withFileTypes` reports them as links, so filtering on `isDirectory()`
  // drops them by itself. That is the policy, not an accident — showing a link
  // and then refusing to enter it (step 4 would) is worse than not showing it.
  //
  // Dot folders are left out too. Their names alone would tell anyone reaching
  // this that the home holds `.ssh`, `.gnupg` or `.aws`, which is more than
  // the board says about itself anywhere else.
  const names = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(byName);
  const max = browseHooks.maxEntries;
  const truncated = names.length > max;
  const entries = await mapLimit(names.slice(0, max), 32, async (name) => {
    const full = m.path.join(real, name);
    return { name, path: toSlash(full), isGit: await isGitRepo(m, full) };
  });

  const up = m.path.dirname(real);
  // No parent at the top of a drive (`dirname` stops moving), and none out of
  // the roots: the client asks for the roots listing instead.
  const parent = m.samePath(up, real) || !inRoots(m, roots, up) ? null : toSlash(up);
  return { path: toSlash(real), parent, entries, truncated };
}

export const browseRouter = express.Router();

/**
 * Mounted after `accessGuard` (`index.js`) and before `express.json`: it needs
 * no body, and from the guard it inherits the `Host` check and the refusal of
 * cross-site GETs, which together are what keeps a DNS-rebinding page from
 * walking the disk through a browser that is already on this machine.
 */
browseRouter.get('/api/browse', async (req, res) => {
  res.set({ 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (!isDirectLoopback(req)) {
    return res.status(403).json({
      error: 'The folder browser only answers from the board machine itself. '
        + 'Open it at http://localhost:7420: via the MagicDNS name the request goes through '
        + '`tailscale serve` and arrives with proxy headers, so it is not valid from here either.',
    });
  }
  try {
    const raw = req.query.path;
    if (raw !== undefined && typeof raw !== 'string') throw httpError(400, 'A single path, or none');
    return res.json(await browse(raw ?? null));
  } catch (e) {
    return res.status(e.status ?? 500).json({ error: e.message });
  }
});
