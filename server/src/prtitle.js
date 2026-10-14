/**
 * The title a draft PR goes out with.
 *
 * The board used to publish `fix: ` plus the issue's title, whatever its
 * length. Issue #1125's title made that 265 characters, GitHub's cap is 256,
 * and the task died at the very last step of a run that had already paid for
 * the fix, the e2e suite and 25 minutes of Browser QA.
 *
 * Two candidates, in order. The subject of the branch's own commit first: it
 * was written in English, by the session that did the work, to fit one line.
 * The issue's title second, clipped at the last word that fits. Both go
 * through the same gate everything published crosses (`language.js`), so a
 * Spanish commit subject falls through to the issue title instead of reaching
 * the repository.
 *
 * Pure: strings in, a decision out. The caller does the parking and the log.
 */

import { publishProblems } from './language.js';
import { WIP_COMMIT_MESSAGE } from './worktree.js';

/** GitHub's cap on a pull request title, in one place. */
export const PR_TITLE_MAX = 256;

/** The conventional-commit prefix the repository uses. */
const CONVENTIONAL = /^(fix|feat|chore|refactor|docs|test|perf|build|ci)(\([^)]*\))?!?: /;

/** A merge commit's subject, whatever the branch it merged. */
const MERGE = /^Merge /;

/** Which half of the convention this branch belongs to. */
export const prTypeFor = (branch) => (String(branch ?? '').startsWith('fix/') ? 'fix' : 'feat');

/** A string that would end on half of a surrogate pair, cut one unit shorter. */
const dropLoneSurrogate = (s) => (/[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s);

/**
 * `text` within `max` characters, cut at the last word that fits and ending in
 * an ellipsis. Never longer than `max`, never half a character: JavaScript
 * lengths count UTF-16 units, so a blind slice can split an emoji in two.
 */
export function clipTitle(text, max = PR_TITLE_MAX) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  // The ellipsis takes one unit of the budget.
  const room = Math.max(0, max - 1);
  const head = s.slice(0, room);
  const space = head.lastIndexOf(' ');
  // A title with no space at all (one enormous token) is cut where it is.
  const cut = space > 0 ? head.slice(0, space) : dropLoneSurrogate(head);
  return `${cut.replace(/[\s,;:.·–—-]+$/, '')}…`;
}

/** Why this candidate cannot be published, as a list of reasons. */
function commitProblems(subject) {
  const problems = [];
  if (subject === WIP_COMMIT_MESSAGE) problems.push('it is the unfinished work commit a move makes');
  if (MERGE.test(subject)) problems.push('it is a merge commit, it does not describe the change');
  if (!CONVENTIONAL.test(subject)) problems.push('it is not shaped like a conventional commit (`fix: …`, `feat(ui): …`)');
  problems.push(...publishProblems(subject, { maxChars: PR_TITLE_MAX }));
  return problems;
}

/**
 * The title to publish, where it came from, and every candidate that was turned
 * down with its reasons — the log says which one won, and the card shows the
 * reasons when neither did.
 *
 * `{ title: null }` is a real outcome: the caller parks the proposal on the
 * card for you to edit, instead of retrying a computation that will produce
 * exactly the same rejected text for ever.
 */
export function choosePrTitle({ branch, issueTitle, commitSubject } = {}) {
  const rejected = [];

  const subject = String(commitSubject ?? '').trim();
  if (subject) {
    const problems = commitProblems(subject);
    if (!problems.length) return { title: subject, source: 'commit', rejected };
    rejected.push({ source: 'commit', title: subject, problems });
  }

  const title = String(issueTitle ?? '').trim();
  if (title) {
    const candidate = clipTitle(`${prTypeFor(branch)}: ${title}`, PR_TITLE_MAX);
    const problems = publishProblems(candidate, { maxChars: PR_TITLE_MAX });
    if (!problems.length) return { title: candidate, source: 'issue', rejected };
    rejected.push({ source: 'issue', title: candidate, problems });
  }

  return { title: null, source: null, rejected };
}
