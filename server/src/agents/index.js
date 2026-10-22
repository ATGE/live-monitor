// Narrow provider selector for the E2 pilot. More pipeline phases remain on
// Claude until their hooks, approvals, MCP and quota semantics are implemented.
import { config } from '../config.js';
import { runClaude } from '../claude.js';
import { isCodexSession, runCodex } from './codex.js';

export function providerFor(stage, resume = null, cfg = config) {
  const selected = cfg.agents?.phases?.[stage] ?? 'claude';
  if (!['triage', 'chat'].includes(stage) && selected !== 'claude') {
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

export async function runTaskAgent(options, { stage = 'triage', cfg = config } = {}) {
  const provider = providerFor(stage, options.resume, cfg);
  if (stage === 'chat') throw new Error('Interactive Codex/Claude sessions must use ChatSession, not runTaskAgent');
  if (provider === 'claude') return runClaude(options);
  const opts = cfg.agents?.codex ?? {};
  // SDK-specific tuning is separate from the existing Claude model aliases.
  return runCodex({
    ...options,
    model: opts.model || undefined,
    modelReasoningEffort: opts.reasoningEffort || undefined,
    timeoutMs: Number.isInteger(opts.timeoutMinutes) && opts.timeoutMinutes > 0
      ? opts.timeoutMinutes * 60_000 : undefined,
  });
}
