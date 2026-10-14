import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { validateWorkPlan } from './workplan.js';
import { newTaskRecord } from './planexec.js';
import { bareLabel } from './questions.js';
import { MCP_GRACE_MS } from './opencode.js';

/**
 * Repairing a plan that is wrong, not the code it describes.
 *
 * Why this exists: a plan task's `check` line was wrong (app-b #5, `t6`).
 * The session saw it and the person had no button, so the session ended up
 * writing a prompt for another session to hand-edit the store. Here the session
 * proposes the change through a tool, the person says yes in the task's window,
 * and only then does the board touch the plan.
 *
 * The scope is deliberately narrow so a proposal can be checked mechanically:
 * the `check` of ONE not-finished task, plus up to MAX_NEW_TASKS new tasks that
 * hang from it. No removing tasks, no editing others, nothing already done.
 * The whole candidate plan goes back through `validateWorkPlan`, so the
 * file-clash guarantee holds for the new tasks too.
 *
 * Pure functions over plain objects, apart from the SDK layer at the bottom.
 */

export const MAX_NEW_TASKS = 5;

const bad = (problem) => ({ ok: false, problem });
const q = (s) => `\`${s}\``;

const isList = (v) => Array.isArray(v);

/** Checks a proposal against the plan. `{ ok, change }` or `{ ok: false, problem }`. */
export function validatePlanChange(plan, taskId, proposal) {
  const task = plan?.tasks?.find((t) => t.id === taskId);
  if (!task) return bad(`la tarea ${q(taskId)} no existe en el plan`);
  if (task.status === 'done' || task.status === 'skipped') {
    return bad(`la tarea ${q(taskId)} ya está ${task.status === 'done' ? 'hecha' : 'saltada'}: no se puede cambiar`);
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return bad('la propuesta no es un objeto');

  const reason = typeof proposal.reason === 'string' ? proposal.reason.trim() : '';
  if (!reason) return bad('falta `reason`: la persona lee tu motivo para decidir');

  // undefined = leave the check alone; null = remove it; a string = replace it.
  let check;
  if (proposal.check !== undefined) {
    if (proposal.check === null) check = null;
    else if (typeof proposal.check !== 'string' || !proposal.check.trim()) {
      return bad('`check` debe ser un comando no vacío, o `null` para quitar la comprobación');
    } else check = proposal.check.trim();
  }
  if (check !== undefined && check === (task.check ?? null)) check = undefined; // not a change

  const rawNew = proposal.newTasks ?? [];
  if (!isList(rawNew)) return bad('`newTasks` debe ser una lista');
  if (rawNew.length > MAX_NEW_TASKS) {
    return bad(`hasta ${MAX_NEW_TASKS} tareas nuevas por cambio, llegaron ${rawNew.length}`);
  }

  const existing = new Set(plan.tasks.map((t) => t.id));
  const selected = new Set(plan.selected ?? plan.tasks.map((t) => t.id));
  const newTasks = [];
  const newIds = new Set();
  for (const [i, entry] of rawNew.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad(`la tarea nueva nº${i + 1} no es un objeto`);
    const id = String(entry.id ?? '').trim();
    if (!id) return bad(`la tarea nueva nº${i + 1} no tiene \`id\``);
    if (existing.has(id) || newIds.has(id)) return bad(`el id ${q(id)} ya existe en el plan; elige otro`);
    newIds.add(id);
    const what = String(entry.what ?? '').trim();
    if (!what) return bad(`la tarea nueva ${q(id)} no dice en \`what\` qué hace`);
    if (!isList(entry.files) || entry.files.some((f) => typeof f !== 'string')) {
      return bad(`\`files\` de ${q(id)} debe ser una lista de rutas`);
    }
    if (!isList(entry.dependsOn) || entry.dependsOn.some((d) => typeof d !== 'string')) {
      return bad(`\`dependsOn\` de ${q(id)} debe ser una lista de ids`);
    }
    if (entry.check !== undefined && entry.check !== null && typeof entry.check !== 'string') {
      return bad(`\`check\` de ${q(id)} debe ser un comando (texto)`);
    }
    newTasks.push({
      id,
      what,
      files: entry.files.map((f) => f.trim()).filter(Boolean),
      dependsOn: [...new Set(entry.dependsOn.map((d) => d.trim()).filter(Boolean))],
      check: String(entry.check ?? '').trim() || null,
    });
  }

  if (check === undefined && !newTasks.length) {
    return bad('la propuesta no cambia nada: da un `check` distinto del actual o `newTasks`');
  }

  // Every new task must hang from the failing one, directly or through other new tasks.
  const byNew = new Map(newTasks.map((t) => [t.id, t]));
  const hangs = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (byNew.get(id)?.dependsOn ?? []).some((d) => d === taskId || (byNew.has(d) && hangs(d, seen)));
  };
  for (const t of newTasks) {
    if (!hangs(t.id)) return bad(`${q(t.id)} tiene que depender de ${q(taskId)} (directa o indirectamente): las tareas nuevas cuelgan de la que falló`);
    for (const d of t.dependsOn) {
      if (byNew.has(d) || d === taskId) continue; // the failing task is the one being repaired
      const dep = plan.tasks.find((x) => x.id === d);
      if (dep && (!selected.has(d) || dep.status === 'skipped' || dep.status === 'failed')) {
        return bad(`${q(t.id)} depende de ${q(d)}, que no se va a ejecutar`);
      }
    }
  }

  // Tasks that never run again cannot clash, so their files do not count.
  const candidate = [
    ...plan.tasks.map((t) => ({
      id: t.id,
      what: t.what,
      files: t.status === 'done' || t.status === 'skipped' ? [] : [...t.files],
      dependsOn: [...t.dependsOn],
      check: t.id === taskId && check !== undefined ? check : (t.check ?? null),
    })),
    ...newTasks,
  ];
  const v = validateWorkPlan({ tasks: candidate });
  if (!v.ok) return bad(v.problem);

  return { ok: true, change: { taskId, reason, check, newTasks } };
}

const codeOrNone = (c) => (c ? q(c) : '«no check»');

/** Mutates the plan record; returns the one line the task log gets. */
export function applyPlanChange(plan, change) {
  const task = plan.tasks.find((t) => t.id === change.taskId);
  const before = task.check ?? null;
  if (change.check !== undefined) task.check = change.check;
  const added = [];
  for (const t of change.newTasks ?? []) {
    plan.tasks.push(newTaskRecord(t));
    plan.selected = [...(plan.selected ?? []), t.id];
    added.push(t.id);
  }

  // Waves come from the same validation the proposal passed, over the plan as
  // it now stands (finished tasks contribute no files: they cannot race).
  const v = validateWorkPlan({
    tasks: plan.tasks.map((t) => ({
      id: t.id, what: t.what, dependsOn: t.dependsOn, check: t.check,
      files: t.status === 'done' || t.status === 'skipped' ? [] : t.files,
    })),
  });
  if (v.ok) plan.waves = v.plan.waves;

  if (!Array.isArray(plan.changes)) plan.changes = [];
  plan.changes.push({
    at: new Date().toISOString(),
    taskId: change.taskId,
    reason: change.reason,
    before: { check: before },
    after: { check: task.check ?? null },
    added,
  });

  const parts = [];
  if (change.check !== undefined) parts.push(`check ${codeOrNone(before)} → ${codeOrNone(task.check ?? null)}`);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  return `${change.taskId}: plan changed — ${parts.join('; ')}`;
}

/** Markdown for the question's preview: the reason, then before and after. */
export function describePlanChange(plan, change) {
  const task = plan.tasks.find((t) => t.id === change.taskId);
  const lines = [`**Reason:** ${change.reason}`, ''];
  if (change.check !== undefined) {
    lines.push(`**Check of ${change.taskId}**`, '',
      `- Before: ${codeOrNone(task?.check ?? null)}`,
      `- After: ${codeOrNone(change.check)}`, '');
  }
  for (const t of change.newTasks ?? []) {
    lines.push(`**New task ${t.id}:** ${t.what}`, '',
      `- Files: ${t.files.length ? t.files.map(q).join(', ') : '(none)'}`,
      `- Depends on: ${t.dependsOn.length ? t.dependsOn.map(q).join(', ') : '(nothing)'}`,
      `- Check: ${codeOrNone(t.check)}`, '');
  }
  return lines.join('\n').trim();
}

/** The approval question, in the same shape as `boardQuestion`. No option is recommended: Edson decides. */
export function planChangeQuestion(plan, change) {
  return {
    questions: [{
      question: `The session of ${change.taskId} proposes changing the plan. Shall I apply it?`,
      header: 'Plan change',
      multiSelect: false,
      options: [
        { label: 'Apply the change', description: 'The board applies it and runs the check again when the turn of the session ends.' },
        { label: 'Do not apply', description: 'Nothing changes; write why in «Other», and the session reads it.' },
      ],
      preview: describePlanChange(plan, change),
    }],
  };
}

/** Exact labels only: «aplicar pero sin t7» is free text, and free text never approves. */
export function readPlanChangeDecision(answer) {
  const raw = String(Array.isArray(answer) ? answer[0] : answer ?? '').trim();
  const label = bareLabel(raw).toLowerCase();
  if (label === 'apply the change' || label === 'aplicar el cambio') return { approve: true, note: null };
  if (label === 'do not apply' || label === 'no aplicar') return { approve: false, note: null };
  return { approve: false, note: raw || null };
}

const PROPOSE_SCHEMA = {
  reason: z.string().min(1),
  check: z.string().nullable().optional(),
  newTasks: z.array(z.object({
    id: z.string(),
    what: z.string(),
    files: z.array(z.string()),
    dependsOn: z.array(z.string()),
    check: z.string().optional(),
  })).max(5).optional(),
};

const PROPOSE_DESCRIPTION = 'Propón un cambio al PLAN de trabajo: la línea `check` de la tarea que falló, o tareas '
  + 'nuevas que dependan de ella. Úsalo solo cuando el fallo está en el plan (la comprobación mal escrita, una '
  + 'tarea que falta), no en el código. El tablero enseña la propuesta a la persona y nada cambia sin su sí; '
  + 'recibes de vuelta si se aplicó y, si no, por qué.';

/** The tool as the session sees it: `mcp__plan__propose_change`. */
export function planChangeTool({ onPropose }) {
  return tool(
    'propose_change',
    PROPOSE_DESCRIPTION,
    PROPOSE_SCHEMA,
    async (args) => {
      try {
        const r = await onPropose(args);
        return { content: [{ type: 'text', text: String(r?.text ?? '') }], ...(r?.ok ? {} : { isError: true }) };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `no se pudo tramitar la propuesta: ${e?.message ?? e}` }] };
      }
    },
    { alwaysLoad: true },
  );
}

/** The shape a session's `mcpServers` takes. The handler waits for a person, hence the long timeout. */
export function planChangeMcpServers({ onPropose, timeoutMs } = {}) {
  return {
    plan: createSdkMcpServer({
      name: 'plan',
      version: '1.0.0',
      alwaysLoad: true,
      timeout: (timeoutMs ?? 30 * 60_000) + MCP_GRACE_MS,
      tools: [planChangeTool({ onPropose })],
    }),
  };
}
