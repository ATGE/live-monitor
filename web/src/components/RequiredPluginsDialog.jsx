import React, { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { PLUGIN_ID_RE, readPlugins } from '../pluginChip.js';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import Kbd from './ui/Kbd.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/**
 * The board's list of required USER-level plugins (`name@marketplace`). Each
 * change is saved at once, like ModelsDialog; the server validates the list and
 * answers with the whole settings snapshot. Nothing is installed from here: the
 * chips offer that, per machine, when a person asks.
 */
export default function RequiredPluginsDialog({ onClose }) {
  const t = useStrings();
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState('');
  // `invalid` is a typing mistake, as a code ('format' | 'duplicate'; red field, message under it); `error` is a save or load failure (caption).
  const [invalid, setInvalid] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const uid = useId();
  const inputId = `${uid}-new`;
  const invalidId = `${uid}-invalid`;

  useEffect(() => {
    let alive = true;
    api.pluginsState()
      .then((s) => { if (alive) setList(readPlugins(s).required); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const write = (next) => {
    setSaving(true);
    setError(null);
    api.setRequiredPlugins(next)
      .then((s) => setList(Array.isArray(s?.requiredPlugins) ? s.requiredPlugins : next))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const add = () => {
    const id = draft.trim();
    if (!PLUGIN_ID_RE.test(id)) { setInvalid('format'); return; }
    if (list.includes(id)) { setInvalid('duplicate'); return; }
    setInvalid(null);
    setDraft('');
    write([...list, id]);
  };

  const loading = !list && !error;

  return (
    <Dialog title={t.topbar.settings.pluginsRequired} icon="puzzle" className="plugins-dialog pl-dialog" onDismiss={onClose}
      hint={<><Kbd>Esc</Kbd> {/* i18n-ok: the key name */}{t.topbar.pluginsDialog.escCloses}</>}
      footer={<button type="button" className="btn btn-md" onClick={onClose}>{t.common.close}</button>}>
      {error ? (
        <p className="pl-note pl-note-error" role="alert"><Icon name="x-circle" className="pl-note-icon" /><span>{fill(t.topbar.pluginsDialog.saveFailed, { error })}</span></p>
      ) : saving ? (
        <p className="pl-note" aria-live="polite"><Icon name="loader" className="pl-note-icon pl-spin" /><span>{t.topbar.pluginsDialog.saving}</span></p>
      ) : (
        <p className="pl-caption" aria-live="polite">{t.topbar.pluginsDialog.caption}</p>
      )}
      {loading && (
        <div className="pl-loading" aria-busy="true">
          <p className="pl-note" aria-live="polite"><Icon name="loader" className="pl-note-icon pl-spin" /><span>{t.common.loading}</span></p>
          <span className="pl-skeleton" aria-hidden="true" />
        </div>
      )}
      {list && (
        <div className="pl-body">
          {list.length === 0 && <p className="pl-empty">{t.topbar.pluginsDialog.empty}</p>}
          {list.length > 0 && (
            <ul className="pl-list" aria-label={t.topbar.pluginsDialog.listLabel}>
              {list.map((id) => (
                <li className="pl-row" key={id}>
                  <Icon name="puzzle" className="pl-row-icon" />
                  <code className="pl-row-id">{id}</code>
                  <button type="button" className="btn btn-sm" disabled={saving} onClick={() => write(list.filter((x) => x !== id))}
                    title={t.topbar.pluginsDialog.removeTitle} aria-label={fill(t.topbar.pluginsDialog.removeLabel, { id })}>{t.topbar.pluginsDialog.remove}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="pl-add">
            <label className="pl-sr-only" htmlFor={inputId}>{t.topbar.pluginsDialog.inputLabel}</label>
            <div className="pl-add-row">
              <input id={inputId} type="text" className="pl-input" value={draft} placeholder={t.topbar.pluginsDialog.inputPlaceholder} spellCheck={false} autoComplete="off"
                aria-invalid={invalid ? 'true' : 'false'} aria-describedby={invalid ? invalidId : undefined}
                onChange={(e) => { setDraft(e.target.value); if (invalid) setInvalid(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' /* i18n-ok: a key name */) add(); }} />
              <button type="button" className="btn btn-primary btn-md" disabled={saving || !draft.trim()} onClick={add}>
                <Icon name="plus" />{t.topbar.pluginsDialog.add}
              </button>
            </div>
            {invalid && (
              <p id={invalidId} className="pl-note pl-note-error" role="alert"><Icon name="x-circle" className="pl-note-icon" /><span>{invalid === 'format' ? t.topbar.pluginsDialog.invalidFormat : t.topbar.pluginsDialog.invalidDuplicate}</span></p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
