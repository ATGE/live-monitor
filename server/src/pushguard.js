// Push guard: a Stop hook handed only to interactive chat sessions. When the assistant
// closes a turn while the chat's branch is ahead of its upstream, it is told, once, to
// push or to say in one sentence why it must not. "A prompt asks; it does not guarantee."
//
// Pure on purpose: no board imports. The caller injects the git runner (machine.exec
// shape, so it reaches the machine the chat runs on), the logger and the project's base
// branch, which keeps this testable without a session or the live store.
//
// Every path out of the hook but one is `{}`: an error of ours never blocks a turn, and
// only unpushed commits count (uncommitted changes are the assistant's call).

const GIT_TIMEOUT_MS = 2000;

const plural = (n) => `${n} commit${n === 1 ? '' : 's'}`;

/**
 * @param {{ worktreePath?: string }} task  read when the hook fires, not when it is built
 * @param {{ planMode?: boolean }} chat     idem: plan mode can be toggled mid-session
 * @param {{ exec: Function, log?: (line: string) => void, baseBranch?: string }} deps
 */
export function chatStopHooks(task, chat, { exec, log, baseBranch } = {}) {
  const say = (line) => {
    try { log?.(`push guard: ${line}`); } catch { /* the log is not worth the turn */ }
  };
  const git = (cwd, args) => exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });

  const decide = async (input) => {
    // Hooks fire inside subagents too; their end is not the turn's end.
    if (input?.agent_id) return {};
    // The loop guard: ask at most once per turn.
    if (input?.stop_hook_active) { say('skipped, already asked this turn'); return {}; }
    if (chat?.planMode) { say('skipped, plan mode'); return {}; }
    const cwd = task?.worktreePath;
    if (!cwd) { say('skipped, no working directory'); return {}; }

    const names = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD', '@{u}']);
    if (!names?.ok) {
      const why = names?.code === -2 ? 'git timed out' : 'detached HEAD, no upstream or git failed';
      say(`nothing to push (${why})`);
      return {};
    }
    const [branch, upstream] = String(names.stdout ?? '').split(/\r?\n/).map((s) => s.trim());
    if (!branch || !upstream || branch === 'HEAD') { say('nothing to push (detached HEAD)'); return {}; }
    // Pushing the base branch is an explicit act, never a reflex.
    if (baseBranch && branch === baseBranch) { say(`skipped, ${branch} is the base branch`); return {}; }

    const counted = await git(cwd, ['rev-list', '--count', '@{u}..HEAD']);
    const ahead = counted?.ok ? Number.parseInt(String(counted.stdout).trim(), 10) : NaN;
    if (!Number.isInteger(ahead)) { say(`nothing to push (could not count commits on ${branch})`); return {}; }
    if (ahead <= 0) { say('nothing to push'); return {}; }

    say(`blocked, ${plural(ahead)} ahead of ${upstream}`);
    return {
      decision: 'block',
      reason: `Branch ${branch} is ${plural(ahead)} ahead of ${upstream}. `
        + 'Push it now (`git push`), or say in one sentence why it must not be pushed yet '
        + "(for example, you are waiting for the owner's approval).",
    };
  };

  const hook = async (input) => {
    try {
      return await decide(input);
    } catch (e) {
      say(`failed open (${e?.message ?? e})`);
      return {};
    }
  };

  return { Stop: [{ hooks: [hook] }] };
}
