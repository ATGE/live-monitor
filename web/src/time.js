/**
 * Dates and times as the board says them, without `Intl`.
 *
 * `Intl.DateTimeFormat('es-ES')` writes «sept» where the board says «sep»,
 * and it would run once per message in threads of six hundred, so the month
 * and day names are spelled out, in the catalog (`shared.time`), one list per
 * language, read when a stamp is formatted.
 *
 * Everything is read off a local `Date` — `getHours`, `getDate` — and never
 * by slicing the ISO string: the stamps arrive in UTC, so a message sent at
 * 01:30 local would be sliced into the day before and labelled «ayer».
 *
 * A missing or unreadable stamp gives `null` everywhere: the caller then
 * paints nothing, instead of a gap or an «Invalid Date».
 */

import { fill, strings } from './i18n/index.js';

const words = () => strings().shared.time;

const pad = (n) => String(n).padStart(2, '0');

/** A `Date` from whatever the server sent, or `null` if it is not a time. */
export function parseTs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How long ago something happened, for a list that is read at a glance:
 * the closed chats, the last poll. Reaches days, because a chat closed on
 * Friday should not read «hace 74 h».
 */
export function ago(ts) {
  const d = parseTs(ts);
  if (!d) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  const t = words();
  if (mins < 1) return t.justNow;
  if (mins < 60) return fill(t.minutesAgo, { n: mins });
  if (mins < 60 * 24) return fill(t.hoursAgo, { n: Math.floor(mins / 60) });
  return fill(t.daysAgo, { n: Math.floor(mins / (60 * 24)) });
}

/** «14:32», in the reader's own time zone. */
export function hhmm(ts) {
  const d = parseTs(ts);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
}

/** The local calendar day a stamp belongs to, as a comparable key. */
export function dayKey(ts) {
  const d = parseTs(ts);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
}

/**
 * Whole days from one local date to another, counted midnight to midnight.
 * Subtracting milliseconds would be wrong twice a year: the day a clock
 * changes is 23 or 25 hours long, and «ayer» would land on «hoy».
 */
function daysApart(from, to) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(to) - midnight(from)) / 86400000);
}

/** «hoy, 17 sep» · «ayer» · «lun, 8 sep» · «lun, 8 sep 2025» for another year. */
export function dayLabel(ts, now = new Date()) {
  const d = parseTs(ts);
  if (!d) return null;
  const distance = daysApart(d, now);
  const t = words();
  const day = d.getDate();
  const month = t.months[d.getMonth()];
  if (distance === 0) return fill(t.today, { day, month });
  if (distance === 1) return t.yesterday;
  const label = fill(t.otherDay, { weekday: t.days[d.getDay()], day, month });
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** The whole stamp, for the tooltip of a time that only shows its hour. */
export function fullStamp(ts) {
  const d = parseTs(ts);
  if (!d) return null;
  const t = words();
  return fill(t.fullStamp, {
    weekday: t.daysLong[d.getDay()],
    day: d.getDate(),
    month: t.months[d.getMonth()],
    year: d.getFullYear(),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  });
}

/**
 * Which messages open a new day, derived from the list as it stands right
 * now — a deleted message can take the first one of a day with it, and a
 * divider remembered from an earlier render would hang off the wrong one.
 *
 * Returns one slot per message: `{ key, label }` for the first message of
 * each day, `null` for the rest. A message with no readable stamp opens
 * nothing and closes nothing: the day it sits in carries on.
 */
export function dayDividers(messages, now = new Date()) {
  const list = messages ?? [];
  const out = new Array(list.length).fill(null);
  let current = null;
  for (let i = 0; i < list.length; i += 1) {
    const key = dayKey(list[i]?.ts);
    if (!key || key === current) continue;
    out[i] = { key, label: dayLabel(list[i].ts, now) };
    current = key;
  }
  return out;
}
