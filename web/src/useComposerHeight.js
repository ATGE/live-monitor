import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { read, write, clear } from './storage.js';
import { PHONE } from './useSidePanel.js';

const KEY = 'hfsmon-composer-height';
// What the thread keeps for itself when you drag the composer up: below this
// the conversation you are answering stops being readable.
const MESSAGES_FLOOR = 150;
// What grows on its own is more prudent than what you ask for by hand.
const AUTO_SHARE = 0.45;
// A panel collapsed to its 34px rail: measuring there would store a junk height.
const ALIVE_WIDTH = 80;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Height of the chat composer, remembered per browser.
 *
 * Until you drag it, the box follows its own text: it starts at
 * `--composer-lines` lines and grows with what you type, dictate or paste.
 * The moment you drag the grip that number wins — exactly, even if it is
 * shorter than the text, because a box that springs back under the cursor
 * reads as a broken drag — and the text scrolls inside. Double-clicking the
 * grip forgets it and the box grows on its own again.
 *
 * One number for the whole board, like the side panel's width: it is
 * furniture, not something each conversation owns.
 *
 * The height is written straight to the DOM. Only «is it pinned» lives in
 * React state: one `setState` per keystroke would repaint the whole thread.
 */
export function useComposerHeight({ value, messagesRef }) {
  const textareaRef = useRef(null);
  const [pinned, setPinned] = useState(() => {
    const saved = read(KEY, null);
    return typeof saved === 'number' && saved > 0 ? saved : null;
  });
  const pinnedRef = useRef(pinned);
  const dragging = useRef(false);
  const stopRef = useRef(null);
  // A phone's composer is two lines tall, so what it says has to fit in two.
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(PHONE).matches);

  useEffect(() => {
    if (pinned == null) clear(KEY); else write(KEY, pinned);
  }, [pinned]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(PHONE);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);         // a resize between the first render and here
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  /**
   * The caps, measured off the live layout: several subpanels share this
   * column and the panel itself is resizable, so fixed pixels would be wrong
   * on half the screens.
   */
  const metrics = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || ta.clientWidth < ALIVE_WIDTH) return null;
    const messages = messagesRef?.current ?? null;
    const style = getComputedStyle(ta);
    const lines = parseFloat(style.getPropertyValue('--composer-lines')) || 3;
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const insets = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + border;
    // The floor lives with the media query: `--composer-lines` is 3 on a
    // desktop and 2 on a phone.
    const min = Math.ceil(lines * lineHeight + insets);
    // The box and the thread trade the same pixels, so their sum does not
    // move when one of them grows: caps drawn from it cannot feed themselves.
    const shared = ta.offsetHeight + (messages?.offsetHeight ?? 0);
    const panel = (messages ?? ta).closest('.subpanel')?.offsetHeight ?? 0;
    const dragCap = Math.max(min, shared - MESSAGES_FLOOR);
    const autoCap = Math.max(min, Math.min(dragCap, Math.round(panel * AUTO_SHARE)));
    return { min, border, dragCap, autoCap };
  }, [messagesRef]);

  const apply = useCallback(() => {
    const ta = textareaRef.current;
    const m = metrics();
    if (!ta || !m) return;                 // collapsed rail: keep the last good height
    if (pinnedRef.current != null) {
      ta.style.height = `${clamp(pinnedRef.current, m.min, m.dragCap)}px`;
      return;
    }
    // An empty box is the floor and nothing else. Measuring it would be
    // wrong: Chrome lays the placeholder out inside the box, and on a phone
    // «Escribe un prompt… (Ctrl+V pega capturas)» wraps to three lines.
    if (!ta.value) { ta.style.height = `${m.min}px`; return; }
    // The caret at the end means the reader follows what is being written;
    // anywhere else the view must stay where it was, or a long paste jumps to
    // the top.
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    const was = ta.scrollTop;
    ta.style.height = '0px';
    // `scrollHeight` leaves the border out and the box is `border-box`
    // (styles.css:17): without those 2px the last line is clipped and the
    // internal scrollbar shows up a line too early.
    const wanted = ta.scrollHeight + m.border;
    ta.style.height = `${clamp(wanted, m.min, m.autoCap)}px`;
    ta.scrollTop = atEnd ? ta.scrollHeight : was;
  }, [metrics]);

  // Keyed on the value, not on input events: dictation writes through
  // `setText` and a paste lands the same way, and both have to count.
  useLayoutEffect(() => {
    pinnedRef.current = pinned;
    apply();
  }, [value, pinned, apply]);

  // The attachment row appearing, the panel resized, the window resized: all
  // of them reach the caps through the thread's own height.
  useEffect(() => {
    const el = messagesRef?.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!dragging.current) apply(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [apply, messagesRef]);

  const startResize = useCallback((event) => {
    const ta = textareaRef.current;
    if (!ta) return;
    event.preventDefault();
    // The pointer stays with the grip: a finger that wanders off it, or a
    // gesture the browser takes away, still ends up in `stop`.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startY = event.clientY;
    const startHeight = ta.offsetHeight;
    let height = startHeight;
    let moved = false;
    dragging.current = true;
    const move = (e) => {
      if (!dragging.current) return;
      const m = metrics();
      if (!m) return;
      // The grip sits on the top edge: dragging up makes the box taller.
      height = clamp(Math.round(startHeight + (startY - e.clientY)), m.min, m.dragCap);
      moved = true;
      ta.style.height = `${height}px`;
    };
    const stop = () => {
      dragging.current = false;
      stopRef.current = null;
      document.body.classList.remove('resizing-row');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      // A click is not a drag. Pinning on one would kill the autogrow with
      // nothing on screen to say how to get it back.
      if (moved) {
        pinnedRef.current = height;
        setPinned(height);
      }
    };
    stopRef.current = stop;
    document.body.classList.add('resizing-row');   // stops text selection mid-drag
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    // Routine on touch: without it the board keeps a row-resize cursor and no
    // text selection, with the box still following the pointer.
    window.addEventListener('pointercancel', stop);
  }, [metrics]);

  // A drag still in flight when the panel closes must not leave the board
  // dressed for it.
  useEffect(() => () => stopRef.current?.(), []);

  const reset = useCallback(() => {
    pinnedRef.current = null;
    setPinned(null);
  }, []);

  return { textareaRef, pinned: pinned != null, narrow, startResize, reset };
}
