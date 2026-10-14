import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import SegmentedControl from './ui/SegmentedControl.jsx';
import { createPortal } from 'react-dom';
import { read, write } from '../storage.js';
import { place, PREVIEW_ID } from './useHoverPreview.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

/**
 * The evidence, big: the screenshot at a width you can read, scrolling inside
 * itself, or the video with its own controls and its speed.
 *
 * Rendered at `<body>`, never where it is declared. `.side` is
 * `position: fixed; z-index: 10` (`styles.css`), which makes it a stacking
 * context: a `z-index: 30` declared inside the panel would be capped at 10 and
 * the board's layer ladder (rail 30 · dialogs 40 · viewer 45) would be a lie.
 * The portal is what keeps the number honest — a different reason from the one
 * in `Dialog.jsx` and `FileViewer.jsx`, where it is a `container-type`
 * ancestor trapping a fixed backdrop.
 */

/** The video speeds, and the one a condensed QA video needs to be watchable. */
export const SPEEDS = [0.25, 0.5, 1, 2];
export const DEFAULT_SPEED = 0.25;
const SPEED_KEY = 'hfsmon-qa-speed';
// «0,25×» or «0.25×» as the language writes it.
const speedLabel = (value) => `${formatNumber(value)}×`;

/**
 * The chosen speed, for the whole board: it is furniture, like the panel's
 * width. Validated against the list on the way in — a corrupt or negative
 * value makes `playbackRate` throw, and that would blank the panel.
 */
export function useQaSpeed() {
  const [rate, setRate] = useState(() => {
    const saved = read(SPEED_KEY, DEFAULT_SPEED);
    return SPEEDS.includes(saved) ? saved : DEFAULT_SPEED;
  });
  const choose = useCallback((value) => {
    if (!SPEEDS.includes(value)) return;
    setRate(value);
    write(SPEED_KEY, value);
  }, []);
  return [rate, choose];
}

/**
 * Both properties, always. The media load algorithm resets `playbackRate` from
 * `defaultPlaybackRate`, so setting only the first is lost on any reload of
 * the element — the video would silently go back to 1×.
 */
export function applyRate(el, rate) {
  if (!el) return;
  try {
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  } catch { /* a rate outside what this browser plays */ }
}

/** The segmented speed switch (the shared primitive, so it reads like the card's). */
export function SpeedBar({ rate, onRate, className = '' }) {
  const t = useStrings();
  return (
    <SegmentedControl
      label={t.card.speed.label}
      value={rate}
      onChange={onRate}
      options={SPEEDS.map((value) => ({ value, label: speedLabel(value), title: fill(t.card.speed.play, { speed: speedLabel(value) }) }))}
      context="menu"
      className={`sp-speed ${className}`.trim()}
    />
  );
}

/**
 * A `<video>` that always plays at the chosen speed: on the callback ref (so a
 * reload already starts slow, before anything is clicked), on every change of
 * speed or source, and again once the browser has the metadata.
 *
 * Never `load()`: that resets the position to zero, and the panel re-renders
 * every four seconds with what the poll brings. Setting the two rate
 * properties is all this does to the element.
 */
export function QaVideo({ src, rate, onEl = null, onLoadedMetadata = null, onEnded = null, ...rest }) {
  const el = useRef(null);
  // The mirror the callback ref and the handlers read. Written in the effect,
  // never during the render, which StrictMode runs twice.
  const rateRef = useRef(rate);

  const setEl = useCallback((node) => {
    el.current = node;
    applyRate(node, rateRef.current);
    onEl?.(node);
  }, [onEl]);

  useEffect(() => {
    rateRef.current = rate;
    applyRate(el.current, rate);
  }, [rate, src]);

  return (
    <video
      ref={setEl}
      src={src}
      onLoadedMetadata={(e) => { applyRate(e.currentTarget, rateRef.current); onLoadedMetadata?.(e); }}
      onEnded={(e) => {
        // It stays on the last frame instead of snapping back to the start:
        // what you were looking at when the run finished is usually the whole
        // point. No `loop`; pressing play again starting from the top is the
        // browser's own behaviour and stays that way.
        const node = e.currentTarget;
        if (Number.isFinite(node.duration) && node.duration > 0) {
          node.currentTime = Math.max(0, node.duration - 0.05);
        }
        onEnded?.(e);
      }}
      {...rest}
    />
  );
}

export default function EvidencePreview({
  item, anchor, src, rate, onRate, onClose, onEnter, onLeave, handover = null,
}) {
  const t = useStrings();
  const box = useRef(null);
  const video = useRef(null);
  const at = useRef(0);        // where the small player was, and where this one is
  const [pos, setPos] = useState(null);
  const keepVideo = useCallback((node) => { video.current = node; }, []);

  const measure = useCallback(() => {
    const node = box.current;
    if (!node || !anchor) return;
    const r = node.getBoundingClientRect();
    setPos(place(anchor, { width: r.width, height: r.height }));
  }, [anchor]);

  // Measured after the first paint, which happens off-screen: no flicker, and
  // an image only knows its size once it has loaded, hence `remeasure`.
  useLayoutEffect(() => { setPos(null); measure(); }, [measure, item.path]);

  // The big player is a new element, not the small one moved: what that would
  // buy — the playing position — costs two lines. The small one pauses and
  // hands its position over; on closing it gets the new one back.
  useEffect(() => {
    if (item.kind !== 'video') return undefined;
    at.current = handover?.take(item.path) ?? 0;
    // On unmount React may have detached the ref already, hence the fallback
    // to the last position the element reported.
    return () => handover?.give(item.path, video.current?.currentTime ?? at.current);
  }, [item.path, item.kind, handover]);

  const isVideo = item.kind === 'video';
  const style = pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '-9999px', top: '0px' };

  return createPortal((
    <div
      id={PREVIEW_ID}
      className={`qa-preview ${isVideo ? 'is-video' : 'is-image'}`}
      role="tooltip"
      ref={box}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className={`qa-preview-body ${isVideo ? 'is-video' : 'is-image'}`}>
        {isVideo ? (
          <QaVideo
            src={src}
            rate={rate}
            controls
            playsInline
            preload="metadata"
            onEl={keepVideo}
            onLoadedMetadata={(e) => {
              if (at.current > 0) e.currentTarget.currentTime = at.current;
              measure();
            }}
            onTimeUpdate={(e) => { at.current = e.currentTarget.currentTime; }}
            onSeeked={(e) => { at.current = e.currentTarget.currentTime; }}
            onEnded={(e) => { at.current = e.currentTarget.currentTime; }}
          />
        ) : (
          // No `object-fit: contain`: a 1280×6000 capture would come out the
          // size of a stamp. It keeps its width and scrolls inside.
          <img src={src} alt={item.name} onLoad={measure} />
        )}
      </div>
      <footer className="qa-preview-foot">
        <span className="qa-preview-name" title={item.name}>{item.name}</span>
        {isVideo && <SpeedBar rate={rate} onRate={onRate} />}
        <button type="button" className="btn btn-close" onClick={onClose} title={t.card.speed.closeTitle} aria-label={t.card.speed.closeAria}><Icon name="x"/></button>
      </footer>
    </div>
  ), document.body);
}
