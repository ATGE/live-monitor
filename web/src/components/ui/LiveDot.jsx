import React from 'react';

/** The cyan dot of "running now". With a `label` it is announced; without, it is decoration. */
export default function LiveDot({ label, size = 7 }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return <span className="ui-live-dot" style={{ width: size, height: size }} {...a11y} />;
}
