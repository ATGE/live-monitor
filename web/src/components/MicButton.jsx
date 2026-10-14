import React from 'react';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';

/**
 * The microphone, wherever it is dictated into: the composer and the two
 * dialogs. It has five faces — no support, at rest, listening, disabled by
 * its host, and the tooltip explaining whichever of those it is — and the
 * markup around it is not the same in the three places, so what travels is
 * the button, not a wrapper.
 *
 * `support` comes in whole (`{ok, reason}`) so the tooltip and the disabled
 * state cannot disagree; `stopPropagation` is for the mic that lives inside
 * something clickable, like the «Otro» card, which would otherwise select or
 * deselect itself on every click.
 *
 * Listening is told by the glyph (a stop square instead of the microphone) and
 * by `aria-pressed`, besides the red and the pulse of `chat.css`.
 */
export default function MicButton({
  listening, support, disabled = false, onToggle, stopPropagation = false, className = '',
}) {
  const t = useStrings();
  const label = listening ? t.app.mic.stop : t.app.mic.start;
  return (
    <button
      type="button"
      className={`btn btn-icon btn-sm mic ${listening ? 'listening' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
      disabled={disabled || !support.ok}
      aria-pressed={listening}
      aria-label={label}
      title={support.ok ? label : support.reason}
      onClick={(e) => { if (stopPropagation) e.stopPropagation(); onToggle(); }}
    ><Icon name={listening ? 'stop' : 'mic'} /></button>
  );
}
