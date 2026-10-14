import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 16; // never closer than this to the window's edge
const GAP = 8; // anchor to panel

/**
 * State of one popover: open/closed, the trigger's props, and the timers of the
 * hover mode. Controlled when `open` and `onOpenChange` are given (the app opens
 * the Settings menu from a card); otherwise it keeps its own state.
 *
 * `hover` opens on mouseenter/focus of the anchor and closes `graceMs` after the
 * pointer leaves both anchor and panel. A click or tap only opens it (it never
 * toggles, or the click after the hover would close it at once); it also closes
 * on Esc and on a press outside, which is how a touch screen leaves it.
 */
export function usePopover({ hover = false, open: controlled, onOpenChange, graceMs = 150 } = {}) {
  const [own, setOwn] = useState(false);
  const isControlled = controlled !== undefined;
  const open = isControlled ? Boolean(controlled) : own;
  const id = useId();
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  const timer = useRef(null);

  const setOpen = useCallback((value) => {
    if (!isControlled) setOwn(value);
    onOpenChange?.(value);
  }, [isControlled, onOpenChange]);

  const cancel = useCallback(() => { clearTimeout(timer.current); timer.current = null; }, []);
  const close = useCallback(() => { cancel(); setOpen(false); }, [cancel, setOpen]);
  const toggle = useCallback(() => { cancel(); setOpen(!open); }, [cancel, setOpen, open]);
  const later = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => setOpen(false), graceMs);
  }, [cancel, setOpen, graceMs]);
  const now = useCallback(() => { cancel(); setOpen(true); }, [cancel, setOpen]);

  useEffect(() => cancel, [cancel]);

  const triggerProps = {
    ref: anchorRef,
    'aria-expanded': open,
    'aria-controls': id,
    // In hover mode the pointer or focus already opened it; the click that follows must not close it.
    onClick: hover ? now : toggle,
    ...(hover ? { onMouseEnter: now, onMouseLeave: later, onFocus: now, onBlur: later } : {}),
  };
  const panelHover = hover ? { onMouseEnter: cancel, onMouseLeave: later, onFocus: cancel, onBlur: later } : {};

  return { open, setOpen, toggle, close, id, anchorRef, panelRef, triggerProps, panelHover };
}

/** Where the panel goes: fixed, from the anchor's rect, clipped to the window. */
function place(anchor, panel, placement) {
  const a = anchor.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.scrollHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = placement === 'bottom-start' ? a.left : placement === 'bottom' ? a.left + a.width / 2 - w / 2 : a.right - w;
  left = Math.max(MARGIN, Math.min(left, vw - MARGIN - w));
  const top = a.bottom + GAP;
  const maxHeight = Math.max(0, vh - top - MARGIN);
  const arrowLeft = Math.max(MARGIN, Math.min(a.left + a.width / 2 - left, w - MARGIN));
  return { top, left, maxHeight: h > maxHeight ? maxHeight : undefined, arrowLeft };
}

/**
 * A non-modal panel anchored to a trigger, rendered in a portal on <body> so no
 * card or column can clip it. Esc closes it and gives the focus back to the
 * anchor; a mousedown outside anchor and panel closes it. z-index 35: above the
 * rail's popup (30), below dialogs (40).
 */
export default function Popover({ pop, placement = 'bottom-end', label, arrow = false, className = '', children }) {
  const { open, close, id, anchorRef, panelRef, panelHover } = pop;
  const [pos, setPos] = useState(null);

  const reposition = useCallback((e) => {
    // The capture-phase scroll listener also hears the panel's own scrolling.
    if (e?.target instanceof Node && panelRef.current?.contains(e.target)) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (anchor && panel) setPos(place(anchor, panel, placement));
  }, [anchorRef, panelRef, placement]);

  // Before paint, so the panel never flashes at the wrong place.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      close();
      anchorRef.current?.focus();
    };
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close, anchorRef, panelRef]);

  if (!open || typeof document === 'undefined') return null;
  const style = pos
    ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight, overflowY: pos.maxHeight ? 'auto' : undefined }
    : { top: 0, left: 0, visibility: 'hidden' };
  return createPortal(
    <div ref={panelRef} id={id} role="dialog" aria-label={label} className={`ui-popover ${className}`.trim()}
      style={style} {...panelHover}>
      {arrow && <span className="ui-popover-arrow" style={{ left: pos?.arrowLeft ?? 0 }} aria-hidden="true" />}
      {children}
    </div>,
    document.body,
  );
}
