import React, { Fragment } from 'react';
import Icon from './Icon.jsx';
import { requestLoginRenew } from '../loginChip.js';
import { useStrings } from '../i18n/useStrings.js';
import { splitAround } from '../i18n/index.js';

/**
 * «Renovar login» card for a chat or a failed task whose session died with the
 * authentication error. It carries only the machine name; the button opens the
 * renew dialog (mounted by LoginChips) for that machine.
 */
export default function LoginCard({ machine, onRenew = null }) {
  const t = useStrings();
  const name = machine ?? 'local';
  return (
    <div className="login-card">
      <span className="login-card-text">
        <Icon name="key"/> {splitAround(t.topbar.login.cardText, { name }).map((p) => (
          p.hole ? <strong key={p.key}>{p.text}</strong> : <Fragment key={p.key}>{p.text}</Fragment>
        ))}
      </span>
      <button className="btn btn-warn btn-md" onClick={() => (onRenew ?? requestLoginRenew)(name)}>{t.topbar.login.renew}</button>
    </div>
  );
}
