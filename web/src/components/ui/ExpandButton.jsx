import React from 'react';
import Icon from '../Icon.jsx';
import { useStrings } from '../../i18n/useStrings.js';

/** The card's lengthen/shorten button: a visible control, never a hidden gesture. */
export default function ExpandButton({ expanded, onToggle, controls, size = 'md' }) {
  const t = useStrings();
  const label = expanded ? t.topbar.ui.shrinkCard : t.topbar.ui.expandCard;
  return (
    <button type="button" className={`btn btn-icon ui-expand${size === 'touch' ? ' ui-expand-touch' : ''}${expanded ? ' is-expanded' : ''}`}
      aria-expanded={Boolean(expanded)} aria-controls={controls} aria-label={label}
      title={expanded ? label : t.topbar.ui.expandCardTitle} onClick={onToggle}>
      <Icon name={expanded ? 'minimize' : 'maximize'} />
    </button>
  );
}
