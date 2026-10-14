import React from 'react';
import Icon from '../Icon.jsx';
import LiveDot from './LiveDot.jsx';

/** Status pill of a task. The icon (and the live dot) carry the state besides the colour. */
export default function Pill({ tone = 'neutral', icon, live = false, title, children }) {
  return (
    <span className={`ui-pill ui-pill-${tone}`} title={title}>
      {live && <LiveDot />}
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </span>
  );
}
