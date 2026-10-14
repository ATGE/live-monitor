import React, { useRef, useState } from 'react';
import TaskCard from './TaskCard.jsx';
import CompletedRail from './CompletedRail.jsx';
import Icon from './Icon.jsx';
import SparkColumns from './charts/SparkColumns.jsx';
import { completedByDay } from '../kpiView.js';
import { taskKey } from '../taskKey.js';
import {
  ALL, DEFAULT_PAGE_SIZE, clampPage, normalizePageSize, pageCount, pageSlice, pageWindow,
  serializePageSize, sortDone,
} from '../donePager.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, splitAround } from '../i18n/index.js';

const DONE_KEY = 'hfsmon-done-collapsed';
const readCollapsed = () => {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; }
};
const SIZE_KEY = 'hfsmon-done-pagesize';
const readPageSize = () => {
  try { return normalizePageSize(localStorage.getItem(SIZE_KEY)); } catch { return DEFAULT_PAGE_SIZE; }
};

// The "Completadas" strip under the columns: collapsible, paginated, with the
// rail map. `done` is the already-placed list of finished tasks; the board owns
// the placement rules, the strip owns everything about showing them.
export default function CompletedStrip({ done, doneTotal, query, parsed, actions }) {
  const t = useStrings();
  // Completed work is reference material, not the day's work: collapsing it
  // gives the columns the height back, and the choice is remembered.
  const [doneCollapsed, setDoneCollapsed] = useState(readCollapsed);
  const toggleDone = () => setDoneCollapsed((c) => {
    try { localStorage.setItem(DONE_KEY, c ? '0' : '1'); } catch { /* private mode */ }
    return !c;
  });
  // While a search is active the strip opens by itself, without touching the
  // remembered choice: clearing the query puts it back as it was.
  const collapsed = doneCollapsed && !parsed;
  const stripRef = useRef(null);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [page, setPage] = useState(1);
  // What the size input shows while it is being typed; null = show pageSize.
  const [sizeDraft, setSizeDraft] = useState(null);
  // Newest first. A search shows every match; otherwise one page of them.
  const doneSorted = sortDone(done);
  const paginated = !parsed && pageSize !== ALL && doneSorted.length > pageSize;
  const pages = parsed ? 1 : pageCount(doneSorted.length, pageSize);
  const cur = clampPage(page, pages);
  const shownDone = parsed ? doneSorted : pageSlice(doneSorted, cur, pageSize);
  const allShown = pageSize === ALL;

  const applySize = (size) => {
    setPageSize(size);
    setPage(1);
    setSizeDraft(null);
    try { localStorage.setItem(SIZE_KEY, serializePageSize(size)); } catch { /* private mode */ }
  };
  const goPage = (n) => {
    setPage(clampPage(n, pages));
    if (stripRef.current) stripRef.current.scrollLeft = 0;
  };
  const commitDraft = () => {
    if (sizeDraft === null || sizeDraft === '') { setSizeDraft(null); return; }
    applySize(normalizePageSize(sizeDraft));
  };
  const pagerButtons = (compact) => (
    <>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={t.board.done.prevPage} disabled={cur <= 1} onClick={() => goPage(cur - 1)}><Icon name="chevron-left"/></button>
      {compact
        ? <span className="cs-pager-text">{cur} / {pages}</span>
        : pageWindow(cur, pages).map((p, i) => (p === '…'
          ? <span className="cs-gap" key={`g${i}`}>…</span>
          : (
            <button type="button" key={p} className={`btn btn-ghost btn-sm cs-pg-num ${p === cur ? 'is-current' : ''}`}
              aria-current={p === cur ? 'page' : undefined} onClick={() => goPage(p)}>{p}</button>
          )))}
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={t.board.done.nextPage} disabled={cur >= pages} onClick={() => goPage(cur + 1)}><Icon name="chevron-right"/></button>
    </>
  );

  /**
   * Jump the strip to one card and flash it. A collapsed strip is opened
   * first; the cards then exist on the next frame, hence the small wait.
   *
   * `key` is the composite `<project>#<issue>`: the board paints one project
   * at a time, but the id is the key, so the caller hands over the key.
   */
  const locate = (key) => {
    const go = () => {
      const el = document.getElementById(`card-${key}`);
      if (!el) return;
      el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      el.classList.add('is-located');
      setTimeout(() => el.classList.remove('is-located'), 1400);
    };
    if (collapsed) {
      setDoneCollapsed(false);
      try { localStorage.setItem(DONE_KEY, '0'); } catch { /* private mode */ }
      setTimeout(go, 50);
    } else {
      go();
    }
  };

  // Last two weeks, for the strip's own summary. Counted over what the strip
  // holds, so a search narrows it too.
  const recent = completedByDay(done, 14, Date.now());
  const recentLabel = fill(t.board.done.recentLabel, { n: recent.total });
  const countText = parsed
    ? `${done.length} / ${doneTotal}`
    : (paginated ? fill(t.board.done.countOf, { shown: shownDone.length, total: doneSorted.length }) : doneSorted.length);
  const toggleLabel = collapsed ? t.board.done.show : t.board.done.hide;

  return (
    <section className={`cs ${collapsed ? 'is-collapsed' : ''}`} aria-label={t.board.done.section}>
      <div className="cs-bar">
        <button type="button" className="cs-toggle" aria-expanded={!collapsed} aria-label={toggleLabel}
          title={parsed ? undefined : toggleLabel} disabled={Boolean(parsed)} onClick={toggleDone}>
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} className="cs-chevron"/>
          <Icon name="check-circle" className="cs-ok"/>
          <span>{t.board.done.section}</span>
          <span className="cs-count">{countText}</span>
        </button>
        <span className="cs-recent">
          {splitAround(t.board.done.recent, { n: recent.total }).map((p) => (p.hole ? <b key={p.key}>{p.text}</b> : p.text))}
          <SparkColumns values={recent.days.map((d) => d.n)} width={98} height={22} label={recentLabel}/>
        </span>
        {/* The map stays when the cards are folded away: that is when it
            saves the most scrolling. */}
        <CompletedRail tasks={shownDone} stripRef={stripRef} onLocate={locate} parsed={parsed} />
        {/* The strip also holds tasks closed without a PR (FSD-G09) and issues
            closed on GitHub: the legend names the three endings, each with its
            own shape besides the colour. */}
        <span className="cs-legend" aria-hidden="true">
          <span className="cs-legend-item"><span className="cs-tick cs-tick-merged"/>{t.board.ending.merged}</span>
          <span className="cs-legend-item"><span className="cs-tick cs-tick-nopr"/>{t.board.ending.noPr}</span>
          <span className="cs-legend-item"><span className="cs-tick cs-tick-closed"/>{t.board.ending.issueClosed}</span>
        </span>
      </div>
      {!collapsed && (
        <div className="cs-body">
          {!parsed && doneTotal > 0 && (
            <div className="cs-tools">
              <label className="cs-size">
                {t.board.done.perPage}{' '}
                <input type="number" min={1} max={10000} inputMode="numeric" className="cs-size-input"
                  value={sizeDraft !== null ? sizeDraft : (allShown ? '' : pageSize)}
                  placeholder={allShown ? t.board.done.all : String(DEFAULT_PAGE_SIZE)}
                  onChange={(e) => setSizeDraft(e.target.value.replace(/\D/g, ''))}
                  onBlur={commitDraft}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); /* i18n-ok: KeyboardEvent.key */ }} />
              </label>
              <button type="button" className={`btn btn-ghost btn-sm cs-all ${allShown ? 'is-on' : ''}`} aria-pressed={allShown}
                onClick={() => applySize(allShown ? DEFAULT_PAGE_SIZE : ALL)}>
                {allShown && <Icon name="check"/>}{t.board.done.all}
              </button>
              {pages > 1 && (
                <>
                  <span className="cs-pager">{pagerButtons(false)}</span>
                  <span className="cs-pager cs-pager-compact">{pagerButtons(true)}</span>
                </>
              )}
            </div>
          )}
          <div className="cs-cards" ref={stripRef}>
            {parsed && shownDone.length === 0 && <div className="cs-empty">{fill(t.board.done.noResults, { query })}</div>}
            {shownDone.map((task) => <TaskCard key={taskKey(task)} task={task} compact parsed={parsed} {...actions} />)}
          </div>
        </div>
      )}
    </section>
  );
}
