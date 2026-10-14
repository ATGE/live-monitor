import { useCallback, useEffect, useRef, useState } from 'react';
import { read, write } from './storage.js';

const WIDTH_KEY = 'hfsmon-side-width';
const COLLAPSED_KEY = 'hfsmon-side-collapsed';
export const RAIL = 34;          // width left behind when collapsed
const MIN = 320;
/** The same width the stylesheet calls a phone (`@media` in styles.css). */
export const PHONE = '(max-width: 780px)';

const phoneQuery = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(PHONE)
  : null);

/**
 * Width and collapsed state of the right-hand panel, remembered per browser.
 * The width is clamped against the current window on every read, so a width
 * saved on a wide monitor cannot leave the board invisible on a laptop.
 *
 * The rail only exists on a desktop. On a phone `.side { width: 100% }` wins
 * over `--side-width`, so a collapse there left no 34px rail at all: just an
 * opaque, fixed, full-screen slab with its contents hidden, over a board that
 * was working perfectly well underneath. The preference is still remembered —
 * it is the same browser profile, and the desktop wants it back — it is
 * simply not applied while the window is phone-sized.
 */
export function useSidePanel() {
  const maxWidth = () => Math.max(MIN, window.innerWidth - 260);
  const clamp = (w) => Math.min(Math.max(w, MIN), maxWidth());

  const [width, setWidth] = useState(() => clamp(read(WIDTH_KEY, 620)));
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY, false));
  const [phone, setPhone] = useState(() => phoneQuery()?.matches ?? false);
  const dragging = useRef(false);

  // Live, not read once: rotating a phone, or dragging a window across the
  // 780px line, has to reach the panel — that is exactly the moment a
  // collapsed desktop turns into a slab.
  useEffect(() => {
    const mq = phoneQuery();
    if (!mq) return undefined;
    const onChange = (e) => setPhone(e.matches);
    setPhone(mq.matches);          // in case it changed before this ran
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { write(WIDTH_KEY, width); }, [width]);
  useEffect(() => { write(COLLAPSED_KEY, collapsed); }, [collapsed]);

  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startResize = useCallback((event) => {
    event.preventDefault();
    dragging.current = true;
    const move = (e) => {
      if (!dragging.current) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      setWidth(clamp(window.innerWidth - x));
    };
    const stop = () => {
      dragging.current = false;
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    document.body.classList.add('resizing');   // stops text selection mid-drag
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }, []);

  // What the board paints, as opposed to what the browser remembers: an
  // inherited `collapsed: true` must never rail a phone.
  const railed = collapsed && !phone;

  return {
    width: railed ? RAIL : width,
    collapsed: railed,
    phone,
    toggle: () => setCollapsed((c) => !c),
    // Opening something in the panel while it is a rail must show it — but
    // there is nothing to expand on a phone, where `railed` is already false,
    // and writing `false` there would spend the desktop's rail from a screen
    // that never had one.
    expand: () => { if (!phone) setCollapsed(false); },
    startResize,
  };
}
