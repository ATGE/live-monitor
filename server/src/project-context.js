/**
 * What the watched project says about itself, for the prompts.
 *
 * The board carries hfs knowledge inside its own templates today — the crate
 * names in `triage.md`, the `cargo fmt -p` line in `fix.md`, the Windows `nul`
 * trap. That works while there is one watched project and stops working the
 * moment there are two. The seam is this module: the prompt keeps a
 * `{{projectContext}}` line, and the text that fills it comes from the
 * repository that actually knows, as a descriptor file committed there.
 *
 * ## Always the main checkout, never a task's worktree
 *
 * `projectContextFor` is given `repoPath` — the project's main checkout — and
 * nothing else. A task runs in a worktree of that repository, and a session
 * working in the worktree can edit any file in it, the descriptor included. If
 * the descriptor were read from the worktree, an agent could rewrite the text
 * that describes how its own work is judged, and the next phase of the same
 * task would be briefed by it. Reading from the main checkout costs nothing
 * and removes the question: the agent resolving a task does not get to choose
 * what it is evaluated with.
 *
 * ## Two names, one meaning
 *
 * `.board/project.md` is the name for any project; `.hfs-monitor/project.md`
 * is what the hfs checkout already has, and is kept as a fallback so nothing
 * over there has to move for this to land. The first that exists wins.
 *
 * ## Hot reload
 *
 * Cached by `mtimeMs`, the same way `read()` caches templates in
 * `prompts.js:104-142`: the file is `stat`ed on every call and re-read only
 * when it moved. Editing the descriptor therefore shows up in the next
 * rendered prompt without restarting the board.
 *
 * No descriptor, no `repoPath`, unreadable file: the answer is `''`. An empty
 * string renders as nothing, so a project that never writes a descriptor gets
 * the prompt it gets today.
 *
 * @module project-context
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Where a descriptor may live inside a checkout, in order of preference.
 * Relative paths, joined onto `repoPath` by {@link projectContextFor}.
 *
 * @type {string[]}
 */
export const DESCRIPTOR_PATHS = [
  path.join('.board', 'project.md'),
  path.join('.hfs-monitor', 'project.md'),
];

/**
 * `repoPath` -> the descriptor it resolved to last time.
 *
 * Keyed by checkout, not by file, because which of the two names wins can
 * change: a project that gains a `.board/project.md` must stop serving the
 * `.hfs-monitor` one, and that is only visible if the resolved path is part of
 * what the cache compares.
 *
 * @type {Map<string, {file: string, mtimeMs: number, text: string}>}
 */
const cache = new Map();

/**
 * The first descriptor that exists under `repoPath`, with its mtime.
 *
 * @param {string} repoPath
 * @returns {{file: string, mtimeMs: number}|null} `null` when neither name exists.
 */
function locate(repoPath) {
  for (const rel of DESCRIPTOR_PATHS) {
    const file = path.join(repoPath, rel);
    try {
      const st = statSync(file);
      if (st.isFile()) return { file, mtimeMs: st.mtimeMs };
    } catch {
      // Not there (or not readable): try the next name.
    }
  }
  return null;
}

/**
 * The project's descriptor text, ready to be substituted into a prompt.
 *
 * Returned verbatim, trailing newline included: that newline is what separates
 * the block from whatever line follows it in the template.
 *
 * @param {{repoPath?: string}} [options] the project's **main checkout**, not a worktree.
 * @returns {string} the descriptor, or `''` when there is none.
 */
export function projectContextFor({ repoPath } = {}) {
  if (typeof repoPath !== 'string' || repoPath === '') return '';

  const found = locate(repoPath);
  if (!found) {
    // The descriptor was deleted: stop serving the copy we still hold.
    cache.delete(repoPath);
    return '';
  }

  const cached = cache.get(repoPath);
  if (cached && cached.file === found.file && cached.mtimeMs === found.mtimeMs) return cached.text;

  let text;
  try {
    text = readFileSync(found.file, 'utf8');
  } catch {
    // Half-written, or vanished between the stat and the read: keep serving
    // the last good version rather than briefing a phase with nothing.
    return cached ? cached.text : '';
  }

  cache.set(repoPath, { file: found.file, mtimeMs: found.mtimeMs, text });
  return text;
}
