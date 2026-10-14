// Pure rules of the reviewer dialog. No React here, so the node tests can
// import it. The server owns the truth (`GET /api/projects/:p/reviewers`);
// this only decides what the dialog says and what it sends.
import { fill, strings } from './i18n/index.js';
import es from './i18n/strings/es.js';

/** How many candidate names the «nobody matches» line spells out. */
export const NAMES_SHOWN = 8;

/**
 * Annotation on the PR author: GitHub refuses to ask the author for a review.
 * A string, so it is the Spanish source text, fixed at import; the dialog reads
 * `authorNote()`, which follows the language in use.
 */
export const AUTHOR_NOTE = es.shared.reviewer.authorNote;
export const authorNote = () => strings().shared.reviewer.authorNote;

/** Is `user` the PR author? The server flags it; the login is compared as a second net. */
export const isAuthorOf = (user, excludeLogin) =>
  user?.isAuthor === true
  || (!!excludeLogin && !!user?.login && user.login.toLowerCase() === excludeLogin.toLowerCase());

/** The status line under the search box. `known` = the unfiltered list from the empty query. */
export function statusLine({ error, busy, shown, known }) {
  const w = strings().shared.reviewer;
  if (error) return fill(w.searchFailed, { error });
  if (busy) return w.searching;
  if (shown.length > 0) return '';
  const names = (known ?? []).slice(0, NAMES_SHOWN).map((u) => u.login);
  return names.length ? fill(w.nobodyKnown, { names: names.join(', ') }) : w.nobody;
}

/** What «Marcar listo» sends for a pick: the checkbox also applies to «Sin revisor». */
export function readyPick(login, remember) {
  if (login) return { reviewer: login, always: remember === true };
  return remember === true ? { noReviewer: true, always: true } : { noReviewer: true };
}

/** What the settings mode sends for a pick (`null` = «Sin revisor»). */
export const settingsPick = (login) => (login ? { reviewer: login } : { noReviewer: true });

/** «Preguntar cada vez»: forget both, the next PR asks again. */
export const ASK_EVERY_TIME = { reviewer: null, noReviewer: false };

/** The project's current setting, in words, for the settings mode. */
export function currentState(project) {
  const w = strings().shared.reviewer;
  if (project?.reviewer) return fill(w.current, { login: project.reviewer });
  if (project?.noReviewer) return w.noReviewer;
  return w.askEvery;
}
