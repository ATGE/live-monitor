// Narrow provider selector for the E2 pilot. More pipeline phases remain on
// Claude until their hooks, approvals, MCP and quota semantics are implemented.
import { config } from '../config.js';
import { runClaude } from '../claude.js';
import { isCodexSession, runCodex } from './codex.js';
import { runCodexReadOnlyPlan } from './planning.js';

export function providerFor(stage, resume = null, cfg = config) {
  const selected = cfg.agents?.phases?.[stage] ?? 'claude';
  if (!['triage', 'chat', 'plan'].includes(stage) && selected !== 'claude') {
    throw new Error(`Provider ${selected} is not yet supported for phase ${stage}`);
  }
  if (!['claude', 'codex'].includes(selected)) {
    throw new Error(`Unknown agent provider: ${selected}`);
  }
  if (resume && isCodexSession(resume)) {
    if (selected !== 'codex') throw new Error('Codex thread cannot be resumed by Claude');
    return 'codex';
  }
  if (resume && selected === 'codex') {
    throw new Error('Claude thread cannot be resumed by Codex');
  }
  return selected;
}

/**
 * A planning transcript from another provider is not a valid executor fork.
 * Return null so the executor starts with the rendered plan in its prompt,
 * never passing a Codex UUID into the Anthropic SDK (or vice versa).
 */
export function forkSessionForProvider(sessionId, targetProvider) {
  if (sessionId == null) return null;
  if (!['claude', 'codex'].includes(targetProvider)) throw new Error('Unknown target provider');
  const sourceProvider = isCodexSession(sessionId) ? 'codex' : 'claude';
  return sourceProvider === targetProvider ? sessionId : null;
}

export async function runTaskAgent(options, { stage = 'triage', cfg = config } = {}) {
  const provider = providerFor(stage, options.resume, cfg);
  if (stage === 'chat') throw new Error('Interactive Codex/Claude sessions must use ChatSession, not runTaskAgent');
  if (provider === 'claude') return runClaude(options);
  const opts = cfg.agents?.codex ?? {};
  // Planning uses the App Server CLI already validated with ChatGPT on dev-vm.
  // Keep it read-only; hooks, external MCPs, and approval handlers from Claude
  // are intentionally not forwarded. All other task stages stay on Claude.
  if (stage === 'plan') {
    return runCodexReadOnlyPlan({
      machine: options.machine, cwd: options.cwd, prompt: options.prompt,
      resume: options.resume, forkSession: options.forkSession,
      onEvent: options.onEvent, signal: options.signal,
      model: opts.model || undefined,
      modelReasoningEffort: opts.reasoningEffort || undefined,
      timeoutMs: Number.isInteger(opts.timeoutMinutes) && opts.timeoutMinutes > 0
        ? opts.timeoutMinutes * 60_000 : undefined,
    });
  }
  // SDK-specific tuning is separate from the existing Claude model aliases.
  return runCodex({
    ...options,
    model: opts.model || undefined,
    modelReasoningEffort: opts.reasoningEffort || undefined,
    timeoutMs: Number.isInteger(opts.timeoutMinutes) && opts.timeoutMinutes > 0
      ? opts.timeoutMinutes * 60_000 : undefined,
  });
}
