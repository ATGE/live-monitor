/**
 * The first non-empty line of a text, trimmed and cut to `max` characters with
 * an ellipsis. Used by the validators' messages to say what a refused text
 * actually starts with, instead of only quoting what it should have opened
 * with. Surrogate-safe: it never cuts an emoji in half.
 */
export function firstLineOf(text, max = 80) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : line;
}
