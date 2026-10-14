import React, { useEffect, useRef, useState } from 'react';
import { meta } from '../status.js';
import Icon from './Icon.jsx';
import Pill from './ui/Pill.jsx';
import Chip from './ui/Chip.jsx';
import { cardId, taskKey } from '../taskKey.js';
import { highlightNumberRange } from '../boardFilter.js';
import { Highlighted } from './TaskCard.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

// How a finished task ended, for the tick's colour AND shape (never colour
// alone): merged PR = filled, closed without a PR = hollow, issue closed on
// GitHub = hollow with a half fill. Same precedence as `completedByDay`.
const ENDING_CLASS = { merged: 'cs-tick-merged', noPr: 'cs-tick-nopr', issueClosed: 'cs-tick-closed' };
function endingOf(task) {
  if (task.closedWithoutPr) return 'noPr';
  if ((task.prs ?? []).some((p) => p?.state === 'MERGED')) return 'merged';
  if (task.issueClosed) return 'issueClosed';
  return 'merged';
}
// Pill tone for the task's state tone (status.js uses its own vocabulary).
const PILL_TONE = { busy: 'live', ok: 'ok', warn: 'warn', error: 'danger', done: 'ok', idle: 'idle' };

/**
 * A map of the completed strip: one thin tick per task, in the strip's order.
 *
 * Twenty-odd cards of 260 px scroll off the screen, and finding one meant
 * dragging the strip blind. Here the whole row fits in a few hundred pixels:
 * the tick under the cursor grows (its neighbours a little, like a dock), a
 * popup names the task, and a click scrolls the strip to its card and flashes
 * it. Ticks whose cards are in view are drawn at full strength, so the rail is
 * also the strip's scrollbar. It stays when the strip is collapsed, which is
 * when a map is most useful.
 */
export default function CompletedRail({ tasks, stripRef, onLocate, parsed }) {
  const t = useStrings();
  const [hover, setHover] = useState(null);       // index under the cursor
  const [visible, setVisible] = useState(new Set());
  const [anchor, setAnchor] = useState(null);     // { left, top, right } of the hovered tick
  const railRef = useRef(null);
  const leaveTimer = useRef(null);
  const pressTimer = useRef(null);

  // Which cards are inside the strip's viewport right now.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) { setVisible(new Set()); return undefined; }
    let frame = null;
    const measure = () => {
      frame = null;
      const box = strip.getBoundingClientRect();
      const seen = new Set();
      for (const task of tasks) {
        const el = document.getElementById(cardId(task.project, task.issue));
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.right > box.left + 8 && r.left < box.right - 8) seen.add(taskKey(task));
      }
      setVisible(seen);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    schedule();
    strip.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      strip.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [tasks, stripRef, stripRef.current]);

  const show = (i, el) => {
    clearTimeout(leaveTimer.current);
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left + r.width / 2, top: r.bottom, right: r.right });
    setHover(i);
  };
  // A short grace so the cursor can travel from the tick into the popup.
  const hide = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { setHover(null); setAnchor(null); }, 120);
  };
  const keep = () => clearTimeout(leaveTimer.current);

  const locate = (task) => {
    hide();
    onLocate(taskKey(task));
  };

  if (!tasks.length) return null;
  const hovered = hover === null ? null : tasks[hover];
  const endings = { merged: 0, noPr: 0, issueClosed: 0 };
  for (const task of tasks) endings[endingOf(task)] += 1;
  const mapLabel = fill(t.board.mapLabel, { n: tasks.length, ...endings });

  return (
    <div className="cs-rail-wrap">
      <div className="cs-rail" ref={railRef} role="list" aria-label={mapLabel} onMouseLeave={hide}>
        {tasks.map((task, i) => {
          // Distance to the hovered tick decides the size: 0 is the one under
          // the cursor, 1 and 2 its neighbours, anything else is the base.
          const d = hover === null ? 9 : Math.min(Math.abs(i - hover), 3);
          const ending = endingOf(task);
          return (
            <button
              key={taskKey(task)}
              type="button"
              role="listitem"
              className={`cs-tick cs-rail-tick ${ENDING_CLASS[ending]} d${d} ${visible.has(taskKey(task)) ? 'in-view' : ''}`}
              aria-label={`#${task.issue} ${task.title} (${t.board.ending[ending]})`}
              onMouseEnter={(e) => show(i, e.currentTarget)}
              onFocus={(e) => show(i, e.currentTarget)}
              onBlur={hide}
              onClick={() => locate(task)}
              // No hover on a phone: a tap jumps, a long press opens the popup.
              onTouchStart={(e) => { const el = e.currentTarget; pressTimer.current = setTimeout(() => show(i, el), 400); }}
              onTouchEnd={() => clearTimeout(pressTimer.current)}
              onTouchMove={() => clearTimeout(pressTimer.current)}
            />
          );
        })}
      </div>

      {hovered && anchor && (
        <Popup task={hovered} parsed={parsed} anchor={anchor} onEnter={keep} onLeave={hide} onClick={() => locate(hovered)} />
      )}
    </div>
  );
}

/** The summary under the tick: what the card would say, in three lines. */
function Popup({ task, parsed, anchor, onEnter, onLeave, onClick }) {
  const t = useStrings();
  const ref = useRef(null);
  const [left, setLeft] = useState(anchor.left);
  // Centred on the tick, then pulled inside the viewport at the edges.
  useEffect(() => {
    const w = ref.current?.offsetWidth ?? 280;
    const max = window.innerWidth - w - 8;
    setLeft(Math.max(8, Math.min(anchor.left - w / 2, max)));
  }, [anchor.left]);
  const info = meta(task.state);
  // The newest PR the branch has, not necessarily the cycle's own — a done
  // task's `prNumber` is null by contract, so the popup would otherwise show
  // nothing for the very PR that got it here.
  const prNumber = task.prs?.[0]?.number ?? task.prNumber;
  return (
    <div
      ref={ref}
      className="cs-popup"
      style={{ left, top: anchor.top + 6 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      role="tooltip"
    >
      <div className="cs-popup-title"><span className="cs-popup-issue">{highlightNumberRange(String(task.issue), task, parsed) ? <mark className="hit">#{task.issue}</mark> : `#${task.issue}`}</span> <Highlighted text={task.title} parsed={parsed} /></div>
      {task.branch && <code className="cs-popup-branch">{task.branch}</code>}
      <div className="cs-popup-meta">
        <Pill tone={PILL_TONE[info.tone] ?? 'neutral'} icon={info.icon}>{info.label}</Pill>
        {task.complexity && <Chip tone={task.complexity === 'complex' ? 'warn' : 'neutral'}>{task.complexity === 'complex' ? t.board.popupComplex : t.board.popupSimple}</Chip>}
        {task.machine && task.machine !== 'local' && <Chip icon="map-pin">{task.machine}</Chip>}
        {prNumber && <span className="cs-popup-pr">PR #{prNumber}</span> /* i18n-ok: PR is the same word in every language */}
      </div>
      <div className="cs-popup-hint">{t.board.popupHint}</div>
    </div>
  );
}
