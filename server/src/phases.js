/**
 * The phases of a run, in order — and what a run that resumes at one of them
 * still has to do.
 *
 * It lives apart from `pipeline.js` on purpose. `mode.js` migrates the field on
 * every boot and must stay importable without dragging in the board — the
 * store, the machines, a Claude session; the web mirrors the same vocabulary to
 * name the step a task died on. So the order is here, with no imports at all.
 *
 * A phase is not a state. `task.phase` is one extra field written *before* each
 * phase starts, which is what lets a failure at the last step be remembered as
 * that step: `STATES` only learns about the PR once the PR exists, so a failure
 * opening it used to be recorded as `browser_qa` and cost a whole Browser QA
 * run on the next Retry (#1125). `demo` has no state of its own at all.
 */

export const PHASES = [
  'assigned', 'worktree', 'triage', 'plan_ready', 'fixing', 'testing', 'browser_qa', 'fix_gaps', 'pr', 'demo',
];

/** How each phase is named on the card and in the log, in the log's language. */
export const PHASE_LABEL = {
  assigned: 'startup',
  worktree: 'the worktree',
  triage: 'triage',
  plan_ready: 'plan approval',
  fixing: 'the fix',
  testing: 'the e2e tests',
  browser_qa: 'Browser QA',
  fix_gaps: 'closing the gaps',
  pr: 'opening the PR',
  demo: 'the demo steps',
};

/**
 * A stored value brought to the current vocabulary, or null when it names
 * nothing. `pr_draft` is the state a task reaches *after* the PR is created;
 * as a phase, the work it names is opening it.
 */
export const normalizePhase = (p) => (p === 'pr_draft' ? 'pr' : (PHASES.includes(p) ? p : null));

/**
 * What a run that resumes at `from` still has to do. Pure, and the whole point
 * of the file: `planOfRun('pr')` says no main, no fix, no tests and no QA —
 * which is the difference between publishing a title and paying for 25 minutes
 * of Browser QA a second time.
 *
 * `mergeMain` is false from the PR on: bringing origin/main in that late
 * invalidates the tests and the QA that already passed on this exact commit.
 * If main moved, the card says so («⬇ Pull ·N») and you decide.
 */
export function planOfRun(from) {
  const at = PHASES.indexOf(normalizePhase(from) ?? 'assigned');
  const i = at < 0 ? 0 : at;
  const pending = (phase) => i <= PHASES.indexOf(phase);
  return {
    mergeMain: i < PHASES.indexOf('pr'),
    worktree: pending('worktree'),
    triage: pending('triage'),
    fix: pending('fixing'),
    e2e: pending('testing'),
    qa: pending('browser_qa'),
    gaps: pending('fix_gaps'),
    pr: pending('pr'),
    demo: pending('demo'),
  };
}
