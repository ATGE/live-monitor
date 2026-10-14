// Pure rules the «Modelos» panel and the chat share. No React here, so the
// node tests can import it. The server owns the truth (`GET /api/tuning`);
// this only mirrors what the interface needs before it sends.
import { strings } from './i18n/index.js';

/** Reasoning budget the CLI accepts for `enabled` (Haiku). Mirrors `THINKING_BUDGET` in effort.js. */
export const THINKING_BUDGET = { min: 1024, max: 32000 };

/** A chat's prompt cache counts as warm while it works or answered less than this ago. */
export const CACHE_WARM_MS = 5 * 60 * 1000;

/** The reasoning modes a model accepts, from the snapshot; none known means none offered. */
export const thinkingModesOfModel = (snap, modelId) =>
  (snap?.models ?? []).find((m) => m.id === modelId)?.thinking ?? [];

/** The mode word of a stored thinking: `'auto'` when there is no override (or `'auto'` itself). */
export const thinkingModeOf = (thinking) =>
  thinking && typeof thinking === 'object' ? thinking.type ?? 'auto' : 'auto';

/** Whether a stored thinking still works on a model that accepts `modes`. */
export const thinkingFits = (thinking, modes) => {
  const mode = thinkingModeOf(thinking);
  return mode === 'auto' || modes.includes(mode);
};

/** The select options for a model's modes: [value, label], «auto» first. */
export const thinkingOptions = (modes) => [
  ['auto', 'auto'],
  ...modes.filter((m) => Object.hasOwn(strings().shared.model.thinking, m)).map((m) => [m, strings().shared.model.thinking[m]]),
];

/** A budget typed by hand, kept inside what the CLI accepts. */
export const clampBudget = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return THINKING_BUDGET.min;
  return Math.min(THINKING_BUDGET.max, Math.max(THINKING_BUDGET.min, v));
};

/** The thinking object to send for a picked mode; `null` clears the override. */
export const thinkingForMode = (mode, budget) => {
  if (mode === 'auto') return null;
  if (mode === 'enabled') return { type: 'enabled', budgetTokens: clampBudget(budget ?? THINKING_BUDGET.min) };
  return { type: mode };
};

/** Why the fast mode cannot be switched on, or `null` when it can. */
export function fastModeNote(status) {
  const w = strings().shared.model;
  if (!status || status.available == null) return w.fastUnknown;
  if (status.available === true && status.reason === 'cooldown') return w.fastCooldown;
  if (status.available) return null;
  if (status.reason === 'extra_usage_disabled') return w.fastNoExtraUsage;
  return status.reason ?? w.fastUnavailable;
}

/** True while changing the model would throw away a warm cache. */
export function cacheIsWarm(chat, now = Date.now()) {
  if (!chat) return false;
  if (chat.busy) return true;
  const at = chat.lastTurnAt ? new Date(chat.lastTurnAt).getTime() : NaN;
  return Number.isFinite(at) && now - at < CACHE_WARM_MS;
}

/**
 * The same name matching the server's `/model` command uses (models.js
 * `resolveModel`): exact id or label, then first word, then partial.
 * Returns `{ match }`, `{ ambiguous }` or `{}`.
 */
export function resolveModelName(available, argument) {
  const wanted = String(argument ?? '').trim().toLowerCase();
  if (!wanted) return {};
  const lower = (s) => String(s ?? '').toLowerCase();
  const words = (id) => lower(id).split(/[-_\s.]+/);
  const rounds = [
    (m) => lower(m.id) === wanted || lower(m.label) === wanted,
    (m) => words(m.label)[0] === wanted || words(m.id).includes(wanted),
    (m) => lower(m.id).includes(wanted) || lower(m.label).includes(wanted),
    (m) => words(wanted).includes(lower(m.id)),
  ];
  for (const round of rounds) {
    const hits = available.filter(round);
    if (hits.length === 1) return { match: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return {};
}

/** The typed `/model <name>` command's argument, or `null` when the text is not one (or has no argument). */
export function modelCommandArgument(text) {
  const m = /^\/model\b\s*(.*)$/i.exec(String(text ?? '').trim());
  return m && m[1].trim() ? m[1].trim() : null;
}
