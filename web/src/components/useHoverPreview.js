import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The lens over the Browser QA evidence: which thumbnail is open, where its
 * big view goes, and every way of closing it.
 *
 * One open item for the whole panel, so two thumbnails in a row sort
 * themselves out — the second one replaces the first instead of stacking.
 * The timings are the ones the completed rail already uses
 * (`CompletedRail.jsx`): a dwell before opening, so crossing a row does not
 * flash, and a grace on leaving, so the pointer can reach the box.
 */
export const DWELL = 150;   // hovering for less than this asks for nothing
export const GRACE = 120;   // time to travel from the thumbnail into the view
export const PRESS = 400;   // a long press on a touch screen
export const WARM = 300;    // just closed one: the next opens with no wait
// A phone fires mouse events after a tap. Without this, a plain tap would also
// schedule the hover open and the tap would both follow the link and enlarge.
const TOUCH_ECHO = 700;

export const PREVIEW_ID = 'qa-preview';

const EDGE = 8;             // breathing room against the window
const GAP = 12;             // between the thumbnail and its big view

/**
 * Where the big view goes: beside the thumbnail, on its right; flipped to its
 * left only when it does not fit there whole; and then clamped inside the
 * window. Pure on purpose — the panel-less checks drive it directly.
 */
export function place(anchor, size, view = { width: window.innerWidth, height: window.innerHeight }) {
  const right = anchor.right + GAP;
  const left = anchor.left - GAP - size.width;
  let x;
  if (right + size.width <= view.width - EDGE) x = right;
  else if (left >= EDGE) x = left;
  // Neither side holds it: the roomier one, and the clamp below does the rest.
  else x = anchor.left > view.width - anchor.right ? left : right;
  const clamp = (v, max) => Math.min(Math.max(v, EDGE), Math.max(EDGE, max));
  return {
    left: Math.round(clamp(x, view.width - size.width - EDGE)),
    // Level with the thumbnail, then pulled inside top and bottom.
    top: Math.round(clamp(anchor.top, view.height - size.height - EDGE)),
  };
}

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
};

const element = (node) => (node && node.nodeType === 1 ? node : null);
const insidePreview = (node) => Boolean(element(node)?.closest(`#${PREVIEW_ID}`));

/**
 * @param items the live evidence list — the panel refreshes it every 4 s, so
 *   the open item is re-derived from it by `path` on every render and a re-run
 *   that replaces the files makes the view disappear instead of showing a
 *   dead one.
 * @param resetKey anything whose change must close the view (the task).
 */
export function useHoverPreview(items, resetKey) {
  const [state, setState] = useState(null);       // { path, anchor }
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const pressTimer = useRef(null);
  const pressed = useRef(false);                  // a long press already showed it
  const closedAt = useRef(0);
  const lastTouch = useRef(0);
  const isOpen = useRef(false);
  const anchorEl = useRef(null);                  // what opened it, to give the focus back
  const hadFocus = useRef(false);                 // the focus went into the view

  const stopOpening = () => { clearTimeout(openTimer.current); openTimer.current = null; };

  const close = useCallback(() => {
    stopOpening();
    clearTimeout(closeTimer.current);
    clearTimeout(pressTimer.current);
    if (isOpen.current) closedAt.current = Date.now();
    isOpen.current = false;
    // The ✕ and Escape leave the focus on <body> when the view goes: it goes
    // back to the thumbnail it came from. Only then — closing with the mouse
    // must not move anybody's focus.
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (anchorEl.current && (insidePreview(active) || (hadFocus.current && (!active || active === document.body)))) {
      anchorEl.current.focus?.({ preventScroll: true });
    }
    hadFocus.current = false;
    setState(null);
  }, []);

  // `el` gives the rect the view is placed against; `focusEl` is what gets the
  // focus back on close (a visible button may differ from the thing it zooms).
  const show = useCallback((item, el, focusEl = el) => {
    stopOpening();
    clearTimeout(closeTimer.current);
    isOpen.current = true;
    anchorEl.current = focusEl;
    setState({ path: item.path, anchor: rectOf(el) });
  }, []);

  // The pointer left the thumbnail: the view stays alive for a moment so the
  // pointer can get there — it holds itself open with its own `onMouseEnter`.
  const leave = useCallback(() => {
    stopOpening();
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, GRACE);
  }, [close]);
  const keep = useCallback(() => { clearTimeout(closeTimer.current); }, []);

  useEffect(() => () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    clearTimeout(pressTimer.current);
  }, []);

  // Another task in the panel is other evidence: nothing to keep open.
  useEffect(() => { close(); }, [resetKey, close]);

  const open = useMemo(
    () => (state ? items.find((i) => i.path === state.path) ?? null : null),
    [items, state],
  );
  // The file is gone from the list: drop the state too, or a later render with
  // that path back would show it again.
  useEffect(() => { if (state && !open) close(); }, [state, open, close]);

  useEffect(() => {
    if (!open) return undefined;
    // No `stopPropagation`: a dialog or the file viewer above keeps its own Escape.
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onDown = (e) => {
      const node = element(e.target);
      if (insidePreview(node) || node?.closest('[data-qa-anchor]')) return;
      close();
    };
    // Scroll does not bubble, so this has to listen in the capture phase on
    // `window`; a scroll inside the view itself is the tall capture moving.
    const onScroll = (e) => { if (!insidePreview(e.target)) close(); };
    const onResize = () => close();
    // Remembered so the focus only travels back when it had gone in there.
    const onFocusIn = (e) => { if (insidePreview(e.target)) hadFocus.current = true; };
    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  /** The handlers a thumbnail (or a video's hot zone) needs. */
  const bind = useCallback((item) => ({
    'data-qa-anchor': '',
    'aria-describedby': state?.path === item.path ? PREVIEW_ID : undefined,
    onMouseEnter: (e) => {
      if (Date.now() - lastTouch.current < TOUCH_ECHO) return;
      // React recycles the event: the element has to be taken now, not inside
      // the timeout, where `currentTarget` is already null.
      const el = e.currentTarget;
      clearTimeout(closeTimer.current);
      stopOpening();
      if (Date.now() - closedAt.current < WARM) show(item, el);
      else openTimer.current = setTimeout(() => show(item, el), DWELL);
    },
    onMouseLeave: leave,
    // Whoever tabs here has already asked for it: no dwell. Only the keyboard,
    // though — clicking or tapping a link also focuses it, and that must open
    // the file in its tab without leaving a view behind on the way back.
    // `?.` guards a missing method, not the SyntaxError a browser that does not
    // know the pseudo-class throws from the selector itself (Safari < 15.4,
    // Firefox < 85) — which would break every focus, not just this one.
    onFocus: (e) => {
      const el = e.currentTarget;
      try { if (el.matches(':focus-visible')) show(item, el); } catch { /* sin :focus-visible */ }
    },
    onBlur: close,
    onTouchStart: (e) => {
      const el = e.currentTarget;
      lastTouch.current = Date.now();
      pressed.current = false;
      clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => { pressed.current = true; show(item, el); }, PRESS);
    },
    onTouchEnd: () => { lastTouch.current = Date.now(); clearTimeout(pressTimer.current); },
    onTouchMove: () => { clearTimeout(pressTimer.current); pressed.current = false; },
    onTouchCancel: () => { clearTimeout(pressTimer.current); pressed.current = false; },
    onClick: (e) => {
      // A plain click or tap still opens the file — and the view goes, instead
      // of staying open behind the new tab until the pointer happens to move.
      if (!pressed.current) { close(); return; }
      pressed.current = false;
      e.preventDefault();              // the long press enlarged it; no second tab
      e.stopPropagation();
    },
  }), [state, show, leave, close]);

  // Opens the view for `item` anchored at `el`, with no dwell. For a visible
  // button (touch screens, where the hot zone is click-through).
  const openAt = show;

  return { open, anchor: state?.anchor ?? null, bind, openAt, keep, leave, close };
}
