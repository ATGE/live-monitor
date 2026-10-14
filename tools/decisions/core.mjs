// Shared helpers for the decisions extractor (and the docs tooling that walks
// fenced Markdown): the sessions allowlist, text normalisation, the
// fence-aware line walker and the lock file.
//
// Code and comments are English; everything the tools write for a human is
// Spanish, like the rest of the board.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// The paths move together: point `HFSMON_DECISIONS_SESSIONS` at a temp copy and
// the local sessions file lands beside it, so a test can never reach the real
// allowlist.
export const SESSIONS_PATH =
  process.env.HFSMON_DECISIONS_SESSIONS ?? path.join(HERE, 'sessions.json');

/** Sessions listed by hand for this machine only. Gitignored, never committed. */
export function localSessionsPathFor(sessionsPath = SESSIONS_PATH) {
  return path.join(path.dirname(sessionsPath), 'sessions.local.json');
}

export const SESSIONS_LOCAL_PATH = localSessionsPathFor(SESSIONS_PATH);
export const LOG_PATH =
  process.env.HFSMON_DECISIONS_LOG ??
  path.join(path.dirname(SESSIONS_PATH), 'decisions.log');


// Pinned on purpose: the day grouping must not follow whatever the machine says.
export const LOCAL_TIME_ZONE = 'America/La_Paz';

/** Canonical form of a text: LF line endings, no trailing blank lines. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/** Short, stable digest of the canonical text. */
export function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeText(text), 'utf8')
    .digest('hex')
    .slice(0, 12);
}
const PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: LOCAL_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** ISO instant -> { day: 'YYYY-MM-DD', time: 'HH:MM:SS' } in LOCAL_TIME_ZONE. */
export function localParts(instant) {
  const parts = Object.fromEntries(
    PARTS_FORMATTER.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}:${parts.second}`,
  };
}

/** A fence wide enough that the prompt's own backticks cannot close it. */
export function fenceFor(text) {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}
/**
 * Walk the document's own lines, skipping everything inside a fenced body.
 *
 * Prompts quote Markdown at us all the time: a body can contain a `## 2026-09-02`
 * heading or even a literal `<!-- prompt ... -->` marker. Anything that looks for
 * structure must walk forward from the top and step over fenced regions, never
 * scan raw lines -- a backward scan cannot tell whether it is inside a body.
 */
export function* structuralLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence === null) {
      const open = /^(`{3,})/.exec(line);
      if (open) {
        fence = open[1];
        continue;
      }
      yield [i, line];
    } else if (line === fence) {
      fence = null;
    }
  }
}

/**
 * One comparable spelling for a filesystem path.
 *
 * Windows hands the same directory out in several spellings at once -- drive
 * case, separators, a trailing slash, and the odd 8.3 or junction detour -- so
 * the roots, the payload's cwd and the transcript paths all go through here
 * before anything compares them. A path that does not exist keeps whatever it
 * was given.
 */
export function normalizeCwd(p) {
  let value = String(p ?? '');
  if (!value) return '';
  try {
    value = fs.realpathSync.native(value);
  } catch {
    /* keep input: an unresolvable path is still comparable with itself */
  }
  return value
    .replace(/\\/g, '/')
    .replace(/^([a-zA-Z]):/, (_m, drive) => `${drive.toLowerCase()}:`)
    .replace(/(.)\/+$/, '$1');
}

function validSessions(list) {
  return Array.isArray(list)
    ? list.filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
    : [];
}

/**
 * The allowlist: the sessions tracked in git, plus the ones listed by hand in
 * this machine's gitignored `sessions.local.json`, plus the optional roots.
 *
 * A broken tracked file still fails closed (it throws). A broken *local* file
 * never does: it is a cache this machine can rebuild, so it is logged and
 * ignored rather than costing a turn.
 */
export function readSessions(sessionsPath = SESSIONS_PATH) {
  const localPath = localSessionsPathFor(sessionsPath);
  const parsed = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  const tracked = validSessions(parsed.sessions);
  const roots = (Array.isArray(parsed.roots) ? parsed.roots : [])
    .filter((r) => typeof r === 'string' && r.length > 0)
    .map(normalizeCwd)
    .filter(Boolean);

  let local = [];
  if (fs.existsSync(localPath)) {
    try {
      const parsedLocal = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      if (!parsedLocal || !Array.isArray(parsedLocal.sessions)) {
        throw new Error('no declara una lista "sessions"');
      }
      local = validSessions(parsedLocal.sessions);
    } catch (err) {
      logDiagnostic(`sessions.local.json ilegible, se ignora: ${err.message}`);
      local = [];
    }
  }

  const trackedIds = new Set(tracked.map((s) => s.id));
  // Tracked wins: a session that reached git is the record, and the local file
  // must never be able to redirect it somewhere else.
  const sessions = [...tracked, ...local.filter((s) => !trackedIds.has(s.id))];

  if (sessions.length === 0 && roots.length === 0) {
    throw new Error('sessions.json no contiene ninguna sesión válida ni ninguna raíz');
  }

  return {
    sessions,
    ids: new Set(sessions.map((s) => s.id)),
    roots,
    local,
    trackedIds,
  };
}

/** Diagnostics go to a .log file -- never to stdout, which reaches the model. */
export function logDiagnostic(message) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* a log that cannot be written must never break the turn */
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

/**
 * Serialise concurrent writers with a lock file kept outside the repo.
 * If the lock cannot be taken in time we run anyway: the caller's write is a
 * single append call, which is the fallback the design asks for.
 */
export function withLock(targetPath, fn, { attempts = 40, waitMs = 25, staleMs = 30_000 } = {}) {
  const key = crypto
    .createHash('sha256')
    .update(path.resolve(targetPath))
    .digest('hex')
    .slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `hfs-decisions-${key}.lock`);
  let held = false;
  for (let i = 0; i < attempts && !held; i += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      held = true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) fs.rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
      sleepSync(waitMs);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Message content is either a bare string or a list of typed blocks. */
export function textOf(content) {
  if (typeof content === 'string') return normalizeText(content);
  if (!Array.isArray(content)) return '';
  return normalizeText(
    content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n'),
  );
}
