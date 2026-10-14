/**
 * Numbers and dates through `Intl`, in the language now in use. The locale is
 * read at call time, so a switch reaches the next render. Formatters are
 * cached per locale and options.
 *
 * time.js keeps its own month and day names on purpose (see its header); this
 * is for everything else.
 */
import { locale } from './index.js';

const cache = new Map();

function formatter(kind, options) {
  const key = `${kind}|${locale()}|${JSON.stringify(options ?? {})}`;
  let f = cache.get(key);
  if (!f) {
    f = kind === 'number' ? new Intl.NumberFormat(locale(), options) : new Intl.DateTimeFormat(locale(), options);
    cache.set(key, f);
  }
  return f;
}

export const formatNumber = (n, options) => formatter('number', options).format(n);

/** `share` is a fraction: 0.26 reads «26 %» in Spanish and «26%» in English. */
export const formatPercent = (share, options) =>
  formatter('number', { style: 'percent', maximumFractionDigits: 0, ...options }).format(share);

/** A date and time as one stamp; `value` is a Date, a number or an ISO string. */
export const formatDateTime = (value, options = { dateStyle: 'medium', timeStyle: 'short' }) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatter('date', options).format(date);
};
