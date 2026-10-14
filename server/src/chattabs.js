import { isProjectId } from './keys.js';

/**
 * The tabs over the chat panel: one per task (or per project chat), shared by
 * every browser that opens the board. A task's tab is `{ project, issue, usedAt }`
 * (issue #12 of two projects are two tabs); a project chat's is
 * `{ issue: 'p:<project>@<machine>', usedAt }`. A task tab written before
 * projects existed has no `project` (`{ issue, usedAt }`) and is kept as it is
 * until `sealTabs` gives it one. Kept in the order they were opened, like editor
 * tabs, and capped: past `MAX_TABS` the one looked at longest ago goes,
 * wherever it sits in the strip.
 *
 * Pure functions over plain arrays, so the rules are testable without the
 * settings file, and so the server applies one operation at a time: two
 * devices sending back whole lists would overwrite each other's tabs.
 */

export const MAX_TABS = 10;

/** A project chat's tab: `p:<project>@<machine>`, kept as a string in `issue`. */
export const HOLDER_TAB = /^p:[a-z0-9][a-z0-9-]*@[A-Za-z0-9._-]+$/;

export const isHolderTab = (issue) => typeof issue === 'string' && HOLDER_TAB.test(issue);

const isIssueNumber = (issue) => Number.isInteger(issue) && issue > 0;

const validIssue = (issue) => isIssueNumber(issue) || isHolderTab(issue);

/** What tells two tabs apart: the holder string, or `<project>#<issue>`. */
function tabId(tab) {
  if (isHolderTab(tab.issue)) return tab.issue;
  return `${tab.project ?? ''}#${tab.issue}`;
}

/**
 * What an operation addresses: a project chat's string, or `{ project, issue }`
 * for a task. A bare number is refused: it is the shape that lost the project.
 */
function targetOf(target) {
  if (isHolderTab(target)) return { issue: target };
  if (!isIssueNumber(target?.issue)) throw new Error('issue must be a positive integer');
  if (!isProjectId(target.project)) throw new Error('project must be a project id');
  return { project: target.project, issue: target.issue };
}

/** A task tab written before projects existed: no `project` to say whose it is. */
export const isLegacyTab = (tab) => !isHolderTab(tab?.issue) && !isProjectId(tab?.project);

/**
 * Whatever the settings file holds, made safe to work on: entries without a
 * valid issue dropped, duplicates collapsed onto the first, `usedAt` a number.
 * An entry with no project is kept (see `sealTabs`), not dropped.
 */
export function normalizeTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tabs) {
    const issue = isHolderTab(t?.issue) ? t.issue : Number(t?.issue);
    if (!validIssue(issue)) continue;
    const usedAt = Number(t.usedAt);
    const tab = isHolderTab(issue) || !isProjectId(t.project)
      ? { issue, usedAt: Number.isFinite(usedAt) ? usedAt : 0 }
      : { project: t.project, issue, usedAt: Number.isFinite(usedAt) ? usedAt : 0 };
    const id = tabId(tab);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(tab);
  }
  return out;
}

/**
 * Gives every tab that has no project the one the board opens on, which is
 * where the browser has always attributed them. Run once at boot; a second run
 * finds nothing to do.
 */
export function sealTabs(tabs, project) {
  const list = normalizeTabs(tabs);
  if (!isProjectId(project)) return list;
  return normalizeTabs(list.map((t) => (isLegacyTab(t) ? { ...t, project } : t)));
}

/**
 * Opens a tab, or brings an open one back into use. A known tab keeps its place
 * in the strip; a new one goes at the end. The tab being opened is never the
 * one evicted, even if the clock says it is the oldest.
 */
export function openTab(tabs, target, now = Date.now()) {
  const wanted = targetOf(target);
  const id = tabId(wanted);
  const list = normalizeTabs(tabs);
  let next = list.some((t) => tabId(t) === id)
    ? list.map((t) => (tabId(t) === id ? { ...t, usedAt: now } : t))
    : [...list, { ...wanted, usedAt: now }];
  while (next.length > MAX_TABS) {
    const victim = next
      .filter((t) => tabId(t) !== id)
      .reduce((oldest, t) => (t.usedAt < oldest.usedAt ? t : oldest));
    next = next.filter((t) => t !== victim);
  }
  return next;
}

/** Takes one tab out of the strip. Its chats are not touched. */
export function closeTab(tabs, target) {
  const id = tabId(targetOf(target));
  return normalizeTabs(tabs).filter((t) => tabId(t) !== id);
}

/** Drops the tabs the board no longer has; `isKnown` gets the whole entry. */
export function pruneTabs(tabs, isKnown) {
  return normalizeTabs(tabs).filter((t) => isKnown(t));
}
