#!/usr/bin/env node
// Exp 6 - the chat form, aimed properly this time.
//
// The census's chat denials are not two board prompts. Every one of them is a
// `<task-notification>` the CLI injects when background work reports, and the
// board's own prompt landing 27-57 ms behind it, while the CLI is inside a
// turn it started by itself to react to that notification.
//
// The earlier attempt (arms D1-D4) pushed the second prompt on a timer, so it
// landed during the BOARD's turn, which is a different thing and came out
// clean. This arm pushes it on the SDK frame that marks the CLI's own
// reaction: `system/task_notification`. Same tick, no timer.
//
// Two arms, one variable: the hook. The chat hook carries no matcher, so it
// covers every tool; the control has no hook at all.
//
// Imports the SDK by path and NOTHING from server/src -- `claude.js` would
// drag in `quota.js` and write the live board's quota file. Options are a hand
// copy of `harness.mjs`, which is itself a copy of `server/src/claude.js`.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BOARD = process.env.HFSMON_BOARD ?? decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^[/]([A-Za-z]:)/, '$1').replace(/[/]$/, ''); // repo root, from this file's location; HFSMON_BOARD points the probes at the live board when run from a worktree
const OUT = join(BOARD, 'tools', 'permission-probe', 'out');
const SDK = join(BOARD, 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
const MODEL = process.env.PROBE_MODEL || 'haiku';
const SESSION_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 150_000);

const { query } = await import(new URL(`file:///${SDK.replace(/\\/g, '/')}`));

function preflight() {
  const q = JSON.parse(readFileSync(join(BOARD, 'server', 'data', 'quota.json'), 'utf8'));
  if (q?.hold) throw new Error(`quota hold activo (${JSON.stringify(q.hold)}) - el probe aborta`);
  return q;
}

// Background work that finishes on its own, so the CLI gets something to
// report and reacts to it with a turn of its own.
const RECIPE = `Haz EXACTAMENTE esto y nada más.

1. Llama UNA vez a la herramienta Agent con: subagent_type "Explore", run_in_background true, description "probe", y prompt:
"Ejecuta estas tres llamadas Bash una tras otra, esperando el resultado de cada una antes de la siguiente: (1) echo uno; (2) echo dos; (3) echo tres. Luego responde con las tres salidas."
2. En cuanto hayas hecho esa llamada, TERMINA TU TURNO inmediatamente con el texto exacto: lanzado, espero
3. No llames a ninguna otra herramienta. No esperes al agente.`;

// What the board would deliver: a prompt that makes the model run tools.
const SECOND = `Ejecuta estas dos llamadas Bash, una tras otra: (1) echo alpha; (2) echo beta. Luego dime en una línea qué salió.`;

function streamingPrompt(text) {
  let release; const gate = new Promise((r) => { release = r; });
  let pushSecond; const secondGate = new Promise((r) => { pushSecond = r; });
  async function* gen() {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: 'probe' };
    await secondGate;
    yield { type: 'user', message: { role: 'user', content: SECOND }, parent_tool_use_id: null, session_id: 'probe' };
    await gate;   // held open for the rest of the arm, exactly like ChatSession
  }
  return { prompt: gen(), release, pushSecond };
}

async function runArm(arm, cwd) {
  const started = Date.now();
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
    settingSources: ['user', 'project'],
    env: (() => { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; return e; })(),
    forwardSubagentText: true,
    maxTurns: 8,
    persistSession: true,
    debugFile: join(OUT, `${arm.id}.debug.log`),
    stderr: (s) => appendFileSync(join(OUT, `${arm.id}.stderr.log`), s),
  };
  if (arm.hook) {
    // No matcher: the chat hook's shape, so it covers every tool.
    options.hooks = {
      PreToolUse: [{
        hooks: [async (input) => { log({ kind: 'hookFired', tool: input?.tool_name }); return {}; }],
      }],
    };
  }

  const { prompt, release, pushSecond } = streamingPrompt(RECIPE);
  let pushed = false;
  const pushNow = (why) => {
    if (pushed) return;
    pushed = true;
    log({ kind: 'secondPromptPushed', why });
    pushSecond();
  };

  let q = null;
  let firstResultAt = null;
  let notifAt = null;
  let selfInitAt = null;
  const toolDenials = [];
  const denials = [];
  let initMode = null; let sessionId = null; let closeReason = 'end';
  // Fallback: if the CLI never reports the background work, the arm must still
  // deliver its second prompt rather than sit there burning the timeout.
  const fallback = setTimeout(() => pushNow('fallback-60s'), 60_000);
  const timer = setTimeout(() => { closeReason = 'timeout'; try { q?.interrupt?.(); } catch { /* gone */ } release?.(); }, SESSION_TIMEOUT_MS);

  try {
    q = query({ prompt, options });
    for await (const m of q) {
      const at = Date.now() - started;
      appendFileSync(framesPath, JSON.stringify({ at, m }) + '\n');
      if (m.type === 'system' && m.subtype === 'init') {
        if (initMode == null) { initMode = m.permissionMode ?? m.permission_mode ?? null; sessionId = m.session_id; }
        else if (firstResultAt != null) { selfInitAt = at; log({ kind: 'selfTurnInit', at }); }
      }
      if (m.type === 'system' && m.subtype === 'task_started') log({ kind: 'task_started', at, task: m.task_id, ambient: !!m.ambient });
      if (m.type === 'system' && m.subtype === 'task_notification' && !m.ambient) {
        notifAt = at;
        log({ kind: 'task_notification', at, task: m.task_id });
        // THE POINT OF THE ARM: same tick as the CLI's own reaction.
        pushNow('task_notification');
      }
      if (m.type === 'system' && m.subtype === 'permission_denied') {
        denials.push({ at, ...m });
        log({ kind: 'permission_denied', at, tool: m.tool_name, reasonType: m.decision_reason_type });
      }
      if (m.type === 'user') {
        const c = m.message?.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'tool_result' && typeof b.content === 'string'
              && /doesn't want to (take this action|proceed)/.test(b.content)) {
              toolDenials.push({ at, id: b.tool_use_id, sidechain: !!m.parent_tool_use_id, afterPush: pushed, sincePushMs: pushed ? at - (events.find((e) => e.kind === 'secondPromptPushed')?.t ?? 0) : null });
              log({ kind: 'TOOL_DENIED', at });
            }
          }
        }
      }
      if (m.type === 'result') {
        if (firstResultAt == null) firstResultAt = at;
        log({ kind: 'result', at, subtype: m.subtype, turns: m.num_turns, stamped: m.user_message_uuid !== undefined, queued: m.queued_turn_count ?? null });
      }
    }
  } catch (e) {
    log({ kind: 'error', message: String(e?.message ?? e) });
    closeReason = 'error';
  } finally {
    clearTimeout(timer);
    clearTimeout(fallback);
    release?.();
    try { await q?.return?.(); } catch { /* gone */ }
  }

  const pushEv = events.find((e) => e.kind === 'secondPromptPushed');
  return {
    arm: arm.id, hook: arm.hook ? 'any (no matcher)' : 'none',
    sessionId, initPermissionMode: initMode, closeReason,
    seconds: Math.round((Date.now() - started) / 1000),
    firstResultAtMs: firstResultAt, taskNotificationAtMs: notifAt, selfTurnInitAtMs: selfInitAt,
    secondPushedAtMs: pushEv?.t ?? null, secondPushedBecause: pushEv?.why ?? null,
    pushAfterNotifMs: pushEv && notifAt != null ? pushEv.t - notifAt : null,
    toolDenials: toolDenials.length,
    permissionDeniedFrames: denials.length,
    hookFired: events.filter((e) => e.kind === 'hookFired').length,
    events, toolDenialDetail: toolDenials, denials,
  };
}

mkdirSync(OUT, { recursive: true });
preflight();
const cwd = process.argv[2];
if (!cwd) throw new Error('uso: node selfturn.mjs <cwd desechable> [armId...]');
const ARMS = [
  { id: 'E1-selfturn-hookAny', hook: true },
  { id: 'E2-selfturn-nohook', hook: false },
];
const only = process.argv.slice(3);
const todo = only.length ? ARMS.filter((a) => only.includes(a.id)) : ARMS;

const results = [];
for (const arm of todo) {
  process.stderr.write(`\n--- ${arm.id} ---\n`);
  preflight();
  const r = await runArm(arm, cwd);
  results.push(r);
  process.stderr.write(`${arm.id}: toolDenials=${r.toolDenials} hookFired=${r.hookFired} notifAt=${r.taskNotificationAtMs} pushAt=${r.secondPushedAtMs} (${r.secondPushedBecause}) gap=${r.pushAfterNotifMs}ms close=${r.closeReason} ${r.seconds}s\n`);
  writeFileSync(join(OUT, 'selfturn.log'), JSON.stringify(results, null, 1));
}
process.stderr.write('\n== resumen ==\n');
for (const r of results) process.stderr.write(`${r.arm}\thook=${r.hook}\tdenials=${r.toolDenials}\thookFired=${r.hookFired}\tgapAfterNotif=${r.pushAfterNotifMs}ms\n`);
