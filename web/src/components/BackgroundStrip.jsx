import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDialog } from '../useDialog.jsx';
import Icon from './Icon.jsx';
import LiveDot from './ui/LiveDot.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill, locale, plural, strings } from '../i18n/index.js';

/**
 * What is still running in the background, pinned above the composer.
 *
 * A subagent or a background command outlives the turn that launched it, and
 * its tree stays where that turn was — often far up the chat. This strip keeps
 * them in view without scrolling: each one with what it is doing right now and
 * for how long. A row takes you to its tree, open. Gone when nothing runs.
 *
 * Servers get a section of their own: they never end by themselves, so a
 * spinner next to them would turn forever. They say since when they serve.
 */

// Mirrors `SERVER_QUIET_MS`, `SERVER_CMD_RE`, `CLIENT_RE` and `isServerLike`
// in server/src/activity.js: the projection counts servers with that rule, and
// the strip must file the same items under «sirviendo».
const SERVER_QUIET_MS = 10 * 60 * 1000;
const SERVER_CMD_RE = /\bserve\b|server|listen|http\.server|--port|while\s+true/i;
const CLIENT_RE = /^(?:[A-Za-z_]\w*=\S+\s+)*(?:sudo\s+)?(?:curl|wget|xh|httpie|http|Invoke-WebRequest|iwr|nc|telnet)\b/i;
const LIVE = new Set(['running', 'stopping']);
const FINISHED = new Set(['done', 'error', 'stopped']);
const MIN_REMAINING_MS = 60 * 1000;

export function isServerLike(item, now = Date.now()) {
  if (!item || item.kind !== 'bash' || !item.background || !LIVE.has(item.status)) return false;
  const since = Date.parse(item.outputChangedAt ?? item.startedAt ?? '');
  if (Number.isFinite(since) && now - since >= SERVER_QUIET_MS) return true;
  const command = String(item.command ?? '');
  if (CLIENT_RE.test(command.trimStart())) return false;
  return SERVER_CMD_RE.test(command) || item.port != null;
}

/** Mirrors `groupProgress` in activity.js: a wave's laggard sets the wait. */
function groupProgress(message, now) {
  const agents = (message.items ?? []).filter((i) => i.kind === 'agent');
  const finished = agents.filter((i) => FINISHED.has(i.status));
  const running = agents.filter((i) => i.status === 'running');
  const spans = finished
    .map((i) => Date.parse(i.endedAt) - Date.parse(i.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const meanMs = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  const remainingMs = meanMs != null && running.length
    ? Math.max(...running.map((i) => {
      const elapsed = now - Date.parse(i.startedAt);
      return Math.max(MIN_REMAINING_MS, meanMs - (Number.isFinite(elapsed) ? elapsed : 0));
    }))
    : null;
  return { total: agents.length, done: finished.length, running: running.length, remainingMs };
}

/** «~4 min», «~1 h 5 min»: never less than a minute, rounded up. */
export function approx(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return min < 60 ? `~${min} min` : `~${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The `⟳ N` of a tab: subagents and commands still going. Servers do not
 * count — they are not something to wait for.
 */
export function runCount(running) {
  const agents = running?.agents?.running ?? 0;
  const commands = running?.commands ?? 0;
  const t = strings().board.bg;
  const parts = [
    agents && plural(agents, t.subagents),
    commands && plural(commands, t.commands),
  ].filter(Boolean);
  const list = new Intl.ListFormat(locale(), { type: 'conjunction' }).format(parts);
  return { n: agents + commands, title: fill(t.inBackground, { parts: list }) };
}

/** Every live background item, split into what will end and what serves. */
function collect(messages, now) {
  const working = [];
  const serving = [];
  const waves = { total: 0, done: 0, remainingMs: null };
  for (const m of messages) {
    if (m.role !== 'activity') continue;
    const group = groupProgress(m, now);
    if (group.running) {
      waves.total += group.total;
      waves.done += group.done;
      if (group.remainingMs != null) waves.remainingMs = Math.max(waves.remainingMs ?? 0, group.remainingMs);
    }
    const walk = (items) => {
      for (const i of items ?? []) {
        if (LIVE.has(i.status) && i.background) {
          (isServerLike(i, now) ? serving : working).push({ messageId: m.id, item: i });
        }
        if (i.children) walk(i.children);
      }
    };
    walk(m.items);
  }
  return { working, serving, waves };
}

/** The agent's step in progress, or its latest; a command's progress line. */
function currentStep(item, starting) {
  if (item.kind !== 'agent') return item.progress ?? null;
  const kids = item.children ?? [];
  const step = [...kids].reverse().find((k) => k.status === 'running') ?? kids[kids.length - 1];
  if (!step) return item.progress ?? starting;
  return `${step.kind === 'bash' ? '$' : step.name} ${step.summary ?? ''}`.trim();
}

function since(iso, now) {
  if (!iso) return '';
  const min = Math.floor((now - Date.parse(iso)) / 60000);
  return min < 1 ? '<1 min' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** «desde 14:05», «desde ayer 14:05», «desde 12/09 14:05». */
function servingSince(iso, now, t) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day(at) === day(today)) return fill(t.servingSince, { time });
  if (day(at) === yesterday.getTime()) return fill(t.servingSinceYesterday, { time });
  return fill(t.servingSinceDate, { date: `${pad(at.getDate())}/${pad(at.getMonth() + 1)}`, time });
}

const nameOf = (item) => (item.kind === 'agent'
  ? String(item.summary ?? '').replace(/^[^:]+:\s*/, '')
  : item.summary || item.command || item.name);

export default function BackgroundStrip({ messages, owner, chatId }) {
  const t = useStrings().board.bg;
  const [now, setNow] = useState(Date.now());
  const { working, serving, waves } = collect(messages, now);
  const count = working.length + serving.length;
  const { ask, notice } = useDialog();
  useEffect(() => {
    if (!count) return undefined;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [count]);
  if (!count) return null;

  const focus = (row) => window.dispatchEvent(new CustomEvent('activity-focus', { detail: { messageId: row.messageId, itemId: row.item.id } }));
  const stop = async (item) => {
    const go = await ask({
      title: fill(t.stopTitle, { name: nameOf(item) }), icon: 'stop',
      text: t.stopText,
      options: [{ value: true, label: t.stop, tone: 'danger' }], cancel: t.keep,
    });
    if (!go) return;
    try {
      await api.stopBackground(owner, chatId, item.id);
    } catch (e) {
      notice({ title: t.stopFailed, text: e.message });
    }
  };

  // The stop button sits beside the row's button, never inside it: a button in
  // a button is invalid HTML, and the click would also open the tree.
  const line = (row, { name, step, meta, live }) => (
    <div key={row.item.id} className="ac-bg-line">
      <button type="button" className="ac-bg-row" onClick={() => focus(row)} title={t.viewTree}>
        <span className="ac-bg-mark">{live ? <LiveDot size={6} /> : <span className="ac-bg-still" aria-hidden="true" />}</span>
        <span className="ac-bg-name">{name}</span>
        {step && <span className="ac-bg-step">{step}</span>}
        <span className="ac-bg-meta">{meta}</span>
      </button>
      {row.item.status === 'stopping'
        ? <span className="ac-bg-stopping">{t.stopping}</span>
        : row.item.taskId && (
          <button type="button" className="btn btn-ghost btn-xs btn-icon ac-bg-stop" onClick={() => stop(row.item)} title={t.stop} aria-label={fill(t.stopAria, { name: nameOf(row.item) })}><Icon name="stop"/></button>
        )}
    </div>
  );

  const spinning = working.some((r) => r.item.status === 'running');
  return (
    <div className={`ac-bg ${working.length ? '' : 'is-only-serving'}`} role="status" aria-live="polite">
      {working.length > 0 && (
        <div className="ac-bg-section">
          <span className="ac-bg-head">
            {spinning && <LiveDot size={6} />} {t.head}
            {waves.total > 0 && ` · ${fill(t.wavesDone, { done: waves.done, total: waves.total })}`}
            {waves.remainingMs != null && ` · ${fill(t.remaining, { time: approx(waves.remainingMs) })}`}
          </span>
          {working.map((row) => {
            const { item } = row;
            const calls = (item.children?.length ?? 0) + (item.hiddenChildren ?? 0);
            return line(row, {
              name: item.kind === 'agent' ? <><Icon name="bot"/> {nameOf(item)}</> : `$ ${nameOf(item)}`,
              step: currentStep(item, t.starting),
              meta: `${item.kind === 'agent' && calls ? `${plural(calls, t.calls)} · ` : ''}${since(item.startedAt, now)}`,
              live: item.status === 'running',
            });
          })}
        </div>
      )}
      {serving.length > 0 && (
        <div className="ac-bg-section">
          <span className="ac-bg-head ac-bg-serving">{t.serving}</span>
          {serving.map((row) => {
            const { item } = row;
            const step = [item.port != null && `:${item.port}`, item.summary && item.command].filter(Boolean).join(' · ');
            return line(row, { name: `$ ${nameOf(item)}`, step, meta: servingSince(item.startedAt, now, t), live: false });
          })}
        </div>
      )}
    </div>
  );
}
