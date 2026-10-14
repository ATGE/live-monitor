import React from 'react';
import Icon from '../Icon.jsx';

/** Small label of the card's tag row. `mono` is for branches, ids and paths only. */
export default function Chip({ tone = 'neutral', icon, mono = false, title, children }) {
  return (
    <span className={`ui-chip ui-chip-${tone}${mono ? ' ui-chip-mono' : ''}`} title={title}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </span>
  );
}
