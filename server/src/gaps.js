/**
 * "Cerrar huecos": the round that runs after the fix and before the PR.
 *
 * The fix session is resumed and asked two things — is there evidence that the
 * change does what the issue wanted, and did it leave gaps — and answers with
 * one `GAPS_VERDICT:` line. Everything here is pure: reading that line, turning
 * the resolvable gaps into the next fix's brief, the markdown for the task chat
 * and the decision to go another round. The pipeline wiring lives elsewhere.
 */

import { parseTaggedJson } from './tagged.js';

export const GAPS_TAG = 'GAPS_VERDICT';

const EVIDENCE = ['yes', 'no', 'partial'];

/** The output contract, substituted into `fix-gaps.md` as `{{gapsContract}}`. */
export function gapsContract() {
  return [
    `Termina tu respuesta con UNA sola línea, la última, que empiece exactamente por \`${GAPS_TAG}:\` seguido de un objeto JSON **en una sola línea** (sin saltos de línea dentro del JSON):`,
    '',
    `${GAPS_TAG}: {"evidence":"yes|no|partial","evidenceNotes":"...","gaps":[{"id":"g1","summary":"...","needsHuman":false,"fix":"..."}]}`,
    '',
    '- `evidence`: `yes` si hay pruebas de que el cambio resuelve el problema (tests, comandos ejecutados, su salida); `partial` si solo una parte está probada; `no` si no hay ninguna.',
    '- `evidenceNotes`: qué pruebas hay y, si faltan, cuáles faltan y cómo conseguirlas.',
    '- `gaps`: lista de huecos que dejó el cambio; vacía (`[]`) si no hay ninguno. Cada hueco lleva `id` único y no vacío, `summary`, `needsHuman` (booleano: `true` solo si una persona debe decidir o aportar algo que tú no puedes) y, si lo sabes, `fix` (qué hacer para cerrarlo).',
    '- No inventes huecos para parecer minucioso: si no hay, `gaps` va vacío.',
  ].join('\n');
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Reads the verdict from a transcript and validates it strictly.
 * @returns {{ok: true, verdict: object} | {ok: false, problem: string}}
 */
export function readGaps(text) {
  const raw = parseTaggedJson(text, GAPS_TAG);
  if (raw === null) return { ok: false, problem: `no hay una línea ${GAPS_TAG}: {...} válida` };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'el veredicto no es un objeto' };
  if (!EVIDENCE.includes(raw.evidence)) {
    return { ok: false, problem: `evidence debe ser ${EVIDENCE.join(', ')}` };
  }
  if (typeof raw.evidenceNotes !== 'string') return { ok: false, problem: 'evidenceNotes debe ser texto' };
  if (!Array.isArray(raw.gaps)) return { ok: false, problem: 'gaps debe ser una lista' };
  const seen = new Set();
  const gaps = [];
  for (const [i, g] of raw.gaps.entries()) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, problem: `gaps[${i}] no es un objeto` };
    if (!isNonEmptyString(g.id)) return { ok: false, problem: `gaps[${i}].id debe ser un texto no vacío` };
    if (seen.has(g.id)) return { ok: false, problem: `gaps[${i}].id repetido: ${g.id}` };
    seen.add(g.id);
    if (!isNonEmptyString(g.summary)) return { ok: false, problem: `gaps[${i}].summary debe ser un texto no vacío` };
    if (typeof g.needsHuman !== 'boolean') return { ok: false, problem: `gaps[${i}].needsHuman debe ser booleano` };
    if (g.fix !== undefined && typeof g.fix !== 'string') return { ok: false, problem: `gaps[${i}].fix debe ser texto` };
    const gap = { id: g.id, summary: g.summary, needsHuman: g.needsHuman };
    if (g.fix !== undefined) gap.fix = g.fix;
    gaps.push(gap);
  }
  return { ok: true, verdict: { evidence: raw.evidence, evidenceNotes: raw.evidenceNotes, gaps } };
}

/** The gaps the session can close by itself. */
export const resolvableGaps = (verdict) => (verdict?.gaps ?? []).filter((g) => !g.needsHuman);

/** Extra context for `fixPhase`: only the gaps that do NOT need a person. */
export function gapsToFixBrief(verdict, round) {
  const todo = resolvableGaps(verdict);
  if (todo.length === 0) return '';
  const lines = [`Ronda ${round} de cierre de huecos. Cierra estos huecos que dejó el cambio anterior:`, ''];
  for (const g of todo) {
    lines.push(`- (${g.id}) ${g.summary}${g.fix ? ` — Cómo: ${g.fix}` : ''}`);
  }
  if (verdict.evidence !== 'yes' && verdict.evidenceNotes) {
    lines.push('', `Evidencia pendiente: ${verdict.evidenceNotes}`);
  }
  return lines.join('\n');
}

const EVIDENCE_LABEL = { yes: 'sí hay evidencia', partial: 'evidencia parcial', no: 'sin evidencia' };

/**
 * The markdown the task chat shows for one round.
 * `fixed` and `pending` are gap ids (or gaps): what the round closed, and what
 * is left for a person.
 */
export function chatSummary({ round, verdict, fixed = [], pending = [] }) {
  const idOf = (x) => (typeof x === 'string' ? x : x?.id);
  const byId = new Map((verdict?.gaps ?? []).map((g) => [g.id, g]));
  const describe = (x) => {
    const g = byId.get(idOf(x)) ?? (typeof x === 'object' ? x : null);
    return g ? `- (${g.id}) ${g.summary}` : `- ${idOf(x)}`;
  };
  const gaps = verdict?.gaps ?? [];
  const out = [`**Cerrar huecos, ronda ${round}**`, ''];
  out.push(`Evidencia: ${EVIDENCE_LABEL[verdict?.evidence] ?? 'desconocida'}.${verdict?.evidenceNotes ? ` ${verdict.evidenceNotes}` : ''}`, '');
  out.push(`Huecos encontrados: ${gaps.length}.`);
  for (const g of gaps) out.push(`- (${g.id}) ${g.summary}${g.needsHuman ? ' — necesita a una persona' : ''}`);
  out.push('');
  if (fixed.length) {
    out.push('Lo que se arregló:', ...fixed.map(describe), '');
  } else {
    out.push('No se arregló nada en esta ronda.', '');
  }
  if (pending.length) {
    out.push('Lo que necesita a una persona:', ...pending.map(describe));
  } else {
    out.push('Nada pendiente para una persona.');
  }
  return out.join('\n').trimEnd();
}

/**
 * Whether to run another round. False when there is nothing the session can
 * close, the rounds are spent, or the same gaps came back two rounds running
 * (the loop guard: a fix that does not move the ids is not going to).
 *
 * @param {object} verdict this round's verdict.
 * @param {number} round the round that just ran, 1-based.
 * @param {number} maxRounds
 * @param {object} [previous] the previous round's verdict, for the loop guard.
 */
export function shouldIterate(verdict, round, maxRounds, previous = null) {
  const todo = resolvableGaps(verdict);
  if (todo.length === 0) return false;
  if (!Number.isInteger(round) || !Number.isInteger(maxRounds) || round >= maxRounds) return false;
  if (previous) {
    const before = resolvableGaps(previous).map((g) => g.id).sort().join('\0');
    const now = todo.map((g) => g.id).sort().join('\0');
    if (before === now) return false;
  }
  return true;
}
