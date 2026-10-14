import React from 'react';
import Icon from './Icon.jsx';
import { itemLabel, installLabel, pluginJobActive } from '../pluginChip.js';
import { usePlugins } from '../usePlugins.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/**
 * One chip per machine that lacks a required user-level plugin, each with an
 * Install (or Activate) button per plugin. It paints nothing while nothing is
 * missing: the editor of the required list is opened from Settings, not from here.
 *
 * Self-contained like LoginChips: it reads the state through `usePlugins`, which
 * follows the reconnects and the `board-plugins` window event. Installing is
 * only ever a click here.
 */
export default function PluginChips() {
  const t = useStrings();
  const { chips, error, install } = usePlugins();
  if (!chips.length && !error) return null;

  return (
    <span className="pl-chips">
      {chips.map((c) => {
        const busy = pluginJobActive(c.job);
        const failed = c.job?.state === 'failed';
        const tone = failed ? 'failed' : busy ? 'busy' : 'missing';
        const text = failed ? t.topbar.plugins.installFailed : busy ? t.topbar.plugins.installing : c.items.map(itemLabel).join(', ');
        // The whole sentence lives in `title` too, because on a phone only the icon and the machine stay visible.
        const title = failed && c.job?.error ? c.job.error : fill(t.topbar.plugins.chipTitle, { machine: c.machine, text });
        return (
          <span key={c.machine} className={`pl-chip pl-chip-${tone}`} role={failed ? 'alert' : 'status'} title={title}>
            <Icon name={failed ? 'x-circle' : busy ? 'loader' : 'puzzle'} className={`pl-chip-icon${busy ? ' pl-spin' : ''}`} />
            <span className="pl-chip-machine">{c.machine}</span>
            <span className="pl-chip-text">{`: ${text}`}</span>
            {!busy && c.items.map((it) => (
              <button key={it.id} type="button" className="pl-chip-btn" onClick={() => install(c.machine, it.id)}
                title={fill(t.topbar.plugins.actionTitle, { action: installLabel(it), id: it.id, machine: c.machine })}
                aria-label={fill(t.topbar.plugins.actionTitle, { action: installLabel(it), id: it.id, machine: c.machine })}>{installLabel(it)}</button>
            ))}
          </span>
        );
      })}
      {error && (
        <span className="pl-chip pl-chip-failed" role="alert" title={error}>
          <Icon name="x-circle" className="pl-chip-icon" />
          <span className="pl-chip-machine">{error}</span>
        </span>
      )}
    </span>
  );
}
