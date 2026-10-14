import React from 'react';
import Icon from '../Icon.jsx';
import { statusText } from '../../settingState.js';

/**
 * One setting line: its name, the effective value with where it comes from, and
 * the control. `detail` goes to the tooltip only: the screen carries the short
 * form. When the project forces the setting (`locked`) the line says so with a
 * lock and, optionally, a button to the place that unlocks it.
 */
export default function SettingRow({
  icon, name, title, effective, source, detail, locked = null, layout = 'stack', children,
}) {
  const tip = [title, detail].filter(Boolean).join(' — ') || undefined;
  return (
    <div className={`ui-setting ui-setting-${layout}${locked ? ' is-locked' : ''}`} title={tip}>
      <div className="ui-setting-head">
        <span className="ui-setting-name">
          {icon && <Icon name={icon} />}
          <span>{name}</span>
        </span>
        {locked ? (
          <span className="ui-setting-status ui-setting-locked">
            <Icon name="lock" />
            <span>{locked.text}</span>
            {locked.action && (
              <button type="button" className="btn btn-xs" onClick={locked.action.onClick}>
                {locked.action.icon && <Icon name={locked.action.icon} />}
                {locked.action.label}
              </button>
            )}
          </span>
        ) : effective === null || effective === undefined ? null : (
          <span className={`ui-setting-status ${effective ? 'is-yes' : 'is-no'}`}>
            <Icon name={effective ? 'check-circle' : 'circle-minus'} />
            <span>{statusText(effective)}{source ? ` · ${source}` : ''}</span>
          </span>
        )}
      </div>
      {children != null && <div className="ui-setting-control">{children}</div>}
    </div>
  );
}
