/**
 * The composite key of a task, `<project>#<issue>`, composed from what the
 * board already receives. The web never parses one back apart (`keys.js`, "The
 * web does not parse keys"): parsing is a server concern, and there is no copy
 * of `keys.js` here on purpose.
 *
 * It is in-memory currency only — React keys, DOM ids, the `lastChat` map. It
 * never goes into a URL: `#` starts the fragment, so the two halves always
 * travel as separate path segments or fields.
 */

/** `<project>#<issue>` from the two halves. */
export const keyOf = (project, issue) => `${project}#${issue}`;

/**
 * `<project>#<issue>` from a task, which carries both. A project-chat holder
 * (`kind: 'project'`) has no issue: its key is `<project>@<machine>`, which
 * never collides with a task's.
 */
export const taskKey = (task) => (task.kind === 'project'
  ? (task.key ?? holderKey(task.project, task.machine))
  : `${task.project}#${task.issue}`);

/** `<project>@<machine>`: a project chat's holder. */
export const holderKey = (project, machine) => `${project}@${machine}`;

/** The tab-strip entry of a holder, as the server stores it: `p:<project>@<machine>`. */
export const holderTabEntry = (project, machine) => `p:${holderKey(project, machine)}`;

/**
 * Splits a tab-strip entry `p:<project>@<machine>` into its halves, or null
 * when the entry is a task's (an issue number). The one place the web reads
 * the shape of a holder entry; the project id never contains `@`.
 */
export function parseHolderTab(issue) {
  if (typeof issue !== 'string' || !issue.startsWith('p:')) return null;
  const at = issue.indexOf('@', 2);
  if (at < 0) return null;
  return { project: issue.slice(2, at), machine: issue.slice(at + 1) };
}

/**
 * The DOM id of a card. `getElementById` takes it literally, `#` and all —
 * a CSS selector would not, so nothing here ever queries by it.
 */
export const cardId = (project, issue) => `card-${project}#${issue}`;

/**
 * Does an incoming `log` / `chat` / `chat-update` belong to this task? The two
 * halves travel as separate fields on the wire, so this compares both.
 *
 * A message with no `project` at all is taken as this task's: a board whose
 * server does not yet stamp the project on its events must keep working
 * exactly as it did, rather than go silent on every chat.
 */
export const sameTask = (detail, task) => {
  // A holder's messages carry `owner: 'project'` and its machine; a task's
  // carry neither. Two holders of one project never cross-talk, and a holder's
  // `issue: null` never matches a task.
  if (task?.kind === 'project') {
    return detail?.owner === 'project' && detail.machine === task.machine && detail.project === task.project;
  }
  if (detail?.owner === 'project') return false;
  return detail?.issue === task?.issue && (detail?.project == null || detail.project === task?.project);
};
