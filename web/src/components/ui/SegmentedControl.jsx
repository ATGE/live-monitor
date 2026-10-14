import React from 'react';
import Icon from '../Icon.jsx';

/**
 * A group of toggle buttons for a choice that is written to the server on click.
 * Not radios: nothing is "selected and then confirmed", each click is the action,
 * so the semantics are a group of buttons with `aria-pressed`. The active one
 * carries a check as well as its fill, so the state is never colour alone.
 *
 * `context="menu"` swaps the active fill (the menu surface is already --surface-4).
 */
export default function SegmentedControl({
  label, value, onChange, options, disabled = false, size = 'sm', context = 'card', className = '',
}) {
  const cls = ['ui-seg', `ui-seg-${size}`, `ui-seg-${context}`, disabled ? 'is-disabled' : '', className]
    .filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label={label}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" className={`ui-seg-btn${active ? ' is-active' : ''}`}
            aria-pressed={active} disabled={disabled || o.disabled} title={o.title}
            // Clicking the active option does nothing: it would only rewrite the same value.
            onClick={() => { if (!active) onChange?.(o.value); }}>
            {active && <Icon name="check" />}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
