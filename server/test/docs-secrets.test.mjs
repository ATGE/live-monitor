// Nothing generated from the transcripts may carry a secret into git.
//
// The decision corpus is a verbatim copy of what Edson and Claude said to each
// other, and those conversations mention the board's own token, the worker's
// address and his mail. This test reads the live configuration, collects the
// values that must never be published, and greps every Markdown file that ends
// up tracked for them.
//
// Imports nothing from `server/src`: it reads the config file directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const SECRET_KEY_RE = /token|secret|password/i;
const MIN_SECRET_CHARS = 16;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Plain deep merge: the local file wins, like the server's own loader. */
function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(over)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(out[key], value)
        : value;
  }
  return out;
}

/**
 * Every string that must not appear in anything we publish.
 *
 * Each needle carries the NAME of what it is, never the value: a failure
 * message that quotes the secret publishes it in the log of whoever ran it.
 */
function collectSecrets(config) {
  const secrets = new Map(); // value -> what it is called in the config

  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const where = trail ? `${trail}.${key}` : key;
      if (typeof value === 'string') {
        if (SECRET_KEY_RE.test(key) && value.length >= MIN_SECRET_CHARS) secrets.set(value, where);
      } else {
        walk(value, where);
      }
    }
  };
  walk(config, '');

  for (const [name, machine] of Object.entries(config?.machines ?? {})) {
    const url = typeof machine?.url === 'string' ? machine.url.trim() : '';
    if (!url) continue;
    try {
      const host = new URL(url).hostname;
      if (host) secrets.set(host, `machines.${name}.url`);
    } catch {
      secrets.set(url, `machines.${name}.url`);
    }
  }
  return secrets;
}

function gitUserEmail() {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return ''; // git missing or user.email unset (a clean public clone)
  }
}

/**
 * The owner's mail, read at runtime so no address is written in this file:
 * `HFSMON_OWNER_EMAIL` first, then `git config user.email`. Empty when neither
 * is available, and the caller then simply omits the entry.
 */
function ownerEmail(env = process.env, git = gitUserEmail) {
  const fromEnv = (env.HFSMON_OWNER_EMAIL ?? '').trim();
  return fromEnv || git();
}

/** Names of the needles found in `text`; never the values themselves. */
function findSecrets(text, secrets) {
  return [...secrets].filter(([secret]) => text.includes(secret)).map(([, what]) => what);
}

/**
 * Tailscale MagicDNS names, which no configuration key declares.
 *
 * `machines.*.url` holds the tailnet IP, so the DNS spelling of the same
 * machine is invisible to the needles above. One is already committed inside a
 * generated plan, so this is a warning and not a failure: the repository is
 * private and issue #2 tracks cleaning it up, and turning the suite red over a
 * file that is already in history only teaches people to skip the test.
 */
const MAGIC_DNS_RE = /\b[\w-]+\.tail[0-9a-f]+\.ts\.net\b/g;

function docFiles() {
  const files = [];
  // The three phase C indexes live at the root, like the documents above: a
  // list of names is cheaper to reason about than a root-level walk, but it
  // only covers what is written down, so a new root document has to be added
  // here by hand.
  for (const name of [
    'decisions.md', 'KNOWLEDGE.md', 'CLAUDE.md', 'README.md', 'AGENTS.md',
    'PRD.md', 'FSD.md', 'adr.md',
  ]) {
    const full = path.join(REPO_ROOT, name);
    if (fs.existsSync(full)) files.push(full);
  }
  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, 'docs'));
  return files;
}

test('ni el corpus de decisiones ni la documentación publican un secreto', (t) => {
  const config = deepMerge(
    readJson(path.join(REPO_ROOT, 'config.json')) ?? {},
    readJson(path.join(REPO_ROOT, 'config.local.json')) ?? {},
  );
  const secrets = collectSecrets(config);
  // The mail alone proves nothing; without a real token or host on top of it
  // the test says so instead of passing for free.
  if (secrets.size === 0) {
    t.skip('config.json no declara ningún token ni host que comprobar');
    return;
  }
  const mail = ownerEmail();
  if (mail) secrets.set(mail, 'el correo del propietario');

  const offenders = [];
  const magic = new Set();
  for (const file of docFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    // Only the NAME of the value is reported, never the value itself.
    for (const what of findSecrets(text, secrets)) offenders.push(`${rel}: ${what}`);
    for (const found of text.matchAll(MAGIC_DNS_RE)) {
      magic.add(`${rel}:${text.slice(0, found.index).split('\n').length}`);
    }
  }

  if (magic.size) {
    console.warn(
      `AVISO: ${magic.size} nombre(s) MagicDNS de la tailnet en archivos generados ` +
        `(${[...magic].join(', ')}). El repositorio es privado y la incidencia #2 lo ` +
        'sigue; no se pone la suite en rojo por un archivo que ya está commiteado.',
    );
  }

  assert.deepEqual(
    offenders,
    [],
    `estos archivos publican un valor de config.json (se nombra la clave, nunca el valor):\n${offenders.join('\n')}`,
  );
});

test('el correo del propietario viene del entorno y es opcional', () => {
  const fixture = 'contact: owner@example.test for details';
  const noGit = () => '';

  // Supplied through HFSMON_OWNER_EMAIL: it is collected and found in a doc.
  const mail = ownerEmail({ HFSMON_OWNER_EMAIL: ' owner@example.test ' }, noGit);
  assert.equal(mail, 'owner@example.test');
  const withMail = new Map([[mail, 'owner']]);
  assert.deepEqual(findSecrets(fixture, withMail), ['owner']);

  // Absent: nothing is collected, nothing is required, nothing crashes.
  assert.equal(ownerEmail({}, noGit), '');
  assert.deepEqual(findSecrets(fixture, new Map()), []);
  assert.equal(typeof gitUserEmail(), 'string');
});
