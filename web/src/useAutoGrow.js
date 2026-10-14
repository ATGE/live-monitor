import { useLayoutEffect, useRef } from 'react';

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
// What a text box inside a dialog may take of its body before it scrolls
// instead of growing: about fourteen lines on a laptop.
const SHARE = 0.4;

/**
 * A text box inside a dialog that follows its own text up to a share of the
 * dialog's body, and then scrolls inside itself.
 *
 * A deliberate cousin of `useComposerHeight`, not a reuse of it: out of that
 * hook's 193 lines a dialog needs about twenty — the floor, the
 * `scrollHeight + border` measure, keeping the scroll position when the caret
 * is not at the end, and the layout effect keyed on the value. It needs
 * nothing of the pin, the grip, localStorage or the ResizeObserver, and above
 * all the cap cannot be computed the same way. The composer trades pixels
 * with the thread above it, so its cap has to come from the pair's sum or it
 * would feed itself; `.modal-body` instead is `flex: 1; overflow-y: auto`
 * inside a `max-height`ed `.modal`, so once the dialog is at its full height
 * the body does not move when the box grows, and reading the cap off it is
 * safe. Parameterising one hook for both would leave six flags and one user
 * each; three duplicated lines of measurement are cheaper.
 */
export function useAutoGrow({ value, share = SHARE }) {
  const ref = useRef(null);

  // Keyed on the value, not on input events: dictation writes through the
  // same `setState` a paste does, and both have to count.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    // The floor comes from the `rows` already in the JSX (3 in the plan, 2 in
    // the questions), and the insets are measured rather than assumed: they
    // differ — `.plan-feedback` pads 8px and `.option-input` inherits
    // 6px 12px — so a shared number would open one of the two at the wrong
    // height and make it jump on the first keystroke.
    const lines = ta.rows || 2;
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const insets = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
    const min = Math.ceil(lines * lineHeight + insets);
    const body = ta.closest('.modal-body');
    const max = body ? Math.max(min, Math.round(body.clientHeight * share)) : Infinity;

    // An empty box is the floor and nothing else: measuring it would measure
    // the placeholder, which Chrome lays out inside the box and wraps.
    if (!ta.value) { ta.style.height = `${min}px`; return; }
    // The caret at the end means the reader follows what is being written or
    // dictated; anywhere else the view must stay where it was.
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    const was = ta.scrollTop;
    ta.style.height = '0px';
    // `scrollHeight` leaves the border out and the box is `border-box`
    // (styles.css:17): without those 2px the last line is clipped and the
    // internal scrollbar shows up a line too early.
    const wanted = ta.scrollHeight + border;
    ta.style.height = `${clamp(wanted, min, max)}px`;
    ta.scrollTop = atEnd ? ta.scrollHeight : was;
  }, [value, share]);

  return ref;
}
