// Optional native Codex SDK bridge. This deliberately does NOT use Anthropic's
// SDK or an API key. The SDK launches its bundled Codex CLI, authenticated via
// the local user's "codex login" session.
//
// E2 scope: read-only, local-machine issue triage. Never use this adapter as a
// transparent replacement for phases which depend on Claude hooks or writes.
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const CODEX_SESSION_PREFIX = 'codex:';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// Injectable seam: tests exercise events, errors and resume without installing
// the SDK or contacting an account. Production imports the official package.
export const codexHooks = {
  create: async () => {
    let sdk;
    try {
      sdk = await import('@openai/codex-sdk');
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error('Codex SDK is not installed. See docs/codex-sdk.md (npm install --no-save --package-lock=false @openai/codex-sdk@0.163.0).');
      }
      throw err;
    }
    return new sdk.Codex();
  },
};

export const isCodexSession = (id) => typeof id === 'string' && id.startsWith(CODEX_SESSION_PREFIX);

/** Never hand a Claude transcript ID to Codex or vice versa. */
export function codexThreadId(sessionId) {
  if (sessionId == null) return null;
  if (!isCodexSession(sessionId)) throw new Error('Cannot resume a Claude session with Codex');
  const id = sessionId.slice(CODEX_SESSION_PREFIX.length);
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) throw new Error('Invalid Codex session id');
  return id;
}

/** Make the SDK events look like the existing phase logging events. */
export function codexEvent(event, onEvent, counts) {
  const item = event.item;
  const started = event.type === 'item.started';
  const completed = event.type === 'item.completed';
  if (!started && !completed && event.type !== 'item.updated') return;
  if (!item || typeof item !== 'object') return;
  let name;
  let input;
  let args;
  let output = '';
  let ok = true;
  switch (item.type) {
    case 'command_execution':
      name = 'Bash';
      input = String(item.command ?? '').slice(0, 300);
      args = { command: item.command ?? '' };
      // SDK events use snake_case; App Server JSON-RPC uses camelCase.
      output = item.aggregatedOutput ?? item.aggregated_output ?? '';
      ok = item.status !== 'failed' && item.status !== 'declined'
        && (item.exitCode ?? item.exit_code ?? 0) === 0;
      break;
    case 'file_change':
      name = 'Edit';
      input = (item.changes ?? []).map((c) => c.path).join(', ').slice(0, 300);
      args = { changes: item.changes ?? [] };
      ok = item.status !== 'failed';
      break;
    case 'mcp_tool_call':
      name = `mcp__${item.server}__${item.tool}`;
      input = JSON.stringify(item.arguments ?? {}).slice(0, 300);
      args = item.arguments ?? {};
      output = item.error?.message ?? '';
      ok = item.status !== 'failed';
      break;
    case 'web_search':
      name = 'WebSearch';
      input = String(item.query ?? '').slice(0, 300);
      args = { query: item.query };
      break;
    case 'agent_message':
      if (completed && item.text) onEvent?.({ kind: 'text', text: item.text });
      return;
    // Do not display hidden reasoning or unknown item payloads as text.
    default:
      return;
  }
  if (started) {
    counts[name] = (counts[name] ?? 0) + 1;
    onEvent?.({ kind: 'tool', id: item.id, name, input, args, parentId: null });
  } else if (completed) {
    onEvent?.({ kind: 'tool_end', id: item.id, name, ok, output, parentId: null });
  }
}

/**
 * Run a read-only Codex turn in one existing local checkout.
 *
 * Contract mirrors runClaude's relevant phase return fields:
 * {ok, quota, sessionId, resultText, toolCounts, error?, stats?}.
 *
 * Deliberately does not attempt to emulate Claude callbacks, forkSession,
 * subagents, maxTurns, MCP setup or account-quota management. A future App
 * Server provider can implement interactive features separately.
 */
export async function runCodex({
  machine, cwd, prompt, resume, onEvent, signal, model, modelReasoningEffort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const counts = Object.create(null);
  let sessionId = resume ?? null;
  let resultText = '';
  let usage = null;
  let completed = false;
  let failure = null;
  let timedOut = false;
  const started = Date.now();
  const result = (ok, error = null) => ({
    ok, quota: false, sessionId, resultText: ok ? resultText : '',
    toolCounts: counts,
    stats: { ms: Date.now() - started, provider: 'codex', tokens: usage
      ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : 0 },
    ...(error ? { error } : {}),
  });

  const ctl = new AbortController();
  const abort = () => ctl.abort();
  const deadline = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  deadline.unref?.();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    if (machine?.kind !== 'local') throw new Error('Codex SDK E2 only supports local worktrees (not remote runners)');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
      throw new Error('Codex requires an existing absolute worktree directory');
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Codex requires a prompt');
    const threadId = codexThreadId(resume);
    const client = await codexHooks.create();
    const options = {
      workingDirectory: cwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      // Do not pass Claude's "opus"/"sonnet" model aliases.
      ...(model ? { model } : {}),
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    };
    const thread = threadId ? client.resumeThread(threadId, options) : client.startThread(options);
    const { events } = await thread.runStreamed(prompt, { signal: ctl.signal });
    for await (const event of events) {
      if (event.type === 'thread.started') {
        sessionId = CODEX_SESSION_PREFIX + event.thread_id;
        onEvent?.({ kind: 'init', provider: 'codex', sessionId, model: model ?? 'default' });
      } else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        codexEvent(event, onEvent, counts);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          resultText = event.item.text ?? resultText;
        }
      } else if (event.type === 'turn.completed') {
        usage = event.usage ?? null;
        completed = true;
        onEvent?.({ kind: 'result', ok: true, turns: 1 });
      } else if (event.type === 'turn.failed') {
        failure = event.error?.message ?? 'Codex turn failed';
      } else if (event.type === 'error') {
        // Unlike SDK Thread.run(), do not silently accept fatal stream errors.
        failure = event.message ?? 'Codex stream failed';
      }
      if (failure) break;
    }
    if (!sessionId && thread.id) sessionId = CODEX_SESSION_PREFIX + thread.id;
    if (failure) throw new Error(failure);
    if (!completed || !resultText.trim()) throw new Error('Codex ended without a completed turn and nonempty answer');
    return result(true);
  } catch (error) {
    const message = timedOut ? 'Codex timed out' : error?.message ?? String(error);
    onEvent?.({ kind: 'error', error: message });
    return result(false, message);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
  }
}
