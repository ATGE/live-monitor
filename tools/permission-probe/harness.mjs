#!/usr/bin/env node
// The probe. Opens one Claude Agent SDK session per arm, in a throwaway
// worktree, and records every frame — above all the two the board discards:
// `system/permission_denied` and `result.permission_denials`.
//
// It imports the SDK by path and NOTHING from server/src: `claude.js` would
// drag in `quota.js`, which writes the live board's `server/data/quota.json`.
// The session options below are a hand copy of `server/src/claude.js:134-147`.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BOARD = process.env.HFSMON_BOARD ?? decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^[/]([A-Za-z]:)/, '$1').replace(/[/]$/, ''); // repo root, from this file's location; HFSMON_BOARD points the probes at the live board when run from a worktree
const OUT = join(BOARD, 'tools', 'permission-probe', 'out');
const SDK = join(BOARD, 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
const MODEL = process.env.PROBE_MODEL || 'haiku';
const SESSION_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 200_000);
const HARD_CAP = 20;

const { query } = await import(new URL(`file:///${SDK.replace(/\\/g, '/')}`));

// -------------------------------------------------------------- preflight
// The quota file is read, never imported: importing `quota.js` would let a
// usage-limit frame of ours park the live board.
function preflight() {
  const q = JSON.parse(readFileSync(join(BOARD, 'server', 'data', 'quota.json'), 'utf8'));
  if (q?.hold) {
    const until = q.hold.until ?? q.hold.resetsAt ?? JSON.stringify(q.hold);
    throw new Error(`quota hold activo (${until}) — el probe aborta`);
  }
  return q;
}

// ----------------------------------------------------------------- prompts
const RECIPES = {
  // The main thread launches a background subagent that runs Bash, then ends
  // its turn. This is the external-app #2 shape.
  agentBg: `Haz EXACTAMENTE esto y nada más.

1. Llama UNA vez a la herramienta Agent con: subagent_type "Explore", run_in_background true, description "probe", y prompt:
"Ejecuta estas tres llamadas Bash una tras otra, esperando el resultado de cada una antes de la siguiente: (1) echo uno; (2) echo dos; (3) echo tres. Luego responde con las tres salidas."
2. En cuanto hayas hecho esa llamada, TERMINA TU TURNO inmediatamente con el texto exacto: lanzado, espero
3. No llames a ninguna otra herramienta. No esperes al agente.`,
  // A background Bash on the main thread, and the turn ends before reading it.
  bashBg: `Haz EXACTAMENTE esto y nada más.

1. Llama UNA vez a Bash con run_in_background true y command: bash -c 'for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; done'
2. En cuanto hayas hecho esa llamada, TERMINA TU TURNO inmediatamente con el texto exacto: lanzado, espero
3. No leas la salida. No llames a ninguna otra herramienta.`,
  // The control: one ordinary Bash in an ordinary turn.
  control: `Llama una vez a Bash con command: echo hola. Luego responde con la salida y termina. Nada más.`,
};

// A second prompt pushed while the first turn is still in flight — the chat
// shape: `session.js` delivers board news and what the user typed mid-turn.
const SECOND_PROMPT = 'Por cierto: cuando acabes dime en una línea qué hiciste.';

// ------------------------------------------------------------------- arms
const HOOK_NONE = null;
const HOOK_ANY = 'any';     // a PreToolUse hook with NO matcher (chatHooks shape)
const HOOK_BASH = 'bash';   // a PreToolUse hook with matcher 'Bash' (phase shape)

const ARMS = [
  // recipe agentBg — the main variable is the hook
  { id: 'A1-agentBg-nohook-chain', recipe: 'agentBg', hook: HOOK_NONE, prompt: 'chain' },
  { id: 'A2-agentBg-hookBash-chain', recipe: 'agentBg', hook: HOOK_BASH, prompt: 'chain' },
  { id: 'A3-agentBg-hookAny-chain', recipe: 'agentBg', hook: HOOK_ANY, prompt: 'chain' },
  { id: 'A4-agentBg-hookBash-canUseTool-chain', recipe: 'agentBg', hook: HOOK_BASH, prompt: 'chain', canUseTool: true },
  { id: 'A5-agentBg-hookBash-stream', recipe: 'agentBg', hook: HOOK_BASH, prompt: 'stream' },
  { id: 'A6-agentBg-nohook-stream', recipe: 'agentBg', hook: HOOK_NONE, prompt: 'stream' },
  { id: 'A7-agentBg-hookBash-chain-noSettings', recipe: 'agentBg', hook: HOOK_BASH, prompt: 'chain', settingSources: [] },
  // recipe bashBg
  { id: 'B1-bashBg-hookBash-chain', recipe: 'bashBg', hook: HOOK_BASH, prompt: 'chain' },
  { id: 'B2-bashBg-nohook-chain', recipe: 'bashBg', hook: HOOK_NONE, prompt: 'chain' },
  { id: 'B3-bashBg-hookBash-stream', recipe: 'bashBg', hook: HOOK_BASH, prompt: 'stream' },
  // control: same options, trivial order, no background work
  { id: 'C1-control-hookBash-chain', recipe: 'control', hook: HOOK_BASH, prompt: 'chain' },
  { id: 'C2-control-nohook-chain', recipe: 'control', hook: HOOK_NONE, prompt: 'chain' },
  // the chat shape: streaming input, a second prompt arrives mid-turn
  { id: 'D1-agentBg-hookAny-stream-2nd', recipe: 'agentBg', hook: HOOK_ANY, prompt: 'stream', second: true },
  { id: 'D2-agentBg-nohook-stream-2nd', recipe: 'agentBg', hook: HOOK_NONE, prompt: 'stream', second: true },
  // The chat shape proper: the second prompt lands WHILE the first turn is
  // still in flight, which is what every chat denial in the census looks like
  // (two prompts 27-57 ms apart, the turn already started). D1/D2 pushed it at
  // the first result, which is too late to be that.
  { id: 'D3-agentBg-hookAny-stream-midturn', recipe: 'agentBg', hook: HOOK_ANY, prompt: 'stream', second: true, secondAtMs: 4000 },
  { id: 'D4-agentBg-nohook-stream-midturn', recipe: 'agentBg', hook: HOOK_NONE, prompt: 'stream', second: true, secondAtMs: 4000 },
];

// ------------------------------------------------------------------ session
function buildHooks(kind, log) {
  if (!kind) return undefined;
  const fn = async (input) => {
    log({ kind: 'hookFired', tool: input?.tool_name, agent: input?.agent_id ?? null, at: Date.now() });
    return {};   // the arm measures the round trip, not a decision
  };
  const matcher = kind === HOOK_BASH ? { matcher: 'Bash', hooks: [fn] } : { hooks: [fn] };
  return { PreToolUse: [matcher] };
}

function streamingPrompt(text, second) {
  // `session.js:194-207`: a generator that yields and STAYS OPEN. The gate is
  // released by the runner when the arm is over, so stdin never closes early.
  let release; const gate = new Promise((r) => { release = r; });
  let pushSecond; const secondGate = new Promise((r) => { pushSecond = r; });
  async function* gen() {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: 'probe' };
    if (second) {
      await secondGate;
      yield { type: 'user', message: { role: 'user', content: SECOND_PROMPT }, parent_tool_use_id: null, session_id: 'probe' };
    }
    await gate;
  }
  return { prompt: gen(), release, pushSecond };
}

async function runArm(arm, cwd) {
  const started = Date.now();
  const frames = [];
  const events = [];
  const log = (e) => events.push({ t: Date.now() - started, ...e });
  const framesPath = join(OUT, `${arm.id}.frames.log`);
  writeFileSync(framesPath, '');

  const options = {
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: arm.settingSources ?? ['user', 'project'],
    env: (() => { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; return e; })(),
    forwardSubagentText: true,
    maxTurns: 6,
    persistSession: true,
    debugFile: join(OUT, `${arm.id}.debug.log`),
    stderr: (s) => appendFileSync(join(OUT, `${arm.id}.stderr.log`), s),
  };
  const hooks = buildHooks(arm.hook, log);
  if (hooks) options.hooks = hooks;
  if (arm.canUseTool) {
    options.canUseTool = async (name, input) => {
      log({ kind: 'canUseTool', tool: name });
      return { behavior: 'allow', updatedInput: input };
    };
  }

  let prompt; let release = null; let pushSecond = null;
  if (arm.prompt === 'stream') ({ prompt, release, pushSecond } = streamingPrompt(RECIPES[arm.recipe], arm.second));
  else prompt = RECIPES[arm.recipe];

  // A mid-turn second prompt goes out on a timer, not on the first result:
  // the chat shape is a prompt that lands while a turn is already running.
  let midTurnTimer = null;
  if (arm.secondAtMs) midTurnTimer = setTimeout(() => { log({ kind: 'secondPromptPushed' }); pushSecond?.(); }, arm.secondAtMs);

  let q = null;
  let firstResultAt = null;
  const denials = [];
  const toolDenials = [];
  let initMode = null; let sessionId = null; let closeReason = 'end';
  const timer = setTimeout(() => { closeReason = 'timeout'; try { q?.interrupt?.(); } catch { } release?.(); }, SESSION_TIMEOUT_MS);

  try {
    q = query({ prompt, options });
    for await (const m of q) {
      const at = Date.now() - started;
      frames.push({ at, m });
      appendFileSync(framesPath, JSON.stringify({ at, m }) + '\n');
      if (m.type === 'system' && m.subtype === 'init') { initMode = m.permissionMode ?? m.permission_mode ?? null; sessionId = m.session_id; }
      if (m.type === 'system' && m.subtype === 'permission_denied') {
        denials.push({ at, ...m });
        log({ kind: 'permission_denied', at, reasonType: m.decision_reason_type, reason: m.decision_reason, agent: m.agent_id, tool: m.tool_name });
      }
      // A tool_result that carries the CLI's generic refusal text.
      if (m.type === 'user') {
        const c = m.message?.content;
        if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'tool_result' && typeof b.content === 'string'
            && /doesn't want to (take this action|proceed)/.test(b.content)) {
            toolDenials.push({ at, id: b.tool_use_id, sidechain: !!m.parent_tool_use_id, afterFirstResult: firstResultAt != null });
          }
        }
      }
      if (m.type === 'result') {
        if (firstResultAt == null) {
          firstResultAt = at;
          // The chat shape: the second prompt only now, while background work runs.
          if (arm.second && !arm.secondAtMs) pushSecond?.();
        }
        log({ kind: 'result', at, subtype: m.subtype, turns: m.num_turns, denials: m.permission_denials ?? null });
        if (Array.isArray(m.permission_denials)) for (const d of m.permission_denials) denials.push({ at, from: 'result', ...d });
        // A streaming arm stays open past the result on purpose; the timer ends it.
        if (arm.prompt !== 'stream') { /* the SDK closes stdin here by itself */ }
      }
    }
  } catch (e) {
    log({ kind: 'error', message: String(e?.message ?? e) });
    closeReason = 'error';
  } finally {
    clearTimeout(timer);
    if (midTurnTimer) clearTimeout(midTurnTimer);
    release?.();
    try { await q?.return?.(); } catch { }
  }

  return {
    arm: arm.id, recipe: arm.recipe, hook: arm.hook ?? 'none', prompt: arm.prompt,
    canUseTool: !!arm.canUseTool, settingSources: (arm.settingSources ?? ['user', 'project']).join('+') || '[]',
    sessionId, initPermissionMode: initMode, closeReason,
    seconds: Math.round((Date.now() - started) / 1000),
    firstResultAtMs: firstResultAt,
    frames: frames.length,
    toolDenials: toolDenials.length,
    toolDenialsAfterFirstResult: toolDenials.filter((d) => d.afterFirstResult).length,
    permissionDeniedFrames: denials.length,
    reasonTypes: [...new Set(denials.map((d) => d.decision_reason_type ?? d.reason_type ?? d.type).filter(Boolean))].join(','),
    hookFired: events.filter((e) => e.kind === 'hookFired').length,
    events, denials, toolDenialDetail: toolDenials,
  };
}

// --------------------------------------------------------------------- run
mkdirSync(OUT, { recursive: true });
preflight();
const cwd = process.argv[2];
if (!cwd) throw new Error('uso: node harness.mjs <cwd del worktree desechable> [armId...]');
const only = process.argv.slice(3);
const todo = only.length ? ARMS.filter((a) => only.includes(a.id)) : ARMS;
if (todo.length > HARD_CAP) throw new Error(`tope duro de ${HARD_CAP} sesiones`);

const results = [];
for (const arm of todo) {
  process.stderr.write(`\n--- ${arm.id} ---\n`);
  preflight();   // again: a hold may appear mid-run
  const r = await runArm(arm, cwd);
  results.push(r);
  process.stderr.write(`${arm.id}: denials=${r.toolDenials} pdFrames=${r.permissionDeniedFrames} hookFired=${r.hookFired} close=${r.closeReason} ${r.seconds}s\n`);
  writeFileSync(join(OUT, 'results.log'), JSON.stringify(results, null, 1));
}

const cols = ['arm', 'recipe', 'hook', 'prompt', 'canUseTool', 'settingSources', 'initPermissionMode',
  'toolDenials', 'toolDenialsAfterFirstResult', 'permissionDeniedFrames', 'reasonTypes', 'hookFired', 'closeReason', 'seconds'];
console.log(cols.join('\t'));
for (const r of results) console.log(cols.map((c) => String(r[c] ?? '')).join('\t'));
