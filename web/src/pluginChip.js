// Pure helpers for the «required plugins» chips. No React, no JSX.
import { fill, strings } from './i18n/index.js';

const ACTIVE_JOB = ['installing', 'enabling', 'verifying'];

/** An install job in a state that will still change. */
export const pluginJobActive = (job) => ACTIVE_JOB.includes(job?.state);

/**
 * The `{ required, machines }` state out of whatever carries it: the bare body of
 * `GET /api/plugins` or the broadcast `{ type: 'plugins', plugins }`.
 */
export function readPlugins(body) {
  const inner = body?.plugins && typeof body.plugins === 'object' && !Array.isArray(body.plugins) ? body.plugins : body;
  const required = Array.isArray(inner?.required) ? inner.required : [];
  const machines = inner?.machines && typeof inner.machines === 'object' ? inner.machines : {};
  return { required, machines };
}

/** The part of a plugin id before the `@`: what a person reads. */
export const pluginName = (id) => String(id).split('@')[0];

/**
 * One chip per machine that lacks something: `{ machine, items, job }` with
 * `items = [{ id, reason }]`, `reason` being `missing` or `disabled`. A machine we
 * could not read (`online: false`) shows nothing: not knowing is not missing.
 */
export function pluginChips(state) {
  const { machines } = readPlugins(state);
  return Object.entries(machines)
    .map(([machine, view]) => {
      if (!view || view.online === false) return null;
      const items = [
        ...(view.missing ?? []).map((id) => ({ id, reason: 'missing' })),
        ...(view.disabled ?? []).map((id) => ({ id, reason: 'disabled' })),
      ];
      const failed = view.job?.state === 'failed';
      return items.length || failed || pluginJobActive(view.job) ? { machine, items, job: view.job ?? null } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

/** The label of one item: «falta frontend-design» or «frontend-design desactivado». */
export const itemLabel = ({ id, reason }) => fill(
  reason === 'disabled' ? strings().shared.plugin.disabled : strings().shared.plugin.missing,
  { name: pluginName(id) },
);

/** The label of the install button for one item. */
export const installLabel = ({ reason }) => (reason === 'disabled' ? strings().shared.plugin.enable : strings().shared.plugin.install);

/** A plugin id as the server accepts it: `name@marketplace`. */
export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
