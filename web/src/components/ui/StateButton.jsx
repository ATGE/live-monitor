import React from 'react';
import { useStrings } from '../../i18n/useStrings.js';

/**
 * The control of a two-valued setting (Manual, Lienzos de diseño, Skills de UX):
 * only the action button. The state itself is painted by `SettingRow`, so the
 * button always says what a click will do, never what is true now.
 */
export default function StateButton({ on, name, onToggle, disabled = false, title, size = 'sm' }) {
  const t = useStrings();
  const label = on ? t.topbar.ui.deactivate : t.topbar.ui.activate;
  return (
    <button type="button" className={`btn btn-sm ui-state-btn${size === 'touch' ? ' ui-state-btn-touch' : ''}`}
      aria-label={name ? `${label} ${name}` : label} title={title} disabled={disabled} onClick={onToggle}>
      {label}
    </button>
  );
}
