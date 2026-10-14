/**
 * Runs a validated WORK_PLAN: one Claude session per task, every ready task
 * at once, wave after wave. This is where "parallel" stops being a request to
 * the model and becomes something the board does.
 *
 * The plan record is the same for a chat's plan and for the fix phase; what
 * differs — where sessions fork from, where their activity goes, how to ask
 * the user, what to do at the end — is the `host`. The runner itself takes
 * `runClaude` as a parameter so the whole thing runs under test with a fake.
 *
 * Task statuses: pending → running → checking → done
 *                              ↘ failed (retried) ↘ asking (retries exhausted, or
 *                                                   the failure is unrecoverable)
 *                              ↘ stopped (Detener; Continuar relaunches)
 *                skipped: not selected, or skipped after failing.
 * While a repair turn runs the status stays `running` and `task.repairing` is
 * true, so everything that already handles a running task handles it.
 */

import { substantialAnswerOf } from './sealedanswer.js';

export const DEFAULT_MAX_RETRIES = 3;

const TERMINAL = new Set(['done', 'failed', 'skipped']);

/**
 * The fresh record of one task. Exported because a plan change adds tasks to a
 * plan already running, and they must be born exactly like the original ones.
 */
export function newTaskRecord(t) {
  return {
    id: t.id, what: t.what, files: [...t.files], dependsOn: [...t.dependsOn], check: t.check ?? null,
    status: 'pending', sessionId: null, attempts: 0, extraRetries: 0, lastFailure: null,
    summary: null, filesChanged: [], startedAt: null, endedAt: null, hint: null,
  };
}

/** A fresh record from a validated plan: every task pending, nothing selected yet. */
export function newPlanRecord({ id, filePath = null, text = '', tasks, waves }) {
  return {
    id,
    filePath,
    text,
    status: 'approved',
    selected: tasks.map((t) => t.id),
    tasks: tasks.map(newTaskRecord),
    waves: waves.map((w) => [...w]),
    activityId: null,
    startedAt: null,
    endedAt: null,
  };
}

const byId = (plan, id) => plan.tasks.find((t) => t.id === id) ?? null;

/** Every task `id` transitively waits for. */
function ancestorsOf(plan, id, acc = new Set()) {
  for (const dep of byId(plan, id)?.dependsOn ?? []) {
    if (!acc.has(dep)) { acc.add(dep); ancestorsOf(plan, dep, acc); }
  }
  return acc;
}

/** Every task that transitively waits for `id`. */
function dependentsOf(plan, id, acc = new Set()) {
  for (const t of plan.tasks) {
    if (t.dependsOn.includes(id) && !acc.has(t.id)) { acc.add(t.id); dependentsOf(plan, t.id, acc); }
  }
  return acc;
}

/**
 * The selection the user asked for, made runnable: picking a task pulls in
 * the dependencies it still needs. Returns the selection and what was added.
 */
export function selectWithDeps(plan, ids) {
  const selected = new Set(ids.filter((id) => byId(plan, id)));
  const added = [];
  for (const id of [...selected]) {
    for (const dep of ancestorsOf(plan, id)) {
      if (!selected.has(dep) && byId(plan, dep).status !== 'done') { selected.add(dep); added.push(dep); }
    }
  }
  const order = plan.tasks.map((t) => t.id);
  return { selected: [...selected].sort((a, b) => order.indexOf(a) - order.indexOf(b)), added };
}

/** Dropping a task drops what depends on it: nothing runs without its inputs. */
export function deselectWithDependents(plan, ids, id) {
  const drop = new Set([id, ...dependentsOf(plan, id)]);
  return { selected: ids.filter((x) => !drop.has(x)), removed: [...drop].filter((x) => ids.includes(x)) };
}

/** Marks the selection on the record: what is not selected is skipped. */
export function applySelection(plan, ids) {
  const { selected } = selectWithDeps(plan, ids);
  plan.selected = selected;
  for (const t of plan.tasks) {
    if (t.status === 'done') continue;
    t.status = selected.includes(t.id) ? 'pending' : 'skipped';
  }
  return plan;
}

/** Pending tasks whose every dependency is done. */
export function readyTasks(plan) {
  return plan.tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => byId(plan, d)?.status === 'done'));
}

/** Pending tasks that can never run: something upstream failed or was skipped. */
export function blockedTasks(plan) {
  return plan.tasks.filter((t) => t.status === 'pending'
    && [...ancestorsOf(plan, t.id)].some((d) => ['failed', 'skipped'].includes(byId(plan, d)?.status)));
}

/** Out of retries — counting the extra rounds the user granted by answering «Reintentar». */
export const exhausted = (task, maxRetries = DEFAULT_MAX_RETRIES) => task.attempts > maxRetries + (task.extraRetries ?? 0);

/**
 * What a check's output says, without what changes on every run: timings,
 * ports, pids and durations are digits, so every run of digits becomes `#`.
 * Two failures with the same signature are the same failure. ANSI is already
 * stripped upstream.
 */
export const failureSignature = (output) => String(output ?? '').replace(/\d+/g, '#').trim();

/**
 * Whether retrying can possibly help. A failed check whose output is the same
 * as the previous attempt's, over a worktree whose content did not change in
 * between, will fail the same way again: the session did nothing, and the
 * next one is handed the same failure. That is the plan or the environment,
 * not the code, and only a person can change either.
 *
 * Only compared against a failure of the same run: the first attempt after
 * «Continuar» must get its chance — the person may have fixed the environment
 * meanwhile. `continuePlan` (also the fix phase's way back) clears
 * `lastFailure.fingerprint` of every task it sends back to pending, and keeps
 * the rest of the record for the UI; the count alone could not tell, because
 * a stopped task keeps its `attempts`. Attempt 1 never compares either
 * (`attempts > 1`). A null fingerprint on either side (host without
 * `fingerprint`, or git failed) never matches: detection off, never a false
 * positive.
 *
 * Tasks of one wave share one worktree, so a sibling's edits change the
 * fingerprint and detection often stays off in multi-task waves. That is the
 * safe direction, and scoping it to `task.files` would miss the files a
 * session touches outside its list.
 */
function isUnrecoverable(task, prev, failure) {
  return task.attempts > 1
    && prev?.kind === 'check' && failure.kind === 'check'
    && Boolean(prev.fingerprint) && Boolean(failure.fingerprint)
    && prev.fingerprint === failure.fingerprint
    && prev.signature === failure.signature;
}

/**
 * The attempt line. Within the budget it counts against the maximum; past it
 * the round exists only because the person answered «Reintentar», and saying
 * «reintento 5 de 3» would be a lie about the budget.
 */
function attemptLabel(task, maxRetries) {
  if (task.attempts === 1) return 'starts';
  const n = task.attempts - 1;
  return n <= maxRetries ? `retry ${n} of ${maxRetries}` : 'extra retry (requested by you)';
}

/** Nothing ever estimates less than a minute left: a spinner at 0 is a lie. */
const MIN_REMAINING_MS = 60 * 1000;

const RUNNING = new Set(['running', 'checking']);

/**
 * How long the plan still has, from how long its finished tasks took. A wave
 * runs at once, so what is left is the laggard's remainder and not the sum;
 * until one task has finished there is nothing to average, and a made-up
 * number would be worse than none.
 */
function estimateMsOf(plan, now) {
  const spans = plan.tasks
    .filter((t) => t.startedAt && t.endedAt)
    .map((t) => Date.parse(t.endedAt) - Date.parse(t.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (!spans.length) return null;
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;

  const running = plan.tasks.filter((t) => RUNNING.has(t.status) && t.startedAt);
  if (!running.length) return null;
  return Math.max(...running.map((t) => {
    const elapsed = now - Date.parse(t.startedAt);
    return Math.max(MIN_REMAINING_MS, Math.round(mean - (Number.isFinite(elapsed) ? elapsed : 0)));
  }));
}

/** Counts by status, how much is left to wait, and the line the bubble shows. */
export function planProgress(plan, now = Date.now()) {
  const counts = {};
  for (const t of plan.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const total = plan.tasks.filter((t) => t.status !== 'skipped').length;
  return { total, done: counts.done ?? 0, counts, estimateMs: estimateMsOf(plan, now) };
}

const GLYPH = { pending: '·', skipped: '⊘', running: '⟳', checking: '⟳', done: '✓', failed: '✗', stopped: '⏹', asking: '❓' };

export function planSummaryLine(plan) {
  return plan.tasks.map((t) => `${t.id} ${GLYPH[t.status] ?? '?'}${t.attempts > 1 ? String(t.attempts).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]) : ''}`).join(' ');
}

/**
 * What the board can now say that a prompt never could: how many sessions
 * ran at once, and what that saved against doing the same work in a line.
 */
export function parallelismReport(plan) {
  const ran = plan.tasks.filter((t) => t.startedAt && t.endedAt);
  const stamps = ran.flatMap((t) => [[Date.parse(t.startedAt), 1], [Date.parse(t.endedAt), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, d] of stamps) { open += d; peak = Math.max(peak, open); }
  const serial = ran.reduce((s, t) => s + (Date.parse(t.endedAt) - Date.parse(t.startedAt)), 0);
  const wall = plan.startedAt && plan.endedAt ? Date.parse(plan.endedAt) - Date.parse(plan.startedAt) : serial;
  return { tasks: plan.tasks.length, waves: plan.waves.length, peak, wallMs: wall, serialMs: serial };
}

export function parallelismReportLine(plan) {
  const r = parallelismReport(plan);
  const min = (ms) => Math.max(1, Math.round(ms / 60000));
  return `plan of ${r.tasks} task${r.tasks === 1 ? '' : 's'} in ${r.waves} wave${r.waves === 1 ? '' : 's'}`
    + ` · ${r.peak} session${r.peak === 1 ? '' : 's'} at a time · ${min(r.wallMs)} min, ${min(r.serialMs)} min serial`;
}

// ---------------------------------------------------------------------------
// The runner

/**
 * `host` provides:
 *   runSession({ task, attempt, resume, fork, prompt }) -> { ok, sessionId, resultText, error }
 *   check(task) -> { ok, output }                  (null check: not called)
 *   fingerprint(task) -> string|null              (optional: the worktree's content
 *                                                   after a failed check; see isUnrecoverable)
 *   filesChanged(task) -> [{ path, added, removed }]
 *   ask(task) -> { action: 'retry'|'skip'|'stop'|'done', hint? } | { action: 'set-check', check }
 *                                                  (retries exhausted or unrecoverable)
 *   repair(task) -> { changed, quota? }            (optional: the task's own session gets one turn
 *                                                   to analyse an unrecoverable failure and, if the
 *                                                   fault is in the plan, propose a change the person
 *                                                   approves; `changed` says it was applied)
 *   onChange(plan)                                  (persist + broadcast)
 *   log(line)
 *   close(plan)                                     (every selected task done)
 *   maxRetries
 *   interrupt(task)                                 (Detener: cut its session)
 */
export async function runPlan(plan, host) {
  if (plan.status === 'running') return plan;
  plan.status = 'running';
  plan.startedAt = plan.startedAt ?? new Date().toISOString();
  plan.endedAt = null;
  host.onChange(plan);

  const inflight = new Map();
  while (plan.status === 'running') {
    for (const t of readyTasks(plan)) {
      if (inflight.has(t.id)) continue;
      inflight.set(t.id, runTask(plan, t, host).catch((e) => host.log(`⚠️ ${t.id}: ${e.message}`)).finally(() => inflight.delete(t.id)));
    }
    if (!inflight.size) break;
    await Promise.race(inflight.values());
  }
  // Whatever was still going when Detener came — let it settle.
  await Promise.allSettled([...inflight.values()]);

  if (plan.status === 'running') {
    const allDone = plan.tasks.every((t) => ['done', 'skipped'].includes(t.status));
    plan.status = allDone ? 'done' : 'failed';
    plan.endedAt = new Date().toISOString();
    host.log(parallelismReportLine(plan));
    host.onChange(plan);
    if (allDone) await host.close(plan);
  } else {
    host.onChange(plan);
  }
  return plan;
}

/** Runs the task's check; null when it passes (or there is none), else the failure record. */
async function recheck(plan, task, host) {
  if (!task.check) return null;
  task.status = 'checking';
  host.onChange(plan);
  const check = await host.check(task);
  if (check.ok) return null;
  const output = check.output ?? '';
  const fingerprint = host.fingerprint ? await host.fingerprint(task).catch(() => null) : null;
  return { kind: 'check', output, signature: failureSignature(output), fingerprint: fingerprint ?? null };
}

async function markDone(plan, task, host, summary, line) {
  task.status = 'done';
  task.summary = summary;
  task.filesChanged = await host.filesChanged(task).catch(() => []);
  task.endedAt = new Date().toISOString();
  task.lastFailure = null;
  task.repairing = false;
  host.onChange(plan);
  host.log(line);
}

const doneLine = (task) => `${task.id}: done${task.attempts > 1 ? ` on attempt ${task.attempts}` : ''}${task.check ? ' · check ✓' : ''}`;

/**
 * The repair turn: the task's own session looks at an unrecoverable failure and
 * may propose a plan change (the host asks the person; nothing changes without
 * a yes). Whatever it did — it may also have fixed code — the check runs again
 * right away, with no new session and no new attempt. Returns 'return' when the
 * task is over for this run (stopped, quota, done), or `{ failure }`: the failure
 * to carry on with (null = no re-check happened, keep the current one).
 */
async function repairTurn(plan, task, host, failure, lastResultText) {
  failure.repairTried = true;
  task.status = 'running';
  task.repairing = true;
  host.log(`${task.id}: unrecoverable failure — the session analyzes whether the failure is in the plan`);
  host.onChange(plan);
  let r;
  try {
    r = (await host.repair(task)) ?? { changed: false };
  } catch (e) {
    host.log(`${task.id}: repair failed (${e.message}); asking the person`);
    r = { changed: false, threw: true };
  }
  task.repairing = false;

  if (r.quota) {
    task.status = 'stopped';
    plan.quotaStopped = true;
    host.log(`${task.id}: quota exhausted; the plan stops without spending an attempt and continues when the quota is back`);
    stopPlan(plan, host);
    return 'return';
  }
  if (plan.status !== 'running') { task.status = 'stopped'; host.onChange(plan); return 'return'; }
  if (r.threw) return { failure: null };

  const label = r.changed ? 'check after the plan change' : 'check after the repair';
  const again = await recheck(plan, task, host);
  if (plan.status !== 'running') { task.status = 'stopped'; host.onChange(plan); return 'return'; }
  if (!again) {
    host.log(`${task.id}: ${label} ✓`);
    await markDone(plan, task, host, lastResultText, doneLine(task));
    return 'return';
  }
  host.log(`${task.id}: ${label} ✗`);
  if (again.fingerprint && again.fingerprint === failure.fingerprint && again.signature === failure.signature) {
    again.unrecoverable = true;
    again.repairTried = true;
  }
  return { failure: again };
}

async function runTask(plan, task, host) {
  const maxRetries = host.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastResultText = '';
  for (;;) {
    if (plan.status !== 'running') { if (task.status === 'running') task.status = 'stopped'; host.onChange(plan); return; }

    task.attempts += 1;
    task.status = 'running';
    task.startedAt = task.startedAt ?? new Date().toISOString();
    host.onChange(plan);
    host.log(`${task.id}: ${attemptLabel(task, maxRetries)} — ${task.what}`);

    const result = await host.runSession({
      task,
      attempt: task.attempts,
      resume: task.sessionId ?? host.forkFrom ?? null,
      fork: !task.sessionId && Boolean(host.forkFrom),
    });
    if (result?.sessionId) task.sessionId = result.sessionId;
    // What the session answered, not the CLI's acknowledgement turn that may have
    // replaced it: this text becomes `task.summary`, pasted into dependent prompts.
    const answer = result
      ? substantialAnswerOf(result, () => host.log(`${task.id}: the adopted answer looked like an acknowledgement; using the sealed text (CLI reaction turn)`))
      : '';
    lastResultText = result?.resultText != null ? answer : lastResultText;

    // The account ran out of usage. This is not an attempt: it says nothing
    // about the task, and counting it would spend the retries — and then the
    // question nobody could answer — on a wall every sibling is about to hit
    // too. So the attempt is given back, the plan stops (which interrupts the
    // siblings), and `continuePlan` picks it up when the window reopens.
    if (result?.quota) {
      task.attempts -= 1;
      task.status = 'stopped';
      plan.quotaStopped = true;
      host.log(`${task.id}: quota exhausted; the plan stops without spending an attempt and continues when the quota is back`);
      stopPlan(plan, host);
      return;
    }

    if (plan.status !== 'running') { task.status = 'stopped'; host.onChange(plan); return; }

    let failure = null;
    if (!result?.ok) {
      failure = { kind: 'session', output: result?.error ?? 'the session ended with an error' };
    } else {
      failure = await recheck(plan, task, host);
    }

    if (!failure) {
      await markDone(plan, task, host, answer, doneLine(task));
      return;
    }

    // Read the previous failure before this one replaces it: the comparison is
    // always against the attempt right before, also after an extra round.
    const prev = task.lastFailure;
    if (isUnrecoverable(task, prev, failure)) {
      failure.unrecoverable = true;
      // Each «Reintentar» that fails the very same way must not buy another repair session.
      if (prev?.repairTried) failure.repairTried = true;
    }
    task.lastFailure = failure;
    task.status = 'failed';
    host.onChange(plan);
    host.log(`${task.id}: ${failure.kind === 'check' ? 'the check' : 'the session'} failed (attempt ${task.attempts})`);

    if (failure.unrecoverable) {
      const repairs = Boolean(host.repair) && !failure.repairTried;
      // With a repair turn the task may still retry (if its re-check fails
      // differently); the repair's own log line says what happens next.
      if (!repairs) host.log(`${task.id}: unrecoverable failure — the check failed the same way and the worktree did not change; not retrying`);
      if (repairs) {
        const out = await repairTurn(plan, task, host, failure, lastResultText);
        if (out === 'return') return;
        if (out.failure) {
          failure = out.failure;
          task.lastFailure = failure;
          task.status = 'failed';
          host.onChange(plan);
          if (!failure.unrecoverable && !exhausted(task, maxRetries)) continue;
        }
      }
    } else if (!exhausted(task, maxRetries)) {
      continue;   // the retry prompt carries the failure
    }

    // Out of retries, or retrying cannot help: somebody decides. Meanwhile the
    // siblings keep running.
    task.status = 'asking';
    host.onChange(plan);
    let decision = await host.ask(task);
    for (;;) {
      if (plan.status !== 'running') { task.status = 'stopped'; host.onChange(plan); return; }
      if (decision.action === 'done') {
        // The person verified it themselves: the check is not run.
        await markDone(plan, task, host, lastResultText, `${task.id}: marked done by the person (check not run)`);
        return;
      }
      if (decision.action !== 'set-check') break;

      // The person rewrote the check line. Only the check runs again — the code
      // is what it is — and if it still fails they are asked again at once: they
      // are there and have just chosen the line, so no session retries are spent.
      const before = task.check;
      host.log(`${task.id}: check changed by the person: \`${before ?? ''}\` → \`${decision.check}\``);
      task.check = decision.check;
      plan.changes = plan.changes ?? [];
      plan.changes.push({
        at: new Date().toISOString(), taskId: task.id, reason: 'changed by the person',
        before: { check: before ?? null }, after: { check: decision.check }, added: [],
      });
      const again = await recheck(plan, task, host);
      if (plan.status !== 'running') { task.status = 'stopped'; host.onChange(plan); return; }
      if (!again) {
        host.log(`${task.id}: check after the person's change ✓`);
        await markDone(plan, task, host, lastResultText, doneLine(task));
        return;
      }
      host.log(`${task.id}: check after the person's change ✗`);
      again.repairTried = true;
      task.lastFailure = again;
      task.status = 'asking';
      host.onChange(plan);
      decision = await host.ask(task);
    }
    if (decision.action === 'skip') {
      task.status = 'skipped';
      task.endedAt = new Date().toISOString();
      for (const dep of dependentsOf(plan, task.id)) {
        const d = byId(plan, dep);
        if (d.status === 'pending') d.status = 'skipped';
      }
      host.onChange(plan);
      host.log(`${task.id}: skipped by the user's decision`);
      return;
    }
    if (decision.action === 'stop') {
      task.status = 'failed';
      stopPlan(plan, host);
      return;
    }
    task.hint = decision.hint ?? null;
    // One more round, then ask again. After an unrecoverable ask this also
    // resumes whatever normal budget was left unspent — on purpose: if the
    // next round fails the same way over the same files it is unrecoverable
    // again at once, so the extra budget never becomes a silent loop.
    task.extraRetries = (task.extraRetries ?? 0) + 1;
  }
}

/** Detener: nothing new starts, what runs is cut, and the record says so. */
export function stopPlan(plan, host) {
  if (!['running', 'asking'].includes(plan.status)) return plan;
  plan.status = 'stopped';
  for (const t of plan.tasks) {
    if (['running', 'checking'].includes(t.status)) {
      host.interrupt?.(t);
      t.status = 'stopped';
      t.repairing = false;
    }
    if (t.status === 'asking') t.status = 'failed';
  }
  host.onChange(plan);
  host.log('plan stopped');
  return plan;
}

/** Continuar: what was cut or never started goes again; what is done stays done. */
export async function continuePlan(plan, host) {
  if (plan.status === 'running') return plan;
  // Whatever stopped it last time, this is a fresh run of it.
  plan.quotaStopped = false;
  for (const t of plan.tasks) {
    const wasStopped = t.status === 'stopped';
    const wasFailed = t.status === 'failed' && plan.selected.includes(t.id);
    if (t.repairing) t.repairing = false;
    if (wasStopped) t.status = 'pending';
    if (wasFailed) { t.status = 'pending'; t.attempts = 0; t.extraRetries = 0; }
    // A failure from the previous run is no basis for «unrecoverable» in this
    // one (see isUnrecoverable); the rest of it stays, the UI shows it.
    if ((wasStopped || wasFailed) && t.lastFailure) t.lastFailure.fingerprint = null;
  }
  plan.status = 'approved';
  host.log('plan resumed');
  return runPlan(plan, host);
}
