/**
 * Project profiles: the starting overrides and detection rules for a new
 * project, keyed by a short id stored in the registry entry's `kind`.
 *
 * Everything here is pure or read-only. A profile never names a stack the
 * project does not have: `e2e`, `stack` and `qa` are REPLACED whole by a
 * project's overrides (see `REPLACED_WHOLE` in projects.js), so `null` means
 * "this project has none", not "inherit hfs's". The `aidlc`
 * profile is the one exception: its `e2e` is `{}` ("a suite will be declared,
 * install nothing meanwhile"), because `null` would autodetect an install.
 *
 * This module must not import `projects.js` (which imports it).
 *
 * @module profiles
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} label short Spanish name for the UI.
 * @property {Object} overrides the registry `overrides` a new project starts with.
 */

/** @type {Readonly<Record<string, Profile>>} */
export const PROFILES = Object.freeze({
  'node-web': {
    id: 'node-web',
    label: 'Aplicación web Node',
    // Only the install step: test commands are never invented, see
    // `detectTestScript`.
    overrides: { e2e: { installCommand: 'npm install' }, stack: null, qa: null },
  },
  python: {
    id: 'python',
    label: 'Proyecto Python',
    overrides: { e2e: null, stack: null, qa: null },
  },
  'cli-lib': {
    id: 'cli-lib',
    label: 'Herramienta de línea de comandos o biblioteca',
    overrides: { e2e: null, stack: null, qa: null },
  },
  'docs-research': {
    id: 'docs-research',
    label: 'Documentación o investigación',
    overrides: { e2e: null, stack: null, qa: null },
  },
  // A repository that follows the AIDLC / AI-SDLC documentation-driven
  // framework declares its own verification. `e2e` is an EMPTY object, not
  // null: null would autodetect manifests and run `npm install` (wrong for a
  // pnpm monorepo), while an `e2e` without `installCommand` installs nothing
  // and, without `testCommand`, skips the test phase (verification: none).
  aidlc: {
    id: 'aidlc',
    label: 'Proyecto AIDLC (guiado por documentos)',
    overrides: { e2e: {}, stack: null, qa: null },
  },
  blank: {
    id: 'blank',
    label: 'Proyecto en blanco',
    overrides: { e2e: null, stack: null, qa: null },
  },
});

export const PROFILE_IDS = Object.freeze(Object.keys(PROFILES));

export const isProfileId = (v) => typeof v === 'string' && Object.hasOwn(PROFILES, v);

/**
 * The overrides a new project of this profile starts with: a fresh deep copy,
 * so a caller may edit it.
 *
 * @param {string} id
 * @returns {Object}
 * @throws {Error} on an unknown profile.
 */
export function overridesOf(id) {
  if (!isProfileId(id)) throw new Error(`perfil desconocido ${JSON.stringify(id ?? null)}`);
  return structuredClone(PROFILES[id].overrides);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The framework's own state: any one of these marks an AIDLC / AI-SDLC checkout. */
function hasAidlcMarker(repoPath) {
  return isFile(path.join(repoPath, 'aidlc-docs', 'aidlc-state.md'))
    || isDir(path.join(repoPath, '.aws-aidlc-rule-details'))
    || isFile(path.join(repoPath, 'docs', 'ai-sdlc', 'state', 'workflow-state.md'));
}

/**
 * Looks at the manifests in `repoPath` and names the profile that fits.
 * Read-only; never throws.
 *
 * - the framework's own state wins over any manifest: `aidlc-docs/aidlc-state.md`
 *   (file), `.aws-aidlc-rule-details` (directory) or
 *   `docs/ai-sdlc/state/workflow-state.md` (file) is `aidlc`;
 * - `package.json` with a `bin` field and no web-ish dependency is `cli-lib`,
 *   any other `package.json` is `node-web`;
 * - `pyproject.toml` / `requirements*.txt` / `setup.py` is `python`;
 * - `Cargo.toml` / `go.mod` is `cli-lib`;
 * - nothing but markdown and other non-code files is `docs-research`;
 * - an empty directory (or one holding only `.git`), or an unreadable path, is `blank`.
 *
 * @param {string} repoPath
 * @returns {string} a profile id.
 */
export function detectProfile(repoPath) {
  const entries = repoPath ? listDir(repoPath) : null;
  if (!entries) return 'blank';
  const files = entries.filter((n) => n !== '.git');
  if (!files.length) return 'blank';
  if (hasAidlcMarker(repoPath)) return 'aidlc';

  const pkg = existsSync(path.join(repoPath, 'package.json'))
    ? readJson(path.join(repoPath, 'package.json'))
    : null;
  if (files.includes('package.json')) {
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const web = ['react', 'vue', 'svelte', 'next', 'vite', 'express', 'fastify', 'koa', 'nuxt', 'astro']
      .some((d) => d in deps);
    return pkg?.bin && !web ? 'cli-lib' : 'node-web';
  }
  if (files.some((n) => n === 'pyproject.toml' || n === 'setup.py' || /^requirements.*\.txt$/.test(n))) {
    return 'python';
  }
  if (files.includes('Cargo.toml') || files.includes('go.mod')) return 'cli-lib';

  const isDocFile = (n) => /\.(md|markdown|txt|rst|adoc)$/i.test(n) || /^(LICENSE|COPYING)/i.test(n);
  const isHidden = (n) => n.startsWith('.');
  if (files.filter((n) => !isHidden(n)).every((n) => isDocFile(n) || listDir(path.join(repoPath, n)))) {
    // Directories count as docs only when the top level is prose; a directory
    // of code without a manifest is not a research repository.
    const hasDoc = files.some(isDocFile);
    if (hasDoc) return 'docs-research';
  }
  return 'cli-lib';
}

/**
 * The project's own test entry point, only when its `package.json` declares a
 * `test` script that is not npm's placeholder. The board never invents one.
 *
 * @param {string} repoPath
 * @returns {string|null} `'npm test'`, or null.
 */
export function detectTestScript(repoPath) {
  if (!repoPath) return null;
  const pkg = readJson(path.join(repoPath, 'package.json'));
  const script = pkg?.scripts?.test;
  if (typeof script !== 'string' || !script.trim() || /no test specified/i.test(script)) return null;
  return 'npm test';
}

function git(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The branch PRs should target: the remote's default (`origin/HEAD`) when
 * known, else the checked-out branch. Read-only; never throws.
 *
 * @param {string} repoPath
 * @returns {string|null} null when it cannot be told (no repo, detached HEAD).
 */
export function detectDefaultBranch(repoPath) {
  if (!repoPath) return null;
  const head = git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.startsWith('origin/') ? head.slice('origin/'.length) : head;
  return git(repoPath, ['symbolic-ref', '--short', 'HEAD']) || null;
}
