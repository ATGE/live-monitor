#!/usr/bin/env node
// Live probe for issue #21: does a PreToolUse hook that returns `updatedInput`
// keep the subagent tool in the foreground under `bypassPermissions`?
//
// It opens a minimal SDK session (haiku, a handful of turns) that is asked to
// launch ONE trivial subagent, with the input channel held open the way
// `runClaude` holds it, and records:
//   1. what the hook saw and returned;
//   2. the `task_started` frame: its fields, and whether `is_backgrounded` is false;
//   3. what the tool result told the model (a background launch says so);
//   4. the order of `task_notification`, `system/init` and `result` frames, i.e.
//      whether an `init` arrives before the turn that holds the final answer.
// A control run without the hook gives the baseline. `--mode deny` probes the
// fallback instead of the rewrite.
//
// Usage:
//   node tools/subagent-probe/probe.mjs [--mode rewrite|deny] [--no-control] [--scenario single|parallel|inturn] [--cli path] [--out file.json]
// `--cli <path>` runs the session on that Claude Code executable (`pathToClaudeCodeExecutable`)
// instead of the SDK's bundled one; the verdict's `initPerTurn` says whether the CLI sent a
// `system/init` before every result after the first (#36 part G1).
// `--scenario inturn` (issue #31) runs with NO gate: a background subagent reports
// inside a turn that already holds the answer; does the CLI open a reaction turn?
// `--scenario parallel` (issue #28) launches TWO subagents in ONE message, each
// running `sleep 20`, with the gate on and no control run, and records whether
// they overlap (about 20 s in total) or serialise (about 40 s).
// The SDK is resolved from, in order: $SDK_DIR, server/node_modules of this
// checkout, the main checkout's server/node_modules (`git worktree list`).
// Costs a few cents. Reads and writes nothing in the repo except --out; its own
// temp directories are removed when each run ends.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { removeTree } from '../../server/test/teardown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MODE = opt('--mode', 'rewrite');
const OUT = opt('--out', null);
const SCENARIO = opt('--scenario', 'single');
const CLI = opt('--cli', null);
if (!['single', 'parallel', 'inturn'].includes(SCENARIO)) throw new Error(`unknown --scenario ${SCENARIO}`);

function sdkDir() {
  const candidates = [process.env.SDK_DIR, join(ROOT, 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')];
  try {
    const list = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    for (const m of list.matchAll(/^worktree (.+)$/gm)) {
      candidates.push(join(m[1], 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
    }
  } catch { /* no git: the other candidates stand */ }
  const found = candidates.filter(Boolean).find((d) => existsSync(join(d, 'package.json')));
  if (!found) throw new Error('claude-agent-sdk not found: set SDK_DIR or run npm ci in server/');
  return found;
}

const dir = sdkDir();
const require = createRequire(join(dir, 'package.json'));
const pkg = require('./package.json');
const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
const { subagentGateHooks } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'subagentgate.js')).href);

const SLEEP_S = 20;
const PROMPT_PARALLEL = 'In ONE single message, make TWO Agent tool calls at the same time '
  + `(subagent_type: general-purpose, descriptions "sleep-a" and "sleep-b"). Each subagent runs exactly the Bash command "sleep ${SLEEP_S}" and then answers with the single word DONE. `
  + 'Do not pass run_in_background at all. When both reports are back, answer with the single line FINAL: <what both said>.';
const PROMPT_SINGLE = 'Launch exactly ONE subagent with the Agent tool (subagent_type: Explore, description: "probe") '
  + 'that answers with the single word PONG, using no tools. Do not pass run_in_background at all. '
  + 'When its report is back, answer with the single line FINAL: <what the subagent said>.';
// Issue #31, section 6: a background subagent that reports INSIDE the turn that
// already holds the good answer. A foreground `node` timer keeps the turn open long
// enough for the report to arrive in it (the CLI blocks a bare `sleep`).
const PROMPT_INTURN = 'In ONE single message, make TWO tool calls at the same time. '
  + 'First, an Agent tool call (subagent_type: general-purpose, description: "quick", run_in_background: true) '
  + 'whose subagent answers with the single word PONG, using no tools. '
  + 'Second, a Bash tool call running exactly: node -e "setTimeout(()=>{},25000)" in the foreground (do not background it, do not use sleep). '
  + 'When that command returns, answer with the single line FINAL: DONE, whether or not the subagent has reported.';
const PROMPT = { parallel: PROMPT_PARALLEL, inturn: PROMPT_INTURN }[SCENARIO] ?? PROMPT_SINGLE;

async function runOnce(label, hooks) {
  const cwd = mkdtempSync(join(tmpdir(), 'subagent-probe-'));
  const events = [];
  const t0 = Date.now();
  const mark = (kind, extra = {}) => events.push({ t: Date.now() - t0, kind, ...extra });
  const wrapped = hooks && {
    PreToolUse: hooks.PreToolUse.map((m) => ({
      ...m,
      hooks: m.hooks.map((fn) => async (input, ...rest) => {
        const out = await fn(input, ...rest);
        mark('hook', { tool: input?.tool_name, sawBackground: input?.tool_input?.run_in_background, returned: out });
        return out;
      }),
    })),
  };

  let release;
  const open = new Promise((r) => { release = r; });
  async function* stream() {
    yield { type: 'user', message: { role: 'user', content: PROMPT }, parent_tool_use_id: null, session_id: '' };
    await open; // held open: closing stdin aborts hooks and kills later turns
  }

  let results = 0;
  let openTasks = 0;
  let idleTimer = null;
  // A CLI turn of its own would show up within this window; an `init` re-arms it.
  const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(release, 4000); };
  const timer = setTimeout(release, 240_000);
  try {
  const session = query({
    prompt: stream(),
    options: {
      cwd, model: 'haiku', maxTurns: 8, permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true, settingSources: [], ...(wrapped ? { hooks: wrapped } : {}),
      ...(CLI ? { pathToClaudeCodeExecutable: CLI } : {}),
    },
  });
  for await (const m of session) {
    if (m.type === 'system' && m.subtype === 'init') { clearTimeout(idleTimer); mark('init'); }
    else if (m.type === 'system' && m.subtype === 'task_started') {
      openTasks += 1;
      mark('task_started', {
        task_id: m.task_id, fields: Object.keys(m).sort(), task_type: m.task_type, subagent_type: m.subagent_type,
        tool_use_id: m.tool_use_id, is_backgrounded: m.is_backgrounded, ambient: m.ambient,
      });
    } else if (m.type === 'system' && m.subtype === 'task_notification') {
      openTasks -= 1;
      mark('task_notification', { task_id: m.task_id, fields: Object.keys(m).sort(), status: m.status, tool_use_id: m.tool_use_id });
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      mark('background_tasks_changed', { tasks: (m.tasks ?? []).map((t) => ({ task_type: t.task_type, ambient: t.ambient })) });
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use' && /^(Agent|Task)$/.test(b.name)) {
          mark('tool_use', { id: b.id, messageId: m.message?.id ?? null, name: b.name, run_in_background: b.input?.run_in_background, inputKeys: Object.keys(b.input ?? {}) });
        } else if (b.type === 'tool_use' && b.name === 'Bash') {
          mark('bash_use', { id: b.id, messageId: m.message?.id ?? null, command: String(b.input?.command ?? '').slice(0, 80), run_in_background: b.input?.run_in_background });
        }
      }
    } else if (m.type === 'user') {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          mark('tool_result', { is_error: b.is_error, text: text.slice(0, 240) });
        }
      }
    } else if (m.type === 'result') {
      results += 1;
      mark('result', { subtype: m.subtype, text: String(m.result ?? '').slice(0, SCENARIO === 'inturn' ? 400 : 160), turns: m.num_turns });
      if (openTasks <= 0) idle();
    }
  }
  clearTimeout(timer);
  } finally {
    await removeTree(cwd).catch((e) => console.error(`subagent-probe: could not remove ${cwd}: ${e.message}`));
  }
  const started = events.filter((e) => e.kind === 'task_started');
  const toolResult = events.find((e) => e.kind === 'tool_result');
  const firstResult = events.findIndex((e) => e.kind === 'result');
  const firstNotification = events.findIndex((e) => e.kind === 'task_notification');
  const initAfterNotification = events.some((e, i) => e.kind === 'init' && firstNotification >= 0 && i > firstNotification);
  const lastResult = events.findLast((e) => e.kind === 'result');
  // Only the subagents count: their inner `sleep` commands arrive as `local_bash` tasks too.
  const tasks = started.filter((e) => e.task_type === 'local_agent').map((e) => {
    const done = events.find((n) => n.kind === 'task_notification' && n.task_id === e.task_id);
    return { task_id: e.task_id, startT: e.t, endT: done?.t ?? null, durationMs: done ? done.t - e.t : null };
  });
  const finished = tasks.filter((x) => x.endT != null);
  const sumMs = finished.reduce((n, x) => n + x.durationMs, 0);
  const spanMs = finished.length ? Math.max(...finished.map((x) => x.endT)) - Math.min(...finished.map((x) => x.startT)) : null;
  const calls = events.filter((e) => e.kind === 'tool_use');
  const parallel = SCENARIO === 'parallel' ? {
    toolUses: calls.map((e) => ({ id: e.id, messageId: e.messageId })),
    sameMessage: calls.length >= 2 && new Set(calls.map((e) => e.messageId)).size === 1,
    tasks, sleepSeconds: SLEEP_S,
    wallMs: lastResult ? lastResult.t : null,
    spanMs, sumTaskMs: sumMs,
    overlap: finished.length >= 2 && Math.max(...finished.map((x) => x.startT)) < Math.min(...finished.map((x) => x.endT)),
    // Two sleeps of SLEEP_S that overlap take about one sleep; one after the other, about two.
    serialised: finished.length >= 2 ? spanMs > 0.9 * sumMs : null,
  } : {};
  const resultIdx = events.flatMap((e, i) => (e.kind === 'result' ? [i] : []));
  const inturn = SCENARIO === 'inturn' ? {
    // Did the subagent report before the first result, i.e. inside the turn?
    reportedInsideFirstTurn: firstNotification >= 0 && firstResult >= 0 && firstNotification < firstResult,
    // Did the CLI open a turn of its own after the first result (init + result)?
    initAfterFirstResult: firstResult >= 0 && events.some((e, i) => e.kind === 'init' && i > firstResult),
    resultTexts: resultIdx.map((i) => events[i].text),
    backgroundAgentCalls: calls.filter((e) => e.run_in_background === true).length,
    bashCalls: events.filter((e) => e.kind === 'bash_use').length,
  } : {};
  // Every result after the first had an `init` between it and the result before it.
  const initPerTurn = resultIdx.length < 2 ? null
    : resultIdx.slice(1).every((r, k) => events.slice(resultIdx[k] + 1, r).some((e) => e.kind === 'init'));
  return {
    label, events,
    verdict: {
      initPerTurn,
      ...parallel,
      ...inturn,
      hookCalls: events.filter((e) => e.kind === 'hook').length,
      taskStarted: started.length,
      isBackgrounded: started.map((e) => e.is_backgrounded),
      taskTypes: started.map((e) => e.task_type),
      toolResultSaysBackground: /background|async|launched|will be notified/i.test(toolResult?.text ?? ''),
      firstResultBeforeNotification: firstResult >= 0 && (firstNotification < 0 || firstResult < firstNotification),
      initAfterNotification,
      results,
    },
  };
}

const report = { sdk: pkg.version, claudeCode: pkg.claudeCodeVersion, cli: CLI ?? '<bundled>', sdkDir: '<sdk dir: not recorded>', mode: MODE, runs: [] };
if (SCENARIO === 'single' && !flag('--no-control')) report.runs.push(await runOnce('control (no hook)', null));
// `inturn` needs the subagent to stay in the background: no gate.
if (SCENARIO === 'inturn') report.runs.push(await runOnce('no hook (background subagent)', null));
else report.runs.push(await runOnce(`hook (${MODE})`, subagentGateHooks({ mode: MODE })));

const text = JSON.stringify(report, null, 2);
if (OUT) writeFileSync(OUT, `${text}\n`);
console.log(text);
process.exit(0);
