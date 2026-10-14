// Pure helpers for the board search box. No React, no JSX.

const NUMERIC = /^(?:([a-z0-9._-]+)#|#)?(\d+)$/;

/** NFD, strip combining marks, lowercase. */
export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Split the raw query into normalized tokens; null when there are none. */
export function parseQuery(text) {
  const tokens = normalize(text).split(/\s+/).filter(Boolean);
  return tokens.length ? { tokens } : null;
}

function numericParts(token) {
  const m = NUMERIC.exec(token);
  return m ? { prefix: m[1] || null, digits: m[2] } : null;
}

function projectOk(prefix, task) {
  return prefix === null || prefix === normalize(task.project);
}

/** True when the task satisfies every token (AND); null `parsed` matches all. */
export function matchTask(task, parsed) {
  if (!parsed) return true;
  const title = normalize(task.title);
  const numbers = [task.issue, task.prNumber, ...(task.prs ?? []).map((p) => p?.number)]
    .filter((n) => n !== undefined && n !== null)
    .map(String);
  return parsed.tokens.every((token) => {
    const num = numericParts(token);
    if (num) {
      // A bare number may also be a word in the title ("fix 404 error").
      return (projectOk(num.prefix, task) && numbers.some((n) => n.startsWith(num.digits)))
        || title.includes(token);
    }
    return title.includes(token);
  });
}

/** Ranges [start, end) over the ORIGINAL text where non-numeric tokens hit. */
export function highlightRanges(text, parsed) {
  const original = String(text ?? '');
  if (!parsed || !original) return [];
  const words = parsed.tokens.filter((t) => !NUMERIC.test(t));
  if (!words.length) return [];
  // Normalize code point by code point, remembering where each char came from.
  let norm = '';
  const from = [];
  let i = 0;
  for (const ch of original) {
    const n = normalize(ch);
    for (let k = 0; k < n.length; k++) from.push([i, i + ch.length]);
    norm += n;
    i += ch.length;
  }
  const found = [];
  for (const w of words) {
    let at = norm.indexOf(w);
    while (at !== -1) {
      let end = from[at + w.length - 1][1];
      while (end < original.length && /^\p{M}$/u.test(original[end])) end++;
      found.push([from[at][0], end]);
      at = norm.indexOf(w, at + 1);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Whether the displayed issue number (digits) should be marked. */
export function highlightNumberRange(numberText, task, parsed) {
  if (!parsed) return false;
  const shown = String(numberText ?? '');
  return parsed.tokens.some((token) => {
    const num = numericParts(token);
    return !!num && projectOk(num.prefix, task) && shown.startsWith(num.digits);
  });
}

/** Tasks the filter never hides: awaiting the user, or open in a panel. */
export function isExempt(task, { awaitingKeys, openKeys } = {}) {
  const key = `${task.project}#${task.issue}`;
  return !!(awaitingKeys?.has(key) || openKeys?.has(key));
}
