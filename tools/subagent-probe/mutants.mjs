#!/usr/bin/env node
// Applies each named mutant of the seal net and of its call sites, runs the
// tests, and prints which ones go red (#31 g1, #36 part A).
// Usage: node tools/subagent-probe/mutants.mjs
//
// Every mutant is applied to a COPY of the repository files the tests need, in
// a fresh temporary directory; the live tree is only read. Killing the script at
// any point therefore leaves `git status` clean: the worst case is a stray
// directory in the OS temp folder.
//
// The copy holds `server/src`, `server/prompts`, `server/test`, the probe's
// recorded `*.json` (a test reads one) and the two `package.json`. Under test the
// board reads `server/test/fixtures/config.test.json`, never `config.json`, so no
// token is copied. `server/node_modules` is linked into the copy with a junction
// (ESM ignores NODE_PATH, so there is no other way short of installing); the link
// is removed explicitly BEFORE the tree, so removing the copy never follows it
// into the real `node_modules`.
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTree } from '../../server/test/teardown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const SEALNET = 'server/src/sealnet.js';
const CLAUDE = 'server/src/claude.js';
const PIPELINE = 'server/src/pipeline.js';
const SEALEDANSWER = 'server/src/sealedanswer.js';

export const TESTS = [
  'server/test/sealnet.test.mjs',
  'server/test/phase-channel.test.mjs',
  'server/test/sealed-guard.test.mjs',
  'server/test/sealed-sites.test.mjs',
  'server/test/pipeline-advisor.test.mjs',
  'server/test/sealedanswer.test.mjs',
];

// A call site of `answerOf` is reverted by handing it a result that carries only
// the adopted text: the validator, the retry and the log note stay as they were,
// so what turns red is exactly «this site stopped reading the sealed answer».
const site = (name, file, head, validator) => ({
  name: `answerOf site: ${name} reads the adopted text only`,
  file,
  from: `answerOf(${head}, ${validator}`,
  to: `answerOf({ resultText: ${head}?.resultText }, ${validator}`,
});

export const MUTANTS = [
  { name: 'drop the early count', file: SEALNET, from: 'const early = reportedBg.size;', to: 'const early = 0;' },
  { name: 'never close the window', file: SEALNET, from: 'if (closes) windowOpen = false;', to: '' },
  { name: 'restore the old adoption condition', file: SEALNET, from: "return { adopt: message.subtype === 'success', closes };", to: 'return { adopt: true, closes };' },
  { name: 'close the window without a clean turn', file: SEALNET, from: 'owedOut.size === 0 && turnClean && earlyNow === 0', to: 'owedOut.size === 0 && earlyNow === 0' },
  { name: 'ignore is_backgrounded', file: SEALNET, from: 'message.is_backgrounded === true', to: 'true' },
  { name: 'remove the held-open wait', file: SEALNET, from: 'return sealed && windowOpen && owedOut.size === 0 && !openTurn && unanswered;', to: 'return false;' },
  { name: 'subagents launched after the seal are not owed (#31 §1)', file: SEALNET, from: 'for (const [id, isAgent] of tasks) if (isAgent) owedOut.add(id);\n      const closes', to: 'const closes' },
  { name: 'remove the local_agent criterion', file: CLAUDE, from: "t.task_type === 'local_agent' || ", to: '' },
  { name: 'answerFrom post without closing', file: CLAUDE, from: "ctx.closes === true ? 'post' : 'unclosed'", to: "'post'" },
  // #36 part G1: a CLI with no `init` per turn still opens a turn.
  { name: 'G1: the first main-thread assistant frame no longer opens a turn', file: SEALNET, from: "message.type === 'assistant' && message.parent_tool_use_id == null && !openTurn", to: 'false' },
  { name: 'G1: a subagent assistant frame opens the main turn', file: SEALNET, from: "message.type === 'assistant' && message.parent_tool_use_id == null && !openTurn", to: "message.type === 'assistant' && !openTurn" },
  // #36 part G2: the good answer of an intermediate turn survives its replacement.
  { name: 'G2: runClaude forgets the texts a later turn replaced', file: CLAUDE, from: 'if (ctx.sealed && ctx.answerFrom && ctx.resultText && ctx.resultText !== next) {', to: 'if (false) {' },
  { name: 'G2: answerOf ignores replacedTexts', file: SEALEDANSWER, from: "for (const t of result?.replacedTexts ?? []) if (t) others.push(['sealed', t]);", to: '' },
  // #36 part C: an error result that closes the window is not «no turn closed it».
  { name: 'C: an error that closes the window stays unclosed', file: CLAUDE, from: "ctx.answerFrom = 'error-closed';", to: "ctx.answerFrom = 'unclosed';" },
  // #31 g2/g3/g4, #36 part A: the seven call sites of `answerOf` in pipeline.js.
  site('work plan', PIPELINE, 'r', '(t) => look(t).ok,'),
  site('tagged lines', PIPELINE, 'r', '(t) => read(t).ok,'),
  site('triage verdict', PIPELINE, 'r', '(t) => Boolean(parseTriageResult(t)),'),
  site('advisor plan', PIPELINE, 'r', '(t) => !advisorPlanProblems(t).length,'),
  { name: 'answerOf site: PR body reads the adopted text only', file: PIPELINE, from: 'const body = answerOf(result, (t) => {', to: 'const body = answerOf({ resultText: result?.resultText }, (t) => {' },
  site('demo steps', PIPELINE, 'result', 'usable,'),
  site('review replies', PIPELINE, 'result', "(t) => Boolean(parseTaggedJson(t, 'REVIEW_REPLIES')),"),
];

const COPIED_DIRS = ['server/src', 'server/prompts', 'server/test'];
const COPIED_FILES = ['package.json', 'server/package.json'];
const PROBE_JSON = /\.json$/;

/** Removes a junction without following it (`rmdir` on a link removes the link). */
function dropLink(link) {
  try { unlinkSync(link); } catch { rmdirSync(link); }
}

/** What is still on disk, for the signal handlers (which cannot await). */
const live = new Set();
function cleanupNow() {
  for (const { dir, link } of live) {
    try { if (link) dropLink(link); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* left behind in the OS temp */ }
  }
  live.clear();
}

function copyTree(root, dir) {
  for (const rel of COPIED_DIRS) {
    cpSync(join(root, rel), join(dir, rel), {
      recursive: true,
      dereference: false,
      filter: (from) => !/[\\/]node_modules([\\/]|$)/.test(from),
    });
  }
  for (const rel of COPIED_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(root, rel), join(dir, rel));
  }
  const probe = join(root, 'tools', 'subagent-probe');
  mkdirSync(join(dir, 'tools', 'subagent-probe'), { recursive: true });
  for (const f of readdirSync(probe)) {
    if (PROBE_JSON.test(f)) cpSync(join(probe, f), join(dir, 'tools', 'subagent-probe', f));
  }
}

function runTests(dir, tests, timeoutMs) {
  // The parent may itself be a node:test child: its marker would make this
  // `node --test` talk to the parent in the runner's wire format, not print.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8', env, timeout: timeoutMs });
  const stdout = `${out.stdout ?? ''}`;
  const failed = [...new Set([...stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((x) => x[1]))];
  return { status: out.status, failed, stdout, stderr: `${out.stderr ?? ''}`, timedOut: out.error?.code === 'ETIMEDOUT' };
}

/**
 * Runs every mutant on a temporary copy of `root` and returns
 * `{ results, tempDir }`, one result per mutant: `{ name, status, failed }` with
 * `status` `RED` (some test failed: good), `GREEN` (none did: the mutant
 * survived) or `UNMATCHED` (its `from` is not in the file exactly once).
 * Nothing under `root` is written. The unmutated copy must pass first, or the
 * run throws: otherwise everything would be red for the wrong reason.
 * `onMutant({ name, dir })` is called while a mutant is applied.
 */
export async function runMutants({ root = REPO, mutants = MUTANTS, tests = TESTS, baseline = true, timeoutMs = 600_000, onMutant = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-mutants-'));
  const modules = join(root, 'server', 'node_modules');
  const link = join(dir, 'server', 'node_modules');
  const entry = { dir, link: null };
  live.add(entry);
  let tempDir = dir;
  try {
    copyTree(root, dir);
    if (existsSync(modules)) {
      symlinkSync(modules, link, 'junction');
      entry.link = link;
    }
    if (baseline) {
      const base = runTests(dir, tests, timeoutMs);
      if (base.status !== 0) {
        const tail = `${base.stdout}\n${base.stderr}`.trim().split('\n').slice(-25).join('\n');
        throw new Error(`the unmutated copy does not pass (${base.failed.length} failing): every mutant would be red for the wrong reason. Does server/node_modules exist?\n${tail}`);
      }
    }
    const results = [];
    for (const m of mutants) {
      const target = join(dir, m.file);
      const original = readFileSync(join(root, m.file), 'utf8');
      const text = original.replace(/\r\n/g, '\n');
      if (text.split(m.from).length !== 2) {
        results.push({ name: m.name, status: 'UNMATCHED', failed: [] });
        continue;
      }
      writeFileSync(target, text.replace(m.from, () => m.to));
      onMutant?.({ name: m.name, dir });
      const ran = runTests(dir, tests, timeoutMs);
      // Put the copy back so the next mutant starts from the clean file.
      writeFileSync(target, text);
      const red = ran.failed.length > 0 || ran.status !== 0;
      results.push({ name: m.name, status: red ? 'RED' : 'GREEN', failed: ran.failed.length ? ran.failed : (red ? [`(exit ${ran.status ?? 'timeout'}, no test named)`] : []) });
    }
    return { results, tempDir };
  } finally {
    // The link first: removing the tree must never walk into the real modules.
    if (entry.link) {
      try { dropLink(entry.link); } catch { /* removeTree below reports what is left */ }
    }
    await removeTree(dir);
    live.delete(entry);
    tempDir = dir;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanupNow(); process.exit(130); });
  }
  let bad = 0;
  try {
    const { results } = await runMutants();
    for (const r of results) {
      console.log(`${r.status === 'RED' ? 'RED  ' : r.status === 'GREEN' ? 'GREEN' : '??   '} ${r.name}${r.status === 'UNMATCHED' ? ': pattern not found exactly once' : ''}`);
      for (const f of r.failed) console.log(`        ${f}`);
      if (r.status !== 'RED') bad += 1;
    }
  } catch (err) {
    console.error(err.message);
    bad = 1;
  }
  process.exit(bad ? 1 : 0);
}
