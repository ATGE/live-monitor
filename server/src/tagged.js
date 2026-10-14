/**
 * Reading the tagged JSON line a phase ends its turn with.
 *
 * It lives apart from `claude.js` because that module pulls in the Agent SDK,
 * and the things that need to *read* a transcript — the work-plan contract, its
 * tests — have no business booting an SDK to parse a string.
 */

/**
 * Extracts the last `TAG: {...}` JSON object from a transcript. Greedy to the
 * final brace on the line, because these payloads carry nested objects, and
 * walking backwards because a model that corrects itself leaves both attempts
 * in the text and the last one is the one it meant.
 */
export function parseTaggedJson(text, tag) {
  const matches = [...String(text ?? '').matchAll(new RegExp(`${tag}:\\s*(\\{.*\\})`, 'g'))];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(matches[i][1]);
    } catch { /* try the one before it */ }
  }
  return null;
}

/** Removes the tagged line from prose that is going to be shown to the user. */
export function stripTaggedLine(text, tag) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^\\s*${tag}:`).test(line))
    .join('\n')
    .trimEnd();
}
