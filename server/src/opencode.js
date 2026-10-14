import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { runClaude } from './claude.js';
import { substantialAnswerOf } from './sealedanswer.js';

/**
 * Delegating a sub-task to another provider's model from an orchestrator
 * session, as an in-process tool the model can call like any other — the
 * structural mechanism the house rules ask for, not a prompt instruction.
 *
 * Two engines live here:
 *
 * - `opencode-cli` shells out to `opencode run` and can only report the final
 *   text it printed. Everything the delegate did in between is invisible.
 * - `claude-harness` runs a one-shot Claude Code session whose brain is an
 *   OpenCode Go model, reached through the board's loopback proxy. Its
 *   Read/Edit/Bash calls come back as ordinary session events, so they nest in
 *   the chat's activity tree under the delegate's own tool item, exactly like a
 *   Claude subagent — and the board can *measure* what happened instead of
 *   trusting the model's account of it.
 *
 * Pure functions first, the impure ones next, the SDK layer last — same shape
 * as qa.js, so everything but the final `machine.exec`/`machine.fs`/`runClaude`
 * calls is testable with no real `opencode` binary and no real session.
 */

export const OPENCODE_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
export const DEFAULT_SANDBOX = 'read-only';
// Windows' command line tops out near 32K; this leaves room for the rest of argv.
export const MAX_TASK_CHARS = 24_000;
export const MAX_OUTPUT_CHARS = 20_000;
// The SDK's own MCP tool-call timeout is effectively unbounded by default; this
// grace is added on top of `timeoutMs` so OUR timeout fires first, with a
// message that names what happened instead of a generic one from the MCP layer.
export const MCP_GRACE_MS = 60_000;
export const HARNESS_ENGINE = 'claude-harness';
// What the tool does when nobody says otherwise: the engine that was here first.
export const DEFAULT_ENGINE = 'opencode-cli';
// The alias the CLI is started with; the proxy rewrites it to the Go model.
export const HARNESS_ALIAS_MODEL = 'sonnet';
export const HARNESS_MAX_TURNS = 60;

const bad = (problem) => ({ ok: false, problem });

/** The `opencode run` argv for one delegated task. `task` is always last. */
export function buildOpencodeArgs({ task, model = null, variant = null }) {
  const text = String(task ?? '').trim();
  if (!text) return bad('no hay ninguna tarea que delegar');
  if (text.length > MAX_TASK_CHARS) return bad(`la tarea tiene ${text.length} caracteres; el máximo es ${MAX_TASK_CHARS}`);
  const args = ['run'];
  if (model) args.push('--model', String(model));
  if (variant) args.push('--variant', String(variant));
  args.push('--format', 'json', '--auto', '--print-logs', '--log-level', 'ERROR', text);
  return { ok: true, args };
}

/**
 * The `opencode.json` written before each call, selected by sandbox. Denies
 * are enforced by OpenCode even under `--auto` (its docs are explicit about
 * this), which is what makes `read-only` a structural guarantee rather than
 * an instruction. `workspace-write` still denies network access and reaching
 * outside the directory OpenCode was pointed at — nothing here needs that yet.
 */
export function opencodePermissionConfig(sandbox) {
  const edit = sandbox === 'workspace-write' ? 'allow' : 'deny';
  const bash = sandbox === 'workspace-write' ? 'allow' : 'deny';
  return JSON.stringify({
    permission: {
      edit, bash,
      webfetch: 'deny', websearch: 'deny', external_directory: 'deny',
    },
  }, null, 2);
}

/**
 * The last agent message out of `opencode run --format json`'s stdout.
 *
 * Walked backwards, because a turn that corrects itself leaves both attempts
 * in the stream — same reasoning as `parseTaggedJson` in tagged.js. The exact
 * event vocabulary is unverified (OpenCode's docs don't pin it down), so a
 * line this doesn't recognize is kept as plain text rather than dropped: an
 * unexpected shape degrades to raw output instead of losing the answer.
 */
export function parseOpencodeOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const events = [];
  const plain = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        events.push(JSON.parse(trimmed));
        continue;
      } catch {
        // Falls through to the plain-text bucket below.
      }
    }
    plain.push(line);
  }

  const messageOf = (e) => {
    if (!e || typeof e !== 'object') return null;
    // Confirmed against a real `opencode run --format json` reply (2026-09-22,
    // CLI 1.18.31): `{ type: 'text', part: { type: 'text', text } }`, one event
    // per part of a step. The other shapes below never showed up for real —
    // kept as a fallback in case the event shape drifts with another provider
    // or a later CLI version, since a guess that degrades to plain text is
    // cheaper than one that silently reports a real answer as empty.
    if (e.part?.type === 'text' && typeof e.part.text === 'string') return e.part.text;
    if (e.type === 'agent_message') return e.message ?? e.text ?? null;
    if (e.msg?.type === 'agent_message') return e.msg.message ?? e.msg.text ?? null;
    if (typeof e.last_agent_message === 'string') return e.last_agent_message;
    return null;
  };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const text = messageOf(events[i]);
    if (typeof text === 'string' && text.trim()) return { text, events };
  }
  return { text: plain.join('\n').trim(), events };
}

/** Agent-facing, never throws — every branch of `runOpencode` returns this instead. */
export function describeOpencodeFailure({ bin, code, stderr, timeoutMs }) {
  const tail = String(stderr ?? '').slice(-2000);
  if (code === -1 && /ENOENT|not recognized|no such file/i.test(tail)) {
    return `opencode no está instalado en esta máquina (\`${bin}\` no se encontró en el PATH)`;
  }
  if (code === -2) {
    const minutes = Math.round((timeoutMs ?? 0) / 60_000);
    return `opencode no terminó en ${minutes} minutos y se cortó.\n${tail}`;
  }
  if (code === -3) return `opencode se quedó sin conexión con la máquina donde corría y no llegó a responder.\n${tail}`;
  if (/not logged in|login|unauthorized|401/i.test(tail)) {
    return `opencode está instalado pero sin sesión: hace falta \`opencode auth login\` (o conectar Zen) en esta máquina.\n${tail}`;
  }
  return `opencode salió con código ${code}.\n${tail}`;
}

/** Keeps the tail: an agent's conclusion is at the end of a long answer. */
export function truncateOutput(text, max = MAX_OUTPUT_CHARS) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  const dropped = str.length - max;
  return `…[se recortaron ${dropped} caracteres]…\n${str.slice(-max)}`;
}

// ---------------------------------------------------------------------------
// The `claude-harness` engine: a Claude Code session with another provider's
// brain, so the delegate's every step is an event the board already knows how
// to draw.

/**
 * What points the CLI at the board's loopback proxy instead of the API.
 *
 * The key is not a secret and never leaves this machine: the proxy is on
 * 127.0.0.1 and claude.js only accepts a credential in an overlay when the base
 * URL is loopback, which is what keeps this from becoming a way to smuggle a
 * real key into a session.
 */
export function harnessEnv(port, model) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/m/${encodeURIComponent(model)}`,
    ANTHROPIC_API_KEY: 'zen-proxy',
  };
}

/**
 * The sandbox, as the only thing that can enforce it: the tool list the session
 * is started with. `read-only` has no Edit/Write/MultiEdit/NotebookEdit and no
 * Bash at all, so a delegate that decides to edit anyway simply has no tool to
 * do it with — the same guarantee `opencodePermissionConfig` gets from
 * OpenCode's denies, one layer up.
 */
export function harnessTools(sandbox) {
  return sandbox === 'workspace-write' ? undefined : ['Read', 'Grep', 'Glob'];
}

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The delegate's events that belong in the chat's tree, and nothing else.
 *
 * What is left out is what the parent turn already owns: its own `result` (a
 * second one ends the tree early), the `init` of a session that is not the
 * chat's, the quota frames of an account this session never touched, and
 * `error`/`warn` — the chat turns those into an «⚠️ Error» message of its own,
 * duplicating the `isError` result this tool is about to return.
 */
const FORWARDED_KINDS = new Set(['tool', 'tool_end', 'progress', 'text', 'task_started', 'task_progress', 'task_done']);

const commandMark = (ok) => (ok === null ? 'sin terminar' : (ok ? 'ok' : 'error'));

/**
 * The block appended to the delegate's answer: what the board watched happen.
 *
 * The model's own text is already the tool result; this is deliberately only
 * what was measured from its events and from git, so a delegate that claims to
 * have run the tests and did not is caught by the reader, not believed.
 */
export function summarizeHarness({ files = [], commands = [], diffBefore = null, diffAfter = null, harnessModel = null }) {
  const lines = ['--- resumen del tablero (medido, no dicho por el modelo) ---'];
  lines.push(`Archivos editados: ${files.length ? files.join(', ') : 'ninguno'}`);
  if (diffAfter !== null) {
    // An empty `after` over a non-empty `before` is not «nothing happened»: the
    // delegate reverted what the tree already had, which the reader must see.
    let changed;
    if (diffAfter && diffAfter !== diffBefore) changed = diffAfter;
    else if (!diffAfter && diffBefore) changed = `sin cambios (antes: ${diffBefore})`;
    else changed = 'sin cambios';
    lines.push(`git diff --stat: ${changed}`);
  }
  const shown = commands.map((c) => `\`${c.command}\` → ${commandMark(c.ok ?? null)}`).join(' · ');
  lines.push(`Comandos: ${shown || 'ninguno'}`);
  lines.push(`Motor: ${HARNESS_ENGINE} · ${harnessModel ?? 'sin modelo'}`);
  return lines.join('\n');
}

/**
 * Runs one delegated task as a Claude Code session driven by `harnessModel`.
 *
 * Never throws, for the same reason `runOpencode` doesn't: a proxy that is down
 * or a session that dies costs the orchestrator one tool result, not its turn.
 */
export async function runOpencodeHarness({
  machine, cwd, task, sandbox = DEFAULT_SANDBOX, harnessModel, timeoutMs = 30 * 60_000,
  onEvent, parentId = null, runClaudeFn = runClaude,
}) {
  const files = new Set();
  const commands = [];
  const byId = new Map();
  let diffBefore = null;
  let diffAfter = null;

  // The last line of `git diff --stat` is its totals row — the one number worth
  // showing. Empty when the tree is clean.
  const diffStat = async () => {
    const r = await machine.exec('git', ['diff', '--stat'], { cwd, timeoutMs: 60_000 });
    const out = String(r?.stdout ?? '').trim();
    return out ? out.split(/\r?\n/).at(-1).trim() : '';
  };
  const summary = () => summarizeHarness({ files: [...files], commands, diffBefore, diffAfter, harnessModel });

  try {
    const port = await machine.zenProxyPort();
    if (sandbox === 'workspace-write') diffBefore = await diffStat();

    // Re-parented on the way out: these events belong to the delegate's tool
    // item in the chat, not to the turn that called it (see FORWARDED_KINDS
    // for what never gets there). The CLI reports absolute paths; inside the
    // worktree the relative one is what a reader compares with `git diff --stat`.
    const inTree = (file) => {
      const p = machine.path;
      if (!p?.isAbsolute?.(file)) return file;
      const rel = p.relative(cwd, file);
      return rel && !rel.startsWith('..') && !p.isAbsolute(rel) ? rel : file;
    };
    // Set the moment the race resolves, whichever way: after a timeout the
    // abandoned session may keep talking for minutes, and its events would
    // land in a chat whose tool item has already answered.
    let settled = false;
    const wrapped = (ev) => {
      if (settled) return;
      if (ev.kind === 'tool') {
        if (EDITING_TOOLS.has(ev.name)) {
          const file = ev.args?.file_path ?? ev.args?.notebook_path;
          if (file) files.add(inTree(String(file)));
        } else if (ev.name === 'Bash' && ev.args?.command) {
          const entry = { command: ev.args.command, id: ev.id, ok: null };
          commands.push(entry);
          byId.set(ev.id, entry);
        }
      } else if (ev.kind === 'tool_end') {
        const entry = byId.get(ev.id);
        if (entry) entry.ok = ev.ok !== false;
      }
      if (!FORWARDED_KINDS.has(ev.kind)) return;
      onEvent?.({ ...ev, parentId: ev.parentId ?? parentId });
    };

    let handle = null;
    let timer = null;
    const TIMED_OUT = Symbol('timeout');
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    const running = runClaudeFn({
      machine,
      cwd,
      prompt: task,
      model: HARNESS_ALIAS_MODEL,
      maxTurns: HARNESS_MAX_TURNS,
      permissionMode: 'bypassPermissions',
      tools: harnessTools(sandbox),
      env: harnessEnv(port, harnessModel),
      // This session runs on another provider's model: what it says proves
      // nothing about the Anthropic window the rest of the board waits on.
      trackQuota: false,
      onEvent: wrapped,
      onQuery: (q) => { handle = q; },
    });
    // On timeout nobody awaits this promise any more; a rejection arriving
    // later with no handler would take the whole board's process down.
    Promise.resolve(running).catch(() => {});
    let r;
    try {
      r = await Promise.race([running, timeout]);
    } finally {
      clearTimeout(timer);
      settled = true;
    }

    if (r === TIMED_OUT) {
      // `close()`, not `interrupt()`: the SDK documents interrupt as streaming
      // input only, and this session was started with a plain string prompt.
      // `close()` terminates the process and ends the iterator.
      try {
        const closing = handle?.close?.();
        if (closing?.catch) closing.catch(() => {});
      } catch { /* the session may already be gone */ }
      return {
        ok: false, text: '', summary: summary(),
        error: `the delegated session did not finish in ${Math.round(timeoutMs / 60_000)} minutes and was cut off`,
      };
    }

    if (sandbox === 'workspace-write') diffAfter = await diffStat();

    if (!r?.ok) {
      const error = r?.quota
        ? 'the delegated session was cut off by quota'
        : (r?.error ?? 'the delegated session ended without a result');
      return { ok: false, text: '', error, summary: summary() };
    }
    // The delegate can fan out to subagents too: an acknowledgement turn must not replace its answer.
    const text = substantialAnswerOf(r);
    if (!text.trim()) return { ok: false, text: '', error: 'the delegated session ended without saying anything', summary: summary() };
    return { ok: true, text, error: null, summary: summary() };
  } catch (err) {
    return { ok: false, text: '', error: err.message, summary: summary() };
  }
}

/**
 * Runs one delegated task and turns whatever happens into a result — never a
 * thrown exception, so a broken or absent `opencode` costs the orchestrator
 * one tool result, not the session.
 *
 * The read-only guard has to run before anything else: OpenCode's documented
 * config precedence is global < `OPENCODE_CONFIG` < the target directory's own
 * `opencode.json`, so a project config in the worktree could silently
 * override the `deny` rules we are about to write. Refusing outright, rather
 * than trusting `OPENCODE_CONFIG` to win, is what keeps `read-only` a real
 * guarantee instead of one that breaks on the first repo with its own config.
 */
export async function runOpencode({
  machine, cwd, configDir, task, sandbox = DEFAULT_SANDBOX, model = null, variant = null,
  bin = 'opencode', timeoutMs = 30 * 60_000, onLine,
  engine = DEFAULT_ENGINE, harnessModel = null, onEvent, parentId = null, runClaudeFn,
}) {
  if (engine === HARNESS_ENGINE) {
    const r = await runOpencodeHarness({ machine, cwd, task, sandbox, harnessModel, timeoutMs, onEvent, parentId, runClaudeFn });
    return { ok: r.ok, text: r.text, code: null, error: r.error, summary: r.summary };
  }
  // OpenCode retries a plan's usage limit silently instead of exiting; the only
  // sign is its own error log on stderr (hence `--print-logs --log-level ERROR`),
  // so we watch for it and abort instead of waiting out the whole timeout.
  const controller = new AbortController();
  let limitLine = null;
  const limitResult = (code) => ({
    ok: false, text: '', code: code ?? null,
    error: 'OpenCode reached its plan usage limit and will not answer until it renews; '
      + `do not retry. (${limitLine.trim().slice(0, 200)})`,
  });
  // Only OpenCode's own log lines count: stdout is JSON events, and a task or a
  // file it reads may well quote the phrase (this very file does).
  const isLimitLog = (text) => !text.startsWith('{') && /\blevel=ERROR\b/.test(text)
    && /usage limit exceeded/i.test(text);
  const watchLine = (line) => {
    if (onLine) onLine(line);
    if (limitLine === null && isLimitLog(String(line).trimStart())) {
      limitLine = String(line);
      controller.abort();
    }
  };
  try {
    if (sandbox === 'read-only') {
      const projectConfig = machine.path.join(cwd, 'opencode.json');
      if (await machine.fs.exists(projectConfig)) {
        return {
          ok: false, text: '', code: null,
          error: 'this worktree has its own opencode.json; with the documented OpenCode precedence '
            + 'it could override the read-only sandbox, so it does not run without a manual review',
        };
      }
    }

    const built = buildOpencodeArgs({ task, model, variant });
    if (!built.ok) return { ok: false, text: '', code: null, error: built.problem };

    const configPath = machine.path.join(configDir, `opencode-${sandbox}.json`);
    await machine.fs.mkdir(configDir);
    await machine.fs.writeFile(configPath, opencodePermissionConfig(sandbox));

    const r = await machine.exec(bin, built.args, {
      // OpenCode's bash tool kills a command after 2 minutes by default and a `cargo test` of hfs
      // takes longer; our own exec timeout still fires first, its timer starts before OpenCode's first bash call.
      cwd, env: { OPENCODE_CONFIG: configPath, OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: String(timeoutMs) }, timeoutMs,
      onLine: watchLine, signal: controller.signal,
    });

    if (limitLine !== null) return limitResult(r?.code);
    if (!r.ok) return { ok: false, text: '', code: r.code, error: describeOpencodeFailure({ bin, code: r.code, stderr: r.stderr, timeoutMs }) };

    const { text } = parseOpencodeOutput(r.stdout);
    if (!text) return { ok: false, text: '', code: r.code, error: 'opencode ended without saying anything' };
    return { ok: true, text, code: r.code, error: null };
  } catch (err) {
    if (limitLine !== null) return limitResult(null);
    return { ok: false, text: '', code: null, error: err.message };
  }
}

const OPENCODE_TASK_SCHEMA = {
  task: z.string().min(1).max(MAX_TASK_CHARS)
    .describe('El encargo completo para OpenCode: qué hacer, dónde mirar y qué debe devolver. '
      + 'OpenCode no ve esta conversación ni nada de lo que ya sabes.'),
  sandbox: z.enum(OPENCODE_SANDBOXES).default(DEFAULT_SANDBOX)
    .describe('`read-only`: OpenCode lee el worktree y responde, sin tocar nada. '
      + '`workspace-write`: además puede editar archivos y correr comandos en el worktree.'),
};

const DELEGATE_DESCRIPTION = 'Delega un sub-encargo en un agente de otro proveedor y espera su respuesta. '
  + 'Corre como un agente aparte en el worktree de esta tarea, sin acceso a esta conversación: `task` '
  + 'tiene que bastarse solo. Úsalo para una segunda opinión de otro proveedor, no para no hacer aquí '
  + 'el trabajo. Por defecto el sandbox es de solo lectura.';

const HARNESS_DESCRIPTION = `${DELEGATE_DESCRIPTION} El delegado es un agente completo: sus lecturas, `
  + 'ediciones y comandos se ven en el chat mientras trabaja, y su respuesta trae un resumen de lo que '
  + 'el tablero midió que hizo.';

/** The tool as the orchestrator sees it: `mcp__opencode__delegate`. */
export function opencodeDelegateTool({
  machine, cwd, configDir, bin, model, variant, timeoutMs, onLine,
  engine = DEFAULT_ENGINE, harnessModel = null, onEvent, parentIdFor,
  runClaudeFn, // seam: the tests drive the harness without starting a real session
}) {
  return tool(
    'delegate',
    engine === HARNESS_ENGINE ? HARNESS_DESCRIPTION : DELEGATE_DESCRIPTION,
    OPENCODE_TASK_SCHEMA,
    async (args) => {
      const sandbox = args.sandbox ?? DEFAULT_SANDBOX;
      // The delegate's own tool_use_id is not visible in here; the PreToolUse
      // hook saw it and left it where `parentIdFor` can claim it by task.
      const parentId = parentIdFor?.(args.task) ?? null;
      const r = await runOpencode({
        machine, cwd, configDir, task: args.task, sandbox, model, variant, bin, timeoutMs, onLine,
        engine, harnessModel, onEvent, parentId, runClaudeFn,
      });
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error }] };
      const text = r.summary ? `${truncateOutput(r.text)}\n\n${r.summary}` : truncateOutput(r.text);
      return { content: [{ type: 'text', text }] };
    },
    { alwaysLoad: true },
  );
}

/** The shape `liveOf` spreads into a chat session's `mcpServers`. */
export function opencodeMcpServers({
  machine, cwd, configDir, bin, model, variant, timeoutMs, onLine,
  engine, harnessModel, onEvent, parentIdFor,
} = {}) {
  return {
    opencode: createSdkMcpServer({
      name: 'opencode',
      version: '1.0.0',
      alwaysLoad: true,
      timeout: (timeoutMs ?? 30 * 60_000) + MCP_GRACE_MS,
      tools: [opencodeDelegateTool({
        machine, cwd, configDir, bin, model, variant, timeoutMs, onLine,
        engine, harnessModel, onEvent, parentIdFor,
      })],
    }),
  };
}
