import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useOpenFile } from '../viewer/context.js';
import { isFileRef } from '../viewer/filerefs.js';
import MachineChips from '../viewer/MachineChips.jsx';
import Stamp from './Stamp.jsx';
import Icon from './Icon.jsx';
import LiveDot from './ui/LiveDot.jsx';
import { PUBLISH_COPY } from '../publishQuestion.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, strings } from '../i18n/index.js';
import '../viewer/filerefs.css';

/** Tools whose summary is the path they worked on (`summarizeToolInput` in server/src/claude.js). */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']); // i18n-ok: tool names, not UI text

/**
 * What a turn did, folded under one line: how many tools, how many subagents
 * and how they stand, how long — and, while it runs, the innermost thing
 * running right now. Open it for the tree: each subagent with its own calls
 * and its report, each Bash with its command and console, each tool with what
 * it answered.
 *
 * Every item renders through the same component, nested or not: a subagent's
 * Read is the same Read as the main thread's.
 *
 * `owner` (a task or a project-chat holder) and `chatId` let a subagent reach its own transcript: opening one
 * fills in any calls the stream never delivered, and «… N anteriores» loads
 * the ones that scrolled out of the history.
 */

const STATUS_ICON = { done: 'check', error: 'x-circle', stopped: 'stop' };

/** Fallback name of a canvas card when the call carries no usable title. */
export const CANVAS_FALLBACK = () => strings().chat.activity.canvasFallback;
// A URL scheme, a drive letter, a leading / \ ~ or ., or a bare file name: not a title.
const FILE_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/]|[\\/~.])|\.(?:html?|md|jsx?|tsx?|css|json|svg|txt)$/i;

/**
 * The name of a published canvas, read from the call's summary. The server
 * sends no title field: `summarizeToolInput` (server/src/claude.js) builds
 * «publish: <title ?? file_path ?? url>». A path or a URL there means the call
 * had no title, so the card says the generic name; the raw URL never shows.
 */
export function canvasTitle(item) {
  const m = /^publish:\s*(.+)$/s.exec(String(item?.summary ?? ''));
  const what = m?.[1].trim();
  return what && !FILE_LIKE.test(what) ? what : CANVAS_FALLBACK();
}

/**
 * Tools that stop and wait for the person's answer while they run: a question,
 * or an Artifact call the publish gate holds (server/src/artifactgate.js).
 */
const READS = new Set(['list', 'read', 'quickstart', 'get', 'query']); // artifactgate.js READ_ACTIONS: these pass without asking
// A read's summary is the bare action; a publish's is «publish: <title>» (summarizeToolInput in claude.js).
const isWaiting = (item) => item.status === 'running' && (item.name === 'AskUserQuestion'
  || (/^Artifact(Comments|Data)?$/.test(item.name ?? '') && !READS.has(String(item.summary ?? '').split(':')[0].trim())));

function walk(items, fn) {
  for (const i of items ?? []) { fn(i); walk(i.children, fn); }
}

function summarize(activity) {
  const all = [];
  walk(activity.items, (i) => all.push(i));
  const agents = all.filter((i) => i.kind === 'agent');
  const running = all.filter((i) => i.status === 'running');
  const hidden = agents.reduce((n, a) => n + (a.hiddenChildren ?? 0), 0);
  return {
    tools: all.length + hidden,
    agents: { total: agents.length, running: agents.filter((i) => i.status === 'running').length },
    running: running.length,
    current: running.length ? running[running.length - 1] : null,
    failed: all.filter((i) => i.status === 'error').length,
    waiting: all.filter(isWaiting).length,
  };
}

/** Seconds between two stamps, or since the first if the second is missing. */
function seconds(from, to, now) {
  if (!from) return null;
  const end = to ? new Date(to).getTime() : now;
  return Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
}

function fmt(s) {
  if (s === null || s === undefined) return '';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A clock that only ticks while something is running. */
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * Something outside asked to show this tree or item — a row of the
 * background strip. Opening on that request is the user's own click, one
 * step removed, so it does not break the rule that only a click opens.
 */
function useFocusRequest(match, onFocus) {
  useEffect(() => {
    const handler = (e) => { if (match(e.detail ?? {})) onFocus(); };
    window.addEventListener('activity-focus', handler);
    return () => window.removeEventListener('activity-focus', handler);
  });
}

export default function ActivityGroup({ activity, owner = null, chatId = null }) {
  const t = useStrings();
  const s = summarize(activity);
  // Open or closed is yours: the caret toggles it any time, and nothing here
  // changes it afterwards — not a new step, not the turn ending. The only
  // automatic part is where it starts: open while the turn runs, so what the
  // subagents are doing is on screen without a click; folded when it is over.
  const [open, setOpen] = useState(() => s.running > 0);
  const now = useNow(s.running > 0);
  const rootRef = useRef(null);
  useFocusRequest((d) => d.messageId === activity.id, () => {
    setOpen(true);
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  });
  if (!activity.items?.length) return null;

  const first = activity.items[0];
  let last = null;
  walk(activity.items, (i) => { if (i.endedAt && (!last || i.endedAt > last)) last = i.endedAt; });
  const total = seconds(first.startedAt, s.running ? null : last, now);
  // `project`/`issue`/`chatId` also scope the file viewer; a holder has no issue.
  const ctx = owner && chatId ? { owner, chatId, project: owner.project, issue: owner.issue ?? null, machine: owner.machine ?? null } : null;

  return (
    <div className={`ac-group ${s.running ? 'is-running' : ''}`} ref={rootRef} id={`act-${activity.id}`}>
      <button type="button" className="ac-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? t.chat.activity.fold : t.chat.activity.showDetail}>
        <Icon name="wrench" className="ac-head-icon" />
        <b className="ac-head-count">{plural(s.tools, t.chat.activity.tools)}</b>
        {s.agents.total > 0 && (
          <span className="ac-head-part"><Icon name="bot" /> {plural(s.agents.total, t.chat.activity.agents)}
            {s.agents.running > 0 ? ` ${fill(t.chat.activity.agentsRunning, { n: s.agents.running })}` : <> <Icon name="check" /></>}</span>
        )}
        {s.waiting > 0 && <span className="ac-head-wait"><Icon name="hourglass" /> {plural(s.waiting, t.chat.activity.waiting)}</span>}
        {s.failed > 0 && <span className="ac-head-bad"><Icon name="x-circle" /> {s.failed}</span>}
        {total !== null && <span className="ac-head-part"><Icon name="timer" /> {fmt(total)}</span>}
        {activity.dropped > 0 && <span className="ac-head-part">{fill(t.chat.activity.dropped, { n: activity.dropped })}</span>}
        {/* A tool tree has no author line, so its hour goes at the end of its
            head, pushed right so it does not read as one more chip. */}
        <Stamp ts={activity.ts} className="ac-stamp" />
        <Icon name={open ? 'chevron-down' : 'chevron-right'} className="ac-caret" />
      </button>
      {!open && s.current && (
        <div className="ac-current">
          <LiveDot size={6} />
          <span className="ac-current-name">{s.current.name}</span>
          <span className="ac-current-summary">{s.current.progress ?? s.current.summary}</span>
        </div>
      )}
      {open && (
        <div className="ac-items">
          {activity.items.map((item) => <ActivityItem key={item.id} item={item} now={now} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

function ActivityItem({ item, now, depth = 0, ctx = null }) {
  const t = useStrings();
  // Same contract as the group: a running subagent starts open, everything
  // else starts closed, and only a click changes it from then on.
  const [open, setOpen] = useState(() => item.kind === 'agent' && item.status === 'running');
  const [earlier, setEarlier] = useState(null);     // calls loaded from the transcript
  const [loading, setLoading] = useState(false);
  // This tree's own chat wins over whichever chat the viewer has in scope.
  const openFile = useOpenFile(ctx ?? undefined);
  const backfilled = useRef(false);
  const itemRef = useRef(null);
  const running = item.status === 'running';
  const elapsed = seconds(item.startedAt, item.endedAt, now);
  const isAgent = item.kind === 'agent';
  // An agent can always be opened: that is what fetches its calls.
  const hasDetail = Boolean(item.output || item.command || item.children?.length || item.text || isAgent);
  // An open subagent keeps its latest step in view while it works; folded,
  // it leaves the scroll alone.
  const listRef = useRef(null);
  const count = item.children?.length ?? 0;
  useEffect(() => {
    if (open && running && listRef.current?.lastElementChild) {
      listRef.current.lastElementChild.scrollIntoView({ block: 'nearest' });
    }
  }, [open, running, count]);

  useFocusRequest((d) => d.itemId === item.id, () => {
    setOpen(true);
    requestAnimationFrame(() => itemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  });

  // Opening an agent the first time fills in what the stream missed. The
  // server is idempotent; once per mount is enough.
  useEffect(() => {
    if (!open || !isAgent || backfilled.current || !ctx || !item.taskId) return;
    backfilled.current = true;
    api.backfillAgent(ctx.owner, ctx.chatId, item.id).catch(() => { backfilled.current = false; });
  }, [open, isAgent, item.id, item.taskId, ctx]);

  const loadEarlier = () => {
    if (!ctx) return;
    setLoading(true);
    api.agentCalls(ctx.owner, ctx.chatId, item.id)
      .then((r) => setEarlier(r.calls ?? []))
      .catch(() => setEarlier([]))
      .finally(() => setLoading(false));
  };

  const label = isAgent
    ? `${item.subagentType ?? 'Agent'}: ${item.summary.replace(/^[^:]+:\s*/, '')}`
    : item.summary;

  const waiting = isWaiting(item);
  // The path of a Read/Write/Edit opens in the viewer. A button cannot hold
  // another, so such a row is a div: an empty button covering it toggles the
  // detail, and the path is a real button above it (filerefs.css).
  const fileRow = Boolean(openFile) && !isAgent && FILE_TOOLS.has(item.name) && isFileRef(item.summary);
  // State is never colour alone: each one has its own icon.
  const status = (
    <span className="ac-status">
      {waiting
        ? <Icon name="hourglass" className="ac-wait" />
        : running
          ? <LiveDot label={t.chat.activity.running} size={6} />
          : <Icon name={STATUS_ICON[item.status] ?? 'dot'} className={`ac-st-${item.status}`} />}
    </span>
  );
  const name = <span className="ac-name" title={isAgent ? undefined : item.name}>{isAgent ? <Icon name="bot" /> : item.kind === 'bash' ? '$' : item.name}</span>;
  const tail = (
    <>
      {item.background && <span className="ac-tag">{t.chat.activity.background}</span>}
      {running && item.progress && <span className="ac-progress">{item.progress}</span>}
      {elapsed !== null && (running || elapsed >= 2) && <span className="ac-time">{fmt(elapsed)}</span>}
      {hasDetail && <Icon name={open ? 'chevron-down' : 'chevron-right'} className="ac-caret" />}
    </>
  );
  const srOnly = waiting ? <span className="ac-sr">{t.chat.activity.waitingSr}</span> : null;

  return (
    <div className={`ac-item ac-kind-${item.kind} ac-status-${item.status}`} style={{ '--depth': depth }} ref={itemRef}>
      {fileRow ? (
        <div className={`ac-line file-row${hasDetail ? '' : ' no-detail'}`}>
          <button
            type="button"
            className="row-toggle"
            onClick={() => setOpen((o) => !o)}
            disabled={!hasDetail}
            aria-expanded={hasDetail ? open : undefined}
            aria-label={`${item.name}: ${item.summary}`}
          />
          {status}
          {name}
          <span className="ac-summary" title={item.summary}>
            <button type="button" className="file-ref" onClick={() => openFile(item.summary)} title={t.chat.activity.openInViewer}>{label}</button>
          </span>
          <MachineChips refText={item.summary} override={ctx ?? undefined} />
          {tail}
        </div>
      ) : (
        <button type="button" className="ac-line" onClick={() => hasDetail && setOpen((o) => !o)} disabled={!hasDetail} aria-expanded={hasDetail ? open : undefined}>
          {status}
          {name}
          <span className="ac-summary" title={item.command ?? item.summary}>{label}</span>
          {tail}
          {srOnly}
        </button>
      )}
      {/* Published canvases: a sibling of the line, never inside its button. */}
      {Array.isArray(item.links) && item.links.length > 0 && (
        <div className="ac-canvases">
          {item.links.map((url, n) => {
            const title = item.links.length > 1 ? `${canvasTitle(item)} (${n + 1})` : canvasTitle(item);
            return (
              <a key={url} className="ac-canvas" href={url} target="_blank" rel="noreferrer"
                aria-label={PUBLISH_COPY.canvasAria(title)} title={fill(t.chat.activity.openCanvas, { title, url })}>
                <span className="ac-canvas-icon"><Icon name="palette" /></span>
                <span className="ac-canvas-title">{title}</span>
                <Icon name="external" className="ac-canvas-ext" />
              </a>
            );
          })}
        </div>
      )}
      {open && (
        <div className="ac-detail">
          {item.command && <pre className="ac-cmd">$ {item.command}</pre>}
          {isAgent && item.text && <div className="ac-agent-text">{item.text}</div>}
          {isAgent && item.hiddenChildren > 0 && ctx && (
            earlier ? (
              <div className="ac-items ac-earlier">
                {earlier.map((c) => <ActivityItem key={c.id} item={c} now={now} depth={depth + 1} ctx={ctx} />)}
              </div>
            ) : (
              <button type="button" className="ac-earlier-btn" onClick={loadEarlier} disabled={loading}>
                {loading ? t.chat.activity.loadingEarlier : plural(item.hiddenChildren, t.chat.activity.earlier)}
              </button>
            )
          )}
          {item.children?.length > 0 && (
            <div className="ac-items ac-children" ref={listRef}>
              {item.children.map((c) => <ActivityItem key={c.id} item={c} now={now} depth={depth + 1} ctx={ctx} />)}
            </div>
          )}
          {item.output && (
            isAgent
              ? <div className="ac-agent-report"><span className="ac-who">{t.chat.activity.report}</span>{item.output}</div>
              : <Console text={item.output} live={running} />
          )}
          {isAgent && running && !item.children?.length && <p className="ac-dim">{t.chat.activity.working}</p>}
        </div>
      )}
    </div>
  );
}

/** Output as a terminal would show it, following the end while it grows. */
function Console({ text, live }) {
  const ref = useRef(null);
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, live]);
  return (
    <pre className={`ac-console ${live ? 'is-live' : ''}`} ref={ref}>
      {text.split('\n').map((line, i) => (
        <span key={i} className={line === '[stderr]' || /^(error|warning)\b/i.test(line) ? 'ac-err' : ''}>{line}{'\n'}</span>
      ))}
    </pre>
  );
}
