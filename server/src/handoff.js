/**
 * What a chat is told about the machine it runs on, and about a move.
 *
 * Pure text: no disk, no git. The caller works out the facts (where the task
 * lived before, whether a session was resumed, whether the board made a WIP
 * commit) and hands them in; these functions only word them.
 *
 * Both blocks carry their own separator, like `renderSiblings`, so a chat that
 * never moved renders `chat-rules.md` byte for byte as before.
 */

const PLATFORM_LABELS = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

// The exact subject of the commit the board makes before moving a dirty
// worktree. Named verbatim so the session can find it in `git log`. Kept here
// rather than imported, so this module stays free of git and config; a test
// holds it equal to `WIP_COMMIT_MESSAGE` in worktree.js.
export const WIP_SUBJECT = 'wip: uncommitted work';

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * One bracketed line placed before the environment rules: where this session
 * runs and which other systems earlier messages may quote paths from. Empty
 * while the task has only ever lived on one machine — nothing to warn about.
 */
export function machineNoteFor({ machine, worktreePath, otherPlatforms = [] } = {}) {
  // Only systems other than this one: another Linux place quotes Linux paths.
  const elsewhere = [...new Set(otherPlatforms)].filter((p) => p !== machine?.platform);
  if (!elsewhere.length) return '';
  const others = [...new Set(elsewhere.map(platformLabel))].join(' or ');
  const where = `${machine?.name} (${platformLabel(machine?.platform)})`;
  return `[This session runs on ${where}, worktree \`${worktreePath}\`. Earlier messages may quote paths from ${others}.]\n\n`;
}

/** `at` as UTC, so the text does not depend on the host's time zone. */
function formatAt(at) {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What the previous session left: its own words first, the git brief after. */
function carried({ text, brief }, intro) {
  if (text && brief) return `${intro}\n${text}\n\nGit brief of the branch:\n${brief}`;
  if (text) return `${intro}\n${text}`;
  if (brief) return `No handoff was written; the git brief of the branch instead:\n${brief}`;
  return '';
}

/**
 * The block prepended to the first turn after a move, then consumed.
 *
 * `handoff = { from, to, at, text, brief, resumed }`. A fresh session is
 * introduced to the task; a resumed one is told what happened while it was
 * away and not to trust its memory of files that changed.
 */
export function arrivalBlock(handoff, { machineName, platform, worktreePath, wip } = {}) {
  if (!handoff) return '';
  const { from, to, at, resumed } = handoff;
  const here = [
    machineName ?? to,
    platform ? ` (${platformLabel(platform)})` : '',
    worktreePath ? `, worktree \`${worktreePath}\`` : '',
  ].join('');

  const parts = resumed
    ? [
      `This session is resuming on ${here}${worktreePath ? ',' : ''} after the task spent time on ${from}; it came back on ${formatAt(at)}.`,
      carried(handoff, 'What happened there:'),
      'Re-read any file that changed before trusting what this session remembers of it.',
    ]
    : [
      `On ${formatAt(at)} this task moved from ${from} to ${here}. This session starts fresh here and cannot see the conversation held on ${from}.`,
      carried(handoff, 'What the previous session wrote before leaving:'),
    ];
  if (wip) {
    // Already pushed, possibly onto an open PR: rewriting it would need a force-push.
    parts.push(`The latest commit, \`${WIP_SUBJECT}\`, was made by the board with unfinished work: continue from it and fold it into a proper commit before asking for review; never force-push a branch that has an open PR.`);
  }
  // The team reads commits and PRs; how the board shuffles tasks is not theirs to read.
  parts.push('Do not mention the move, the machines or the board in commit messages or PR text.');
  return `\n\n[Handoff from the board: ${parts.filter(Boolean).join('\n\n')}]`;
}
