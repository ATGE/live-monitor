import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Dialog from './components/Dialog.jsx';
import Icon from './components/Icon.jsx';
import Kbd from './components/ui/Kbd.jsx';
import { useStrings } from './i18n/useStrings.js';

/**
 * `confirm()` and `alert()` as the board's own window: options with a
 * description each, the recommended one first and highlighted, Esc to
 * cancel. `ask` resolves with the chosen option's `value` (or `null` on
 * cancel); `notice` resolves when acknowledged.
 *
 *   const { ask, notice } = useDialog();
 *   const go = await ask({ title: '¿Eliminar el worktree?', text: '…',
 *     options: [{ value: true, label: 'Eliminar', description: '…', tone: 'danger' }], cancel: 'Dejarlo' });
 *
 * One dialog at a time: opening another replaces the one on screen, and the
 * replaced one resolves as if dismissed (`null` for `ask`, `true` for
 * `notice`), so no caller is left awaiting a dialog nobody can see.
 * `icon` (dialog and options) is an Icon.jsx name or a literal emoji; `cancel`
 * and `notice`'s `ok` may be a string or `{ icon, label }`.
 * `focus: 'cancel'` starts `ask` on the cancel button instead of the first
 * option, for confirmations a stray Enter must not accept.
 */
const DialogContext = createContext(null);

export function DialogProvider({ children }) {
  const t = useStrings();
  const [current, setCurrent] = useState(null);   // { kind, props, resolve }
  // The dialog on screen, read synchronously: two opens in one tick must still
  // resolve the first, which a state read would not see yet.
  const cur = useRef(null);

  const open = useCallback((next) => {
    const prev = cur.current;
    cur.current = next;
    prev?.resolve(prev.kind === 'ask' ? null : true);
    setCurrent(next);
  }, []);
  const ask = useCallback((props) => new Promise((resolve) => open({ kind: 'ask', props, resolve })), [open]);
  const notice = useCallback((props) => new Promise((resolve) => open({ kind: 'notice', props: typeof props === 'string' ? { text: props } : props, resolve })), [open]);
  const settle = (value) => {
    const c = cur.current;
    cur.current = null;
    c?.resolve(value);
    setCurrent(null);
  };

  const value = useMemo(() => ({ ask, notice }), [ask, notice]);
  return (
    <DialogContext.Provider value={value}>
      {children}
      {current?.kind === 'ask' && <AskDialog {...current.props} onPick={(v) => settle(v)} onCancel={() => settle(null)} />}
      {current?.kind === 'notice' && (
        <Dialog title={current.props.title ?? t.app.dialog.notice} icon={current.props.icon ?? 'info'} onDismiss={() => settle(true)}
          hint={<><Kbd>Esc</Kbd> {t.app.dialog.escCloses}{/* i18n-ok: the key's name */}</>}
          footer={<button type="button" className="btn btn-primary btn-md" autoFocus onClick={() => settle(true)}>{okLabel(current.props.ok, t.app.dialog.understood)}</button>}>
          <p className="modal-text">{current.props.text}</p>
        </Dialog>
      )}
    </DialogContext.Provider>
  );
}

// A notice's button is a string or `{ icon, label }`.
function okLabel(ok, fallback) {
  const { icon, label } = typeof ok === 'object' && ok ? ok : { label: ok };
  return <>{icon && <><Icon name={icon} />{' '}</>}{label ?? fallback}</>;
}

function AskDialog({ title, icon = 'help-circle', text = null, options = [], cancel: cancelOpt = null, focus = 'option', onPick, onCancel }) {
  const t = useStrings();
  const cancel = cancelOpt ?? t.common.cancel;
  const cancelIcon = typeof cancel === 'object' && cancel ? cancel.icon : null;
  const cancelLabel = typeof cancel === 'object' && cancel ? cancel.label : cancel;
  const danger = options.some((o) => o.tone === 'danger');
  return (
    <Dialog title={title} icon={icon} onDismiss={onCancel} tone={danger ? 'danger' : 'default'}
      hint={<><Kbd>Esc</Kbd> {t.app.dialog.escCancels}{/* i18n-ok: the key's name */}</>}
      footer={(
        <>
          <button type="button" className="btn btn-md" autoFocus={focus === 'cancel'} onClick={onCancel}>{cancelIcon && <><Icon name={cancelIcon} />{' '}</>}{cancelLabel}</button>
          <span className="modal-spacer" />
          {options.map((o, i) => (
            <button type="button" key={o.label} className={`btn btn-${o.tone === 'danger' ? 'danger-solid' : o.tone === 'warn' ? 'warn' : 'primary'} btn-md`}
              autoFocus={focus !== 'cancel' && i === 0} onClick={() => onPick(o.value ?? o.label)}>
              {o.icon && <><Icon name={o.icon} />{' '}</>}{o.label}
            </button>
          ))}
        </>
      )}>
      {text && <p className="modal-text">{text}</p>}
      {options.some((o) => o.description) && (
        <ul className="modal-options">
          {options.map((o) => (
            <li key={o.label}><b>{o.icon && <><Icon name={o.icon} />{' '}</>}{o.label}</b>{o.description ? <span> — {o.description}</span> : null}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog needs a DialogProvider above it'); // i18n-ok: a developer error
  return ctx;
}
