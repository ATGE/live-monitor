import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import TaskCard from './TaskCard.jsx';
import ProjectChatCard from './ProjectChatCard.jsx';
import CompletedStrip from './CompletedStrip.jsx';
import Icon from './Icon.jsx';
import { BUSY_STATES, COLUMNS, HIDE_WHEN_EMPTY, MODES, meta, orphanStates } from '../status.js';
import { taskKey } from '../taskKey.js';
import { PHONE } from '../useSidePanel.js';
import { read, write } from '../storage.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';

// The guard exists for changes exactly like the one that moved `manual` out of
// the states; it is worth nothing unless something calls it.
const orphans = orphanStates();
if (orphans.length) console.warn(`[board] states without a column: ${orphans.join(', ')}`); // i18n-ok: console diagnostic

// Which lane the phone was on, remembered per device (a convenience: the board
// works without it).
const MOBILE_COLUMN_KEY = 'hfsmon-mobile-column';

/**
 * Which column a card belongs to, in strict order of precedence:
 *
 * 1. merged work is finished work, whoever drove it;
 * 2. a task being worked on stays in its phase column — moving the switch must
 *    not make a running card vanish while the slot counter still counts it;
 * 3. the mode, for anything the board is not carrying by itself;
 * 4. its state.
 */
const placement = (task) => {
  if (task.state === 'done') return 'done';
  if (BUSY_STATES.includes(task.state)) return `state:${task.state}`;
  const mode = task.mode ?? 'auto';
  if (mode !== 'auto') return `mode:${mode}`;
  return `state:${task.state}`;
};

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches // i18n-ok: media query
  : false;
const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth');

/** True while the window is phone-sized; live, so rotating the phone reaches the board. */
function usePhone() {
  const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE) : null);
  const [phone, setPhone] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return undefined;
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** Ghost columns for the very first load: the shape of the board, no data. */
function BoardSkeleton() {
  const t = useStrings();
  return (
    <div className="bd-main bd-skeleton" aria-busy="true" role="status" aria-label={t.board.loadingTasks}>
      {[2, 3, 1].map((cards, i) => (
        <section className="bd-col is-ghost" key={i} aria-hidden="true">
          <header className="bd-col-head">
            <span className="bd-ghost bd-ghost-icon" />
            <span className="bd-ghost bd-ghost-title" />
          </header>
          <div className="bd-cards">
            {Array.from({ length: cards }, (_, j) => (
              <div className="bd-ghost-card" key={j}>
                <span className="bd-ghost bd-ghost-line is-short" />
                <span className="bd-ghost bd-ghost-line" />
                <span className="bd-ghost bd-ghost-line is-mid" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Board({
  tasks, query, parsed, doneTotal, projectChats = [], onOpenProjectChat,
  // Painted here, and kept out of `actions`, which goes on to every TaskCard.
  loading = false, polling = false, onPollNow = null,
  ...actions
}) {
  const t = useStrings();
  const done = tasks.filter((task) => placement(task) === 'done');
  const phone = usePhone();
  // Nothing open anywhere, and nobody searching: say so, and offer the one
  // useful move. Finished work lives in the strip below and does not count.
  const empty = !loading && !(query ?? '').trim() && projectChats.length === 0
    && tasks.every((task) => placement(task) === 'done');

  // Empty phase columns fold into a 40px rail; a click (or a task arriving)
  // gives the column its width back.
  const [opened, setOpened] = useState(() => new Set());
  const open = (key) => setOpened((prev) => new Set(prev).add(key));

  // `lead` is what a column carries besides tasks (the project chat cards):
  // never filtered, never counted, and enough to keep the column on screen.
  const describe = (key, info, items, hideWhenEmpty, lead = []) => {
    if (hideWhenEmpty && items.length === 0 && lead.length === 0) return null;
    return { key, info, items, lead, bare: items.length === 0 && lead.length === 0 };
  };

  const columns = [
    // The two mode columns lead: a task waiting on your answer is the one
    // thing on this board that cannot move without you.
    ...Object.entries(MODES).map(([mode, info]) =>
      describe(mode, info, tasks.filter((task) => placement(task) === `mode:${mode}`), true,
        mode === 'manual' ? projectChats : [])),
    ...COLUMNS.map(({ key, states }) => {
      const items = tasks.filter((task) => states.some((s) => placement(task) === `state:${s}`));
      // Columns that only make sense when populated stay hidden otherwise.
      return describe(key, meta(key), items, HIDE_WHEN_EMPTY.includes(key));
    }),
  ].filter(Boolean);

  const mainRef = useRef(null);
  const navRef = useRef(null);

  // ---- "N more columns": columns still out of view to the right ----------
  // Keeps the lane keys, never their labels: a label stored here would stay in
  // the language it was measured in.
  const [more, setMore] = useState({ count: 0, lanes: '' });
  const measure = useCallback(() => {
    const main = mainRef.current;
    if (!main || phone) {
      setMore((m) => (m.count === 0 ? m : { count: 0, lanes: '' }));
      return;
    }
    const edge = main.getBoundingClientRect().right;
    const out = [...main.querySelectorAll(':scope > .bd-col')]
      .filter((el) => el.getBoundingClientRect().right > edge + 2);
    const lanes = out.map((el) => el.dataset.lane).join(',');
    setMore((m) => (m.count === out.length && m.lanes === lanes ? m : { count: out.length, lanes }));
  }, [phone]);

  // After every render: a column appearing, folding or growing moves the edge.
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return undefined;
    main.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(main);
    window.addEventListener('resize', measure);
    return () => {
      main.removeEventListener('scroll', measure);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, loading, empty]);

  const showMore = () => {
    const main = mainRef.current;
    if (!main) return;
    const mainRect = main.getBoundingClientRect();
    const next = [...main.querySelectorAll(':scope > .bd-col')]
      .find((el) => el.getBoundingClientRect().right > mainRect.right + 2);
    if (!next) return;
    main.scrollBy({ left: next.getBoundingClientRect().left - mainRect.left - 12, behavior: scrollBehavior() });
  };

  // ---- phone: one lane at a time, picked from a row of chips -------------
  const [savedKey, setSavedKey] = useState(() => read(MOBILE_COLUMN_KEY, null));
  const activeKey = columns.some((c) => c.key === savedKey) ? savedKey : columns[0]?.key;
  const laneOf = (key) => mainRef.current?.querySelector(`:scope > [data-lane="${key}"]`);

  const pick = (key) => {
    setSavedKey(key);
    write(MOBILE_COLUMN_KEY, key);
    const lane = laneOf(key);
    if (lane) mainRef.current.scrollTo({ left: lane.offsetLeft, behavior: scrollBehavior() });
  };

  // Swiping changes the lane; the chip follows. Only once the scroll has come
  // to rest (`scrollend`, or a short debounce where it does not exist): reading
  // it mid-flight made the chip jump through the lanes passed on the way during
  // pick()'s smooth scroll, and wrote the device's storage on every frame.
  useEffect(() => {
    const main = mainRef.current;
    if (!phone || !main) return undefined;
    const settle = () => {
      const lanes = [...main.querySelectorAll(':scope > .bd-col')];
      if (!lanes.length) return;
      const gap = (el) => Math.abs(el.offsetLeft - main.scrollLeft);
      const key = lanes.reduce((best, el) => (gap(el) < gap(best) ? el : best), lanes[0]).dataset.lane;
      if (key && key !== activeKey) {
        setSavedKey(key);
        write(MOBILE_COLUMN_KEY, key);
      }
    };
    if ('onscrollend' in window) {
      main.addEventListener('scrollend', settle);
      return () => main.removeEventListener('scrollend', settle);
    }
    let timer = null;
    const later = () => { clearTimeout(timer); timer = setTimeout(settle, 150); };
    main.addEventListener('scroll', later, { passive: true });
    return () => { clearTimeout(timer); main.removeEventListener('scroll', later); };
  }, [phone, loading, empty, activeKey]);

  // Coming back (or turning the phone) lands on the remembered lane.
  const landed = useRef(false);
  useEffect(() => {
    if (!phone || loading) { landed.current = false; return; }
    if (landed.current || !activeKey) return;
    const lane = laneOf(activeKey);
    if (!lane) return;
    landed.current = true;
    mainRef.current.scrollTo({ left: lane.offsetLeft, behavior: 'auto' });
  });

  // Keep the active chip in view in its own scrolling row.
  useEffect(() => {
    if (!phone) return;
    const chip = navRef.current?.querySelector('[aria-current="true"]');
    chip?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: scrollBehavior() });
  }, [phone, activeKey]);

  const moreNames = more.lanes.split(',').filter(Boolean)
    .map((key) => columns.find((c) => c.key === key)?.info.label ?? key).join(', ');

  const renderColumn = ({ key, info, items, lead, bare }) => {
    const folded = bare && !phone && !opened.has(key);
    if (folded) {
      return (
        <section className={`bd-col bd-col-${key} is-rail`} key={key} data-lane={key} aria-label={`${info.label}: ${plural(0, t.common.task)}`}>
          <button type="button" className="bd-rail" title={fill(t.board.openColumn, { label: info.label })} onClick={() => open(key)}>
            <span className="bd-count">0</span>
            <span className="bd-rail-name">{info.label}</span>
            <Icon name="chevron-right" />
          </button>
        </section>
      );
    }
    return (
      <section className={`bd-col bd-col-${key}${bare ? ' is-bare' : ''}`} key={key} data-lane={key}
        aria-label={`${info.label}: ${plural(items.length, t.common.task)}`}>
        <header className="bd-col-head">
          <Icon name={info.icon} />
          <h2 className="bd-col-title">{info.label}</h2>
          <span className="bd-count">{items.length}</span>
          {info.hint && <span className="bd-hint">{info.hint}</span>}
        </header>
        <div className="bd-cards">
          {lead.map((holder) => (
            <ProjectChatCard key={holder.key} holder={holder} showMachine={lead.length > 1}
              onOpen={() => onOpenProjectChat?.(holder.project, holder.machine)} />
          ))}
          {items.map((task) => <TaskCard key={taskKey(task)} task={task} parsed={parsed} {...actions} />)}
          {bare && <div className="bd-none">—</div>}
        </div>
      </section>
    );
  };

  return (
    <div className={`board-wrap bd-wrap${loading ? ' is-loading' : ''}`}>
      {phone && !loading && !empty && columns.length > 0 && (
        <nav className="bd-nav" aria-label={t.board.columnsNav} ref={navRef}>
          {columns.map(({ key, info, items }) => (
            <button type="button" key={key} className="bd-tab"
              aria-current={key === activeKey ? 'true' : undefined} onClick={() => pick(key)}>
              <Icon name={info.icon} />
              <span>{info.label}</span>
              <b>{items.length}</b>
            </button>
          ))}
        </nav>
      )}

      {loading && <BoardSkeleton />}

      {empty && (
        <div className="bd-empty" role="status">
          <p>{t.board.noOpenTasks}</p>
          <button type="button" className="btn btn-sm" onClick={() => onPollNow?.()} disabled={polling}>
            <Icon name="refresh" /> {t.board.pollNow}
          </button>
        </div>
      )}

      {!loading && !empty && (
        <div className="bd-stage">
          <main className="bd-main" aria-label={t.board.columnsLabel} ref={mainRef}>
            {columns.map(renderColumn)}
          </main>
          {!phone && more.count > 0 && (
            <>
              <div className="bd-fade" aria-hidden="true" />
              <button type="button" className="bd-more" title={fill(t.board.viewRight, { names: moreNames })}
                onClick={showMore}>
                <Icon name="chevron-right" />
                {plural(more.count, t.board.moreColumns)}
              </button>
            </>
          )}
        </div>
      )}

      {(doneTotal > 0 || done.length > 0) && (
        <CompletedStrip done={done} doneTotal={doneTotal} query={query} parsed={parsed} actions={actions} />
      )}
    </div>
  );
}
