import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { loginChips, readLogin, LOGIN_RENEW_EVENT } from '../loginChip.js';
import LoginDialog from './LoginDialog.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/**
 * One chip per machine whose Claude login expires in 5 days or less (or already
 * has), the laptop included, each with its «Renovar login» button; plus the
 * renew dialog those buttons, the chat cards and the task cards open.
 *
 * Self-contained like RestartControl: it reads the state on mount and on every
 * reconnect, follows the `board-login` window event (the WebSocket `login`
 * broadcast, forwarded by App) and opens the dialog on `login-renew`.
 */
export default function LoginChips() {
  const t = useStrings();
  const [state, setState] = useState({});
  const [now, setNow] = useState(Date.now());
  // The machine whose dialog is open, or null.
  const [renewing, setRenewing] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.loginState().then((r) => { if (alive) setState(readLogin(r)); }).catch(() => {});
    load();
    const onState = (ev) => setState(readLogin(ev.detail));
    const onRenew = (ev) => {
      const name = typeof ev.detail === 'string' ? ev.detail : ev.detail?.machine;
      if (name) setRenewing(name);
    };
    window.addEventListener('board-connected', load);
    window.addEventListener('board-login', onState);
    window.addEventListener(LOGIN_RENEW_EVENT, onRenew);
    // A limit crossed while the page stays open still shows its chip.
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      alive = false;
      window.removeEventListener('board-connected', load);
      window.removeEventListener('board-login', onState);
      window.removeEventListener(LOGIN_RENEW_EVENT, onRenew);
      clearInterval(clock);
    };
  }, []);

  const chips = loginChips(state, now);
  return (
    <>
      {chips.length > 0 && (
        <span className="tb-logins">
          {chips.map((c) => (
            <span key={c.machine} className={`tb-chip tb-login tb-login-${c.tone}`} title={fill(t.topbar.login.chipTitle, { label: c.label, machine: c.machine })}>
              <Icon name={c.tone === 'expired' ? 'alert-triangle' : 'key'}/>
              <span className="tb-chip-text">{c.machine}: {c.label}</span>
              <button type="button" className="btn btn-warn btn-xs tb-chip-action" onClick={() => setRenewing(c.machine)}>{t.topbar.login.renew}</button>
            </span>
          ))}
        </span>
      )}
      {renewing && (
        <LoginDialog
          machine={renewing}
          onClose={() => setRenewing(null)}
          onFinished={() => api.loginState().then((r) => setState(readLogin(r))).catch(() => {})}
        />
      )}
    </>
  );
}
