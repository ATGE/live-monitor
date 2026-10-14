/**
 * The seal net's bookkeeping, as a plain state machine with no timers and no
 * I/O: `runClaude` feeds it the frames and does what it answers.
 *
 * Why it exists. A phase that fans out to subagents often seals (`resultAnswers`)
 * on a result that is only the sentence «they are still working»; the real answer
 * comes in a later turn. The net lets those later results replace the sealed one,
 * but only inside a window, or any turn the CLI opens on its own afterwards (a
 * background `cargo build` that ended) would replace the plan with its message.
 *
 * The window is open while the seal left a DEBT, and it closes with the turn that
 * follows the last owed report. The debt is three kinds of subagent:
 *
 *   - those still out when the answer was sealed (`out`),
 *   - those still out at a later result of the window (launched after the seal,
 *     e.g. a turn that starts subagent B and answers «waiting for B»), and
 *   - those launched in the background that already reported inside the sealed
 *     turn (`early`): the CLI sealed the waiting sentence of a turn that had its
 *     report before it closed (recorded in `tools/subagent-probe`). A subagent
 *     that ran in the foreground (`is_backgrounded === false`, which is what the
 *     gate makes of them) answered inside its own turn and owes nothing; a
 *     frame without the field is treated as foreground, as before the net.
 *
 * Closing rule: the first result — success or not — whose turn opened after the
 * last owed report. A turn that was already in flight when the report arrived
 * ends in a result that may still be the waiting sentence, so it does not close
 * it. A CLI that emits no `init` per turn is read as «a result opens the next
 * turn right after the previous one».
 */

/**
 * How long to hold the channel for the CLI's own turn after an owed subagent has
 * reported and no turn has opened yet. The gap recorded between the report and
 * the next `init` is a few milliseconds.
 */
export const REPORT_SETTLE_MS = 15_000;

export function createSealNet() {
  let sealed = false;
  let windowOpen = false;
  let openTurn = false;       // a turn is in flight (`init` opens one, a result closes it)
  let turnClean = true;       // the turn in flight (or the next) opened after every report so far
  let unanswered = false;     // a report arrived and no result has followed it yet
  const known = new Map();    // subagent task id → launched in the background
  const reportedBg = new Set(); // background subagents that reported inside the turn in flight, not owed (before the seal, or launched while the window is open)
  const owedOut = new Set();  // subagents out at the seal, or still out at a later result of the window, that have not reported

  const reported = (id, background) => {
    if (!sealed) {
      if (background) reportedBg.add(id);
      return;
    }
    if (!owedOut.delete(id)) {
      // Launched after the seal and reported inside one turn: that turn holds
      // the report, so it cannot be the one that follows it.
      if (windowOpen && openTurn && background) reportedBg.add(id);
      return;
    }
    unanswered = true;
    if (openTurn) turnClean = false;
  };

  return {
    /**
     * Call after `trackTasks` updated `tasks` (id → is a subagent) for `message`.
     * Results are not observed here: see `result`.
     */
    observe(message, tasks) {
      // A CLI that sends no `init` per turn still opens one with the first
      // assistant frame of the main thread; with `init` present this is a no-op.
      // Subagent frames (`parent_tool_use_id` set) say nothing about the main turn.
      if (message.type === 'assistant' && message.parent_tool_use_id == null && !openTurn) {
        openTurn = true;
        return;
      }
      if (message.type !== 'system') return;
      if (message.subtype === 'init') {
        openTurn = true;
        turnClean = true;
        return;
      }
      if (message.subtype === 'task_started' && !message.ambient && message.task_id && tasks.get(message.task_id)) {
        known.set(message.task_id, message.is_backgrounded === true);
      }
      for (const [id, isAgent] of tasks) {
        if (isAgent && !known.has(id)) known.set(id, false);
      }
      for (const [id, background] of [...known]) {
        if (!tasks.get(id)) {
          known.delete(id);
          reported(id, background);
        }
      }
    },

    /**
     * Call for every result. `mine` says it answers our prompt. Answers
     * `{ seal: { out, early }, adopt, closes }` for the sealing result,
     * `{ adopt, closes }` after it; `closes` says this result ended the window.
     */
    result(message, tasks, { mine }) {
      if (!sealed && mine) {
        sealed = true;
        for (const [id, isAgent] of tasks) if (isAgent) owedOut.add(id);
        const out = owedOut.size;
        const early = reportedBg.size;
        reportedBg.clear();
        windowOpen = out + early > 0;
        unanswered = early > 0;
        openTurn = false;
        turnClean = true;
        return { seal: { out, early }, adopt: true, closes: false };
      }
      const earlyNow = reportedBg.size;
      reportedBg.clear();
      openTurn = false;
      unanswered = false;
      if (!sealed || !windowOpen) {
        turnClean = true;
        return { adopt: !sealed, closes: false };
      }
      // Subagents launched while the window is open are owed too: the window
      // closes only on the turn that follows the last report, not on a turn that
      // answers «waiting for B».
      for (const [id, isAgent] of tasks) if (isAgent) owedOut.add(id);
      const closes = owedOut.size === 0 && turnClean && earlyNow === 0;
      if (closes) windowOpen = false;
      // A turn that was already in flight when the last report arrived does not
      // close the window: keep the channel for the turn that will follow it.
      unanswered = windowOpen && owedOut.size === 0;
      turnClean = true;
      return { adopt: message.subtype === 'success', closes };
    },

    /** An owed subagent reported and the turn that should follow it has not opened. */
    awaitsTurn() {
      return sealed && windowOpen && owedOut.size === 0 && !openTurn && unanswered;
    },

    /** A turn is in flight while the window is open: the channel must stay up for it. */
    turnOpen() {
      return sealed && windowOpen && openTurn;
    },

    /** Gave up waiting for that turn: the sealed answer stands. */
    giveUp() {
      windowOpen = false;
    },
  };
}
