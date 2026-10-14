import React, { useEffect, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { fill, strings } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import {
  THINKING_BUDGET, clampBudget, fastModeNote, thinkingFits, thinkingForMode, thinkingModeOf,
  thinkingModesOfModel, thinkingOptions,
} from '../modelRules.js';

/**
 * Model, effort and reasoning per role, for the whole board. The server owns the rules:
 * `GET /api/tuning` says which models exist and which efforts each accepts, and
 * `POST /api/tuning` validates what is written. «auto» is the absence of a
 * setting (the CLI chooses), so it clears the override instead of storing a word.
 */
// Where the label is `null` it is a catalog entry under `dialogs.models.roles`;
// the rest are names that read the same in every language. The label is read
// at use time, so a language switch reaches it.
const ROLE_NAMES = [
  ['triage', 'Triage'], // i18n-ok: a phase name, the same in every language
  ['advisor', null],
  ['plan', 'Plan'], // i18n-ok: a phase name, the same in every language
  ['fix', 'Fix'], // i18n-ok: a phase name, the same in every language
  ['pr', 'PR'], // i18n-ok: a phase name, the same in every language
  ['demo', 'Demo'], // i18n-ok: a phase name, the same in every language
  ['reply', null],
  ['chat', 'Chat'], // i18n-ok: a phase name, the same in every language
  ['qa', 'QA'], // i18n-ok: a phase name, the same in every language
  ['qaPlan', null],
];
export const ROLE_LABELS = ROLE_NAMES.map(([role, fixed]) => Object.defineProperty(
  [role, fixed], 1, { enumerable: true, get: () => fixed ?? strings().dialogs.models.roles[role] },
));

/** The efforts a model accepts, from the snapshot; none known means none offered. */
export const effortsOfModel = (snap, modelId) =>
  (snap?.models ?? []).find((m) => m.id === modelId)?.efforts ?? [];

export default function ModelsDialog({ onClose }) {
  const t = useStrings();
  const d = t.dialogs.models;
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.tuning().then((s) => { if (alive) setSnap(s); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const write = (patch) => {
    setSaving(true);
    setError(null);
    api.setTuning(patch)
      .then((s) => setSnap(s))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
  const setRole = (role, fields) => write({ roles: { [role]: fields } });

  const models = snap?.models ?? [];
  const anyFast = models.some((m) => m.fastMode);
  const fastNote = fastModeNote(snap?.fastModeStatus);
  const newModels = snap?.newModels ?? [];

  return (
    <Dialog
      title={d.title} icon="brain" className="models-dialog" onDismiss={onClose}
      footer={<><span className="modal-spacer" /><button type="button" className="btn btn-ghost btn-md" onClick={onClose}>{t.common.close}</button></>}
    >
      <p className="modal-caption" aria-live="polite">
        {error ? fill(d.saveFailed, { error }) : saving ? d.saving : d.caption}
      </p>
      {!snap && !error && <p className="modal-caption">{t.common.loading}</p>}
      {newModels.length > 0 && (
        <div className="modal-caption dlg-c-notice" role="status">
          {newModels.map((m) => {
            return (
              <p key={m.resolvedModel}>
                {fill(d.newModel, { name: m.displayName, id: m.resolvedModel })}{' '}
                <button type="button" className="btn btn-ghost btn-xs" disabled={saving} onClick={() => write({ dismissModel: m.resolvedModel })}>{d.dismiss}</button>
              </p>
            );
          })}
        </div>
      )}
      {snap && (
        <div className="models-grid">
          {ROLE_LABELS.map(([role, label]) => {
            const cur = snap.roles?.[role] ?? {};
            const efforts = effortsOfModel(snap, cur.model);
            const known = models.some((m) => m.id === cur.model);
            // An effort the model does not accept is shown as stored, never as «auto»:
            // the server lowers it, and says to what.
            const effort = cur.effort ?? 'auto';
            const lowered = cur.effort && cur.effectiveEffort && cur.effectiveEffort !== cur.effort ? cur.effectiveEffort : null;
            const modes = thinkingModesOfModel(snap, cur.model);
            const mode = thinkingModeOf(cur.thinking);
            return (
              <React.Fragment key={role}>
                <div className="models-row">
                  <span className="models-role">{label}</span>
                  <select
                    aria-label={fill(d.modelOf, { label })} value={cur.model ?? ''} disabled={saving}
                    onChange={(e) => {
                      const model = e.target.value || null;
                      // A reasoning mode the new model rejects is cleared with the switch;
                      // the effort stays: the server lowers it to what the model accepts.
                      const stale = !thinkingFits(cur.thinking, thinkingModesOfModel(snap, model));
                      setRole(role, stale ? { model, thinking: null } : { model });
                    }}
                  >
                    {!known && <option value={cur.model ?? ''}>{cur.model ?? d.byDefault}</option>}
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
                  </select>
                  {known && efforts.length === 0 ? <span /> : (
                    <select
                      aria-label={fill(d.effortOf, { label })} value={effort} disabled={saving || efforts.length === 0}
                      onChange={(e) => setRole(role, { effort: e.target.value === 'auto' ? null : e.target.value })}
                    >
                      {/* i18n-ok: the CLI word */}<option value="auto">auto</option>
                      {cur.effort && !efforts.includes(cur.effort) && <option value={cur.effort}>{cur.effort}</option>}
                      {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  )}
                  <button
                    type="button" className="btn btn-ghost btn-icon btn-sm models-reset" disabled={saving} title={d.resetTitle}
                    aria-label={fill(d.resetOf, { label })} onClick={() => setRole(role, { model: null, effort: null, thinking: null })}
                  ><Icon name="reset"/></button>
                </div>
                {modes.length > 0 && (
                  <div className="models-row">
                    <span className="models-role">{d.reasoning}</span>
                    <select
                      aria-label={fill(d.reasoningOf, { label })} value={mode} disabled={saving}
                      onChange={(e) => setRole(role, { thinking: thinkingForMode(e.target.value, cur.thinking?.budgetTokens) })}
                    >
                      {thinkingOptions(modes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {mode === 'enabled' ? (
                      <input
                        type="number" inputMode="numeric" min={THINKING_BUDGET.min} max={THINKING_BUDGET.max} step="1"
                        aria-label={fill(d.budgetOf, { label })} title={fill(d.budgetTitle, { min: THINKING_BUDGET.min, max: THINKING_BUDGET.max })}
                        key={cur.thinking?.budgetTokens} defaultValue={cur.thinking?.budgetTokens ?? THINKING_BUDGET.min} disabled={saving}
                        onBlur={(e) => {
                          const budgetTokens = clampBudget(e.target.value);
                          if (budgetTokens !== cur.thinking?.budgetTokens) setRole(role, { thinking: { type: 'enabled', budgetTokens } });
                          else e.target.value = budgetTokens;
                        }}
                      />
                    ) : <span />}
                    <span />
                  </div>
                )}
                {lowered && <p className="modal-caption">{fill(d.lowered, { label, lowered, effort: cur.effort })}</p>}
              </React.Fragment>
            );
          })}
        </div>
      )}
      {snap && anyFast && (
        <label className="dlg-c-check models-extra" title={d.fastTitle}>
          <input type="checkbox" checked={snap.fastMode === true} disabled={saving || (snap.fastMode !== true && snap.fastModeStatus?.available !== true)}
            onChange={(e) => write({ fastMode: e.target.checked })} />
          {fastNote ? fill(d.fastWithNote, { note: fastNote }) : d.fast}
        </label>
      )}
    </Dialog>
  );
}
