import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STATUS } from '../status.js';
import Icon from './Icon.jsx';
import LiveDot from './ui/LiveDot.jsx';
import { runCount } from './BackgroundStrip.jsx';
import { holderKey, keyOf, parseHolderTab, taskKey } from '../taskKey.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';

/**
 * The strip over the chat panel: one tab per task, like editor tabs in VS
 * Code. The list is the board's, shared by every device; which one is active
 * is this screen's own `activeKey`.
 *
 * A tab is `{ project, issue }` — issue #12 of two repositories are two tabs,
 * so everything here goes by the composite key `<project>#<issue>`.
 *
 * A project chat's tab is `{ issue: 'p:<project>@<machine>' }` (the strip's
 * entry for a holder, see `parseHolderTab`): it has no issue and is drawn
 * first, as `💬 Proyecto`, with `is-project`. It resolves against `holders`,
 * the active project's holder summaries.
 *
 * A task being looked at that is not in the list — another device closed its
 * tab — still shows, in italics, so the chat on screen never vanishes from
 * under the reader.
 */
export default function TaskTabs({
  tabs = [], tasks, holders = [], activeKey, onSelect, onClose, onSelectHolder, onCloseHolder, onCollapse, phone = false,
}) {
  const t = useStrings();
  const byKey = new Map(tasks.map((t) => [taskKey(t), t]));
  const holderByKey = new Map(holders.map((h) => [taskKey(h), h]));
  const holderTabs = tabs
    .map((t) => parseHolderTab(t.issue))
    .filter(Boolean)
    .map((p) => holderByKey.get(holderKey(p.project, p.machine)))
    .filter(Boolean);
  const listed = [
    ...holderTabs,
    ...tabs.filter((t) => parseHolderTab(t.issue) == null)
      .map((t) => byKey.get(keyOf(t.project, t.issue))).filter(Boolean),
  ];
  const provisional = activeKey != null && !listed.some((t) => taskKey(t) === activeKey)
    ? holderByKey.get(activeKey) ?? byKey.get(activeKey) ?? null
    : null;
  const shown = provisional ? [...listed, provisional] : listed;

  const strip = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useLayoutEffect(measure, [measure, shown.length]);
  useEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // The active tab is always in view, however it became active.
  useEffect(() => {
    const el = strip.current?.querySelector('.task-tab.is-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, shown.length]);

  // A vertical wheel moves the strip sideways: there is nothing to scroll
  // up or down in it, and a mouse has no horizontal wheel.
  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  if (!shown.length) return null;

  const nudge = (dir) => strip.current?.scrollBy({ left: dir * 160, behavior: 'smooth' });

  return (
    <div className="task-tabs-bar">
      {/* The arrows float over the strip, so they share its box and not the
          bar's: the collapse button beside it must stay clear of them. */}
      <div className="task-tabs-scroller">
        {edges.left && (
          <button className="btn btn-ghost btn-sm btn-icon task-tabs-arrow is-left" onClick={() => nudge(-1)} title={t.chat.tabs.previous} aria-label={t.chat.tabs.previous}><Icon name="chevron-left"/></button>
        )}
        <div className="task-tabs" role="tablist" ref={strip} onScroll={measure}>
          {shown.map((task) => {
            if (task.kind === 'project') {
              const active = taskKey(task) === activeKey;
              const busy = (task.chats ?? []).filter((c) => c.busy && !c.closedAt).length;
              const waiting = (task.chats ?? []).some((c) => c.pending && !c.closedAt);
              const name = holders.length > 1 ? fill(t.chat.tabs.projectOnMachine, { machine: task.machine }) : t.chat.tabs.project;   // full label, for title/aria
              const tip = [
                fill(t.chat.tabs.projectChat, { project: task.project }), task.machine, task.baseBranch,
                busy ? plural(busy, t.chat.tabs.busy) : null,
                waiting ? t.chat.tabs.waitsDecision : null,
                task === provisional ? t.chat.tabs.notInStrip : null,
              ].filter(Boolean).join(' · ');
              return (
                <div
                  key={taskKey(task)}
                  role="tab"
                  aria-selected={active}
                  className={`task-tab is-project ${active ? 'is-active' : ''} ${task === provisional ? 'is-provisional' : ''}`}
                  title={tip}
                  aria-label={name}
                >
                  <button className="task-tab-label" aria-label={name} onClick={() => onSelectHolder(task.project, task.machine)}>
                    <span className="task-tab-icon tt-lead" aria-hidden="true">
                      {busy > 0 ? <LiveDot /> : <Icon name="message"/>}
                    </span>
                    <span className="task-tab-title" data-label={t.chat.tabs.project}>{t.chat.tabs.project}</span>
                    {holders.length > 1 && <span className="task-tab-machine">{task.machine}</span>}
                    {waiting && <span className="tt-ask" role="img" aria-label={t.chat.tabs.waitsDecisionLabel} title={t.chat.tabs.waitsDecisionLabel}><Icon name="help-circle"/></span>}
                  </button>
                  <button
                    className="btn btn-ghost btn-icon task-tab-close tt-close"
                    onClick={(e) => { e.stopPropagation(); onCloseHolder(task.project, task.machine); }}
                    title={t.chat.tabs.removeFromStrip}
                    aria-label={t.chat.tabs.removeProject}
                  ><Icon name="x"/></button>
                </div>
              );
            }
            const active = taskKey(task) === activeKey;
            const busy = (task.chats ?? []).filter((c) => c.busy && !c.closedAt).length;
            const waiting = (task.awaitingYou ?? []).length > 0;
            const status = STATUS[task.state];
            const run = runCount(task.running);
            const tip = [
              `#${task.issue}`, task.title, task.branch,
              busy ? plural(busy, t.chat.tabs.busy) : null,
              run.n ? run.title : null,
              waiting ? t.chat.tabs.waitsDecision : null,
              task === provisional ? t.chat.tabs.notInStrip : null,
            ].filter(Boolean).join(' · ');
            return (
              <div
                key={taskKey(task)}
                role="tab"
                aria-selected={active}
                className={`task-tab ${active ? 'is-active' : ''} ${task === provisional ? 'is-provisional' : ''}`}
                title={tip}
              >
                <button className="task-tab-label" onClick={() => onSelect(task.project, task.issue)}>
                  {/* State by shape as well as colour: the cyan dot works, the
                      amber help icon waits for you, else the state's own icon. */}
                  <span className="task-tab-icon tt-lead" aria-hidden="true">
                    {waiting ? <span className="tt-ask"><Icon name="help-circle"/></span>
                      : busy > 0 || run.n > 0 ? <LiveDot /> : <Icon name={status?.icon ?? 'dot'} />}
                  </span>
                  <span className="task-tab-num" data-label={`#${task.issue}`}>#{task.issue}</span>
                  <span className="task-tab-title" data-label={task.title}>{task.title}</span>
                  {waiting && <span className="tt-sr">{t.chat.tabs.waitsDecisionLabel}</span>}
                  {run.n > 0 && <span className="run-count tt-run" title={run.title}><Icon name="refresh"/> {run.n}</span>}
                </button>
                {/* Never disabled: taking a tab out of the strip stops nothing
                    and archives nothing, unlike a chat's own ✕. */}
                <button
                  className="btn btn-ghost btn-icon task-tab-close tt-close"
                  onClick={(e) => { e.stopPropagation(); onClose(task.project, task.issue); }}
                  title={t.chat.tabs.removeFromStrip}
                  aria-label={fill(t.chat.tabs.removeTask, { issue: task.issue })}
                ><Icon name="x"/></button>
              </div>
            );
          })}
        </div>
        {edges.right && (
          <button className="btn btn-ghost btn-sm btn-icon task-tabs-arrow is-right" onClick={() => nudge(1)} title={t.chat.tabs.next} aria-label={t.chat.tabs.next}><Icon name="chevron-right"/></button>
        )}
      </div>
      {/* The panel's other collapse tab is on its far left edge: with a wide
          panel that is a whole screen away, so the strip carries one too. On
          a phone there is no rail to collapse to and the same button closes
          the panel, so it says so. */}
      {onCollapse && (
        <button
          className="btn btn-ghost btn-icon task-tabs-collapse"
          onClick={onCollapse}
          title={phone ? t.chat.tabs.closePanel : t.chat.tabs.collapsePanel}
          aria-label={phone ? t.chat.tabs.closePanel : t.chat.tabs.collapsePanel}
        >{phone ? <Icon name="x"/> : <Icon name="chevron-right"/>}</button>
      )}
    </div>
  );
}
