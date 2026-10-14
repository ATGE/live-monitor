/**
 * The board's words, in the language now in use.
 *
 * Module state plus a subscription, not a React context: the plain modules
 * (status.js, time.js, ...) are imported by Node tests and have no tree to read
 * a context from. Spanish is the source language and the default, so those
 * tests keep seeing Spanish without a DOM or a stored choice.
 *
 * Components read `useStrings()` (see useStrings.js); plain modules call
 * `strings()` INSIDE a function, never at module top level: a constant built at
 * import freezes the language that was current then.
 *
 * Nothing here touches `localStorage` or `document` at import time.
 */
import es from './strings/es.js';
import en from './strings/en.js';
import fr from './strings/fr.js';
import de from './strings/de.js';
import { write } from '../storage.js';

export const LOCALES = ['es', 'en', 'fr', 'de'];
export const DEFAULT_LOCALE = 'es';
/** The key (through storage.js) the choice is kept under in this browser. */
export const LOCALE_KEY = 'hfsmon-lang';

const TABLES = { es, en, fr, de };

export const isLocale = (value) => LOCALES.includes(value);

let current = DEFAULT_LOCALE;
const listeners = new Set();

export const strings = () => TABLES[current];
export const locale = () => current;

/**
 * Switches the language: the strings, `<html lang>` and every subscriber.
 * An unknown value falls back to Spanish. Does not persist; see `setLocale`.
 */
export function applyLocale(next) {
  current = isLocale(next) ? next : DEFAULT_LOCALE;
  try { document.documentElement.setAttribute('lang', current); } catch { /* no DOM: a Node test */ }
  for (const fn of listeners) fn();
  return current;
}

/** The language picker's entry point: applies the choice and remembers it. */
export function setLocale(next) {
  const applied = applyLocale(next);
  write(LOCALE_KEY, applied);
  return applied;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: back to Spanish with no subscribers left over. */
export function resetLocaleState() {
  current = DEFAULT_LOCALE;
  listeners.clear();
}

/** `{name}` holes. A hole nobody filled stays visible instead of reading "undefined". */
export function fill(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : whole);
}

/**
 * `forms` is `{ one, other }`; `{n}` is filled with the count. Other holes are
 * left for the caller's own `fill` or `splitAround`.
 */
export function plural(n, forms) {
  let rule;
  try { rule = new Intl.PluralRules(current).select(n); } catch { rule = n === 1 ? 'one' : 'other'; }
  return fill(rule === 'one' ? forms.one : forms.other, { n });
}

/**
 * A sentence with markup inside it stays whole in the catalog, with named
 * holes; this cuts it into `{ key, text, hole }` parts so the caller can put an
 * element where each hole is. Holes not given stay in the text.
 */
export function splitAround(template, holes) {
  const parts = [];
  let last = 0;
  let i = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (!Object.hasOwn(holes, m[1])) continue;
    if (m.index > last) parts.push({ key: `t${i++}`, text: template.slice(last, m.index), hole: null });
    parts.push({ key: `h${i++}`, text: String(holes[m[1]]), hole: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ key: `t${i++}`, text: template.slice(last), hole: null });
  return parts;
}
