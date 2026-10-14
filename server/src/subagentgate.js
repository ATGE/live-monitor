// PreToolUse hook that keeps subagents in the foreground.
//
// The subagent tool (`Agent`, or `Task` in older CLIs) runs its subagent in the
// background by default and returns at once. A phase that fans out then ends its
// turn on "the subagents are still working", and that sentence — not the plan or
// the PR body written once they report — is what the board took as the answer.
// Forcing `run_in_background: false` means the turn that answers the prompt
// cannot end with a subagent still out.
//
// The input is REPLACED by the CLI, not merged, so the rewrite carries the whole
// original input. `mode: 'deny'` is the fallback should a CLI not honour
// `updatedInput`: the call is refused with a reason that tells the model what to
// change (same shape as the gate in `pipeline.js#ghGateHooks`).

/** Tool names the CLI has used for the subagent tool. */
export const SUBAGENT_TOOLS = ['Agent', 'Task'];

export const SUBAGENT_MATCHER = SUBAGENT_TOOLS.join('|');

export const FOREGROUND_REASON = 'Este subagente se lanzaría en segundo plano y el turno terminaría sin su resultado. '
  + 'Vuelve a lanzarlo con `run_in_background: false` y espera su informe antes de responder.';

/** True when the call asks for (or defaults to) a background subagent. */
export const wantsBackground = (toolInput) => toolInput?.run_in_background !== false;

/**
 * The hook callback. Passes everything but a subagent launch through untouched.
 * @param {{ mode?: 'rewrite' | 'deny' }} [options]
 */
export function subagentGate({ mode = 'rewrite' } = {}) {
  return async (input) => {
    // Like `ghGateHooks`: a bug of its own (or an input whose getter throws)
    // costs a subagent that runs as the model asked, never the turn.
    try {
      if (!SUBAGENT_TOOLS.includes(input?.tool_name)) return {};
      const toolInput = input.tool_input;
      if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return {};
      if (!wantsBackground(toolInput)) return {};
      if (mode === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: FOREGROUND_REASON,
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...toolInput, run_in_background: false },
        },
      };
    } catch {
      return {};
    }
  };
}

/** The hooks object for `runClaude`; merge it with `mergeHooks`. */
export function subagentGateHooks(options) {
  return { PreToolUse: [{ matcher: SUBAGENT_MATCHER, hooks: [subagentGate(options)] }] };
}
