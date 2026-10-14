/**
 * The SDK's own words for "you are out of usage", and nothing else.
 *
 * Its own file for one reason: `mode.js` has to recognise a limit notice — the
 * migration that cleans the poisoned `demoSteps` — and `mode.js` is imported by
 * `store.js`, which `quota.js` imports. Sharing the check through `quota.js`
 * would close that circle. Nothing here imports anything of the board.
 *
 * The prefixes come from the SDK rather than from a copy, so a new one reaches
 * the board with the next `npm install` and not with the next incident.
 */

import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';

export { USAGE_LIMIT_ERROR_PREFIXES };

/**
 * Whether this text is one of those notices.
 *
 * Line by line, not just at the very start: what reaches the board is rarely
 * the raw message — it arrives as the tail of a session's result, or as the
 * body a phase was supposed to fill with something else. A prefix that opens a
 * line is the notice; the same words in the middle of a sentence are prose.
 */
export function looksLikeUsageLimit(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return text.split(/\r?\n/).some((line) => {
    const l = line.trim();
    return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => l.startsWith(prefix));
  });
}
