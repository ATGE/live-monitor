// SessionStart hook: one line saying whether the hfs context bridge is in
// place on this machine. Whatever this prints on stdout lands in the model's
// context, so it is short, factual and never noisy.
//
// It checks EXISTENCE only: that CLAUDE.local.md is here and that the watched
// repo's CLAUDE.md is where config.json says. It deliberately does not read
// anything out of hfs (crate count, MSRV) -- the A/B probe that proves the
// `@` import resolves asks exactly those two facts without tools, and a hook
// that answered them would make that probe pass for the wrong reason.
//
// Registered from .claude/settings.local.json (gitignored) with an absolute
// path; the script itself is portable and reads paths from config.json.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Same overlay rule as server/src/config.js, kept local so this hook never
// imports server code: objects merge recursively, everything else replaces.
function mergeInto(base, extra) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isObject(value) && isObject(base[key])) mergeInto(base[key], value);
    else base[key] = value;
  }
  return base;
}

function headOf(repoPath) {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return '?';
  }
}

// The `@` import in CLAUDE.local.md points outside the working directory, so
// the CLI treats it as an *external include* and only expands it once the
// project has approved them. A declined or reset approval disables the import
// silently -- the line stays as literal text and nothing warns. This is the
// one place that makes that state visible. The flag lives per project in
// ~/.claude.json, keyed by the project path AS THE SESSION WAS LAUNCHED, so
// the same directory can appear twice (`c:/...` and `C:/...`) and the CLI
// consults whichever matches its cwd spelling. Verified 2026-09-18: approving
// only the lower-case entry left the import dead. Every variant must be true.
function externalIncludesApproved() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const state = readJson(path.join(home, '.claude.json'));
  const projects = state?.projects ?? {};
  const want = ROOT.replace(/\\/g, '/').toLowerCase();
  const keys = Object.keys(projects).filter((k) => k.replace(/\\/g, '/').toLowerCase() === want);
  if (keys.length === 0) return null;
  return keys.every((k) => projects[k].hasClaudeMdExternalIncludesApproved === true);
}

function statusLine() {
  const config = mergeInto(readJson(path.join(ROOT, 'config.json')) ?? {}, readJson(path.join(ROOT, 'config.local.json')));
  const repoPath = config.project?.repoPath;
  const local = path.join(ROOT, 'CLAUDE.local.md');

  if (!fs.existsSync(local)) return '[hook session-start] HFS BRIDGE MISSING: no hay CLAUDE.local.md en el tablero (ver CLAUDE.md, «Si falta el puente»).';
  if (!repoPath) return '[hook session-start] HFS BRIDGE MISSING: config.json no declara project.repoPath.';
  const target = path.join(repoPath, 'CLAUDE.md');
  if (!fs.existsSync(target)) return `[hook session-start] HFS BRIDGE MISSING: no existe ${target}.`;
  const approved = externalIncludesApproved();
  if (approved !== true) {
    // Addressed to Edson, not to the model: this line enters the context and
    // must not read as an instruction to go and edit ~/.claude.json.
    return (
      `[hook session-start] HFS BRIDGE INACTIVE: ${target} existe pero las importaciones externas de ` +
      `CLAUDE.md ${approved === null ? 'no constan' : 'NO están aprobadas'} para este proyecto en ` +
      '~/.claude.json (hasClaudeMdExternalIncludesApproved, todas las variantes de la clave). ' +
      'El @ de CLAUDE.local.md se queda como texto. (Edson: abre `claude` en este directorio y ' +
      'acepta el diálogo de importaciones externas.)'
    );
  }
  // "aprobadas", not "importado": the flag does not prove the import resolved;
  // only the A/B probe in the plan does.
  return `[hook session-start] HFS bridge: ${target} presente; importaciones externas aprobadas (hfs @ ${headOf(repoPath)}).`;
}

try {
  process.stdout.write(`${statusLine()}\n`);
} catch {
  /* a broken hook must never cost the session its start */
}
process.exit(0);
