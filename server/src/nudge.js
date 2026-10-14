/**
 * The parallelism nudge: one follow-up in the same session when it went in a row.
 *
 * A prompt asks for fan-out; it does not guarantee it. After a session ends, if
 * it launched fewer subagents than `minSubagents` while making at least
 * `minCalls` calls that could have been split (reads, greps, commands), the
 * board resumes that same session once and asks for the fan-out. Never twice for
 * the same session: the ids already nudged live in `task.nudged`, which is
 * persisted before the resume so a restart cannot repeat it.
 *
 * The nudge never makes a phase worse: if it fails, runs out of quota or comes
 * back empty, the original result is kept.
 *
 * Pure on purpose: it takes the run function and the log/persist callbacks, and
 * imports nothing from the store or the pipeline.
 */
import { PARALLEL_SCOPE } from './parallel.js';
import { subagentsUsed } from './workplan.js';

/** Calls a session could have handed to subagents. */
export const FANOUT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'];

/** Cap of the `task.nudged` list: the sessions of one task never come near it. */
const NUDGED_KEEP = 50;

/**
 * On for the phases that only read; off for the ones that write to the tree or
 * resume the principal session, where asking again redoes work. Tune it with the
 * subagent-share view once there is real data.
 */
export const NUDGE_DEFAULTS = {
  minCalls: 12,
  minSubagents: 2,
  maxTurns: 15,
  phases: {
    triage: true,
    'change-request': true,
    'qa-plan': true,
    'pr-body': true,
    demo: true,
    'fix-gaps': false,
    'review-replies': false,
  },
};

const SUBAGENT_NAMES = ['Agent', 'Task'];

/**
 * The policy for one template, or null when it must not be nudged.
 *
 * `name` is the template name, the key of `PARALLEL_SCOPE`. Exempt templates
 * (close-issue, issue-draft, handoff) and `edit` ones (they write; their waves
 * belong to the plan executor) are never nudged, whatever the config says. A
 * call whose `tools` list is given and has no subagent tool cannot fan out.
 *
 * `cfg` is `pipeline.nudge`: `false` turns everything off; an object may carry
 * `minCalls`, `minSubagents`, `maxTurns` and `phases: { <name>: true | false | { minCalls, ... } }`.
 */
export function nudgePolicy(name, cfg, tools) {
  if (cfg === false) return null;
  if (PARALLEL_SCOPE[name] !== 'core') return null;
  if (Array.isArray(tools) && !tools.some((t) => SUBAGENT_NAMES.includes(t))) return null;
  const mine = cfg?.phases?.[name] ?? NUDGE_DEFAULTS.phases[name] ?? false;
  if (mine === false) return null;
  const over = mine && typeof mine === 'object' ? mine : {};
  // A value that is not a positive integer (0, "15", -1) is skipped, level by level,
  // like `maxTurnsFor` does: it never reaches the SDK.
  const pick = (key) => [over[key], cfg?.[key]].find((v) => Number.isInteger(v) && v > 0) ?? NUDGE_DEFAULTS[key];
  return { minCalls: pick('minCalls'), minSubagents: pick('minSubagents'), maxTurns: pick('maxTurns') };
}

/** Calls of a session that could have been split across subagents. */
const fanoutCalls = (toolCounts = {}) => FANOUT_TOOLS.reduce((n, t) => n + (toolCounts[t] ?? 0), 0);

/** Whether a finished session went in a row and has not been nudged yet. */
export function shouldNudge(result, policy, nudgedIds = []) {
  if (!policy || !result?.ok || result.quota || !result.sessionId) return false;
  if (result.stats?.subtype === 'error_max_turns') return false;
  if (nudgedIds.includes(result.sessionId)) return false;
  if (subagentsUsed(result.toolCounts) >= policy.minSubagents) return false;
  return fanoutCalls(result.toolCounts) >= policy.minCalls;
}

/** The one follow-up message (Spanish, like the board's other re-asks). */
export function nudgePrompt({ calls, subagents }) {
  return [
    `Tu sesión hizo ${calls} lecturas, búsquedas y comandos con ${subagents} subagente${subagents === 1 ? '' : 's'}: fue en fila.`,
    'Reparte lo que queda por comprobar o revisar: lanza al menos 2 subagentes en un mismo mensaje,',
    'cada uno con una pregunta independiente, en primer plano, y espera a todos.',
    'Si de verdad no hay nada independiente que repartir, dilo en una frase y sigue.',
    'En todo caso termina repitiendo tu respuesta final completa, sin preámbulo y en el mismo formato de antes:',
    'esa respuesta es lo que se guarda, así que una frase sola no la sustituye.',
  ].join(' ');
}

const addCounts = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** A sum that stays null when neither side knows the figure. */
const addKnown = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * The stats of a session plus its nudge: time, turns and cost add up (they are
 * what the nudge cost on top); everything else, subtype included, is the last call's.
 */
function mergeStats(first, again) {
  if (!first || !again) return again ?? first;
  return {
    ...again,
    ms: addKnown(first.ms, again.ms),
    turns: addKnown(first.turns, again.turns),
    costUsd: addKnown(first.costUsd, again.costUsd),
  };
}

/**
 * Runs the session and, if it went in a row, resumes it once.
 *
 * - `cfg`: `pipeline.nudge` (see `nudgePolicy`).
 * - `options`: what `run` takes; `options.tools` is read for the exemption.
 * - `before`: awaited right before the resume (a phase releases the principal chat there);
 *   when it throws the nudge is refused and the session is NOT marked.
 * - `log` / `persist`: one log line per outcome; `persist` runs after `before`, before the resume.
 *
 * - `held`: true while a quota hold stops new work; no paid turn starts then.
 *
 * Returns the original result untouched when there is no nudge, the original
 * with `nudged: 'kept'` and a `nudgeReason` (`refused`, `threw`, `error`, `quota`,
 * `empty`) when the nudge did not help, or the nudge's own result
 * with the tool counts of both, the session id kept and `nudged: true`. That
 * last one also carries `fallbackTexts`, the first answer's texts: the nudge may
 * answer in one sentence, and the phase's own validator (`answerOf`) falls back
 * to them when the adopted reply is not an answer.
 */
export async function withNudge({ task, name, cfg, options, run, log = () => {}, persist = () => {}, before, held }) {
  const first = await run(options);
  const policy = nudgePolicy(name, cfg, options?.tools);
  if (!shouldNudge(first, policy, task?.nudged ?? [])) return first;
  if (held?.()) {
    log(`${name}: quota pause in effect; the fan-out nudge is not sent`);
    return first;
  }

  const calls = fanoutCalls(first.toolCounts);
  const subagents = subagentsUsed(first.toolCounts);
  // A refused `before` (the principal chat has a live turn) leaves the session
  // unmarked, like the quota hold: the nudge can still happen on a later pass.
  try {
    await before?.();
  } catch (e) {
    log(`${name}: nudge refused (${e?.message ?? e}); the session is not marked and the original answer is kept`);
    return { ...first, nudged: 'kept', nudgeReason: 'refused' };
  }
  task.nudged = [...(task.nudged ?? []), first.sessionId].slice(-NUDGED_KEEP);
  persist();
  log(`${name}: ${calls} parallelizable calls and ${subagents} subagents; nudging for fan-out once in the same session`);

  let again;
  try {
    again = await run({
      ...options,
      prompt: nudgePrompt({ calls, subagents }),
      resume: first.sessionId,
      forkSession: undefined,
      maxTurns: policy.maxTurns,
      metrics: options?.metrics ? { ...options.metrics, nudge: true } : options?.metrics,
    });
  } catch (e) {
    log(`${name}: the nudge resume threw (${e?.message ?? e}); the original answer is kept`);
    return { ...first, nudged: 'kept', nudgeReason: 'threw' };
  }
  const useless = !again?.ok ? ['error', 'ended with an error']
    : again.quota ? ['quota', 'hit the quota']
      : !String(again.resultText ?? '').trim() ? ['empty', 'returned an empty answer'] : null;
  if (useless) {
    log(`${name}: the nudge ${useless[1]}; the original answer is kept`);
    return { ...first, nudged: 'kept', nudgeReason: useless[0] };
  }
  log(`${name}: after the nudge, ${subagentsUsed(again.toolCounts)} more subagents`);
  return {
    ...again,
    stats: mergeStats(first.stats, again.stats),
    sessionId: again.sessionId ?? first.sessionId,
    toolCounts: addCounts(first.toolCounts, again.toolCounts),
    fallbackTexts: [first.resultText, ...(first.replacedTexts ?? []), first.sealedText].filter((t) => typeof t === 'string' && t.trim()),
    nudged: true,
  };
}
