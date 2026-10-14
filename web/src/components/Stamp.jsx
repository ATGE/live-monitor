import React from 'react';
import { hhmm, fullStamp } from '../time.js';

/**
 * The local time of a message, beside its author. Absolute on purpose: an
 * hour never ages, so the thread needs no ticker repainting it — and a
 * six-hundred-message conversation repaints for what happens in it, nothing
 * else.
 *
 * A message with no stamp, or one that is not a time, paints nothing at all:
 * an empty slot beside the author reads as a bug — which is why the space
 * that separates it from the author is the stamp's own, and not a literal one
 * in the line: «Tú » with a trailing space is the same kind of bug.
 */
export default function Stamp({ ts, className = 'stamp' }) {
  const label = hhmm(ts);
  if (!label) return null;
  return (
    <>
      {' '}
      <time className={className} dateTime={typeof ts === 'string' ? ts : undefined} title={fullStamp(ts)}>
        {label}
      </time>
    </>
  );
}
