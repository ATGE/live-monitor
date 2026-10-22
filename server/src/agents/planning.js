// Single-turn, read-only Codex App Server runner for planning phases.
//
// Reuses the protocol already exercised by the real Incus/ChatGPT smoke,
// rather than depending on a second CLI distributed through the SDK package.
// Crucially does NOT emulate Claude's PreToolUse hooks or grant write access.
// No model/permission settings from Claude are forwarded.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CodexChatSession } from './chat-session.js';

export const codexBatchHooks = {
  create: (options) => new CodexChatSession(options),
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function runCodexReadOnlyPlan({
  machine, cwd, prompt, resume, forkSession = false, onEvent, signal,
  model, modelReasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS,
  mcpPolicy = null,
} = {}) {
  const started = Date.now();
  const failed = (error) => ({
    ok: false, quota: false, sessionId: resume ?? null, resultText: '',
    toolCounts: Object.create(null),
    stats: { ms: Date.now() - started, provider: 'codex', tokens: 0 },
    error,
  });
  if (machine?.kind !== 'local') return failed('Codex planning currently requires the local Incus worktree');
  if (!path.isAbsolute(cwd ?? '')) return failed('Codex planning requires an absolute worktree path');
  try {
    if (!(await stat(cwd)).isDirectory()) return failed('Codex planning requires a directory');
  } catch {
    return failed('Codex planning worktree does not exist');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) return failed('Codex planning requires a prompt');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return failed('Invalid Codex planning timeout');
  if (signal?.aborted) return failed('Codex planning aborted before it started');

  let session;
  let timer;
  let aborted = false;
  let timedOut = false;
  const abort = () => { aborted = true; session?.close(); };
  try {
    session = codexBatchHooks.create({
      machine, cwd, model: model ?? null, effort: modelReasoningEffort ?? null,
      resume: resume ?? null, forkSession, permissionMode: 'plan',
      onEvent, idleMs: 0,
      mcpPolicy,
      // All approval RPCs are rejected; no write permission can be granted.
      onApproval: async () => ({ decision: 'decline' }),
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => {
      timedOut = true;
      session.close();
    }, timeoutMs);
    const result = await session.send(prompt);
    if (aborted || timedOut) {
      return { ...result, ok: false, quota: false, resultText: '',
        error: timedOut ? 'Codex planning timed out' : 'Codex planning aborted' };
    }
    return result;
  } catch (error) {
    return failed(error?.message ?? String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    session?.close();
  }
}
